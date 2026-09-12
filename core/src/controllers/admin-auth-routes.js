function getClientIp(req) {
  const cfIp = req.headers["cf-connecting-ip"];
  if (cfIp) return cfIp.trim();

  const realIp = req.headers["x-real-ip"];
  if (realIp) return realIp.trim();

  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    const candidates = forwardedFor
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (candidates.length > 0) return candidates[0];
  }

  if (req.ip && req.ip !== "::1" && req.ip !== "::ffff:127.0.0.1")
    return req.ip;

  const remoteAddress =
    req.connection?.remoteAddress || req.socket?.remoteAddress;
  if (remoteAddress?.startsWith("::ffff:")) return remoteAddress.substring(7);
  return remoteAddress || "unknown";
}

function isTrustedLocalIp(ip) {
  // 免登录仅对可信来源开放：本机回环 + 局域网私网段（部署在公网时勿用此接口）
  if (!ip) return false;
  const clean = String(ip).replace(/^::ffff:/, "");
  if (clean === "127.0.0.1" || clean === "::1" || clean === "localhost") return true;
  const parts = clean.split(".");
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (a === 10) return true;                 // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;   // 192.168.0.0/16
  return false;
}

function registerAdminAuthRoutes({
  app,
  logger,
  userStore,
  requireAdminToken,
  createAdminSession,
  updateAdminSessions,
}) {
  // 本机/局域网免登录直登：仅对可信来源开放，自动以 admin 身份签发 token。
  // 用于"打开面板直接进首页"，避免每次手动登录。公网部署请勿暴露此接口。
  app.post("/api/auto-login", (req, res) => {
    try {
      const ip = getClientIp(req);
      if (!isTrustedLocalIp(ip)) {
        return res.status(403).json({ ok: false, error: "仅限本机或局域网访问" });
      }
      const users = userStore.getAllUsers();
      const admin = users.find((u) => u.role === "admin" || u.role === "super_admin");
      if (!admin) {
        return res.status(500).json({ ok: false, error: "未找到管理员账号" });
      }
      const token = createAdminSession({
        username: admin.username,
        role: admin.role,
        card: admin.card || null,
        accountLimit: admin.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2,
      });
      logger.info("免登录直登", { username: admin.username, ip });
      return res.json({
        ok: true,
        data: {
          token,
          role: admin.role,
          accountLimit: admin.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2,
          user: { username: admin.username },
        },
      });
    } catch (error) {
      logger.error("免登录直登失败", { error: error.message });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/login", (req, res) => {
    const { username, password } = req.body || {};
    const ip = getClientIp(req);
    const userAgent = req.headers["user-agent"] || "";

    if (!username || !password) {
      return res.status(401).json({ ok: false, error: "请输入用户名和密码" });
    }

    const validationResult = userStore.validateUser(username, password, ip);
    if (validationResult && validationResult.error) {
      const status =
        validationResult.error === "rate_limit"
          ? 429
          : validationResult.error === "locked"
            ? 423
            : 401;
      logger.warn("登录失败", {
        username,
        error: validationResult.error,
        ip,
        message: validationResult.message,
      });
      userStore.addLoginLog(
        "login_failed",
        username,
        validationResult.error,
        ip,
        userAgent,
      );
      return res.status(status).json({
        ok: false,
        error: validationResult.message,
        errorType: validationResult.error,
        remainingMs: validationResult.remainingMs,
      });
    }

    if (!validationResult) {
      logger.warn("登录失败", {
        username,
        ip,
        reason: "invalid_credentials",
      });
      userStore.addLoginLog(
        "login_failed",
        username,
        "invalid_credentials",
        ip,
        userAgent,
      );
      return res.status(401).json({ ok: false, error: "用户名或密码错误" });
    }

    if (
      validationResult.role !== "admin" &&
      validationResult.role !== "super_admin"
    ) {
      if (validationResult.card && validationResult.card.enabled === false) {
        logger.warn("登录拒绝", { username, reason: "banned" });
        return res
          .status(403)
          .json({ ok: false, error: "账号已被封禁，请联系管理员" });
      }

      if (
        validationResult.card &&
        validationResult.card.expiresAt &&
        validationResult.card.expiresAt < Date.now()
      ) {
        logger.warn("登录拒绝", { username, reason: "expired" });
        return res
          .status(403)
          .json({ ok: false, error: "账号已过期，请续费后重新登录" });
      }
    }

    userStore.addLoginLog("login_success", username, null, ip, userAgent);
    const token = createAdminSession(validationResult);
    return res.json({
      ok: true,
      data: {
        token,
        role: validationResult.role,
        card: validationResult.card,
        accountLimit:
          validationResult.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2,
        user: { username: validationResult.username },
        mustChangePassword: validationResult.mustChangePassword || false,
      },
    });
  });

  app.post("/api/register", (req, res) => {
    const { username, password, cardCode } = req.body || {};
    if (!username || !password || !cardCode) {
      return res.status(400).json({ ok: false, error: "请填写完整信息" });
    }

    const result = userStore.registerUser(username, password, cardCode);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, data: result.user });
  });

  app.get("/api/card/info/:code", (req, res) => {
    try {
      const { code } = req.params;
      const card = userStore.getAllCards().find((item) => item.code === code);
      if (!card) {
        return res.status(404).json({ ok: false, error: "卡密不存在" });
      }
      if (!card.enabled) {
        return res.status(400).json({ ok: false, error: "卡密已被禁用" });
      }
      if (card.usedBy) {
        return res.status(400).json({ ok: false, error: "卡密已被使用" });
      }

      res.json({
        ok: true,
        data: {
          type: card.type || "time",
          days: card.days,
          value: card.value,
          durationValue: card.durationValue,
          durationUnit: card.durationUnit,
          durationMs: card.durationMs,
          isPermanent: card.isPermanent === true || card.days === -1,
          description: card.description,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/user/renew", requireAdminToken, (req, res) => {
    const { cardCode } = req.body || {};
    const username = req.currentUser?.username;
    if (!username) {
      return res.status(401).json({ ok: false, error: "未登录" });
    }
    if (!cardCode) {
      return res.status(400).json({ ok: false, error: "请提供卡密" });
    }

    const result = userStore.renewUser(username, cardCode);
    if (!result.ok) return res.status(400).json(result);

    updateAdminSessions(
      (session) => session.username === username,
      (session) => {
        session.card = result.card;
        session.accountLimit = result.accountLimit;
      },
    );
    res.json({
      ok: true,
      data: {
        card: result.card,
        accountLimit: result.accountLimit,
        cardType: result.cardType,
      },
    });
  });

  app.post("/api/public/renew", (req, res) => {
    try {
      const ip = getClientIp(req);
      const rateLimit = userStore.checkRateLimit(ip);
      if (!rateLimit.allowed) {
        return res.status(429).json({
          ok: false,
          error: rateLimit.message,
          errorType: "rate_limit",
          remainingMs: rateLimit.remainingMs,
        });
      }

      const { username, cardCode } = req.body || {};
      if (!username) {
        return res.status(400).json({ ok: false, error: "请提供用户名" });
      }
      if (!cardCode) {
        return res.status(400).json({ ok: false, error: "请提供卡密" });
      }

      const result = userStore.renewUser(username, cardCode);
      if (!result.ok) return res.status(400).json(result);

      logger.info("公开续费成功", { username, cardType: result.cardType, ip });
      res.json({
        ok: true,
        data: {
          card: result.card,
          accountLimit: result.accountLimit,
          cardType: result.cardType,
        },
      });
    } catch (error) {
      logger.error("公开续费失败", { error: error.message });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/public/reset-password/verify", (req, res) => {
    try {
      const ip = getClientIp(req);
      const rateLimit = userStore.checkRateLimit(ip);
      if (!rateLimit.allowed) {
        return res.status(429).json({
          ok: false,
          error: rateLimit.message,
          errorType: "rate_limit",
          remainingMs: rateLimit.remainingMs,
        });
      }

      const { username, cardCode } = req.body || {};
      if (!username || !cardCode) {
        return res.status(400).json({ ok: false, error: "请提供用户名和卡密" });
      }

      const result = userStore.verifyCardOwnership(username, cardCode);
      if (!result.ok) return res.status(400).json(result);
      res.json({ ok: true });
    } catch (error) {
      logger.error("找回密码验证失败", { error: error.message });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/public/reset-password/confirm", (req, res) => {
    try {
      const ip = getClientIp(req);
      const rateLimit = userStore.checkRateLimit(ip);
      if (!rateLimit.allowed) {
        return res.status(429).json({
          ok: false,
          error: rateLimit.message,
          errorType: "rate_limit",
          remainingMs: rateLimit.remainingMs,
        });
      }

      const { username, cardCode, newPassword } = req.body || {};
      if (!username || !cardCode || !newPassword) {
        return res
          .status(400)
          .json({ ok: false, error: "请提供用户名、卡密和新密码" });
      }

      const result = userStore.resetPasswordByCard(
        username,
        cardCode,
        newPassword,
      );
      if (!result.ok) return res.status(400).json(result);

      logger.info("找回密码重置成功", { username, ip });
      res.json({ ok: true, message: result.message });
    } catch (error) {
      logger.error("找回密码重置失败", { error: error.message });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/user/change-password", requireAdminToken, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    const username = req.currentUser?.username;
    if (!username) {
      return res.status(401).json({ ok: false, error: "未登录" });
    }
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ ok: false, error: "请提供原密码和新密码" });
    }

    const result = userStore.changePassword(username, oldPassword, newPassword);
    res.json(result);
  });
}

module.exports = { registerAdminAuthRoutes };

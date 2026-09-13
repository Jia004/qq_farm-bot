/**
 * 护主犬（宠物）管理接口
 *
 * - GET  /api/dog/panel            宠物面板全量数据（宠物列表/出战/食物/礼包）
 * - GET  /api/dog/gifts            查询当前可领同气礼包数量
 * - POST /api/dog/gifts/claim      领取同气礼包
 * - POST /api/dog/deploy           出战护农 { dogId }
 * - POST /api/dog/withdraw         收回宠物
 * - POST /api/dog/feed             投喂狗粮 { foodId, count }
 * - POST /api/dog/activate         激活宠物 { dogId }
 * - GET  /api/dog/protect-logs     看护日志（抓住小偷记录）
 *
 * 【2026-09-14 客户端反混淆实锤】协议 = gamepb.dogpb.DogService.*
 *   GetDogInfo / ActivateDog / DeployDog / WithdrawDog / AddFood / GetProtectLogs / ClaimSkillGifts
 */
function getAccountOrRespond(req, res, { getAccountIdFromRequest, canAccessAccount }) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json({ ok: false, error: "Missing x-account-id" });
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }
  return accountId;
}

/** 游戏业务错误（code=xxx）以 200 + 结构化返回，前端可解析 code */
function respondGameError(res, error, fallbackMessage) {
  const message = String(error?.message || error || fallbackMessage);
  const codeMatch = message.match(/code=(\d+)/);
  const code = codeMatch ? Number(codeMatch[1]) : 0;
  if (code > 0) {
    return res.json({ ok: false, code, error: message });
  }
  return null;
}

function registerAdminDogRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  const access = { getAccountIdFromRequest, canAccessAccount };

  // 宠物面板全量数据
  app.get("/api/dog/panel", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const data = await provider.getDogPanelData(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  // 查询可领礼包数量（保留旧接口）
  app.get("/api/dog/gifts", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const data = await provider.getDogGiftStatus(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  // 领取同气礼包
  app.post("/api/dog/gifts/claim", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const data = await provider.claimDogGifts(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      if (respondGameError(res, error, "领取同气礼包失败")) return;
      sendProviderError(res, error);
    }
  });

  // 出战护农
  app.post("/api/dog/deploy", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const dogId = Number(req.body?.dogId) || 0;
    if (dogId <= 0) {
      return res.status(400).json({ ok: false, error: "缺少 dogId" });
    }

    try {
      const data = await provider.deployDog(accountId, dogId);
      res.json({ ok: true, data });
    } catch (error) {
      if (respondGameError(res, error, "出战失败")) return;
      sendProviderError(res, error);
    }
  });

  // 收回宠物
  app.post("/api/dog/withdraw", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const data = await provider.withdrawDog(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      if (respondGameError(res, error, "收回失败")) return;
      sendProviderError(res, error);
    }
  });

  // 投喂狗粮
  app.post("/api/dog/feed", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const foodId = Number(req.body?.foodId) || 0;
    const count = Math.max(1, Number(req.body?.count) || 1);
    if (foodId <= 0) {
      return res.status(400).json({ ok: false, error: "缺少 foodId" });
    }

    try {
      const data = await provider.addDogFood(accountId, foodId, count);
      res.json({ ok: true, data });
    } catch (error) {
      if (respondGameError(res, error, "投喂失败")) return;
      sendProviderError(res, error);
    }
  });

  // 激活宠物
  app.post("/api/dog/activate", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const dogId = Number(req.body?.dogId) || 0;
    if (dogId <= 0) {
      return res.status(400).json({ ok: false, error: "缺少 dogId" });
    }

    try {
      const data = await provider.activateDog(accountId, dogId);
      res.json({ ok: true, data });
    } catch (error) {
      if (respondGameError(res, error, "激活失败")) return;
      sendProviderError(res, error);
    }
  });

  // 看护日志
  app.get("/api/dog/protect-logs", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const from = Number(req.query?.from) || 0;
    const count = Math.max(1, Number(req.query?.count) || 50);
    const filterType = Number(req.query?.filterType) || 0;

    try {
      const data = await provider.getDogProtectLogs(accountId, from, count, filterType);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminDogRoutes };

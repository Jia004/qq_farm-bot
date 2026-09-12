const { getItemById, getSeedImageBySeedId } = require("../config/gameConfig");
const { toNum } = require("../utils/utils");

// 装扮商店的商店 ID（协议里固定为 4）
const DECORATION_SHOP_ID = 4;

function getAuthorizedAccountId({
  req,
  res,
  getAccountIdFromRequest,
  canAccessAccount,
}) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(400).json({ ok: false, error: "Missing\x20x-account-id" });
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }
  return accountId;
}

/**
 * 从游戏服务器原始商品构建装扮条目。
 * 不再依赖硬编码白名单：服务器返回什么就展示什么，游戏上新装扮会自动出现。
 */
function buildDecorationItemFromGoods(goods, userGoldBean) {
  const itemId = toNum(goods && goods.item_id) || 0;
  if (itemId <= 0) return null;

  const itemConfig = getItemById(itemId);
  const price = toNum(goods && goods.price) || 0;
  const limitCount = toNum(goods && goods.limit_count) || 0;
  const boughtNum = toNum(goods && goods.bought_num) || 0;
  const isSoldOut = limitCount > 0 && boughtNum >= limitCount;
  const unlocked = !!goods.unlocked;

  return {
    id: toNum(goods && goods.id) || itemId,   // 商品ID（购买用）
    itemId,
    itemCount: toNum(goods && goods.item_count) || 1,
    price,
    limitCount,
    boughtNum,
    unlocked,
    name: (itemConfig && itemConfig.name) || `装扮${itemId}`,
    image: getSeedImageBySeedId(itemId),
    desc: (itemConfig && itemConfig.desc) || "",
    effectDesc: (itemConfig && itemConfig.effectDesc) || "",
    canBuy: unlocked && !isSoldOut && userGoldBean >= price,
    isSoldOut,
  };
}

// 回退：服务器没返回装扮时，退回旧的静态列表，避免页面空白
const FALLBACK_DECORATION_ITEM_IDS = [2130, 2131];

function buildFallbackDecorationItem(itemId, userGoldBean) {
  const itemConfig = getItemById(itemId);
  if (!itemConfig) return null;
  const price = Number(itemConfig.price) || 0;
  return {
    id: itemId,
    itemId,
    itemCount: 1,
    price,
    name: itemConfig.name || `装扮${itemId}`,
    image: getSeedImageBySeedId(itemId),
    desc: itemConfig.desc || "",
    effectDesc: itemConfig.effectDesc || "",
    canBuy: userGoldBean >= price,
  };
}

function registerAdminDecorationShopRoutes({
  app,
  provider,
  adminLogger,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  app.get("/api/shop/decoration", async (req, res) => {
    const accountId = getAuthorizedAccountId({
      req,
      res,
      getAccountIdFromRequest,
      canAccessAccount,
    });
    if (!accountId) return;

    try {
      const status = provider.getStatus(accountId);
      if (!status || !status.connection || !status.connection.connected) {
        return res.json({
          ok: false,
          error: "获取装扮商城失败:\x20账号未运行",
        });
      }

      const userGoldBean = status?.status?.goldBean || 0;

      let decorations = [];
      try {
        const shopReply = await provider.getShopInfo(accountId, DECORATION_SHOP_ID);
        const goodsList = (shopReply && shopReply.goods_list) || [];
        decorations = goodsList
          .map((g) => buildDecorationItemFromGoods(g, userGoldBean))
          .filter(Boolean);
      } catch (error) {
        adminLogger.warn("装扮商城动态获取失败，回退静态列表", {
          error: error.message,
        });
      }

      // 服务器无数据时回退，保证页面不空白
      if (decorations.length === 0) {
        decorations = FALLBACK_DECORATION_ITEM_IDS.map((itemId) =>
          buildFallbackDecorationItem(itemId, userGoldBean),
        ).filter(Boolean);
      }

      res.json({ ok: true, data: decorations, userGoldBean });
    } catch (error) {
      adminLogger.error("获取装扮商城失败", {
        error: error.message,
        stack: error.stack,
      });
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminDecorationShopRoutes };

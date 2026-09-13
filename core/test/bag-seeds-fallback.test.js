/**
 * 背包种子识别 + 种植失败处理的回归测试
 *
 * 背景（2026-09 线上故障）：
 * 1) 本地 Plant.json 落后于服务器，新种子（狗尾草/小红花/芦苇/泡泡棉花糖）
 *    被 getBagSeeds 直接丢弃 → 用户在「背包种子优先」里看不到新种子。
 * 2) 服务器对不可种种子返回 code=1003005，旧实现把它当作「土地未解锁」
 *    并对 24 块地逐一重试，单小时产生上万条失败日志，且一颗种子失败就
 *    禁用整轮第二优先策略 → 表现为「什么都种不了」。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const gameConfig = require(path.join(__dirname, '..', 'src/config/gameConfig'));

// 与 warehouse.getBagSeeds 保持一致的判定（回归守卫）
function looksLikeSeed(id) {
  const info = gameConfig.getItemById(id);
  const interactionType = String((info && info.interaction_type) || '').toLowerCase();
  const plant = gameConfig.getPlantBySeedId(id);
  return !!plant
    || (typeof gameConfig.isSeedItem === 'function' ? gameConfig.isSeedItem(id) : false)
    || interactionType === 'plant';
}

function resolveSeedName(id) {
  const plant = gameConfig.getPlantBySeedId(id);
  if (plant && plant.name) return String(plant.name);
  const info = gameConfig.getItemById(id);
  if (info && info.name) return String(info.name).replace(/种子$/, '');
  return `种子${id}`;
}

test('新种子不在 Plant.json 时仍被识别为种子（ItemInfo 兜底）', () => {
  const newSeeds = [20516, 20883, 25995, 29004];
  for (const id of newSeeds) {
    assert.strictEqual(
      looksLikeSeed(id), true,
      `种子 ${id} 应通过 ItemInfo 判定为种子（Plant.json 缺失时不得丢弃）`
    );
  }
});

test('新种子名称能正确解析（无「??」或「种子N」残留）', () => {
  assert.strictEqual(resolveSeedName(20516), '狗尾草');
  assert.strictEqual(resolveSeedName(20883), '小红花');
  assert.strictEqual(resolveSeedName(25995), '芦苇');
  assert.strictEqual(resolveSeedName(29004), '泡泡棉花糖');
});

test('非种子物品不会被误判为种子', () => {
  assert.strictEqual(looksLikeSeed(1001), false, '金币不应被识别为种子');
  assert.strictEqual(looksLikeSeed(1011), false, '化肥容器不应被识别为种子');
});

test('老种子（Plant.json 有）判定不受影响', () => {
  for (const id of [20167, 20108, 20022, 20001]) {
    assert.strictEqual(looksLikeSeed(id), true, `老种子 ${id} 应仍被识别`);
  }
});

test('plantSeeds 连续失败会提前止损（源码级守卫）', () => {
  const fs = require('fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src/services/planting-service.js'), 'utf8'
  );
  assert.match(src, /consecutiveLockLikeFailures/, '应有连续失败计数');
  assert.match(src, /seed_rejected_early_stop/, '应有提前止损日志');
  assert.match(src, /maxConsecutiveFailures/, '应有最大连续失败阈值');
});

test('plantFromBagSeeds 单颗种子失败不再禁用整轮（源码级守卫）', () => {
  const fs = require('fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src/services/planting-service.js'), 'utf8'
  );
  assert.match(src, /result: 'seed_rejected'/, '应有跳过单颗种子的日志');
  assert.match(src, /all_bag_seeds_rejected/, '应有全部种子失败时的汇总日志');
  // 旧实现：planted===0 时也会走 fallbackAllowed=false 并中断
  assert.doesNotMatch(
    src,
    /if \(plantResult\.planted < maxCount && remainingIds\.length > 0\) \{\s*fallbackAllowed = false;\s*logWarn\('种植', `背包种子 \$\{seed\.name\} 实际种植 0\//,
    '不应存在「种植 0 颗即禁用回退」的旧逻辑'
  );
});

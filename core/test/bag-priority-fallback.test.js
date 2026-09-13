/**
 * 行为级回归测试：plantFromBagSeeds 的「优先列表全部失败 → 兜底其他背包种子」
 *
 * 线上故障背景（2026-09）：用户保存的优先列表是早期数据，其中的种子因
 * 活动结束/等级变化已不可种，旧实现会让整轮颗粒无收（"什么都种不了"）。
 * 修复后：优先列表内种子全部失败时，自动尝试背包中其他可用种子。
 *
 * 同时守卫：
 * - 优先列表中有能种的种子时，不会去动其他背包种子（保持优先语义）
 * - 兜底不会回退到商店购买（防误购语义不变）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const root = path.join(__dirname, '..');
process.chdir(root);

// 优先列表内不可种种子（20167）与背包中可种种子（20022）
const PRIORITY_SEED = 20167;
const OTHER_BAG_SEED = 20022;

function setupEnv() {
  const proto = require(path.join(root, 'src/utils/proto'));
  const network = require(path.join(root, 'src/utils/network'));
  const utils = require(path.join(root, 'src/utils/utils'));
  const warehouse = require(path.join(root, 'src/services/warehouse'));
  const store = require(path.join(root, 'src/models/store'));
  return { proto, network, utils, warehouse, store };
}

test('plantFromBagSeeds: 优先列表全部失败时兜底尝试其他背包种子', async () => {
  const { proto, network, utils, warehouse, store } = setupEnv();
  await proto.loadProto();

  // 背包：两颗 1x1 种子
  const originalGetBagSeeds = warehouse.getBagSeeds;
  warehouse.getBagSeeds = async () => [
    { seedId: PRIORITY_SEED, name: '欢乐糖果', count: 10, requiredLevel: 21, plantSize: 1 },
    { seedId: OTHER_BAG_SEED, name: '鳄梨', count: 10, requiredLevel: 138, plantSize: 1 },
  ];
  const originalGetPriority = store.getBagSeedPriority;
  store.getBagSeedPriority = () => [PRIORITY_SEED];
  const originalGetFallback = store.getBagSeedFallbackStrategy;
  store.getBagSeedFallbackStrategy = () => 'level';

  // 网络：PRIORITY_SEED 一律失败，OTHER_BAG_SEED 前 2 块成功
  const originalSend = network.sendMsgAsync;
  const plantedSeeds = [];
  network.sendMsgAsync = async (service, method, body) => {
    if (method !== 'Plant')
      return originalSend(service, method, body);
    const decoded = proto.types.PlantRequest.decode(body);
    const seedId = Number(decoded.items[0].seed_id);
    plantedSeeds.push(seedId);
    if (seedId === PRIORITY_SEED) {
      const err = new Error('gamepb.plantpb.PlantService.Plant 错误: code=1003005 格子已锁定');
      err.code = 1003005;
      throw err;
    }
    const PlantReply = proto.types.PlantReply;
    return {
      body: PlantReply.encode(PlantReply.create({
        land: [{ id: Number(decoded.items[0].land_ids[0]), plant: { seed_id: seedId } }],
      })).finish(),
    };
  };

  const warnLogs = [];
  const originalWarn = utils.logWarn;
  const originalSleep = utils.sleep;
  utils.logWarn = (tag, msg, meta) => { warnLogs.push({ msg: String(msg), meta }); };
  utils.sleep = async () => {};

  try {
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
    const planting = require(path.join(root, 'src/services/planting-service'));

    const landIds = Array.from({ length: 6 }, (_, i) => i + 1);
    const result = await planting.plantFromBagSeeds(landIds, '1');

    // 优先种子失败后（4 次止损），应接着尝试 OTHER_BAG_SEED 并种上
    assert.ok(plantedSeeds.includes(OTHER_BAG_SEED),
      '兜底应尝试背包中其他可用种子');
    assert.ok(result.totalPlanted > 0,
      `兜底后应有种植成功（实际 ${result.totalPlanted}）`);
    assert.ok(
      warnLogs.some(w => String(w.meta && w.meta.result) === 'priority_fallback_to_other_bag_seeds'),
      '应有 priority_fallback_to_other_bag_seeds 标记',
    );
  } finally {
    warehouse.getBagSeeds = originalGetBagSeeds;
    store.getBagSeedPriority = originalGetPriority;
    store.getBagSeedFallbackStrategy = originalGetFallback;
    network.sendMsgAsync = originalSend;
    utils.logWarn = originalWarn;
    utils.sleep = originalSleep;
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
  }
});

test('plantFromBagSeeds: 优先列表内种子能种时不触碰其他背包种子', async () => {
  const { proto, network, utils, warehouse, store } = setupEnv();
  await proto.loadProto();

  const originalGetBagSeeds = warehouse.getBagSeeds;
  warehouse.getBagSeeds = async () => [
    { seedId: PRIORITY_SEED, name: '欢乐糖果', count: 10, requiredLevel: 21, plantSize: 1 },
    { seedId: OTHER_BAG_SEED, name: '鳄梨', count: 10, requiredLevel: 138, plantSize: 1 },
  ];
  const originalGetPriority = store.getBagSeedPriority;
  store.getBagSeedPriority = () => [PRIORITY_SEED];
  const originalGetFallback = store.getBagSeedFallbackStrategy;
  store.getBagSeedFallbackStrategy = () => 'level';

  const originalSend = network.sendMsgAsync;
  const plantedSeeds = [];
  network.sendMsgAsync = async (service, method, body) => {
    if (method !== 'Plant')
      return originalSend(service, method, body);
    const decoded = proto.types.PlantRequest.decode(body);
    const seedId = Number(decoded.items[0].seed_id);
    plantedSeeds.push(seedId);
    const PlantReply = proto.types.PlantReply;
    return {
      body: PlantReply.encode(PlantReply.create({
        land: [{ id: Number(decoded.items[0].land_ids[0]), plant: { seed_id: seedId } }],
      })).finish(),
    };
  };

  const originalWarn = utils.logWarn;
  const originalSleep = utils.sleep;
  utils.logWarn = () => {};
  utils.sleep = async () => {};

  try {
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
    const planting = require(path.join(root, 'src/services/planting-service'));

    const landIds = [1, 2];
    const result = await planting.plantFromBagSeeds(landIds, '1');

    assert.ok(plantedSeeds.every(id => id === PRIORITY_SEED),
      `只应种植优先列表内种子（实际种子序列 ${plantedSeeds.join(',')}）`);
    assert.strictEqual(result.totalPlanted, 2, '两块地都应种上优先种子');
  } finally {
    warehouse.getBagSeeds = originalGetBagSeeds;
    store.getBagSeedPriority = originalGetPriority;
    store.getBagSeedFallbackStrategy = originalGetFallback;
    network.sendMsgAsync = originalSend;
    utils.logWarn = originalWarn;
    utils.sleep = originalSleep;
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
  }
});

test('plantFromBagSeeds 不再因单颗种子失败禁用整轮（源码级守卫）', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(root, 'src/services/planting-service.js'), 'utf8');
  assert.match(src, /plantSeedBatch/, '应有共享的批次种植逻辑');
  assert.match(src, /priority_fallback_to_other_bag_seeds/, '应有优先列表兜底日志');
  assert.match(src, /result: 'seed_rejected'/, '单颗失败应跳过而非中断');
  assert.match(src, /all_bag_seeds_rejected/, '全部失败时应汇总');
});

/**
 * 行为级回归测试：plantSeeds 遇到「种子整体不可种」时提前止损
 *
 * 线上故障背景：服务器对不可种种子返回 code=1003005（"格子已锁定"），
 * 旧实现把每一块地都试一遍（24 次），单小时产生 1.2 万条失败日志，
 * 并让整轮种植卡死。修复后连续 4 次同类失败即中止该种子。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const root = path.join(__dirname, '..');
process.chdir(root);

test('plantSeeds: 连续失败时提前止损，不遍历全部地块', async () => {
  // 初始化 proto（plantSeeds 内部会 encode）
  const proto = require(path.join(root, 'src/utils/proto'));
  await proto.loadProto();
  assert.ok(proto.types.PlantRequest, 'proto 应已加载');

  // patch 网络层：Plant 一律返回 1003005
  const network = require(path.join(root, 'src/utils/network'));
  let plantCallCount = 0;
  const originalSend = network.sendMsgAsync;
  network.sendMsgAsync = async (service, method, body, timeout, opts) => {
    if (method === 'Plant') {
      plantCallCount += 1;
      const err = new Error('gamepb.plantpb.PlantService.Plant 错误: code=1003005 格子已锁定');
      err.code = 1003005;
      throw err;
    }
    return originalSend(service, method, body, timeout, opts);
  };

  // 捕获日志（避免测试输出被刷屏）
  const utils = require(path.join(root, 'src/utils/utils'));
  const warnLogs = [];
  const originalWarn = utils.logWarn;
  const originalSleep = utils.sleep;
  utils.logWarn = (tag, msg, meta) => { warnLogs.push({ msg: String(msg), meta }); };
  utils.sleep = async () => {};

  try {
    // 清掉 require 缓存，确保解构到 patch 后的函数
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
    const planting = require(path.join(root, 'src/services/planting-service'));

    const landIds = Array.from({ length: 24 }, (_, i) => i + 1);
    const result = await planting.plantSeeds(20167, landIds, { maxPlantCount: 24 });

    assert.strictEqual(plantCallCount, 4,
      `应在 4 次连续失败后止损（实际 ${plantCallCount} 次，旧实现为 24 次）`);
    assert.strictEqual(result.planted, 0, '不应有种植成功');
    assert.strictEqual(result.lockedCount, 4, '应记录 4 次锁定类失败');
    assert.ok(warnLogs.length <= 2,
      `日志不应刷屏（实际 ${warnLogs.length} 条，旧实现每块地一条）`);
    assert.ok(
      warnLogs.some(w => String(w.meta && w.meta.result) === 'seed_rejected_early_stop'),
      '应有 seed_rejected_early_stop 标记'
    );
  } finally {
    network.sendMsgAsync = originalSend;
    utils.logWarn = originalWarn;
    utils.sleep = originalSleep;
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
  }
});

test('plantSeeds: 部分地块成功时继续正常流程', async () => {
  const proto = require(path.join(root, 'src/utils/proto'));
  await proto.loadProto();

  const network = require(path.join(root, 'src/utils/network'));
  const originalSend = network.sendMsgAsync;
  let calls = 0;
  network.sendMsgAsync = async (service, method, body, timeout, opts) => {
    if (method === 'Plant') {
      calls += 1;
      // 前 2 块成功，其余失败
      if (calls <= 2) {
        const PlantReply = proto.types.PlantReply;
        return {
          body: PlantReply.encode(PlantReply.create({
            land: [{ id: calls, plant: { seed_id: 20167 } }],
          })).finish(),
        };
      }
      const err = new Error('gamepb.plantpb.PlantService.Plant 错误: code=1003005 格子已锁定');
      err.code = 1003005;
      throw err;
    }
    return originalSend(service, method, body, timeout, opts);
  };

  const utils = require(path.join(root, 'src/utils/utils'));
  const originalWarn = utils.logWarn;
  const originalSleep = utils.sleep;
  utils.logWarn = () => {};
  utils.sleep = async () => {};

  try {
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
    const planting = require(path.join(root, 'src/services/planting-service'));

    const landIds = Array.from({ length: 24 }, (_, i) => i + 1);
    const result = await planting.plantSeeds(20167, landIds, { maxPlantCount: 24 });

    assert.strictEqual(result.planted, 2, '前 2 块地应种植成功');
    assert.ok(result.plantedLandIds.length >= 2, '应记录已种植地块');
  } finally {
    network.sendMsgAsync = originalSend;
    utils.logWarn = originalWarn;
    utils.sleep = originalSleep;
    delete require.cache[require.resolve(path.join(root, 'src/services/planting-service'))];
  }
});

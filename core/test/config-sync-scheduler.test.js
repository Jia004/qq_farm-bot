/**
 * 单元测试：config-sync-scheduler（官方配置自动同步调度器）
 *
 * 覆盖：
 * - start/stop 生命周期（幂等、定时器清理）
 * - runOnce 并发保护（busy 跳过）
 * - runOnce 结果分类日志（upToDate / 同步成功 / 无缓存 / 异常）
 *
 * 测试通过 mock scripts/sync-game-config.js 的 autoSync 注入各类结果，
 * 不实际联网。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SCHED_PATH = path.join(__dirname, '..', 'src', 'services', 'config-sync-scheduler.js');
const TOOL_PATH = path.join(__dirname, '..', '..', 'scripts', 'sync-game-config.js');

/** 临时替换 require 缓存中的 sync 工具，跑完恢复 */
function withMockedTool(mock, fn) {
  const original = require.cache[require.resolve(TOOL_PATH)];
  require.cache[require.resolve(TOOL_PATH)] = {
    id: TOOL_PATH,
    filename: TOOL_PATH,
    loaded: true,
    exports: mock,
  };
  // 重新加载调度器以使用新缓存
  delete require.cache[require.resolve(SCHED_PATH)];
  try {
    return fn(require(SCHED_PATH));
  } finally {
    if (original) require.cache[require.resolve(TOOL_PATH)] = original;
    else delete require.cache[require.resolve(TOOL_PATH)];
    delete require.cache[require.resolve(SCHED_PATH)];
  }
}

test('runOnce: upToDate 结果（版本未变）', async () => {
  const calls = [];
  await withMockedTool({
    autoSync: async () => { calls.push('autoSync'); return { ok: true, upToDate: true, bundleVers: { mainscene: 'x' } }; },
  }, async (sched) => {
    const r = await sched.runOnce();
    assert.strictEqual(r.upToDate, true);
    assert.strictEqual(calls.length, 1);
    assert.ok(r.at, '结果应带时间戳');
  });
});

test('runOnce: 检测到更新并同步成功', async () => {
  await withMockedTool({
    autoSync: async () => ({
      ok: true,
      upToDate: false,
      rcSync: 0,
      rcIcons: 0,
      bundleVers: { mainscene: 'new123' },
    }),
  }, async (sched) => {
    const r = await sched.runOnce();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.upToDate, false);
    assert.strictEqual(r.bundleVers.mainscene, 'new123');
  });
});

test('runOnce: 无游戏缓存时静默跳过（ok=false, reason=no-game-cache）', async () => {
  await withMockedTool({
    autoSync: async () => ({ ok: false, reason: 'no-game-cache' }),
  }, async (sched) => {
    const r = await sched.runOnce();
    assert.strictEqual(r.reason, 'no-game-cache');
  });
});

test('runOnce: autoSync 抛异常时被捕获，返回 ok=false', async () => {
  await withMockedTool({
    autoSync: async () => { throw new Error('网络不可达'); },
  }, async (sched) => {
    const r = await sched.runOnce();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /网络不可达/);
  });
});

test('runOnce: 并发保护（上一轮未结束则跳过）', async () => {
  let resolvers = [];
  let started = 0;
  await withMockedTool({
    autoSync: () => {
      started++;
      return new Promise((resolve) => { resolvers.push(resolve); });
    },
  }, async (sched) => {
    const p1 = sched.runOnce();       // 第一轮：挂起
    const p2 = await sched.runOnce(); // 第二轮：应被跳过
    assert.strictEqual(p2.skipped, 'busy', '并发时应返回 busy');
    assert.strictEqual(started, 1, 'autoSync 只应被调用一次');
    resolvers[0]({ ok: true, upToDate: true });
    await p1;
  });
});

test('start/stop: 生命周期幂等，stop 后清理定时器', async () => {
  await withMockedTool({
    autoSync: async () => ({ ok: true, upToDate: true }),
  }, async (sched) => {
    // 用大延迟避免测试期间真的触发
    sched.start({ startupDelayMs: 60 * 60 * 1000, intervalMs: 60 * 60 * 1000 });
    sched.start({ startupDelayMs: 60 * 60 * 1000, intervalMs: 60 * 60 * 1000 }); // 幂等
    sched.stop();
    sched.stop(); // 幂等
    assert.ok(true, '重复 start/stop 不应抛异常');
  });
});

test('getLastResult: 初次为空，runOnce 后有值', async () => {
  await withMockedTool({
    autoSync: async () => ({ ok: true, upToDate: true, bundleVers: { plant: 'p1' } }),
  }, async (sched) => {
    assert.strictEqual(sched.getLastResult(), null);
    await sched.runOnce();
    const last = sched.getLastResult();
    assert.ok(last);
    assert.strictEqual(last.bundleVers.plant, 'p1');
  });
});

/**
 * 宠物「我的宠物」判据回归测试
 *
 * 线上 bug（2026-09-14 用户报告）：无法选择仓库已有的宠物出战。
 *
 * 根因：游戏服务端的字段语义与命名直觉相反 ——
 *   owned=true,  activated=false → 仓库中已有，待激活
 *   owned=false, activated=true  → 已激活可用（激活成功后服务端把 owned 重置为 false！）
 *   owned=false, activated=false → 尚未拥有
 * 前端此前用 `filter(d => d.owned)` 筛「我的宠物」，导致激活后 owned 变 false
 * 的宠物全部从列表消失，用户无法选择它们出战。
 *
 * 修复：后端输出 hasDog = owned || activated，前端以 hasDog 为准。
 * 本测试锁死该语义，防止回归。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeDogData } = require('../src/services/dog-gifts');

function buildRaw(dogs, extra = {}) {
  return {
    dog_list: dogs,
    current_deployed_dog_id: 0,
    food_last_sec: 0,
    max_food_last_sec: 0,
    food_list: [],
    pending_gift_count: 0,
    ...extra,
  };
}

test('owned=true/activated=false（仓库待激活）→ hasDog=true, status=idle', () => {
  const out = normalizeDogData(buildRaw([
    { id: 90002, owned: true, activated: false },
  ]));
  const dog = out.dogs[0];
  assert.equal(dog.owned, true);
  assert.equal(dog.activated, false);
  assert.equal(dog.hasDog, true, '仓库已有的宠物必须出现在「我的宠物」');
  assert.equal(dog.status, 'idle', '待激活状态');
});

test('owned=false/activated=true（激活后被服务端重置）→ hasDog=true, status=active', () => {
  const out = normalizeDogData(buildRaw([
    { id: 90002, owned: false, activated: true },
  ]));
  const dog = out.dogs[0];
  assert.equal(dog.owned, false);
  assert.equal(dog.activated, true);
  assert.equal(dog.hasDog, true, '已激活宠物（owned 被重置为 false）不得从列表消失');
  assert.equal(dog.status, 'active', '已激活可出战');
});

test('owned=false/activated=false（未拥有）→ hasDog=false, status=locked', () => {
  const out = normalizeDogData(buildRaw([
    { id: 90001, owned: false, activated: false },
  ]));
  const dog = out.dogs[0];
  assert.equal(dog.hasDog, false);
  assert.equal(dog.status, 'locked');
});

test('出战中的宠物 status=deployed（无论 owned 字段如何）', () => {
  const out = normalizeDogData(buildRaw([
    { id: 90002, owned: false, activated: true },
  ], { current_deployed_dog_id: 90002 }));
  const dog = out.dogs[0];
  assert.equal(dog.deployed, true);
  assert.equal(dog.status, 'deployed');
  assert.equal(dog.hasDog, true, '出战中的宠物必须仍在「我的宠物」中');
});

test('真实场景组合：仓库待激活 + 已激活 + 未拥有 混合', () => {
  const out = normalizeDogData(buildRaw([
    { id: 90001, name: '田园犬', owned: false, activated: false },  // 未拥有
    { id: 90002, name: '牧羊犬', owned: true, activated: false },   // 仓库待激活
    { id: 90003, name: '斑点狗', owned: false, activated: true },   // 已激活
    { id: 90011, name: '柯基', owned: false, activated: true },     // 已激活
  ], { current_deployed_dog_id: 90011 }));

  // 模拟前端筛选
  const myDogs = out.dogs.filter((d) => d.hasDog);
  const lockedDogs = out.dogs.filter((d) => !d.hasDog);

  assert.equal(myDogs.length, 3, '我的宠物 = 仓库待激活(1) + 已激活(2)');
  assert.deepEqual(
    myDogs.map((d) => d.name).sort((a, b) => a.localeCompare(b, 'zh')),
    ['牧羊犬', '斑点狗', '柯基'].sort((a, b) => a.localeCompare(b, 'zh')),
  );
  assert.equal(lockedDogs.length, 1);
  assert.equal(lockedDogs[0].name, '田园犬');

  // 关键：所有 hasDog 的宠物都必须是可出战或可激活的
  for (const d of myDogs) {
    assert.ok(d.activated || d.owned, `${d.name} 应可激活或已激活`);
  }
});

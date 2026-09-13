/**
 * 作物收益分析回归测试（多季作物口径修正）
 *
 * 背景（2026-09-14）：旧实现对多季作物用了两个无依据的假设：
 *   1. 生长时间 ×1.5
 *   2. 收入/经验固定 ×2
 * 与官方客户端 ItemTipsBottom 口径不符（官方：时间=单季阶段之和，
 * 收入=fruit.count×单价（每季），经验=plant.exp（每季），总产出=单季×seasons）。
 *
 * 本测试锁死修正后的口径，防止回归。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { getPlantRankings } = require('../src/services/analytics');
const { getAllPlants, getFruitPrice, getSeedPrice } = require('../src/config/gameConfig');

function findPlant(name) {
  const hit = getAllPlants().find((p) => p.name === name);
  assert.ok(hit, `配置中应存在作物「${name}」`);
  return hit;
}

function sumPhases(growPhases) {
  return growPhases
    .split(';')
    .filter(Boolean)
    .reduce((sum, part) => {
      const m = part.match(/:(\d+)$/);
      return sum + (m ? Number(m[1]) : 0);
    }, 0);
}

test('单季作物：时间=阶段之和，效率以单季为基准', () => {
  const plant = findPlant('草莓');
  const row = getPlantRankings('exp').find((r) => r.name === '草莓');
  assert.ok(row, '草莓应出现在经验排行中');

  const expectSec = sumPhases(plant.grow_phases); // 28800
  assert.equal(row.growTime, expectSec, 'growTime 应等于 grow_phases 之和');
  assert.equal(row.seasons, 1);
  assert.equal(row.expPerSeason, plant.exp, '单季经验 = plant.exp');
  assert.equal(row.totalExp, plant.exp, '单季作物总经验 = 单季经验');
});

test('多季作物（鳄梨 seasons=2）：总时间为单季×季数，总经验按实际季数', () => {
  const plant = findPlant('鳄梨');
  assert.ok(Number(plant.seasons) > 1, '鳄梨应为多季作物');

  const row = getPlantRankings('exp').find((r) => r.name === '鳄梨');
  assert.ok(row);

  const seasonSec = sumPhases(plant.grow_phases);
  assert.equal(row.growTime, seasonSec, 'growTime 应为单季时间（不做 ×1.5 放大）');
  assert.equal(row.seasons, Number(plant.seasons));

  const seasons = Number(plant.seasons);
  assert.equal(row.expPerSeason, plant.exp, '单季经验 = plant.exp（不做 ×2 假设）');
  assert.equal(row.totalExp, plant.exp * seasons, '总经验 = 单季 × 实际季数');
  assert.equal(row.totalCycleTime, seasonSec * seasons, '全周期时间 = 单季 × 季数');
  assert.equal(row.totalCycleTimeStr, '24时', '鳄梨全周期应为 24 小时（12h×2）');
});

test('多季作物效率以单季时间为分母（每季都要等一个生长周期）', () => {
  const plant = findPlant('鳄梨');
  const row = getPlantRankings('exp').find((r) => r.name === '鳄梨');

  const seasonSec = sumPhases(plant.grow_phases);
  const expectExpPerHour = (plant.exp / seasonSec) * 3600;
  assert.ok(
    Math.abs(row.expPerHour - expectExpPerHour) < 0.5,
    `expPerHour 应为 单季经验/单季时间 ×3600（期望≈${expectExpPerHour.toFixed(2)}，实际 ${row.expPerHour}）`,
  );
});

test('多季作物种子成本按季数摊分（避免把整颗种子算到单季）', () => {
  const plant = findPlant('鳄梨');
  const row = getPlantRankings('profit').find((r) => r.name === '鳄梨');
  assert.ok(row, '鳄梨应出现在利润排行（有价格）');

  const seedPrice = getSeedPrice(Number(plant.seed_id));
  const seasons = Number(plant.seasons);
  const fruitPrice = getFruitPrice(Number(plant.fruit.id));
  const incomePerSeason = Number(plant.fruit.count) * fruitPrice;

  assert.equal(row.incomePerSeason, incomePerSeason, '单季收入 = 果实数×单价');
  assert.equal(row.income, incomePerSeason * seasons, '总收入 = 单季 × 季数');
  assert.equal(row.netProfit, incomePerSeason * seasons - seedPrice, '净利润 = 总收入 - 种子价');

  const expectPerSeason = incomePerSeason - seedPrice / seasons;
  assert.ok(
    Math.abs(row.netProfitPerSeason - expectPerSeason) < 0.5,
    '单季摊分利润应扣除 种子价/季数',
  );
});

test('金币/利润排行过滤无价格作物（消除负利润假象）', () => {
  for (const sortBy of ['gold', 'profit', 'fert_profit']) {
    const rows = getPlantRankings(sortBy);
    const noPrice = rows.filter((r) => !r.hasPriceData);
    assert.equal(noPrice.length, 0, `${sortBy} 排行不应含无价格作物`);
  }

  const expRows = getPlantRankings('exp');
  assert.ok(expRows.length >= getPlantRankings('profit').length, '经验排行保留全部作物');
});

test('效率排行按小时收益降序', () => {
  for (const sortBy of ['exp', 'gold', 'profit']) {
    const rows = getPlantRankings(sortBy);
    const key = { exp: 'expPerHour', gold: 'goldPerHour', profit: 'profitPerHour' }[sortBy];
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1][key] >= rows[i][key], `${sortBy} 排行第 ${i} 项应不小于第 ${i + 1} 项`);
    }
  }
});

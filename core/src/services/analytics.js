/**
 * 种植分析服务 - 植物排名计算
 *
 * 【2026-09-14 修正多季作物逻辑】
 * 官方客户端（ItemTipsBottom）口径：
 *   - 单季时间 = grow_phases 各阶段之和（成熟:0 不计）
 *   - 单季收入 = fruit.count × 果实单价
 *   - 单季经验 = plant.exp
 *   - 多季作物总产出 = 单季 × seasons（seasons 从配置读取）
 * 之前实现的问题：
 *   1. 把多季作物的时间按 ×1.5 放大（无依据，官方时间就是单季总和）
 *   2. 收入/经验固定按 ×2 处理（应使用实际 seasons，且以单季时长为分母）
 *   3. 化肥减时对多季作物也做了 ×1.5（应直接按剩余时间扣减）
 * 修正后：所有指标按「单季时间」为基准计算效率（元/小时、经验/小时），
 *         并额外输出「全周期总收益」（含全部季数）供参考。
 *
 * 功能：
 * - 解析生长时间、化肥减少时间
 * - 按经验/化肥经验/金币/利润/等级对各植物进行排名
 */
const { getAllPlants, getFruitPrice, getSeedPrice, getItemImageById, getSeedLevel } = require('../config/gameConfig');

const SECONDS_PER_HOUR = 3600;

/**
 * 解析生长阶段字符串中的总时间（秒）
 * 格式如 "phase1:300;phase2:600;..."
 */
function parseGrowTime(growPhases) {
  if (!growPhases) return -1;
  const phases = growPhases.split(';').filter((p) => p.length > 0);
  let totalSec = 0;
  for (const phase of phases) {
    const match = phase.match(/:(\d+)$/);
    if (match) totalSec += Number.parseInt(match[1], 10);
  }
  return totalSec;
}

/**
 * 解析普通化肥减少时间（第一个阶段的时长即为化肥减少量）
 */
function parseNormalFertilizerReduceSec(growPhases) {
  if (!growPhases) return 0;
  const phases = String(growPhases).split(';').filter((p) => p.length > 0);
  if (!phases.length) return 0;
  const first = phases[0];
  const match = first.match(/:(\d+)$/);
  return match ? Number.parseInt(match[1], 10) || 0 : 0;
}

/**
 * 格式化秒数为人类可读时间
 */
function formatTime(secs) {
  if (secs < 60) return `${secs}秒`;
  if (secs < 3600) return `${Math.floor(secs / 60)}分${secs % 60}秒`;
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  return mins > 0 ? `${hours}时${mins}分` : `${hours}时`;
}

/**
 * 获取植物排名列表
 * @param {'exp'|'fert'|'gold'|'profit'|'fert_profit'|'level'} sortBy - 排序方式
 */
function getPlantRankings(sortBy = 'exp') {
  const allPlants = getAllPlants();
  const eligiblePlants = allPlants.filter(
    (p) => p.seed_id > 0 && p.grow_phases
  );

  const rankings = [];

  for (const plant of eligiblePlants) {
    // 单季生长时间（官方口径：grow_phases 总和）
    const growTime = parseGrowTime(plant.grow_phases);
    if (growTime <= 0) continue;

    const seasons = Math.max(1, Number(plant.seasons) || 1);

    // 单季经验（官方口径：plant.exp 为「经验/季」）
    const expPerSeason = Number.parseInt(plant.exp, 10) || 0;
    // 全周期经验 = 单季 × 季数
    const totalExp = expPerSeason * seasons;

    // 单季经验/小时（以单季时间为分母）
    const expPerHour = expPerSeason / growTime * SECONDS_PER_HOUR;

    // 化肥：减少第一个阶段的时长（普通化肥）
    const reduceSec = parseNormalFertilizerReduceSec(plant.grow_phases);
    const fertGrowTime = growTime - reduceSec;
    const fertEffectiveTime = fertGrowTime > 0 ? fertGrowTime : growTime;

    // 化肥后单季经验/小时
    const normalFertilizerExpPerHour = expPerSeason / fertEffectiveTime * SECONDS_PER_HOUR;

    // 金币计算
    const fruitId = Number(plant.fruit && plant.fruit.id) || 0;
    const fruitCountPerSeason = Number(plant.fruit && plant.fruit.count) || 0;
    const fruitPrice = getFruitPrice(fruitId);
    const seedPrice = getSeedPrice(Number(plant.seed_id) || 0);

    // 单季收入与全周期收入
    const incomePerSeason = fruitCountPerSeason * fruitPrice;
    const income = incomePerSeason * seasons;
    const netProfit = income - seedPrice;
    const netProfitPerSeason = incomePerSeason - (seedPrice / seasons);

    // 每小时效率（以单季时间为分母 —— 多季作物每季都要等一个生长周期）
    const goldPerHour = incomePerSeason / growTime * SECONDS_PER_HOUR;
    const profitPerHour = netProfitPerSeason / growTime * SECONDS_PER_HOUR;
    const fertProfitPerHour = netProfitPerSeason / fertEffectiveTime * SECONDS_PER_HOUR;

    const level = getSeedLevel(Number(plant.seed_id) || 0);
    const levelOrNull = Number.isFinite(level) && level > 0 ? level : null;

    rankings.push({
      id: plant.id,
      seedId: plant.seed_id,
      name: plant.name,
      seasons,
      level: levelOrNull,
      // 单季时间（原名保留供前端展示）
      growTime,
      growTimeStr: formatTime(growTime),
      // 全周期总时间（含所有季）供参考
      totalCycleTime: growTime * seasons,
      totalCycleTimeStr: formatTime(growTime * seasons),
      reduceSec,
      reduceSecApplied: reduceSec,
      expPerHour: Number.parseFloat(expPerHour.toFixed(2)),
      normalFertilizerExpPerHour: Number.parseFloat(normalFertilizerExpPerHour.toFixed(2)),
      goldPerHour: Number.parseFloat(goldPerHour.toFixed(2)),
      profitPerHour: Number.parseFloat(profitPerHour.toFixed(2)),
      normalFertilizerProfitPerHour: Number.parseFloat(fertProfitPerHour.toFixed(2)),
      // 单季与全周期收益
      incomePerSeason,
      income,
      netProfit,
      netProfitPerSeason: Number.parseFloat(netProfitPerSeason.toFixed(2)),
      expPerSeason,
      totalExp,
      fruitId,
      fruitCount: fruitCountPerSeason,
      fruitPrice,
      seedPrice,
      hasPriceData: fruitPrice > 0,
      image: getItemImageById(plant.seed_id),
    });
  }

  // 排序
  if (sortBy === 'exp') {
    rankings.sort((a, b) => b.expPerHour - a.expPerHour);
  } else if (sortBy === 'fert') {
    rankings.sort((a, b) => b.normalFertilizerExpPerHour - a.normalFertilizerExpPerHour);
  } else if (sortBy === 'gold') {
    // 金币/利润排行需要价格数据，过滤无价格的作物（避免负利润假象）
    const withPrice = rankings.filter((r) => r.hasPriceData);
    withPrice.sort((a, b) => b.goldPerHour - a.goldPerHour);
    return withPrice;
  } else if (sortBy === 'profit') {
    const withPrice = rankings.filter((r) => r.hasPriceData);
    withPrice.sort((a, b) => b.profitPerHour - a.profitPerHour);
    return withPrice;
  } else if (sortBy === 'fert_profit') {
    const withPrice = rankings.filter((r) => r.hasPriceData);
    withPrice.sort((a, b) => b.normalFertilizerProfitPerHour - a.normalFertilizerProfitPerHour);
    return withPrice;
  } else if (sortBy === 'level') {
    const levelVal = (v) => (v === null || v === undefined ? -Infinity : Number(v));
    rankings.sort((a, b) => levelVal(b.level) - levelVal(a.level));
  }

  return rankings;
}

module.exports = {
  getPlantRankings,
};

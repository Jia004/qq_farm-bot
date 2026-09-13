const { sendMsgAsync, getUserState, getWsErrorState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, toLong, toTimeSec, getServerTimeSec, log, logWarn, sleep } = require('../utils/utils');
const { getPlantNameBySeedId, getPlantGrowTime, formatGrowTime, getAllSeeds, getPlantBySeedId, getPlantById } = require('../config/gameConfig');
const {
  getPlantingStrategy,
  getPreferredSeed,
  getBagSeedPriority,
  getBagSeedFallbackStrategy,
  getBagPriorityLandTypes,
  getPrioritize2x2Crops,
} = require('../models/store');
const { getPlantRankings } = require('./analytics');
const { getBagSeeds } = require('./warehouse');
const { getShopInfo, buyGoods, getSeedShopId } = require('./farm-api');
const { buildLandMap, getDisplayLandContext, getLandTypeByLevel } = require('./farm-land-analyzer');
const { runFertilizerByConfig } = require('./farm-fertilizer');
const { removePlant } = require('./farm-api');

const FARM_COLUMNS = 4;
const FARM_ROWS = 6;

// 土地品质类型 → 中文名（用于日志展示）
const LAND_TYPE_NAME_MAP = {
  purple: '紫土地',
  gold: '金土地',
  black: '黑土地',
  red: '红土地',
  normal: '普通地'
};
let reserved2x2GroupKeys = [];
let last2x2WaitingSignature = '';
const failed2x2Retries = new Map();
const TWO_BY_TWO_RETRY_DELAY_MS = 30_000;

// ─── 种植策略标签 ───

const PLANTING_STRATEGY_LABELS = {
  preferred: '优先种植种子',
  level: '最高等级作物',
  max_exp: '最大经验/时',
  max_fert_exp: '最大普通肥经验/时',
  max_profit: '最大净利润/时',
  max_fert_profit: '最大普通肥净利润/时',
  bag_priority: '背包种子优先'
};

function getPlantingStrategyLabel(strategy) {
  return PLANTING_STRATEGY_LABELS[strategy] || strategy;
}

function getCurrentAccountId() {
  const userState = getUserState();
  return String((userState && userState.accountId) || process.env.FARM_ACCOUNT_ID || '').trim();
}

// ─── 编码/解码 ───

/** 编码种植请求 */
function encodePlantRequest(seedId, landIds) {
  return types.PlantRequest.encode(types.PlantRequest.create({
    items: [{
      seed_id: toLong(seedId),
      land_ids: (landIds || []).map(id => toLong(id)),
    }],
  })).finish();
}

/** 根据种子 ID 获取植物占地大小（用于合并种植） */
function getPlantSizeBySeedId(seedId) {
  const plant = getPlantBySeedId(toNum(seedId));
  return Math.max(1, toNum(plant && plant.size) || 1);
}

function isSeedLockedByLevel(seed, userLevel) {
  const requiredLevel = Number(seed && seed.requiredLevel);
  return Number.isFinite(requiredLevel) && requiredLevel > Number(userLevel || 0);
}

function isLockedPlantError(error) {
  const message = String(error && error.message || error || '').toLowerCase();
  return /锁定|未解锁|等级不足|level|lock|unlock/.test(message);
}

function groupKey(landIds) {
  return [...landIds].map(Number).sort((a, b) => a - b).join('-');
}

/** 构建所有合法 2x2 组合；协议锚点为左下角。 */
function build2x2LandGroups(lands) {
  const unlockedIds = new Set(
    (Array.isArray(lands) ? lands : [])
      .filter(land => land?.unlocked)
      .map(land => toNum(land.id))
      .filter(Boolean)
  );
  const groups = [];

  for (let bottomRow = 1; bottomRow < FARM_ROWS; bottomRow++) {
    for (let column = 0; column < FARM_COLUMNS - 1; column++) {
      const masterLandId = bottomRow * FARM_COLUMNS + column + 1;
      const landIds = [
        masterLandId,
        masterLandId + 1,
        masterLandId - FARM_COLUMNS,
        masterLandId - FARM_COLUMNS + 1,
      ];
      if (!landIds.every(id => unlockedIds.has(id))) continue;
      groups.push({
        key: groupKey(landIds),
        masterLandId,
        landIds,
      });
    }
  }
  return groups;
}

function getActive2x2Footprints(lands) {
  return (Array.isArray(lands) ? lands : [])
    .map((land) => {
      const masterLandId = toNum(land?.id);
      const slaves = Array.isArray(land?.slave_land_ids)
        ? land.slave_land_ids.map(toNum).filter(Boolean)
        : [];
      const landIds = [masterLandId, ...slaves].filter(Boolean);
      return slaves.length === 3
        ? { key: groupKey(landIds), landIds: new Set(landIds) }
        : null;
    })
    .filter(Boolean);
}

function overlapsLandIds(left, right) {
  return left.some(id => right.has(id));
}

function selectMaximumNonOverlappingGroups(groups, limit) {
  const candidates = [...groups].sort((a, b) => a.masterLandId - b.masterLandId);
  let best = [];

  function search(index, selected, occupied) {
    if (selected.length > best.length) best = [...selected];
    if (selected.length >= limit || index >= candidates.length) return;
    if (selected.length + candidates.length - index <= best.length) return;

    const group = candidates[index];
    if (!group.landIds.some(id => occupied.has(id))) {
      const nextOccupied = new Set(occupied);
      group.landIds.forEach(id => nextOccupied.add(id));
      search(index + 1, [...selected, group], nextOccupied);
    }
    search(index + 1, selected, occupied);
  }

  search(0, [], new Set());
  return best;
}

function getEstimatedLandClearAt(land, emptySet) {
  const landId = toNum(land?.id);
  if (emptySet.has(landId)) return 0;

  const plant = land?.plant;
  const phases = Array.isArray(plant?.phases) ? plant.phases : [];
  if (phases.length === 0) return 0;

  const maturePhase = phases.find(phase => toNum(phase?.phase) === 6);
  const matureAt = toTimeSec(maturePhase?.begin_time);
  if (matureAt <= 0) return Number.MAX_SAFE_INTEGER;

  const plantConfig = getPlantById(toNum(plant.id));
  const currentSeason = Math.max(1, toNum(plant.season) || 1);
  const totalSeasons = Math.max(currentSeason, toNum(plantConfig?.seasons) || currentSeason);
  const remainingSeasons = Math.max(0, totalSeasons - currentSeason);
  const growSeconds = Math.max(0, toNum(getPlantGrowTime(toNum(plant.id))));

  return Math.max(getServerTimeSec(), matureAt) + remainingSeasons * growSeconds;
}

/** 优先选择已完全空闲的组合，并且最多保留一个仍在等待清空的组合。 */
function select2x2Reservations(groups, emptyLandIds, desiredCount, lands) {
  const emptySet = new Set((emptyLandIds || []).map(toNum).filter(Boolean));
  const landMap = buildLandMap(lands);
  const activeFootprints = getActive2x2Footprints(lands);
  const candidates = (groups || []).filter((group) => {
    return !activeFootprints.some(
      footprint => overlapsLandIds(group.landIds, footprint.landIds)
    );
  });
  const ready = candidates
    .filter(group => group.landIds.every(id => emptySet.has(id)));
  const selected = selectMaximumNonOverlappingGroups(ready, desiredCount);
  const occupied = new Set(selected.flatMap(group => group.landIds));

  const previousReservations = new Set(reserved2x2GroupKeys);
  const waiting = candidates
    .filter(group => !group.landIds.every(id => emptySet.has(id)))
    .sort((a, b) => {
      const clearAtA = Math.max(...a.landIds.map(id => getEstimatedLandClearAt(landMap.get(id), emptySet)));
      const clearAtB = Math.max(...b.landIds.map(id => getEstimatedLandClearAt(landMap.get(id), emptySet)));
      if (clearAtA !== clearAtB) return clearAtA - clearAtB;
      const reservedA = previousReservations.has(a.key) ? 1 : 0;
      const reservedB = previousReservations.has(b.key) ? 1 : 0;
      if (reservedA !== reservedB) return reservedB - reservedA;
      const emptyA = a.landIds.filter(id => emptySet.has(id)).length;
      const emptyB = b.landIds.filter(id => emptySet.has(id)).length;
      return emptyB - emptyA || a.masterLandId - b.masterLandId;
    });

  // 已完整空闲的区域可以种植多组；需要等待的区域最多只预留一组。
  for (const group of waiting) {
    if (selected.length >= desiredCount) break;
    if (group.landIds.some(id => occupied.has(id))) continue;
    selected.push(group);
    group.landIds.forEach(id => occupied.add(id));
    break;
  }

  reserved2x2GroupKeys = selected
    .filter(group => !group.landIds.every(id => emptySet.has(id)))
    .map(group => group.key);
  return selected;
}

function expandRemoved2x2Lands(emptyLandIds, removedLandIds, lands) {
  const result = new Set((emptyLandIds || []).map(toNum).filter(Boolean));
  const landMap = buildLandMap(lands);
  for (const rawId of removedLandIds || []) {
    const landId = toNum(rawId);
    if (!landId) continue;
    result.add(landId);
    const land = landMap.get(landId);
    for (const slaveId of land?.slave_land_ids || []) {
      const id = toNum(slaveId);
      if (id) result.add(id);
    }
  }
  return [...result];
}

async function plant2x2Seed(seedId, group) {
  const payload = encodePlantRequest(seedId, group.landIds);
  const { body } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', payload);
  const reply = types.PlantReply.decode(body);
  const landMap = buildLandMap(reply?.land || []);
  const master = landMap.get(group.masterLandId);
  const actualSlaves = new Set(
    (master?.slave_land_ids || []).map(toNum).filter(Boolean)
  );
  const expectedSlaves = group.landIds.filter(id => id !== group.masterLandId);
  const linked = expectedSlaves.every((id) => {
    return actualSlaves.has(id) && toNum(landMap.get(id)?.master_land_id) === group.masterLandId;
  });
  if (!master || toNum(master.land_size) !== 2 || !linked) {
    throw new Error(`服务器未确认 2x2 土地关联: ${group.landIds.join(',')}`);
  }
  return {
    masterLandId: group.masterLandId,
    occupiedLandIds: [...group.landIds],
  };
}

async function plantPrioritized2x2Crops(emptyLandIds, lands, accountId) {
  if (!getPrioritize2x2Crops(accountId)) {
    reserved2x2GroupKeys = [];
    last2x2WaitingSignature = '';
    return { reservedLandIds: [], plantedMasterIds: [], plantedCount: 0, occupiedCount: 0 };
  }

  let bagSeeds;
  try {
    bagSeeds = await getBagSeeds();
  } catch (err) {
    logWarn('种植', `读取四格种子失败，继续普通种植: ${err.message}`, {
      module: 'farm',
      event: '读取2x2种子',
      result: 'error',
    });
    return { reservedLandIds: [], plantedMasterIds: [], plantedCount: 0, occupiedCount: 0 };
  }
  const userState = getUserState();
  const userLevel = Number(userState && userState.level) || 0;
  const sortedSize2Seeds = sortBagSeedsForPlanting(
    bagSeeds.filter(seed => Number(seed?.count) > 0 && Number(seed?.plantSize) === 2),
    getBagSeedPriority(accountId)
  ).map(seed => ({ ...seed, count: Number(seed.count) || 0 }));
  const lockedByLevelSeeds = sortedSize2Seeds.filter(seed => isSeedLockedByLevel(seed, userLevel));
  const size2Seeds = sortedSize2Seeds.filter(seed => !isSeedLockedByLevel(seed, userLevel));

  if (lockedByLevelSeeds.length > 0) {
    log('种植', `已跳过当前等级未解锁的 2x2 背包种子: ${lockedByLevelSeeds.map(seed => seed.name || seed.seedId).join('，')}`, {
      module: 'farm',
      event: '种植2x2作物',
      result: 'skip_locked',
      seedIds: lockedByLevelSeeds.map(seed => seed.seedId),
      userLevel,
    });
  }

  const totalSeedCount = size2Seeds.reduce((sum, seed) => sum + seed.count, 0);
  if (totalSeedCount <= 0) {
    reserved2x2GroupKeys = [];
    last2x2WaitingSignature = '';
    return { reservedLandIds: [], plantedMasterIds: [], plantedCount: 0, occupiedCount: 0 };
  }

  const groups = build2x2LandGroups(lands);
  const reservations = select2x2Reservations(
    groups,
    emptyLandIds,
    Math.min(totalSeedCount, groups.length),
    lands
  );
  const reservedLandIdSet = new Set(reservations.flatMap(group => group.landIds));
  const emptySet = new Set((emptyLandIds || []).map(toNum).filter(Boolean));
  const readyGroups = reservations.filter(group => group.landIds.every(id => emptySet.has(id)));
  const plantedMasterIds = [];
  let occupiedCount = 0;

  function release2x2Reservation(group) {
    for (const landId of group.landIds) reservedLandIdSet.delete(landId);
  }

  function hasRetryBlocked2x2Seed(group) {
    const now = Date.now();
    return size2Seeds.some((seed) => {
      if (Number(seed.count || 0) <= 0) return false;
      const retryKey = `${group.key}:${seed.seedId}`;
      const retryAt = failed2x2Retries.get(retryKey) || 0;
      return retryAt > now;
    });
  }

  function pickNext2x2Seed(group) {
    const now = Date.now();
    return size2Seeds.find((seed) => {
      if (Number(seed.count || 0) <= 0) return false;
      const retryKey = `${group.key}:${seed.seedId}`;
      const retryAt = failed2x2Retries.get(retryKey) || 0;
      return retryAt <= now;
    }) || null;
  }

  for (const group of readyGroups) {
    let seed = pickNext2x2Seed(group);
    if (!seed && !hasRetryBlocked2x2Seed(group)) {
      release2x2Reservation(group);
      continue;
    }

    while (seed) {
      const retryKey = `${group.key}:${seed.seedId}`;
      try {
        const result = await plant2x2Seed(seed.seedId, group);
        failed2x2Retries.delete(retryKey);
        seed.count -= 1;
        plantedMasterIds.push(result.masterLandId);
        occupiedCount += result.occupiedLandIds.length;
        result.occupiedLandIds.forEach(id => emptySet.delete(id));
        log('种植', `已优先种植 2x2 作物 ${seed.name}，主地块#${result.masterLandId}，占地 ${result.occupiedLandIds.join(',')}`, {
          module: 'farm',
          event: '种植2x2作物',
          result: 'ok',
          seedId: seed.seedId,
          masterLandId: result.masterLandId,
          landIds: result.occupiedLandIds,
        });
        break;
      } catch (err) {
        if (isLockedPlantError(err)) {
          seed.count = 0;
          failed2x2Retries.delete(retryKey);
          const nextSeed = pickNext2x2Seed(group);
          logWarn('种植', nextSeed
            ? `2x2 作物 ${seed.name} 当前不可种植，已切换其他 2x2 作物: ${err.message}`
            : `2x2 作物 ${seed.name} 当前不可种植，且没有其他可切换的 2x2 作物: ${err.message}`, {
            module: 'farm',
            event: '种植2x2作物',
            result: 'seed_locked',
            seedId: seed.seedId,
            landIds: group.landIds,
          });
          if (!nextSeed && !hasRetryBlocked2x2Seed(group))
            release2x2Reservation(group);
          seed = nextSeed;
          continue;
        }

        failed2x2Retries.set(retryKey, Date.now() + TWO_BY_TWO_RETRY_DELAY_MS);
        logWarn('种植', `2x2 作物 ${seed.name} 种植失败: ${err.message}`, {
          module: 'farm',
          event: '种植2x2作物',
          result: 'error',
          seedId: seed.seedId,
          landIds: group.landIds,
        });
        break;
      }
    }
    await sleep(200, 400);
  }

  if (reservations.length > readyGroups.length) {
    const readyKeys = new Set(readyGroups.map(group => group.key));
    const waiting = reservations
      .filter(group => !readyKeys.has(group.key))
      .map(group => group.landIds.join(','));
    const waitingSignature = waiting.join('|');
    if (waiting.length > 0 && waitingSignature !== last2x2WaitingSignature) {
      log('种植', `已为 2x2 作物预留土地，等待区域清空: ${waiting.join(' | ')}`, {
        module: 'farm',
        event: '预留2x2土地',
        result: 'waiting',
        groups: waiting,
      });
    }
    last2x2WaitingSignature = waitingSignature;
  } else {
    last2x2WaitingSignature = '';
  }

  return {
    reservedLandIds: [...reservedLandIdSet],
    plantedMasterIds,
    plantedCount: plantedMasterIds.length,
    occupiedCount
  };
}

// ─── 种植核心 ───

/**
 * 在指定地块种植指定种子
 * @param {number} seedId - 种子 ID
 * @param {number[]} landIds - 地块 ID 列表
 * @param {object} options - { maxPlantCount }
 * @returns {{ planted, plantedLandIds, occupiedLandIds }} 种植结果
 */
async function plantSeeds(seedId, landIds, options = {}) {
  let planted = 0;
  let lockedCount = 0;
  let otherFailureCount = 0;
  const plantedLandIds = [];
  const occupiedSet = new Set();
  const maxPlantCount = Math.max(1, toNum(options.maxPlantCount) || 1) || Number.POSITIVE_INFINITY;
  const remainingLandIds = new Set(
    (Array.isArray(landIds) ? landIds : []).map(id => toNum(id)).filter(Boolean)
  );
  // 与调用方共用的失败上下文：便于判断"整轮失败"并提前止损
  const failureCtx = options.failureCtx || null;
  // 同一错误连续重现次数：服务器若对「该种子当前不可种」返回该类错误，
  // 则不应把 24 块地全试一遍（每次失败都会刷屏日志并拖慢循环）。
  let consecutiveLockLikeFailures = 0;
  const maxConsecutiveFailures = Math.max(2, toNum(options.maxConsecutiveFailures) || 4);

  for (const rawLandId of landIds) {
    const landId = toNum(rawLandId);
    if (!landId || !remainingLandIds.has(landId)) continue;
    if (planted >= maxPlantCount) break;

    try {
      const payload = encodePlantRequest(seedId, [landId]);
      const { body } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', payload);
      const reply = types.PlantReply.decode(body);
      const replyLands = Array.isArray(reply && reply.land) ? reply.land : [];
      const landMap = buildLandMap(replyLands);
      const tempLand = landMap.get(landId) || { id: landId };
      const displayCtx = getDisplayLandContext(tempLand, landMap);
      const occupiedIds = displayCtx.occupiedLandIds.length > 1
        ? displayCtx.occupiedLandIds
        : [landId];

      planted++;
      consecutiveLockLikeFailures = 0;
      plantedLandIds.push(displayCtx.masterLandId || landId);

      for (const occId of occupiedIds) {
        occupiedSet.add(occId);
        remainingLandIds.delete(occId);
      }
    } catch (err) {
      const isLocked = isLockedPlantError(err);
      lockedCount += Number(isLocked ? 1 : 0);
      otherFailureCount += Number(isLocked ? 0 : 1);
      if (failureCtx) {
        if (isLocked) failureCtx.lockedCount = (failureCtx.lockedCount || 0) + 1;
        else failureCtx.otherError = err.message;
      }

      consecutiveLockLikeFailures += 1;
      if (consecutiveLockLikeFailures === 1) {
        // 第一次失败保留完整原因，便于排查；后续同类失败降级为 debug 计数，
        // 避免刷屏（原实现每块地一条 warn，单小时可达上万条）。
        logWarn('种植', `土地#${landId} 失败: ${err.message}`, {
          module: 'farm', event: '种植种子', result: isLocked ? 'land_locked' : 'error', seedId, landId,
        });
      }
      if (consecutiveLockLikeFailures >= maxConsecutiveFailures) {
        logWarn('种植', `种子 ${seedId} 连续 ${consecutiveLockLikeFailures} 次失败，本轮跳过剩余 ${remainingLandIds.size} 块地`, {
          module: 'farm', event: '种植种子', result: 'seed_rejected_early_stop',
          seedId, consecutiveFailures: consecutiveLockLikeFailures, lastError: err.message,
        });
        break;
      }
    }
    // 多地种植时加间隔
    if (landIds.length > 1) await sleep(200, 400);
  }

  return {
    planted,
    plantedLandIds,
    occupiedLandIds: [...occupiedSet],
    lockedCount,
    otherFailureCount,
  };
}

// ─── 背包种子种植 ───

/**
 * 按背包优先级排序背包种子
 * @param {Array} bagSeeds - 背包种子列表
 * @param {Array} priorityList - 优先级种子 ID 列表
 */
function sortBagSeedsForPlanting(bagSeeds, priorityList) {
  const priorityMap = new Map();
  const priorities = Array.isArray(priorityList) ? priorityList : [];
  priorities.forEach((seedId, index) => {
    const num = Number(seedId);
    if (num > 0) priorityMap.set(num, index);
  });

  return [...(Array.isArray(bagSeeds) ? bagSeeds : [])].sort((a, b) => {
    const priorityA = priorityMap.has(a.seedId) ? priorityMap.get(a.seedId) : Number.MAX_SAFE_INTEGER;
    const priorityB = priorityMap.has(b.seedId) ? priorityMap.get(b.seedId) : Number.MAX_SAFE_INTEGER;
    if (priorityA !== priorityB) return priorityA - priorityB;

    const levelA = Number(a.requiredLevel || 0);
    const levelB = Number(b.requiredLevel || 0);
    if (levelA !== levelB) return levelB - levelA;

    return Number(a.seedId || 0) - Number(b.seedId || 0);
  });
}

/**
 * 使用背包种子种植（bag_priority 策略）
 * @param {number[]} emptyLandIds - 空地 ID 列表
 */
async function plantFromBagSeeds(emptyLandIds, accountId = getCurrentAccountId()) {
  const landIds = (Array.isArray(emptyLandIds) ? emptyLandIds : [])
    .map(id => Number(id))
    .filter(id => id > 0);

  if (landIds.length === 0) {
    return {
      remainingLandIds: [], fallbackAllowed: false,
      plantedLandIds: [], totalPlanted: 0, occupiedCount: 0
    };
  }

  const bagSeeds = await getBagSeeds();
  const allSeeds = Array.isArray(bagSeeds) ? bagSeeds : [];
  const seedPriority = getBagSeedPriority(accountId);
  const prioritySet = new Set(
    Array.isArray(seedPriority) ? seedPriority.map(id => Number(id)) : []
  );
  const hasCustomPriority = prioritySet.size > 0;

  const usableBagSeeds = allSeeds.filter(s =>
    Number(s && s.count) > 0 &&
    Number(s && s.plantSize) === 1
  );
  const customPrioritySeeds = hasCustomPriority
    ? usableBagSeeds.filter(s => prioritySet.has(Number(s.seedId)))
    : [];

  // ??????????????????????????? 1x1 ?????
  const availableSeeds = sortBagSeedsForPlanting(
    customPrioritySeeds.length > 0 ? customPrioritySeeds : usableBagSeeds,
    customPrioritySeeds.length > 0 ? seedPriority : []
  );

  if (availableSeeds.length === 0) {
    const hasAnySeeds = allSeeds.some(s => Number(s && s.count) > 0);
    log('种植', hasAnySeeds
      ? '背包中没有可用的 1x1 种子，准备按第二优先策略补种'
      : '背包种子已用完，准备按第二优先策略补种', {
      module: 'farm', event: '种植种子', result: 'fallback_ready', strategy: 'bag_priority'
    });
    return {
      remainingLandIds: landIds, fallbackAllowed: true,
      plantedLandIds: [], totalPlanted: 0, occupiedCount: 0
    };
  }

  let remainingIds = [...landIds];
  let fallbackAllowed = true;
  let totalPlanted = 0;
  let totalOccupied = 0;
  const allPlantedIds = [];
  const batches = [];
  const rejectedSeeds = [];

  for (const seed of availableSeeds) {
    if (remainingIds.length === 0) break;

    const maxCount = Math.min(
      Number(seed.count || 0),
      remainingIds.length
    );
    if (maxCount <= 0) continue;

    const plantResult = await plantSeeds(seed.seedId, remainingIds, { maxPlantCount: maxCount });
    const occupiedIds = (Array.isArray(plantResult.occupiedLandIds) ? plantResult.occupiedLandIds : [])
      .map(Number).filter(id => id > 0);
    const plantedIds = (Array.isArray(plantResult.plantedLandIds) ? plantResult.plantedLandIds : [])
      .map(Number).filter(id => id > 0);

    if (plantResult.planted > 0) {
      totalPlanted += plantResult.planted;
      totalOccupied += occupiedIds.length > 0 ? occupiedIds.length : plantResult.planted;
      allPlantedIds.push(...plantedIds);
      remainingIds = remainingIds.filter(id => !occupiedIds.includes(id));
      batches.push(`${seed.name  }x${  plantResult.planted}`);
    }

    if (plantResult.planted === 0) {
      // 该种子在当前条件下完全种不了（例如未解锁/等级不足/已被服务器拒绝）。
      // 记下来并继续尝试下一颗种子——旧实现会因此整轮放弃导致"什么都种不了"。
      rejectedSeeds.push(seed.name);
      logWarn('种植', `背包种子 ${seed.name} 本次无法种植，已跳过（不影响后续种子）`, {
        module: 'farm', event: '种植种子', result: 'seed_rejected',
        seedId: seed.seedId, requested: maxCount, lockedCount: plantResult.lockedCount || 0,
      });
      continue;
    }

    // 部分成功：剩余空地存在但该种子数量不足/部分地块不可用。
    // 此时不再回退商店买种，避免误购（保持原有防误购语义）。
    if (plantResult.planted < maxCount && remainingIds.length > 0) {
      fallbackAllowed = false;
      logWarn('种植', `背包种子 ${seed.name} 实际种植 ${plantResult.planted}/${maxCount}，为避免误购商店种子，本轮不执行第二优先策略`, {
        module: 'farm', event: '种植种子', result: 'partial_bag_failure',
        seedId: seed.seedId, requested: maxCount, planted: plantResult.planted
      });
    }
  }

  if (batches.length > 0) {
    log('种植', `已按背包优先策略种植: ${batches.join('，')}`, {
      module: 'farm', event: '种植种子', result: 'ok',
      strategy: 'bag_priority', count: totalPlanted
    });
  }

  // 全部种子都完全无法种植：说明不是"部分地块不可用"而是"这批种子整体不可用"，
  // 同样不回退商店买种，避免误购；但把原因汇总出来便于排查。
  if (totalPlanted === 0 && rejectedSeeds.length > 0) {
    fallbackAllowed = false;
    logWarn('种植', `背包中 ${rejectedSeeds.length} 颗种子均无法种植（${rejectedSeeds.join('，')}），本轮跳过背包策略`, {
      module: 'farm', event: '种植种子', result: 'all_bag_seeds_rejected',
      rejected: rejectedSeeds,
    });
  }

  return {
    remainingLandIds: remainingIds,
    fallbackAllowed,
    plantedLandIds: [...new Set(allPlantedIds)],
    totalPlanted,
    occupiedCount: totalOccupied
  };
}

// ─── 商店购买种植 ───

/**
 * 根据种植策略查找最佳种子
 * @param {string} overrideStrategy - 覆盖策略（可选）
 */
async function findBestSeed(overrideStrategy, accountId = getCurrentAccountId()) {
  const seedShopId = await getSeedShopId();
  let shopInfo;
  try {
    shopInfo = await getShopInfo(seedShopId);
  } catch (err) {
    logWarn('商店', `查询种子商店失败: ${err.message}，使用本地备选列表`);
    // 回退到本地种子数据
    return await findBestSeedFromLocal(overrideStrategy, accountId);
  }
  if (!shopInfo.goods_list || shopInfo.goods_list.length === 0) {
    logWarn('商店', '种子商店无商品');
    return null;
  }

  const userState = getUserState();
  const candidates = [];

  // 筛选可购买的种子
  for (const goods of shopInfo.goods_list) {
    if (!goods.unlocked) continue;

    let requiredLevel = 0;
    const conds = goods.conds || [];
    for (const cond of conds) {
      if (toNum(cond.type) === 1) {
        requiredLevel = toNum(cond.param);
        if (userState.level < requiredLevel) { requiredLevel = -1; break; }
      }
    }
    if (requiredLevel === -1) continue;

    // 检查限购
    const limitCount = toNum(goods.limit_count);
    const boughtNum = toNum(goods.bought_num);
    if (limitCount > 0 && boughtNum >= limitCount) continue;

    const seedId = toNum(goods.item_id);
    if (getPlantSizeBySeedId(seedId) !== 1) continue;
    candidates.push({
      goods, goodsId: toNum(goods.id), seedId,
      price: toNum(goods.price), requiredLevel
    });
  }

  if (candidates.length === 0) {
    logWarn('商店', '没有可购买的种子');
    return null;
  }

  const strategy = overrideStrategy || getPlantingStrategy(accountId);
  const rankingStrategies = {
    max_exp: 'exp',
    max_fert_exp: 'fert',
    max_profit: 'profit',
    max_fert_profit: 'fert_profit'
  };

  const rankingType = rankingStrategies[strategy];

  // 使用排行榜策略
  if (rankingType) {
    try {
      const rankings = getPlantRankings(rankingType);
      const candidateMap = new Map(candidates.map(c => [c.seedId, c]));
      for (const rank of rankings) {
        const seedId = Number(rank && rank.seedId) || 0;
        if (seedId <= 0) continue;

        const level = Number(rank && rank.level);
        if (Number.isFinite(level) && level > userState.level) continue;

        const match = candidateMap.get(seedId);
        if (match) return match;
      }
      logWarn('商店', `策略 ${strategy} 未找到可购买作物，回退最高等级`);
    } catch (err) {
      logWarn('商店', `策略 ${strategy} 计算失败: ${err.message}，回退最高等级`);
    }
    // 回退：按所需等级降序
    return candidates.sort((a, b) => b.requiredLevel - a.requiredLevel)[0];
  }

  if (strategy === 'preferred') {
    const preferredSeed = getPreferredSeed(accountId);
    if (preferredSeed > 0) {
      const match = candidates.find(c => c.seedId === preferredSeed);
      if (match) return match;
      logWarn('商店', `优先种子 ${preferredSeed} 当前不可购买，回退自动选择`);
    }
    candidates.sort((a, b) => b.requiredLevel - a.requiredLevel);
  } else {
    candidates.sort((a, b) => b.requiredLevel - a.requiredLevel);
  }

  return candidates[0];
}

/**
 * 从背包库存中查找最佳种子（商店不可用时的回退）
 */
async function findBestSeedFromLocal(overrideStrategy, accountId = getCurrentAccountId()) {
  const userState = getUserState();
  const allSeeds = getAllSeeds();
  if (!allSeeds || allSeeds.length === 0) return null;

  let bagSeeds = [];
  try {
    bagSeeds = await getBagSeeds();
  } catch (err) {
    logWarn('商店', `商店不可用且读取背包种子失败: ${err.message}，已跳过本轮自动种植`);
    return null;
  }

  const ownedSeedMap = new Map(
    (Array.isArray(bagSeeds) ? bagSeeds : [])
      .filter(seed => Number(seed && seed.count) > 0)
      .map(seed => [Number(seed.seedId), seed])
  );

  if (ownedSeedMap.size === 0) {
    logWarn('商店', '商店不可用且背包中没有可种植的种子，已跳过本轮自动种植');
    return null;
  }

  const availableSeeds = allSeeds.reduce((list, seed) => {
    const seedId = Number(seed && seed.seedId) || 0;
    if (seedId <= 0 || !ownedSeedMap.has(seedId)) return list;
    if (getPlantSizeBySeedId(seedId) !== 1) return list;

    const owned = ownedSeedMap.get(seedId);
    list.push({
      ...seed,
      count: Math.max(0, Number(owned && owned.count) || 0),
    });
    return list;
  }, []);

  if (availableSeeds.length === 0) {
    logWarn('商店', '商店不可用且本地种子库与背包库存未匹配到可种植种子，已跳过本轮自动种植');
    return null;
  }

  const strategy = overrideStrategy || getPlantingStrategy(accountId);

  // 优先种子策略
  if (strategy === 'preferred') {
    const preferredSeed = getPreferredSeed(accountId);
    if (preferredSeed > 0) {
      const match = availableSeeds.find(s => s.seedId === preferredSeed && s.requiredLevel <= userState.level);
      if (match) return match;
    }
  }

  const rankingStrategies = {
    max_exp: 'exp',
    max_fert_exp: 'fert',
    max_profit: 'profit',
    max_fert_profit: 'fert_profit'
  };

  const rankingType = rankingStrategies[strategy];
  if (rankingType) {
    try {
      const rankings = getPlantRankings(rankingType);
      for (const rank of rankings) {
        const seedId = Number(rank && rank.seedId) || 0;
        if (seedId <= 0) continue;
        const level = Number(rank && rank.level);
        if (Number.isFinite(level) && level > userState.level) continue;
        const match = availableSeeds.find(s => s.seedId === seedId);
        if (match && match.requiredLevel <= userState.level) return match;
      }
    } catch { /* fall through */ }
  }

  // 回退策略：按等级降序，选当前等级以下最高等级种子
  const candidates = availableSeeds.filter(s => s.requiredLevel <= userState.level);
  candidates.sort((a, b) => b.requiredLevel - a.requiredLevel);
  return candidates[0] || null;
}

/**
 * 获取所有可用种子列表（供前端展示）
 */
async function getAvailableSeeds() {
  const seedShopId = await getSeedShopId();
  const userState = getUserState();
  let seeds = [];

  try {
    const shopInfo = await getShopInfo(seedShopId);
    if (shopInfo.goods_list) {
      for (const goods of shopInfo.goods_list) {
        let requiredLevel = 0;
        for (const cond of (goods.conds || [])) {
          if (toNum(cond.type) === 1) requiredLevel = toNum(cond.param);
        }
        const limitCount = toNum(goods.limit_count);
        const boughtNum = toNum(goods.bought_num);
        const soldOut = limitCount > 0 && boughtNum >= limitCount;

        seeds.push({
          seedId: toNum(goods.item_id),
          goodsId: toNum(goods.id),
          name: getPlantNameBySeedId(toNum(goods.item_id)),
          price: toNum(goods.price),
          requiredLevel,
          locked: !goods.unlocked || userState.level < requiredLevel,
          soldOut
        });
      }
    }
  } catch (err) {
    const wsError = getWsErrorState();
    if (!wsError || Number(wsError.code) !== 400) {
      logWarn('商店', `获取商店失败: ${err.message}，使用本地备选列表`);
    }
  }

  // 商店不可用时回退到本地种子库
  if (seeds.length === 0) {
    const allSeeds = getAllSeeds();
    seeds = allSeeds.map(s => ({
      ...s, goodsId: 0, price: null,
      unknownMeta: true, locked: false, soldOut: false
    }));
  }

  return seeds.sort((a, b) => {
    const levelA = a.requiredLevel ?? 999;
    const levelB = b.requiredLevel ?? 999;
    return levelA - levelB;
  });
}

/**
 * 自动在空地上种植（主入口）
 * @param {number[]} deadLandIds - 枯死地块（需先铲除）
 * @param {number[]} emptyLandIds - 空地
 */
async function autoPlantEmptyLands(deadLandIds, emptyLandIds, lands = []) {
  let allEmptyLands = [...emptyLandIds];
  const userState = getUserState();
  const accountId = getCurrentAccountId();
  const result = {
    plantedLands: [],
    plantedCount: 0,
    occupiedCount: 0,
    removedCount: 0,
    reservedLandIds: []
  };

  // 铲除枯死作物
  if (deadLandIds.length > 0) {
    try {
      await removePlant(deadLandIds);
      log('铲除', `已铲除 ${deadLandIds.length} 块 (${deadLandIds.join(',')})`, {
        module: 'farm', event: '铲除植物', result: 'ok', count: deadLandIds.length
      });
      result.removedCount += deadLandIds.length;
      allEmptyLands.push(...deadLandIds);
    } catch (err) {
      logWarn('铲除', `批量铲除失败: ${err.message}`, {
        module: 'farm', event: '铲除植物', result: 'error'
      });
      allEmptyLands.push(...deadLandIds);
    }
  }

  allEmptyLands = expandRemoved2x2Lands(allEmptyLands, deadLandIds, lands);
  const strategy = String(getPlantingStrategy(accountId) || '').trim();
  const size2Result = await plantPrioritized2x2Crops(allEmptyLands, lands, accountId);
  const reservedLandSet = new Set(size2Result.reservedLandIds || []);
  const normalEmptyLands = allEmptyLands.filter(id => !reservedLandSet.has(Number(id)));
  result.reservedLandIds = [...reservedLandSet];
  result.plantedLands.push(...(size2Result.plantedMasterIds || []));
  result.plantedCount += Number(size2Result.plantedCount || 0);
  result.occupiedCount += Number(size2Result.occupiedCount || 0);

  if (size2Result.plantedMasterIds.length > 0) {
    await runFertilizerByConfig(size2Result.plantedMasterIds);
  }

  if (allEmptyLands.length === 0) return result;
  if (normalEmptyLands.length === 0) return result;

  // 背包优先策略
  if (strategy === 'bag_priority') {
    // 按"优先品质地块"配置拆分空地：
    // 指定品质地块 → 背包种子优先种植；其余地块 → 直接走第二优先策略
    const allowedLandTypes = getBagPriorityLandTypes(accountId);
    const landTypeSet = new Set(Array.isArray(allowedLandTypes) ? allowedLandTypes : []);
    const isUnrestricted = landTypeSet.size === 0 || landTypeSet.size >= 5;

    let preferredEmptyLands = normalEmptyLands;
    let otherEmptyLands = [];

    if (!isUnrestricted) {
      // 构建 landId → 品质类型 映射（复用主流程已传入的 lands，避免额外请求）
      const landTypeMap = new Map();
      for (const land of (Array.isArray(lands) ? lands : [])) {
        if (!land) continue;
        const landId = toNum(land.id);
        if (!landId) continue;
        landTypeMap.set(landId, getLandTypeByLevel(land.level));
      }
      preferredEmptyLands = [];
      otherEmptyLands = [];
      for (const id of normalEmptyLands) {
        const landId = toNum(id);
        const landType = landTypeMap.get(landId);
        if (landType && landTypeSet.has(landType)) preferredEmptyLands.push(id);
        else otherEmptyLands.push(id);
      }
      const typeNames = allowedLandTypes.map(t => LAND_TYPE_NAME_MAP[t] || t).join('、');
      log('种植', `背包优先：指定品质地块[${typeNames}]空地 ${preferredEmptyLands.length} 块，其余空地 ${otherEmptyLands.length} 块将按第二优先策略种植`, {
        module: 'farm', event: '种植种子', result: 'land_filter',
        strategy: 'bag_priority', preferred: preferredEmptyLands.length, other: otherEmptyLands.length
      });
    }

    const plantedLands = [];

    // 仅在指定品质地块有空位时，才执行背包种子优先（第一策略）
    let bagRemainingIds = [];
    let bagFallbackAllowed = true;
    if (preferredEmptyLands.length > 0) {
      let bagResult;
      try {
        bagResult = await plantFromBagSeeds(preferredEmptyLands, accountId);
      } catch (err) {
        logWarn('种植', `读取背包种子失败，本轮跳过第二优先策略以避免误购: ${err.message}`, {
          module: 'farm', event: '种植种子', result: 'bag_load_error'
        });
        return result;
      }
      plantedLands.push(...(bagResult.plantedLandIds || []));
      result.plantedLands.push(...(bagResult.plantedLandIds || []));
      result.plantedCount += Number(bagResult.totalPlanted || 0);
      result.occupiedCount += Number(bagResult.occupiedCount || 0);
      bagRemainingIds = bagResult.remainingLandIds || [];
      bagFallbackAllowed = bagResult.fallbackAllowed;
    }

    // 第二优先策略补种范围：
    //  - 非指定品质地块（otherEmptyLands）：直接补种
    //  - 指定地块中背包种子未能覆盖的剩余空地（背包用完/无对应种子时）
    const fallbackLandIds = [...otherEmptyLands];
    if (bagFallbackAllowed && bagRemainingIds.length > 0) {
      fallbackLandIds.push(...bagRemainingIds);
    }
    // 背包部分种植失败(bagFallbackAllowed=false)时，指定地块剩余空位本轮不补种以避免误购；
    // 但非指定地块仍应正常按第二策略种植。

    if (fallbackLandIds.length > 0) {
      const fallbackStrategy = getBagSeedFallbackStrategy(accountId) || 'level';
      log('种植', `开始按第二优先策略"${getPlantingStrategyLabel(fallbackStrategy)}"补种剩余空地`, {
        module: 'farm', event: '种植种子', result: 'fallback_start',
        strategy: fallbackStrategy, remainingCount: fallbackLandIds.length
      });
      const shopResult = await plantFromShop(fallbackLandIds, userState, fallbackStrategy, accountId);
      const shopPlantedLands = shopResult.plantedLands || [];
      plantedLands.push(...shopPlantedLands);
      result.plantedLands.push(...shopPlantedLands);
      result.plantedCount += Number(shopResult.plantedCount || 0);
      result.occupiedCount += Number(shopResult.occupiedCount || 0);
    }

    // 种植后补肥
    if (plantedLands.length > 0) {
      await runFertilizerByConfig(plantedLands);
    }
    return result;
  }

  // 商店购买种植
  const shopResult = await plantFromShop(normalEmptyLands, userState, undefined, accountId);
  result.plantedLands.push(...(shopResult.plantedLands || []));
  result.plantedCount += Number(shopResult.plantedCount || 0);
  result.occupiedCount += Number(shopResult.occupiedCount || 0);
  if (shopResult.plantedLands && shopResult.plantedLands.length > 0) {
    await runFertilizerByConfig(shopResult.plantedLands);
  }
  return result;
}

/**
 * 从商店购买种子并种植
 * @param {number[]} landIds - 目标地块
 * @param {object} userState - 用户状态
 * @param {string} overrideStrategy - 覆盖策略
 */
async function plantFromShop(landIds, userState, overrideStrategy, accountId = getCurrentAccountId()) {
  let bestSeed;
  try {
    bestSeed = await findBestSeed(overrideStrategy, accountId);
  } catch (err) {
    logWarn('商店', `查询失败: ${err.message}`);
    return { plantedLands: [], plantedCount: 0, occupiedCount: 0 };
  }

  const result = { plantedLands: [], plantedCount: 0, occupiedCount: 0 };
  if (!bestSeed) return result;

  const plantName = getPlantNameBySeedId(bestSeed.seedId);
  const growTime = getPlantGrowTime(bestSeed.seedId);
  const growTimeStr = growTime > 0 ? ` 生长${formatGrowTime(growTime)}` : '';
  const plantSize = getPlantSizeBySeedId(bestSeed.seedId);
  const footprint = plantSize * plantSize;
  const hasShopData = toNum(bestSeed.goodsId) > 0; // 来自真实商店数据才走购买流程

  log('商店', `最佳种子: ${plantName} (${bestSeed.seedId})${hasShopData ? ` 价格=${bestSeed.price}金币` : ' (本地回退)'}${growTimeStr}`, {
    module: 'warehouse', event: '选择种子', seedId: bestSeed.seedId, price: bestSeed.price, fromShop: hasShopData
  });

  // 合并种植需要占用 footprint 块地
  let plantCount = landIds.length;
  if (footprint > 1) {
    plantCount = Math.floor(landIds.length / footprint);
    if (plantCount <= 0) {
      log('种植', `${plantName} 需要至少 ${footprint} 块空地才能合并种植，当前仅 ${landIds.length} 块可用，已跳过`, {
        module: 'farm', event: '种植种子', result: 'skip',
        seedId: bestSeed.seedId, landFootprint: footprint, emptyCount: landIds.length
      });
      return result;
    }
  }

  const totalCost = (bestSeed.price || 0) * plantCount;
  // 金币检查（仅在来自商店数据时）
  if (hasShopData && totalCost > 0 && totalCost > userState.gold) {
    logWarn('商店', `金币不足! 需要 ${totalCost} 金币, 当前 ${userState.gold} 金币`, {
      module: 'farm', event: '购买种子跳过', result: 'insufficient_gold',
      need: totalCost, current: userState.gold
    });
    const affordable = Math.floor(userState.gold / bestSeed.price);
    if (affordable <= 0) return result;
    plantCount = affordable;
    const sizeMsg = plantSize > 1
      ? `金币有限，只尝试种植 ${affordable} 组 ${plantSize}x${plantSize} 作物`
      : `金币有限，只种 ${affordable} 块地`;
    log('商店', sizeMsg);
  }

  if (!hasShopData) {
    const availableCount = Math.max(0, Number(bestSeed.count) || 0);
    if (availableCount <= 0) {
      logWarn('种植', `${plantName} 在本地回退候选中无可用库存，已跳过本轮种植`, {
        module: 'farm', event: '种植种子', result: 'skip', seedId: bestSeed.seedId
      });
      return result;
    }
    if (plantCount > availableCount) {
      plantCount = availableCount;
      const stockMsg = plantSize > 1
        ? `背包仅剩 ${availableCount} 颗 ${plantName} 种子，本轮只尝试种植 ${availableCount} 组 ${plantSize}x${plantSize} 作物`
        : `背包仅剩 ${availableCount} 颗 ${plantName} 种子，本轮只尝试种植 ${availableCount} 块地`;
      log('种植', stockMsg, {
        module: 'farm', event: '种植种子', result: 'stock_limit',
        seedId: bestSeed.seedId, count: availableCount
      });
    }
  }

  let finalSeedId = bestSeed.seedId;
  if (hasShopData) {
    try {
      const buyResult = await buyGoods(bestSeed.goodsId, plantCount, bestSeed.price);
      // 从购买结果中提取实际种子 ID（可能是获取物品后得到的真实 ID）
      if (buyResult.get_items && buyResult.get_items.length > 0) {
        const item = buyResult.get_items[0];
        const itemId = toNum(item.id);
        if (itemId > 0) finalSeedId = itemId;
      }
      // 更新金币（扣除花费）
      if (buyResult.cost_items) {
        for (const costItem of buyResult.cost_items) {
          userState.gold -= toNum(costItem.count);
        }
      }
      const boughtName = getPlantNameBySeedId(finalSeedId);
      log('购买', `已购买 ${boughtName}种子 x${plantCount}, 花费 ${bestSeed.price * plantCount} 金币`, {
        module: 'warehouse', event: '购买种子', result: 'ok',
        seedId: finalSeedId, count: plantCount, cost: bestSeed.price * plantCount
      });
    } catch (err) {
      logWarn('购买', err.message);
      return { plantedLands: [], plantedCount: 0, occupiedCount: 0 };
    }
  }

  // 执行种植
  let plantedLands = [];
  try {
    const { planted, plantedLandIds, occupiedLandIds } =
      await plantSeeds(finalSeedId, landIds, { maxPlantCount: plantCount });
    const occupiedCount = occupiedLandIds.length > 0 ? occupiedLandIds.length : planted;
    if (planted > 0) {
      if (plantSize > 1) {
        log('种植', `已种植 ${planted} 组 ${plantSize}x${plantSize} 作物，占用 ${occupiedCount} 块地 (${occupiedLandIds.join(',')})`, {
          module: 'farm', event: '种植种子', result: 'ok',
          seedId: finalSeedId, count: planted, occupiedCount
        });
      } else {
        log('种植', `已在 ${planted} 块地种植 (${landIds.slice(0, planted).join(',')})`, {
          module: 'farm', event: '种植种子', result: 'ok',
          seedId: finalSeedId, count: planted
        });
      }
      plantedLands = plantedLandIds;
      result.plantedCount = planted;
      result.occupiedCount = occupiedCount;
    }
  } catch (err) {
    logWarn('种植', err.message);
  }

  result.plantedLands = plantedLands;
  return result;
}

module.exports = {
  encodePlantRequest,
  getPlantSizeBySeedId,
  build2x2LandGroups,
  selectMaximumNonOverlappingGroups,
  select2x2Reservations,
  expandRemoved2x2Lands,
  plant2x2Seed,
  plantPrioritized2x2Crops,
  plantSeeds,
  PLANTING_STRATEGY_LABELS,
  getPlantingStrategyLabel,
  sortBagSeedsForPlanting,
  plantFromBagSeeds,
  findBestSeed,
  getAvailableSeeds,
  autoPlantEmptyLands,
  plantFromShop
};

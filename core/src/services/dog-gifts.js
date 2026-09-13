/**
 * 护主犬（宠物）服务
 *
 * 【2026-09-14 客户端反混淆实锤，协议已完整还原】
 *  协议集合 = gamepb.dogpb.DogService.*
 *   - GetDogInfo        查询宠物全量信息（列表/出战/食物/礼包）
 *   - ActivateDog       激活宠物（已有宠物，免费激活）
 *   - BuyAndActivateDog 购买并激活宠物
 *   - DeployDog         出战护农（设置看护宠物）
 *   - WithdrawDog       收回宠物（停止看护）
 *   - AddFood           投喂狗粮（food_id + count）
 *   - GetProtectLogs    看护日志（抓住小偷记录）
 *   - ClaimSkillGifts   领取同气礼包
 *
 * 字段编号全部从客户端编译后的 protobuf 描述符提取（见 dogpb.proto）。
 */
const { sendMsgAsync } = require('../utils/network');
const { log } = require('../utils/utils');
const { types } = require('../utils/proto');

const DOG_SERVICE = 'gamepb.dogpb.DogService';

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
  return Number(value) || 0;
}

/**
 * 从 protobuf 响应体中提取顶层指定字段号的 varint 值。
 * @param {Buffer|Uint8Array} bodyBytes
 * @param {number} fieldNo
 * @returns {number|null} 找到字段时返回其值，否则返回 null
 */
function extractVarintField(bodyBytes, fieldNo) {
  if (!bodyBytes || bodyBytes.length === 0) return null;
  try {
    const Reader = require('protobufjs/minimal').Reader;
    const reader = Reader.create(Buffer.from(bodyBytes));
    while (reader.pos < reader.len) {
      const key = reader.uint32();
      const fno = key >> 3;
      const wt = key & 7;
      if (fno === fieldNo && wt === 0) {
        return reader.uint32();
      }
      if (wt === 0) reader.skip();
      else if (wt === 1) reader.skip(8);
      else if (wt === 5) reader.skip(4);
      else if (wt === 2) { const l = reader.uint32(); reader.skip(l); }
      else break;
    }
  } catch {
    // 解析失败返回 null
  }
  return null;
}

/**
 * 查询宠物全量信息（GetDogInfo）
 * @returns {Promise<object>} 原始 reply 对象
 */
async function fetchDogInfoRaw() {
  const { body } = await sendMsgAsync(DOG_SERVICE, 'GetDogInfo', Buffer.alloc(0));
  const GetDogInfoReply = types.GetDogInfoReply;
  if (!GetDogInfoReply) {
    // protobuf 未就绪时降级：仅返回礼包数
    return { pending_gift_count: extractVarintField(body, 7) || 0 };
  }
  const reply = GetDogInfoReply.decode(body);
  return GetDogInfoReply.toObject(reply, { longs: Number, defaults: false });
}

/**
 * 整理宠物数据为前端友好格式
 */
function normalizeDogData(raw, configs = {}) {
  const dogCfg = configs.dogCfg || {};
  const foodCfg = configs.foodCfg || {};
  const dogs = (raw.dog_list || []).map((d) => {
    const id = toNumber(d.id);
    const cfg = dogCfg[id] || {};
    const activated = !!d.activated;
    const owned = !!d.owned;
    const deployed = id === toNumber(raw.current_deployed_dog_id) && toNumber(raw.current_deployed_dog_id) > 0;
    return {
      id,
      name: cfg.name || d.name || `宠物${id}`,
      customName: d.custom_name || '',
      displayName: d.custom_name || cfg.name || d.name || `宠物${id}`,
      protectProbability: toNumber(d.protect_probability) || toNumber(cfg.protect_probability) || 0,
      skillDesc: cfg.dog_skill_desc || '',
      tag: cfg.dog_tag || '',
      price: toNumber(d.price) || toNumber(cfg.price) || 0,
      owned,
      activated,
      deployed,
      status: deployed ? 'deployed' : (activated ? 'active' : (owned ? 'idle' : 'locked')),
      expireTime: toNumber(d.expire_time),
      isReddot: !!d.is_reddot,
      availableSkins: (d.available_skins || []).map(toNumber),
      icon: cfg.icon_path || '',
      resourcePath: cfg.resource_path || '',
    };
  });

  const foods = (raw.food_list || []).map((f) => {
    const id = toNumber(f.id);
    const cfg = foodCfg[id] || {};
    const duration = toNumber(f.time) || toNumber(cfg.time) || 0;
    return {
      id,
      name: cfg.name || `狗粮${id}`,
      durationSec: duration,
      durationDays: Math.round(duration / 86400 * 10) / 10,
      ownCount: toNumber(f.own_count),
    };
  });

  const foodLastSec = toNumber(raw.food_last_sec);
  const maxFoodLastSec = toNumber(raw.max_food_last_sec);

  return {
    dogs,
    deployedDogId: toNumber(raw.current_deployed_dog_id),
    foodLastSec,
    maxFoodLastSec,
    foodList: foods,
    isExistNewLog: !!raw.is_exist_new_log,
    pendingGiftCount: toNumber(raw.pending_gift_count),
    skillUseInfos: (raw.skill_use_infos || []).map((s) => ({
      skillId: toNumber(s.skill_id),
      dailyTriggerCount: toNumber(s.daily_trigger_count),
      maxTriggerDaily: toNumber(s.max_trigger_daily),
      dogId: toNumber(s.dog_id),
    })),
  };
}

/**
 * 查询宠物面板完整数据（含配置表信息）
 */
async function getDogPanelData() {
  const raw = await fetchDogInfoRaw();
  const dogCfg = {};
  const foodCfg = {};
  try {
    const {
      getAllDogConfigs,
      getAllFoodConfigs,
    } = require('../config/gameConfig');
    for (const cfg of getAllDogConfigs()) {
      const id = Number(cfg && cfg.id) || 0;
      if (id > 0) dogCfg[id] = cfg;
    }
    for (const cfg of getAllFoodConfigs()) {
      const id = Number(cfg && cfg.id) || 0;
      if (id > 0) foodCfg[id] = cfg;
    }
  } catch {
    // 配置表缺失时使用协议数据
  }
  return normalizeDogData(raw, { dogCfg, foodCfg });
}

/**
 * 查询礼包状态（兼容旧接口）
 */
async function getDogGiftStatus() {
  const { body } = await sendMsgAsync(DOG_SERVICE, 'GetDogInfo', Buffer.alloc(0));
  const claimable = extractVarintField(body, 7);
  return { ok: true, claimable: claimable || 0 };
}

/**
 * 出战宠物（护农）
 * @param {number} dogId
 */
async function deployDog(dogId) {
  const DeployDogRequest = types.DeployDogRequest;
  if (!DeployDogRequest) throw new Error('protobuf 未就绪');
  const msg = DeployDogRequest.create({ dog_id: dogId });
  const body = DeployDogRequest.encode(msg).finish();
  const { body: respBody } = await sendMsgAsync(DOG_SERVICE, 'DeployDog', Buffer.from(body));
  const reply = types.DeployDogReply.decode(respBody);
  const deployed = toNumber(reply.deployed_dog_id);
  log('宠物', `出战宠物 id=${dogId} → 生效=${deployed}`, { module: 'dog', event: '出战', result: 'ok', dogId, deployed });
  return {
    ok: true,
    deployedDogId: deployed,
    previousDeployedDogId: toNumber(reply.previous_deployed_dog_id),
  };
}

/**
 * 收回宠物（停止看护）
 */
async function withdrawDog() {
  const { body: respBody } = await sendMsgAsync(DOG_SERVICE, 'WithdrawDog', Buffer.alloc(0));
  const WithdrawDogReply = types.WithdrawDogReply;
  let withdrawn = 0;
  if (WithdrawDogReply) {
    const reply = WithdrawDogReply.decode(respBody);
    withdrawn = toNumber(reply.withdrawn_dog_id);
  }
  log('宠物', `收回宠物 id=${withdrawn}`, { module: 'dog', event: '收回', result: 'ok' });
  return { ok: true, withdrawnDogId: withdrawn };
}

/**
 * 投喂狗粮
 * @param {number} foodId 狗粮ID（90004/90005/90006）
 * @param {number} count 数量
 */
async function addDogFood(foodId, count) {
  const AddFoodRequest = types.AddFoodRequest;
  if (!AddFoodRequest) throw new Error('protobuf 未就绪');
  const msg = AddFoodRequest.create({ food_id: foodId, count });
  const body = AddFoodRequest.encode(msg).finish();
  const { body: respBody } = await sendMsgAsync(DOG_SERVICE, 'AddFood', Buffer.from(body));
  const reply = types.AddFoodReply.decode(respBody);
  const foodLastSec = toNumber(reply.food_last_sec);
  log('宠物', `投喂狗粮 id=${foodId} x${count} → 剩余${Math.round(foodLastSec / 3600)}小时`, {
    module: 'dog', event: '投喂', result: 'ok', foodId, count, foodLastSec,
  });
  return { ok: true, foodLastSec, foodLastHours: Math.round(foodLastSec / 3600 * 10) / 10 };
}

/**
 * 激活宠物（已有宠物，免费激活）
 * @param {number} dogId
 */
async function activateDog(dogId) {
  const ActivateDogRequest = types.ActivateDogRequest;
  if (!ActivateDogRequest) throw new Error('protobuf 未就绪');
  const msg = ActivateDogRequest.create({ dog_id: dogId });
  const body = ActivateDogRequest.encode(msg).finish();
  const { body: respBody } = await sendMsgAsync(DOG_SERVICE, 'ActivateDog', Buffer.from(body));
  const ActivateDogReply = types.ActivateDogReply;
  let dog = null;
  if (ActivateDogReply) {
    const reply = ActivateDogReply.decode(respBody);
    if (reply.dog) {
      dog = {
        id: toNumber(reply.dog.id),
        activated: !!reply.dog.activated,
      };
    }
  }
  log('宠物', `激活宠物 id=${dogId}`, { module: 'dog', event: '激活', result: 'ok', dogId });
  return { ok: true, dog };
}

/**
 * 查询看护日志（抓住小偷记录）
 */
async function getProtectLogs({ from = 0, count = 50, filterType = 0 } = {}) {
  const GetProtectLogsRequest = types.GetProtectLogsRequest;
  if (!GetProtectLogsRequest) throw new Error('protobuf 未就绪');
  const msg = GetProtectLogsRequest.create({ from, count, filter_type: filterType });
  const body = GetProtectLogsRequest.encode(msg).finish();
  const { body: respBody } = await sendMsgAsync(DOG_SERVICE, 'GetProtectLogs', Buffer.from(body));
  const GetProtectLogsReply = types.GetProtectLogsReply;
  if (!GetProtectLogsReply) return { ok: true, logs: [], totalCount: 0 };
  const reply = GetProtectLogsReply.decode(respBody);
  const obj = GetProtectLogsReply.toObject(reply, { longs: Number, defaults: false });
  const logs = (obj.logs || []).map((l) => ({
    roleLevel: toNumber(l.role_level),
    roleName: l.role_name || '',
    roleAvatarUrl: l.role_avatar_url || '',
    protectTimestamp: toNumber(l.protect_timestamp),
    protectCount: toNumber(l.protect_count),
    rewardGold: toNumber(l.reward_gold),
    dogId: toNumber(l.dog_id),
    dogName: l.dog_name || '',
    gid: toNumber(l.gid),
    skillName: l.skill_name || '',
  }));
  return { ok: true, logs, totalCount: toNumber(obj.total_count) };
}

/**
 * 领取同气礼包
 */
async function claimDogGifts() {
  const { body } = await sendMsgAsync(DOG_SERVICE, 'ClaimSkillGifts', Buffer.alloc(0));
  const claimed = extractVarintField(body, 3);
  log('宠物', `领取同气礼包: ${claimed || 0} 个`, {
    module: 'dog',
    event: '领取同气礼包',
    result: 'ok',
    claimed: claimed || 0,
  });
  return { ok: true, claimed: claimed || 0 };
}

module.exports = {
  getDogGiftStatus,
  claimDogGifts,
  getDogPanelData,
  deployDog,
  withdrawDog,
  addDogFood,
  activateDog,
  getProtectLogs,
  extractVarintField,
};

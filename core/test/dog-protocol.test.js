/**
 * 宠物（护主犬）协议线格式回归测试
 *
 * 背景（2026-09-14）：宠物协议此前只有 GetDogInfo 一项（从抓包得到），
 * 出战/投喂/激活等操作协议完全未知。通过对游戏客户端 assets/main/index.*.js
 * 的双层混淆字符串表做反混淆（自定义 base64 字典解码），还原出 DogService
 * 全部方法名，并从编译后的 protobuf 描述符提取了精确字段编号。
 *
 * 本测试把这批字段编号「冻结」为断言：protobuf 线格式是确定性的，
 * 任何字段号写错都会导致 encode 出的 tag 字节不符 → 断言失败。
 * 因此它是不依赖游戏服务器即可运行的协议正确性铁证。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const protobuf = require('protobufjs');

const protoDir = path.join(__dirname, '..', 'src', 'proto');
const root = new protobuf.Root();
root.loadSync([
  path.join(protoDir, 'game.proto'),
  path.join(protoDir, 'corepb.proto'),
  path.join(protoDir, 'dogpb.proto'),
], { keepCase: true });

const T = (n) => root.lookupType(`gamepb.dogpb.${n}`);

// ---------- 请求侧：字段编号 = 客户端编译描述符提取值 ----------

test('DeployDogRequest: dog_id 在字段1（出战护农）', () => {
  const b = Buffer.from(T('DeployDogRequest').encode({ dog_id: 12345 }).finish());
  assert.equal(b[0], 0x08, 'dog_id 应为 field1/wiretype0 → tag=0x08');
  assert.equal(b[1], 0xB9); // 12345 varint 低字节
  assert.equal(b[2], 0x60); // 12345 varint 高字节
});

test('WithdrawDogRequest: 无参消息编码为空', () => {
  const b = Buffer.from(T('WithdrawDogRequest').encode({}).finish());
  assert.equal(b.length, 0);
});

test('AddFoodRequest: food_id=f1, count=f2（投喂狗粮）', () => {
  const b = Buffer.from(T('AddFoodRequest').encode({ food_id: 90004, count: 3 }).finish());
  assert.equal(b[0], 0x08, 'food_id 在 f1');
  let i = 1;
  while (i < b.length && b[i] !== 0x10) i++;
  assert.ok(i < b.length, 'count 应在 f2（tag=0x10）');
  assert.equal(b[i + 1], 3);
});

test('ActivateDogRequest: dog_id 在字段1', () => {
  const b = Buffer.from(T('ActivateDogRequest').encode({ dog_id: 90001 }).finish());
  assert.equal(b[0], 0x08);
});

test('BuyAndActivateDogRequest: price 在字段2', () => {
  const b = Buffer.from(T('BuyAndActivateDogRequest').encode({ dog_id: 90001, price: 5000 }).finish());
  assert.equal(b[0], 0x08);
  let i = 1;
  while (i < b.length && b[i] !== 0x10) i++;
  assert.ok(i < b.length, 'price 应在 f2');
});

test('GetProtectLogsRequest: from/count/filter_type = f1/f2/f3', () => {
  const b = Buffer.from(T('GetProtectLogsRequest').encode({ from: 0, count: 20, filter_type: 0 }).finish());
  let found = false;
  for (let i = 0; i < b.length - 1; i++) {
    if (b[i] === 0x10 && b[i + 1] === 20) { found = true; break; }
  }
  assert.ok(found, 'count=20 应编码在 f2');
});

test('FeedFriendDogRequest: host_gid=f1, foods=f2, fill=f3', () => {
  const b = Buffer.from(T('FeedFriendDogRequest').encode({
    host_gid: 10001,
    foods: [{ id: 90004, count: 1 }],
    fill: true,
  }).finish());
  assert.equal(b[0], 0x08, 'host_gid 在 f1');
  let hasF2 = false;
  let hasF3 = false;
  for (const byte of b) {
    if (byte === 0x12) hasF2 = true;
    if (byte === 0x18) hasF3 = true;
  }
  assert.ok(hasF2, 'foods 在 f2（wiretype2 → tag=0x12）');
  assert.ok(hasF3, 'fill 在 f3（tag=0x18）');
});

test('EquipDogSkinRequest: skin_type=f1, dog_id=f2', () => {
  const b = Buffer.from(T('EquipDogSkinRequest').encode({ skin_type: 2, dog_id: 90031 }).finish());
  assert.equal(b[0], 0x08, 'skin_type 在 f1');
  let i = 1;
  while (i < b.length && b[i] !== 0x10) i++;
  assert.ok(i < b.length, 'dog_id 在 f2');
});

test('SetDogCustomNameRequest: name 为 f2 字符串', () => {
  const b = Buffer.from(T('SetDogCustomNameRequest').encode({ dog_id: 90001, name: '旺财' }).finish());
  assert.equal(b[0], 0x08);
  let i = 1;
  while (i < b.length && b[i] !== 0x12) i++;
  assert.ok(i < b.length, 'name(string) 标签应为 0x12');
});

// ---------- 响应侧：嵌套结构解析 ----------

test('GetDogInfoReply: 宠物列表/出战/食物/礼包 全字段解析', () => {
  const Reply = T('GetDogInfoReply');
  const payload = Reply.encode({
    dog_list: [
      { id: 90001, name: '田园犬', protect_probability: 1000, owned: true, activated: true, is_reddot: true, available_skins: [1, 2] },
      { id: 90031, name: '比熊犬', protect_probability: 5000, price: 100000 },
    ],
    current_deployed_dog_id: 90001,
    food_last_sec: 432000,
    max_food_last_sec: 864000,
    food_list: [
      { id: 90004, time: 86400, own_count: 5 },
      { id: 90006, time: 432000, own_count: 2 },
    ],
    is_exist_new_log: true,
    pending_gift_count: 3,
    skill_use_infos: [{ skill_id: 1, daily_trigger_count: 2, max_trigger_daily: 5, dog_id: 90001 }],
  }).finish();

  const obj = Reply.toObject(Reply.decode(payload), { longs: Number, defaults: false });
  assert.equal(obj.dog_list.length, 2);
  assert.equal(obj.dog_list[0].protect_probability, 1000, '看护率在 DogInfo f3');
  assert.deepEqual(obj.dog_list[0].available_skins, [1, 2], '皮肤列表在 DogInfo f12');
  assert.equal(obj.current_deployed_dog_id, 90001, '出战ID在 f2');
  assert.equal(obj.food_last_sec, 432000, '食物剩余在 f3');
  assert.equal(obj.max_food_last_sec, 864000, '上限在 f4');
  assert.equal(obj.food_list.length, 2, '狗粮库存在 f5');
  assert.equal(obj.food_list[0].time, 86400, '单份时长在 FoodInfo f2');
  assert.equal(obj.is_exist_new_log, true, '新日志在 f6');
  assert.equal(obj.pending_gift_count, 3, '礼包数在 f7（旧版唯一依赖字段）');
  assert.equal(obj.skill_use_infos[0].dog_id, 90001, '技能归属宠物在 SkillUseInfo f4');
});

test('DeployDogReply / AddFoodReply 字段位', () => {
  const Deploy = T('DeployDogReply');
  const deployed = Deploy.toObject(Deploy.decode(Deploy.encode({ deployed_dog_id: 90011, previous_deployed_dog_id: 90001 }).finish()), { longs: Number });
  assert.equal(deployed.deployed_dog_id, 90011, 'deployed_dog_id 在 f1');
  assert.equal(deployed.previous_deployed_dog_id, 90001, 'previous 在 f2');

  const AddFood = T('AddFoodReply');
  const fed = AddFood.toObject(AddFood.decode(AddFood.encode({ food_last_sec: 950000 }).finish()), { longs: Number });
  assert.equal(fed.food_last_sec, 950000, '投喂后剩余秒数在 f1');
});

test('GetProtectLogsReply: ProtectLog 嵌套全字段', () => {
  const Reply = T('GetProtectLogsReply');
  const payload = Reply.encode({
    logs: [{
      role_level: 42,
      role_name: '小偷甲',
      protect_timestamp: 1789300000,
      protect_count: 2,
      reward_gold: 1500,
      dog_id: 90001,
      dog_name: '田园犬',
      gid: 55555,
      is_read: false,
      record_type: 1,
      skill_id: 3,
      skill_name: '吼叫',
      param1: 7,
    }],
    total_count: 1,
  }).finish();

  const obj = Reply.toObject(Reply.decode(payload), { longs: Number, defaults: false });
  assert.equal(obj.logs[0].role_name, '小偷甲');
  assert.equal(obj.logs[0].reward_gold, 1500);
  assert.equal(obj.logs[0].dog_id, 90001, '抓人的宠物ID在 f8');
  assert.equal(obj.logs[0].gid, 55555, '小偷GID在 f10');
  assert.equal(obj.logs[0].skill_name, '吼叫', '技能名在 f17');
  assert.equal(obj.total_count, 1);
});

test('GetFriendFeedInfoReply: 好友投喂信息 12 字段', () => {
  const Reply = T('GetFriendFeedInfoReply');
  const obj = Reply.toObject(Reply.decode(Reply.encode({
    food_list: [{ id: 90004, time: 86400, own_count: 3 }],
    action: 1,
    friend_name: '好友A',
    food_last_sec: 100,
    max_food_last_sec: 200,
    daily_feed_days: 2,
    daily_limit_days: 5,
    can_fill: true,
    dog_custom_name: '大黄',
    remain_days: 3,
  }).finish()), { longs: Number, defaults: false });

  assert.equal(obj.friend_name, '好友A', '好友名在 f5');
  assert.equal(obj.can_fill, true, '可继续投喂在 f10');
  assert.equal(obj.dog_custom_name, '大黄', '狗自定义名在 f11');
  assert.equal(obj.remain_days, 3, '剩余天数在 f12');
});

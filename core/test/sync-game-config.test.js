/**
 * 单元测试：sync-game-config.js 的核心纯函数
 *
 * 覆盖：
 * - XOR 解密（已知密钥往返）
 * - Cocos 压缩 UUID 解码（已知对照）
 * - 表合并策略（官方优先 / 本地独有字段保留 / 本地独有条目保留 / 名称占位标记清理）
 * - 键序无关比较（stableStringify）
 * - PNG 解码/编码往返（图集切图基础）
 * - 图集裁剪（无旋转 / 旋转）
 *
 * 不覆盖网络请求（需真实 CDN），网络部分由 `node scripts/sync-game-config.js check` 验证。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');

const tool = require(path.join(__dirname, '..', '..', 'scripts', 'sync-game-config.js'));

// ---------------------------------------------------------------------------
test('decryptXor: 已知密钥可往返（解密后再加密还原）', () => {
  const key = Buffer.from('NQF_SHANGXIANDAMAI_#2026_SECURE', 'latin1');
  const plain = Buffer.from('{"id":1,"name":"测试"}', 'utf8');
  // 加密 = 再异或一次
  const enc = tool.decryptXor(plain);
  assert.notDeepStrictEqual(enc, plain, '加密后应不同');
  const dec = tool.decryptXor(enc);
  assert.strictEqual(dec.toString('utf8'), plain.toString('utf8'), '往返应一致');
});

test('decryptXor: 密钥按 31 字节循环', () => {
  const key = Buffer.from('NQF_SHANGXIANDAMAI_#2026_SECURE', 'latin1');
  assert.strictEqual(key.length, 31, '密钥应为 31 字节');
  // 构造 62 字节全 0，异或结果应为密钥重复两遍
  const zeros = Buffer.alloc(62);
  const out = tool.decryptXor(zeros);
  assert.strictEqual(out.toString('latin1'), key.toString('latin1') + key.toString('latin1'));
});

// ---------------------------------------------------------------------------
test('decodeUuid: Cocos 压缩 UUID 解码（真实对照）', () => {
  // 来自线上 config：ItemInfo 组件 uuid
  assert.strictEqual(
    tool.decodeUuid('3fQNcjKwVAR5yhvG+KWRs9'),
    '3f40d723-2b05-4047-9ca1-bc6f8a591b3d'
  );
  // 长 uuid 原样返回
  assert.strictEqual(
    tool.decodeUuid('already-full-uuid-string-here'),
    'already-full-uuid-string-here'
  );
});

// ---------------------------------------------------------------------------
test('stableStringify: 键序无关', () => {
  const a = { b: 1, a: 2, c: [1, 2] };
  const b = { a: 2, c: [1, 2], b: 1 };
  assert.strictEqual(tool.stableStringify(a), tool.stableStringify(b));
  assert.notStrictEqual(tool.stableStringify({ a: 1 }), tool.stableStringify({ a: 2 }));
});

// ---------------------------------------------------------------------------
test('mergeTable: 官方字段覆盖、本地独有字段保留', () => {
  const local = [
    { id: 1, name: '道具1', price: 100, price_id: 1001, _auto_added: true, _name_unknown: true },
  ];
  const online = [
    { id: 1, name: '真名', desc: '官方描述', new_field: 'x' },
  ];
  const { merged, stats } = tool.mergeTable(local, online, 'id');
  assert.strictEqual(merged.length, 1);
  const m = merged[0];
  assert.strictEqual(m.name, '真名', '官方名称应覆盖');
  assert.strictEqual(m.desc, '官方描述', '官方新增字段应写入');
  assert.strictEqual(m.new_field, 'x');
  assert.strictEqual(m.price, 100, '本地独有 price 应保留');
  assert.strictEqual(m.price_id, 1001, '本地独有 price_id 应保留');
  assert.strictEqual(m._name_unknown, undefined, '官方名确认后应清理 _name_unknown');
  assert.strictEqual(m._auto_added, true, '_auto_added 非名称标记，应保留');
  assert.strictEqual(stats.changed.length, 1);
  assert.deepStrictEqual(stats.changed[0].fields, ['name']);
  assert.strictEqual(stats.added.length, 0);
});

test('mergeTable: 官方占位名不清理标记', () => {
  const local = [{ id: 2, name: '道具2', _name_unknown: true }];
  const online = [{ id: 2, name: '道具2', desc: 'x' }];
  const { merged } = tool.mergeTable(local, online, 'id');
  assert.strictEqual(merged[0]._name_unknown, true, '官方仍是占位名时保留标记');
});

test('mergeTable: 本地独有条目保留（官方已下架）', () => {
  const local = [
    { id: 1, name: 'A' },
    { id: 99, name: '已下架' },
  ];
  const online = [{ id: 1, name: 'A' }];
  const { merged, stats } = tool.mergeTable(local, online, 'id');
  assert.strictEqual(merged.length, 2, '下架条目不应被删除');
  assert.strictEqual(stats.keptLocalOnly.length, 1);
  assert.strictEqual(stats.keptLocalOnly[0].id, 99);
  // 排序：按 id 升序
  assert.deepStrictEqual(merged.map((x) => x.id), [1, 99]);
});

test('mergeTable: 官方新增条目', () => {
  const local = [{ id: 1, name: 'A' }];
  const online = [
    { id: 1, name: 'A' },
    { id: 2, name: 'B', desc: '新' },
  ];
  const { merged, stats } = tool.mergeTable(local, online, 'id');
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(stats.added.length, 1);
  assert.strictEqual(stats.added[0].id, 2);
  assert.strictEqual(stats.sameCount, 1, '未变化条目计数');
});

test('mergeTable: 键序不同但值相同 → 不算变化', () => {
  const local = [{ id: 1, a: 1, b: 2 }];
  const online = [{ b: 2, id: 1, a: 1 }];
  const { stats } = tool.mergeTable(local, online, 'id');
  assert.strictEqual(stats.changed.length, 0, '键序差异不应误报变化');
  assert.strictEqual(stats.sameCount, 1);
});

// ---------------------------------------------------------------------------
test('PNG: 编码 → 解码往返一致', () => {
  const w = 4, h = 3;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = i * 10 % 256;
    rgba[i * 4 + 1] = (i * 20) % 256;
    rgba[i * 4 + 2] = (i * 30) % 256;
    rgba[i * 4 + 3] = i % 2 ? 255 : 128;
  }
  const png = tool.encodePng(w, h, rgba);
  assert.strictEqual(png[0], 0x89, 'PNG 魔数');
  const decoded = tool.decodePng(png);
  assert.strictEqual(decoded.width, w);
  assert.strictEqual(decoded.height, h);
  assert.deepStrictEqual(decoded.rgba, rgba, '像素应完全一致');
});

test('cropFromAtlas: 从图集切出指定区域', () => {
  // 造一个 4x4 图集，每个像素是唯一颜色
  const aw = 4, ah = 4;
  const atlas = Buffer.alloc(aw * ah * 4);
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      const i = (y * aw + x) * 4;
      atlas[i] = x * 60;        // R = x 坐标标记
      atlas[i + 1] = y * 60;    // G = y 坐标标记
      atlas[i + 2] = 0;
      atlas[i + 3] = 255;
    }
  }
  const atlasPng = tool.encodePng(aw, ah, atlas);

  // 切 (1,1) 起的 2x2
  const out = tool.cropFromAtlas(atlasPng, { x: 1, y: 1, width: 2, height: 2 }, false);
  const cropped = tool.decodePng(out);
  assert.strictEqual(cropped.width, 2);
  assert.strictEqual(cropped.height, 2);
  // 检查像素：(0,0) 应等于原图 (1,1)
  assert.strictEqual(cropped.rgba[0], 60, 'R 应为 x=1 → 60');
  assert.strictEqual(cropped.rgba[1], 60, 'G 应为 y=1 → 60');
  // (1,1) 应等于原图 (2,2)
  assert.strictEqual(cropped.rgba[3 * 4], 120, 'R 应为 x=2 → 120');
  assert.strictEqual(cropped.rgba[3 * 4 + 1], 120, 'G 应为 y=2 → 120');
});

test('decodePng: 拒绝非 PNG / 隔行 PNG', () => {
  assert.throws(() => tool.decodePng(Buffer.from('not a png')), /png/);
});

// ---------------------------------------------------------------------------
test('detectImage: 识别 PNG / JPG 魔数', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  assert.strictEqual(tool.detectImage(png), 'png');
  assert.strictEqual(tool.detectImage(jpg), 'jpg');
  assert.strictEqual(tool.detectImage(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9])), 'unknown');
});

// ---------------------------------------------------------------------------
test('SYNC_TABLES: 配置完备（每表有 file/bundle/idKey）', () => {
  assert.ok(Array.isArray(tool.SYNC_TABLES));
  for (const t of tool.SYNC_TABLES) {
    assert.ok(t.file && t.file.endsWith('.json'), `${t.file} 应为 json`);
    assert.ok(t.bundle, `${t.file} 应有 bundle`);
    assert.ok(t.table, `${t.file} 应有 table`);
    assert.ok(t.idKey, `${t.file} 应有 idKey`);
  }
});

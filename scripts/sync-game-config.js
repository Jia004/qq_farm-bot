#!/usr/bin/env node
/**
 * QQ 农场 · 官方配置全量同步工具
 * =================================
 *
 * 用途
 * ----
 * 把官方服务器上的**全部**配置表（ItemInfo / Plant / RoleLevel / MutantEffect 等）
 * 一次性拉取到本地 core/src/gameConfig/，替换「出问题才按需补一条」的旧流程。
 *
 * 数据来源链路（已逆向验证）
 * -------------------------
 *   1. 游戏客户端每次启动会把最新版本号写进本地缓存：
 *        %APPDATA%/QQEX/miniapp/temps/miniapp_src/<hash>/src/settings.<hash>.json
 *      其中 assets.bundleVers 记录每个 bundle 的版本（如 "mainscene": "d5852"）
 *   2. 资源清单直接可从官方 CDN 拉：
 *        https://cdn-resource.nqf.qq.com/release/remote/<bundle>/config.<vers>.json
 *   3. 每张配置表在清单里有 uuid + hash，数据文件 URL 为：
 *        .../<bundle>/import/<uuid前2位>/<uuid>.<hash>.json
 *   4. 数据文件里有一段 base64 blob，用固定 XOR 密钥循环异或即得明文 JSON：
 *        密钥 = NQF_SHANGXIANDAMAI_#2026_SECURE （31 字节，按位循环）
 *
 * 后续官方更新怎么办
 * ------------------
 *   打开一次游戏（客户端会自动更新缓存里的 bundleVers），然后重新运行本工具：
 *     node scripts/sync-game-config.js check   # 只对比，告诉你官方新增/改了什么
 *     node scripts/sync-game-config.js sync --write
 *   工具会记录上次同步的版本号（.sync-meta.json），版本没变时直接提示「已是最新」。
 *
 * 用法
 * ----
 *   node scripts/sync-game-config.js check              # 检查更新（不写文件）
 *   node scripts/sync-game-config.js sync               # 预览同步（dry-run）
 *   node scripts/sync-game-config.js sync --write       # 写入配置表
 *   node scripts/sync-game-config.js icons              # 检查缺失图标
 *   node scripts/sync-game-config.js icons --write      # 下载缺失图标（PNG）
 *   node scripts/sync-game-config.js all --write        # 数据 + 图标一起同步
 *   node scripts/sync-game-config.js tables             # 列出官方全部配置表
 *   node scripts/sync-game-config.js raw <表名>         # 导出单张表原始数据到 tmp/
 *
 * 合并策略（保护本地手工数据）
 * ---------------------------
 *   - 官方有的字段 → 以官方为准（覆盖本地旧值）
 *   - 仅本地有的字段（price / price_id / _name_confirmed 等）→ 保留
 *   - 仅本地有的条目（官方已下架的活动道具）→ 保留，不删除
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const CFG_DIR = path.join(ROOT, 'core', 'src', 'gameConfig');
const IMG_DIR = path.join(CFG_DIR, 'seed_images_named');
const META_FILE = path.join(CFG_DIR, '.sync-meta.json');
const CDN = 'https://cdn-resource.nqf.qq.com/release/remote/';
const XOR_KEY = Buffer.from('NQF_SHANGXIANDAMAI_#2026_SECURE', 'latin1');

// 支持同步的表：本地文件名 → { bundle, table, idKey, preserveLocalFields }
//   idKey: 用于去重/合并的主键字段
//   preserveLocalFields: 除「仅本地字段」外，额外强制保留的字段
const SYNC_TABLES = [
  { file: 'ItemInfo.json', bundle: 'mainscene', table: 'ItemInfo', idKey: 'id' },
  { file: 'Plant.json', bundle: 'mainscene', table: 'Plant', idKey: 'id' },
  { file: 'RoleLevel.json', bundle: 'mainscene', table: 'RoleLevel', idKey: 'level' },
];

// 图标查找顺序（bundle 名），gui/texture 图标主要在 extraRes
const ICON_BUNDLES = ['extraRes', 'mainscene', 'delayRes', 'plant'];

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function log(...args) {
  console.log(...args);
}

function warn(...args) {
  console.warn(...args);
}

/** HTTPS GET → Buffer；非 200 返回 null（不抛异常） */
function httpGet(url, timeout = 30000, redirects = 0) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      timeout,
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(httpGet(next, timeout, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ status: res.statusCode });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: 200, body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

/** XOR 解密（原地） */
function decryptXor(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) out[i] ^= XOR_KEY[i % XOR_KEY.length];
  return out;
}

// ---- Cocos Creator 压缩 UUID 解码 -------------------------------------------
const B64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUES = new Int32Array(123).fill(-1);
for (let i = 0; i < 64; i++) B64_VALUES[B64_KEYS.charCodeAt(i)] = i;

function decodeUuid(base64) {
  const uuid = String(base64).split('@')[0];
  if (uuid.length !== 22) return base64;
  const HexChars = '0123456789abcdef';
  const _t = ['', '', '', ''];
  const UuidTemplate = _t.concat(_t, ['-'], _t, ['-'], _t, ['-'], _t, ['-'], _t, _t, _t);
  const Indices = UuidTemplate.map((x, i) => (x === '-' ? -1 : i)).filter((i) => i !== -1);
  UuidTemplate[0] = uuid[0];
  UuidTemplate[1] = uuid[1];
  for (let i = 2, j = 2; i < 22; i += 2) {
    const lhs = B64_VALUES[uuid.charCodeAt(i)];
    const rhs = B64_VALUES[uuid.charCodeAt(i + 1)];
    UuidTemplate[Indices[j++]] = HexChars[lhs >> 2];
    UuidTemplate[Indices[j++]] = HexChars[((lhs & 3) << 2) | (rhs >> 4)];
    UuidTemplate[Indices[j++]] = HexChars[rhs & 0xF];
  }
  return UuidTemplate.join('');
}

// ---------------------------------------------------------------------------
// 版本发现：读游戏本地缓存拿最新 bundleVers
// ---------------------------------------------------------------------------
function findLocalGameSettings() {
  const bases = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'QQEX', 'miniapp', 'temps', 'miniapp_src'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'QQEX', 'miniapp', 'fs'), // 兜底
  ];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    let dirs;
    try {
      dirs = fs.readdirSync(base)
        .map((d) => ({ d, mt: fs.statSync(path.join(base, d)).mtimeMs }))
        .filter((x) => x.d)
        .sort((a, b) => b.mt - a.mt);
    } catch { continue; }
    for (const { d, mt } of dirs) {
      const srcDir = path.join(base, d, 'src');
      if (!fs.existsSync(srcDir)) continue;
      const settingsFile = fs.readdirSync(srcDir).find((f) => /^settings\..*\.json$/.test(f));
      if (!settingsFile) continue;
      try {
        const settings = JSON.parse(fs.readFileSync(path.join(srcDir, settingsFile), 'utf8'));
        const vers = (settings.assets && settings.assets.bundleVers) || {};
        return { settingsFile, srcDir, bundleVers: vers, mtime: mt, gameDir: d };
      } catch { /* 继续找 */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 官方资源拉取
// ---------------------------------------------------------------------------
async function fetchBundleConfig(bundle, vers) {
  const url = `${CDN}${bundle}/config.${vers}.json`;
  const r = await httpGet(url);
  if (r.status !== 200) throw new Error(`拉取 ${bundle}/config.${vers}.json 失败 (HTTP ${r.status})`);
  return JSON.parse(r.body.toString('utf8'));
}

/** 从 config 里解析某张表的 uuid + hash */
function resolveTable(cfg, tableName) {
  let idx = null;
  for (const [idxStr, v] of Object.entries(cfg.paths)) {
    const p = Array.isArray(v) ? v[0] : v;
    if (p === `config/${tableName}`) { idx = Number(idxStr); break; }
  }
  if (idx === null) return null;
  const importVers = {};
  const vi = cfg.versions.import || [];
  for (let i = 0; i + 1 < vi.length; i += 2) importVers[vi[i]] = vi[i + 1];
  const hash = importVers[idx];
  const uuid = decodeUuid(cfg.uuids[idx]);
  return { idx, uuid, hash };
}

/** 拉取并解密一张表 */
async function fetchTable(bundle, cfg, tableName) {
  const t = resolveTable(cfg, tableName);
  if (!t) throw new Error(`资源清单里找不到表 ${tableName}`);
  if (!t.hash) throw new Error(`表 ${tableName} 缺少 hash（清单版本不匹配？）`);
  const url = `${CDN}${bundle}/import/${t.uuid.slice(0, 2)}/${t.uuid}.${t.hash}.json`;
  const r = await httpGet(url);
  if (r.status !== 200) throw new Error(`拉取 ${tableName} 失败 (HTTP ${r.status}) ${url}`);
  const text = r.body.toString('utf8');
  // 数据文件结构：数组里混有多个字符串，最长的那个 base64 串是加密数据
  const matches = [...text.matchAll(/"([A-Za-z0-9+/=]{200,})"/g)].map((m) => m[1]);
  if (!matches.length) throw new Error(`表 ${tableName} 里找不到 base64 数据段`);
  matches.sort((a, b) => b.length - a.length);
  let data;
  try {
    data = JSON.parse(decryptXor(Buffer.from(matches[0], 'base64')).toString('utf8'));
  } catch (e) {
    throw new Error(`表 ${tableName} 解密后 JSON 解析失败: ${e.message}`);
  }
  if (!Array.isArray(data)) throw new Error(`表 ${tableName} 解密结果不是数组`);
  return { data, url };
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------
/**
 * 把官方全量数据合并进本地数组：
 *   - 官方条目为准覆盖同键条目；仅本地存在的字段保留原值
 *   - 官方没有、本地有的条目保留（不删除）
 * 返回 { merged, stats }
 */
/** 键序无关的稳定序列化，用于「是否真的变了」判断 */
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function mergeTable(localArr, onlineArr, idKey) {
  const onlineById = new Map();
  for (const it of onlineArr) onlineById.set(String(it[idKey]), it);
  const localById = new Map();
  for (const it of localArr) localById.set(String(it[idKey]), it);

  const stats = { added: [], removedLocal: [], changed: [], keptLocalOnly: [], sameCount: 0 };
  const merged = [];

  for (const o of onlineArr) {
    const key = String(o[idKey]);
    const l = localById.get(key);
    if (!l) {
      stats.added.push(o);
      merged.push(o);
      continue;
    }
    // 官方字段优先；仅本地字段保留
    const m = { ...l };
    for (const k of Object.keys(o)) m[k] = o[k];
    for (const k of Object.keys(l)) {
      if (!(k in o)) m[k] = l[k];
    }
    // 清理过期标记：官方名称已确认（非「道具XXX」占位）时，删除本地的未确认标记
    const officialName = String(o.name || '');
    if (officialName && !/^(道具|物品)\d+$/.test(officialName)) {
      delete m._name_unknown;
      delete m._name_confirmed;
    }
    // 只比较「本地已有字段」，忽略官方新增字段（那是官方新增字段，不算值变化）
    let valueChanged = false;
    const changedFields = [];
    for (const k of Object.keys(l)) {
      if (!(k in o)) continue;
      if (stableStringify(l[k]) !== stableStringify(o[k])) {
        valueChanged = true;
        changedFields.push(k);
      }
    }
    const newFields = Object.keys(o).filter((k) => !(k in l));
    if (valueChanged) {
      stats.changed.push({ key, name: o.name || l.name, local: l, merged: m, fields: changedFields, newFields });
    } else {
      stats.sameCount++;
      if (newFields.length) stats.newFieldsOnly = (stats.newFieldsOnly || 0) + 1;
    }
    merged.push(m);
  }

  for (const l of localArr) {
    const key = String(l[idKey]);
    if (!onlineById.has(key)) {
      stats.keptLocalOnly.push(l);
      merged.push(l);
    }
  }

  // 稳定排序：数字主键升序
  merged.sort((a, b) => (Number(a[idKey]) || 0) - (Number(b[idKey]) || 0));
  return { merged, stats };
}

/** 按项目现有风格写 JSON（2 空格缩进、CRLF、末尾换行、中文不转义） */
function writeJsonLikeExisting(filePath, data) {
  const json = JSON.stringify(data, null, 2).replace(/\n/g, '\r\n') + '\r\n';
  fs.writeFileSync(filePath, json, 'utf8');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// 元数据（记录上次同步版本，用于「有没有更新」判断）
// ---------------------------------------------------------------------------
function readMeta() {
  try { return readJson(META_FILE); } catch { return null; }
}
function writeMeta(patch) {
  const cur = readMeta() || {};
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(META_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// 图标同步
// ---------------------------------------------------------------------------
/** 收集 bundle 里所有资源：path → { idx, type, uuid(压缩), hash } */
function buildAssetIndex(cfg) {
  const importVers = {};
  const vi = cfg.versions.import || [];
  for (let i = 0; i + 1 < vi.length; i += 2) importVers[vi[i]] = vi[i + 1];
  const nativeVers = {};
  const vn = cfg.versions.native || [];
  for (let i = 0; i + 1 < vn.length; i += 2) nativeVers[vn[i]] = vn[i + 1];

  const index = new Map(); // path -> { idx, type, uuidShort, importHash, nativeHash }
  for (const [idxStr, v] of Object.entries(cfg.paths)) {
    const p = Array.isArray(v) ? v[0] : v;
    if (typeof p !== 'string') continue;
    const idx = Number(idxStr);
    index.set(p, {
      idx,
      type: Array.isArray(v) ? v[1] : undefined,
      uuidShort: cfg.uuids[idx],
      importHash: importVers[idx] || null,
      nativeHash: nativeVers[idx] || null,
    });
  }
  return index;
}

/** 检查下载到的文件类型 */
function detectImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 4 && buf[0] === 0x13 && buf[1] === 0xab) return 'astc';
  return 'unknown';
}

// ---- 纯 Node PNG 解码 / 编码 / 裁剪（用于从图集里切 sprite）----
function pngCrc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(pngCrc32(td));
  return Buffer.concat([len, td, crc]);
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];
  let palette = null, trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced png unsupported');
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bitDepth ${bitDepth} unsupported`);
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : (() => { throw new Error('colorType ' + colorType); })();
  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride);
    rp += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        v = (v + pr) & 0xff;
      }
      cur[x] = v;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    if (channels === 4) {
      rgba[i * 4] = out[i * 4]; rgba[i * 4 + 1] = out[i * 4 + 1]; rgba[i * 4 + 2] = out[i * 4 + 2]; rgba[i * 4 + 3] = out[i * 4 + 3];
    } else if (channels === 3) {
      rgba[i * 4] = out[i * 3]; rgba[i * 4 + 1] = out[i * 3 + 1]; rgba[i * 4 + 2] = out[i * 3 + 2]; rgba[i * 4 + 3] = 255;
    } else if (channels === 1 && palette) {
      const pi = out[i];
      rgba[i * 4] = palette[pi * 3]; rgba[i * 4 + 1] = palette[pi * 3 + 1]; rgba[i * 4 + 2] = palette[pi * 3 + 2];
      rgba[i * 4 + 3] = trns && pi < trns.length ? trns[pi] : 255;
    }
  }
  return { width, height, rgba };
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 从图集 PNG 里切出 rect 区域（支持 rotated） */
function cropFromAtlas(atlasBuf, rect, rotated) {
  const img = decodePng(atlasBuf);
  const { x, y, width: w, height: h } = rect;
  const out = Buffer.alloc(w * h * 4);
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      let sx, sy;
      if (rotated) {
        sx = x + oy;
        sy = y + (w - 1 - ox);
      } else {
        sx = x + ox;
        sy = y + oy;
      }
      const si = (sy * img.width + sx) * 4;
      const di = (oy * w + ox) * 4;
      out[di] = img.rgba[si]; out[di + 1] = img.rgba[si + 1]; out[di + 2] = img.rgba[si + 2]; out[di + 3] = img.rgba[si + 3];
    }
  }
  return encodePng(w, h, out);
}

/** 在 bundle 的图集（pack）里查 sprite 帧，返回 { packKey, frame } */
async function findInPacks(cfg, bundleName, spriteName, timeout = 30000) {
  if (!cfg.packs) return null;
  const importVers = {};
  const vi = cfg.versions.import || [];
  for (let i = 0; i + 1 < vi.length; i += 2) importVers[vi[i]] = vi[i + 1];
  for (const pk of Object.keys(cfg.packs)) {
    const idx = cfg.uuids.indexOf(pk);
    if (idx < 0) continue;
    const hash = importVers[idx];
    if (!hash) continue;
    const url = `${CDN}${bundleName}/import/${pk.slice(0, 2)}/${pk}.${hash}.json`;
    const r = await httpGet(url, timeout);
    if (r.status !== 200) continue;
    let js;
    try { js = JSON.parse(r.body.toString('utf8')); } catch { continue; }
    const frames = js[5];
    if (!Array.isArray(frames)) continue;
    for (const fr of frames) {
      const meta = fr[0] && fr[0][0];
      if (meta && meta.name === spriteName) {
        return { packKey: pk, hash, frame: meta, textureRef: (js[1] && js[1][0]) || null };
      }
    }
  }
  return null;
}

/**
 * 建立 bundle 的图集帧索引：一次性下载全部 pack 的 import，索引 帧名 → 位置。
 * 返回 Map<spriteName, { packKey, hash, frame, textureRef }>
 * 结果缓存在内存 + 磁盘（tmp/.pack-index-<bundle>.json），避免重复下载。
 */
async function buildPackIndex(cfg, bundleName, { timeout = 30000, useCache = true } = {}) {
  if (!cfg || !cfg.packs) return new Map();
  const cacheFile = path.join(ROOT, 'tmp', `.pack-index-${bundleName}.json`);
  const versKey = String(cfg.versions && cfg.versions.import && cfg.versions.import.length || 0);

  // 磁盘缓存：版本一致且较新（1 天内）则复用
  if (useCache && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached.versKey === versKey && Date.now() - (cached.at || 0) < 24 * 3600 * 1000) {
        const m = new Map();
        for (const [k, v] of Object.entries(cached.frames || {})) m.set(k, v);
        return m;
      }
    } catch { /* 缓存损坏，重建 */ }
  }

  const importVers = {};
  const vi = cfg.versions.import || [];
  for (let i = 0; i + 1 < vi.length; i += 2) importVers[vi[i]] = vi[i + 1];

  const index = new Map();
  const packKeys = Object.keys(cfg.packs);
  // 4 路并发
  const queue = [...packKeys];
  async function worker() {
    while (queue.length) {
      const pk = queue.shift();
      const idx = cfg.uuids.indexOf(pk);
      if (idx < 0) continue;
      const hash = importVers[idx];
      if (!hash) continue;
      const url = `${CDN}${bundleName}/import/${pk.slice(0, 2)}/${pk}.${hash}.json`;
      const r = await httpGet(url, timeout);
      if (r.status !== 200) continue;
      let js;
      try { js = JSON.parse(r.body.toString('utf8')); } catch { continue; }
      const frames = js[5];
      if (!Array.isArray(frames)) continue;
      const textureRef = (js[1] && js[1][0]) || null;
      for (const fr of frames) {
        const meta = fr[0] && fr[0][0];
        if (meta && meta.name && !index.has(meta.name)) {
          index.set(meta.name, { packKey: pk, hash, frame: meta, textureRef });
        }
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);

  // 写缓存（只保留必要字段以控体积）
  try {
    const obj = {};
    for (const [k, v] of index) {
      obj[k] = { packKey: v.packKey, frame: v.frame, textureRef: v.textureRef };
    }
    fs.writeFileSync(cacheFile, JSON.stringify({ versKey, at: Date.now(), frames: obj }), 'utf8');
  } catch { /* 缓存写失败不影响主流程 */ }

  return index;
}

/** 从 pack 图集下载纹理并切图（可选 packIndex 加速） */
async function extractFromPack(cfg, bundleName, spriteName, opts = {}) {
  const { timeout = 60000, packIndex = null } = opts;
  let hit = null;
  if (packIndex && packIndex.has(spriteName)) {
    hit = packIndex.get(spriteName);
  } else {
    hit = await findInPacks(cfg, bundleName, spriteName, timeout);
  }
  if (!hit) return null;
  const frame = hit.frame;
  const rect = frame.rect;
  if (!rect) return null;
  const ref = String(hit.textureRef || '').split('@')[0];
  if (!ref) return null;
  // 找纹理资源的 native hash
  const texIdx = cfg.uuids.findIndex((u) => String(u).split('@')[0] === ref);
  if (texIdx < 0) return null;
  const vn = cfg.versions.native || [];
  let nativeHash = null;
  for (let i = 0; i + 1 < vn.length; i += 2) if (vn[i] === texIdx) nativeHash = vn[i + 1];
  if (!nativeHash) return null;
  const uuid = decodeUuid(cfg.uuids[texIdx]);
  const url = `${CDN}${bundleName}/native/${uuid.slice(0, 2)}/${uuid}.${nativeHash}.png`;
  const r = await httpGet(url, timeout);
  if (r.status !== 200) return null;
  const kind = detectImage(r.body);
  if (kind !== 'png') return null;
  try {
    const out = cropFromAtlas(r.body, rect, !!frame.rotated);
    return { body: out, url, kind: 'png', fromPack: hit.packKey, rect };
  } catch (e) {
    return null;
  }
}

async function downloadIcon(assetIndexes, bundle, spriteName, timeout = 30000) {
  // 依次在每个 bundle 里找 <spriteName> 资源：
  //   - gui/texture/.../<spriteName>/spriteFrame 类型（type=6，SpriteFrame）
  //   - gui/texture/.../<spriteName> 类型（type=4，ImageAsset）
  //   - model/v4/<spriteName>（type=0/1/2，种子等模型资源）
  // 优先下载同 uuid 的 native 图片（PNG/JPG）；若只有 ASTC 也返回（调用方决定）
  const suffixes = [
    `${spriteName}/spriteFrame`,
    `/${spriteName}`,
  ];
  for (const { bundleName, index } of assetIndexes) {
    for (const [p, meta] of index) {
      const matched = suffixes.some((sfx) => p === sfx || p.endsWith(sfx));
      if (!matched) continue;
      if (meta.type !== 4 && meta.type !== 6 && meta.type !== 0) continue;
      const fullUuid = String(decodeUuid(meta.uuidShort)).split('@')[0];
      // 优先 native 直接图（PNG/JPG）
      if (meta.nativeHash) {
        const url = `${CDN}${bundleName}/native/${fullUuid.slice(0, 2)}/${fullUuid}.${meta.nativeHash}.png`;
        const r = await httpGet(url, timeout);
        if (r.status === 200) {
          const kind = detectImage(r.body);
          if (kind === 'png' || kind === 'jpg') return { body: r.body, url, kind, path: p, bundle: bundleName };
        }
      }
      // 没有 native hash 时，尝试不带 hash 的 native URL（部分资源如此）
      {
        const url = `${CDN}${bundleName}/native/${fullUuid.slice(0, 2)}/${fullUuid}.png`;
        const r = await httpGet(url, timeout);
        if (r.status === 200) {
          const kind = detectImage(r.body);
          if (kind === 'png' || kind === 'jpg') return { body: r.body, url, kind, path: p, bundle: bundleName };
        }
      }
      // 退回 import 描述（可能指向图集）
      if (meta.importHash) {
        const url = `${CDN}${bundleName}/import/${fullUuid.slice(0, 2)}/${fullUuid}.${meta.importHash}.json`;
        const r = await httpGet(url, timeout);
        if (r.status === 200) {
          return { body: r.body, url, kind: 'json', path: p, bundle: bundleName };
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------
async function loadOnlineTables(bundleVers, tables, { quiet = false } = {}) {
  const bundleCfgs = new Map();
  const result = {};
  for (const t of tables) {
    const vers = bundleVers[t.bundle];
    if (!vers) { warn(`  ! bundle ${t.bundle} 没有版本号，跳过 ${t.table}`); continue; }
    if (!bundleCfgs.has(t.bundle)) {
      const cfg = await fetchBundleConfig(t.bundle, vers);
      bundleCfgs.set(t.bundle, cfg);
    }
    const cfg = bundleCfgs.get(t.bundle);
    const { data, url } = await fetchTable(t.bundle, cfg, t.table);
    result[t.table] = { data, url };
    if (!quiet) log(`  ✓ ${t.table}: ${data.length} 条  (${t.bundle}/${vers})`);
  }
  return result;
}

async function cmdCheck(opts) {
  log('== QQ 农场配置同步 · 检查更新 ==\n');
  const local = findLocalGameSettings();
  if (!local) {
    warn('✗ 找不到游戏本地缓存（%APPDATA%/QQEX/miniapp/temps/miniapp_src）。');
    warn('  请先启动一次 QQ 农场游戏客户端，再运行本工具。');
    return 2;
  }
  log(`游戏缓存: ${local.gameDir}`);
  log(`配置文件: ${local.settingsFile}`);
  log(`bundleVers: ${Object.entries(local.bundleVers).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);

  const meta = readMeta() || {};
  const prevVers = (meta.bundleVers && meta.bundleVers.mainscene) || null;
  const curVers = local.bundleVers.mainscene || null;
  if (prevVers && curVers && prevVers === curVers) {
    log(`✓ 官方版本未变（mainscene=${curVers}），无需同步。`);
    log(`  （上次同步于 ${meta.updatedAt || '未知'}）`);
    return 0;
  }
  if (prevVers) log(`版本变化: mainscene ${prevVers} → ${curVers}`);

  log('\n拉取官方最新数据...');
  const online = await loadOnlineTables(local.bundleVers, SYNC_TABLES);

  let needSync = false;
  for (const t of SYNC_TABLES) {
    if (!online[t.table]) continue;
    const localPath = path.join(CFG_DIR, t.file);
    const localArr = fs.existsSync(localPath) ? readJson(localPath) : [];
    const { stats } = mergeTable(localArr, online[t.table].data, t.idKey);
    const total = stats.added.length + stats.changed.length;
    if (total > 0 || stats.keptLocalOnly.length) needSync = true;
    log(`\n[${t.table}] 本地 ${localArr.length} 条 / 官方 ${online[t.table].data.length} 条`);
    if (stats.added.length) {
      log(`  + 官方新增 ${stats.added.length} 条:`);
      for (const it of stats.added.slice(0, 12)) log(`      ${it[t.idKey]} ${it.name || ''}`);
      if (stats.added.length > 12) log(`      ... 其余 ${stats.added.length - 12} 条`);
    }
    if (stats.changed.length) {
      log(`  ~ 官方更新 ${stats.changed.length} 条（示例 8 条）:`);
      for (const c of stats.changed.slice(0, 8)) {
        log(`      ${c.key} ${c.name || ''}  [字段: ${c.fields.slice(0, 6).join(', ')}${c.fields.length > 6 ? ', ...' : ''}]`);
        for (const f of c.fields.slice(0, 3)) {
          const before = JSON.stringify(c.local[f]);
          const after = JSON.stringify(c.merged[f]);
          log(`         ${f}: ${String(before).slice(0, 50)} → ${String(after).slice(0, 50)}`);
        }
      }
    }
    if (stats.keptLocalOnly.length) {
      log(`  · 本地独有 ${stats.keptLocalOnly.length} 条（官方已下架，将保留）:`);
      for (const it of stats.keptLocalOnly.slice(0, 8)) log(`      ${it[t.idKey]} ${it.name || ''}`);
    }
    if (!total && !stats.keptLocalOnly.length) log('  = 无变化');
  }

  log(needSync ? '\n→ 有更新。运行: node scripts/sync-game-config.js sync --write' : '\n→ 数据已是最新。');
  return 0;
}

async function cmdSync(opts) {
  const write = !!opts.write;
  log(`== QQ 农场配置同步 · ${write ? '写入' : '预览(dry-run)'} ==\n`);
  const local = findLocalGameSettings();
  if (!local) {
    warn('✗ 找不到游戏本地缓存。请先启动一次 QQ 农场客户端。');
    return 2;
  }
  log(`bundleVers: ${Object.entries(local.bundleVers).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);
  log('拉取官方全量数据...');
  const online = await loadOnlineTables(local.bundleVers, SYNC_TABLES);

  let wrote = 0;
  const summary = [];
  for (const t of SYNC_TABLES) {
    if (!online[t.table]) continue;
    const localPath = path.join(CFG_DIR, t.file);
    const localArr = fs.existsSync(localPath) ? readJson(localPath) : [];
    const { merged, stats } = mergeTable(localArr, online[t.table].data, t.idKey);
    summary.push({ table: t.table, before: localArr.length, after: merged.length, stats });
    log(`\n[${t.table}] 本地 ${localArr.length} → ${merged.length} 条`);
    log(`  + 新增 ${stats.added.length}  ~ 更新 ${stats.changed.length}  = 不变 ${stats.sameCount}  · 保留本地独有 ${stats.keptLocalOnly.length}`);
    if (write) {
      writeJsonLikeExisting(localPath, merged);
      wrote++;
      log(`  ✓ 已写入 ${t.file}`);
    } else {
      log(`  (预览模式，未写入)`);
    }
  }

  if (write) {
    writeMeta({
      bundleVers: local.bundleVers,
      gameDir: local.gameDir,
      settingsFile: local.settingsFile,
      tables: summary.map((s) => ({ table: s.table, before: s.before, after: s.after, added: s.stats.added.length, updated: s.stats.changed.length })),
    });
    log(`\n✓ 已同步 ${wrote} 张表，元数据写入 ${path.relative(ROOT, META_FILE)}`);
  } else {
    log('\n（dry-run 结束；加 --write 实际写入）');
  }
  return 0;
}

async function cmdIcons(opts) {
  const write = !!opts.write;
  log(`== QQ 农场配置同步 · 图标${write ? '下载' : '检查'} ==\n`);
  const local = findLocalGameSettings();
  if (!local) {
    warn('✗ 找不到游戏本地缓存。请先启动一次 QQ 农场客户端。');
    return 2;
  }

  const itemFile = path.join(CFG_DIR, 'ItemInfo.json');
  const items = readJson(itemFile);
  const plantFile = path.join(CFG_DIR, 'Plant.json');
  const plants = fs.existsSync(plantFile) ? readJson(plantFile) : [];
  const existingIcons = new Set(fs.readdirSync(IMG_DIR));

  // 已有图标的 id
  const haveIds = new Set();
  for (const f of existingIcons) {
    const m = f.match(/^(\d+)[_.]/);
    if (m) haveIds.add(Number(m[1]));
  }

  // 需要的图标：
  //   A. ItemInfo 条目有 icon_res（如 gui/texture/icon/icon_xxx/spriteFrame）
  //   B. Plant.json 种子的 asset_name（Crop_XXX → Crop_XXX_Seed，走 asset 回退）
  const need = [];
  const dynamicSkip = []; // 动态合成资源（官方客户端运行时合成，CDN 无静态资源）
  for (const it of items) {
    const id = Number(it.id);
    if (!id || haveIds.has(id)) continue;
    const ir = String(it.icon_res || '');
    const m = ir.match(/\/([^/]+)\/spriteFrame$/);
    if (!m) continue;
    // 种子解锁卡等用的是 icon_card_crop_* —— 客户端「卡面底图 + 种子图」动态合成，
    // 全量扫描 234 个图集与所有 bundle 清单均无此静态资源；前端靠 asset_name 回退显示
    // 自选礼包 giftpack_* 同类（客户端运行时按礼包内容合成）
    if (/icon_card_crop_|^giftpack_/.test(m[1])) {
      dynamicSkip.push({ id, name: it.name || '', sprite: m[1] });
      continue;
    }
    need.push({ id, name: it.name || '', sprite: m[1], kind: 'item' });
  }
  // 种子图标：从 ItemInfo 的「种子」条目取 asset_name（Crop_XXX / gold/Crop_XXX）
  // 目标文件名：<种子id>_Seed.png（匹配既有 20516_Seed.png 命名）
  const haveSeedFiles = new Set();
  const haveSeedAssets = new Set();
  for (const f of existingIcons) {
    const m = f.match(/^(\d+)_Seed\.png$/i);
    if (m) haveSeedFiles.add(Number(m[1]));
    const m2 = f.match(/^(Crop_\d+_Seed)\.png$/i);
    if (m2) haveSeedAssets.add(m2[1]);
  }
  for (const it of items) {
    const id = Number(it.id);
    if (!id || haveIds.has(id)) continue;
    const asset = String(it.asset_name || '');
    const m = asset.match(/^(gold\/)?(Crop_\d+)$/);
    if (!m) continue;
    // 只处理种子类（interaction_type=plant 或有 icon_res 指向 card 的解锁卡）
    const isSeed = String(it.interaction_type || '') === 'plant' || /种子/.test(String(it.name || ''));
    const isCard = /icon_card_crop_/.test(String(it.icon_res || ''));
    if (!isSeed && !isCard) continue;
    if (haveSeedFiles.has(id)) continue;
    const sprite = `${asset}_Seed`;
    if (haveSeedAssets.has(sprite)) continue;
    need.push({ id, name: it.name || '', sprite, kind: 'seed' });
  }

  log(`ItemInfo ${items.length} 条 + Plant ${plants.length} 种；需补图标 ${need.length} 个` +
    (dynamicSkip.length ? `（另有 ${dynamicSkip.length} 个动态合成资源跳过：客户端运行时合成，CDN 无静态图，前端已按 asset_name 回退显示）` : '') + '\n');
  if (!need.length) {
    log('✓ 所有可下载图标均已就绪');
    if (dynamicSkip.length) log(`  （${dynamicSkip.length} 个动态合成资源：如「种子解锁卡」，前端显示为对应种子图）`);
    return 0;
  }

  for (const n of need.slice(0, 30)) log(`  ${n.id} ${n.name}  <- ${n.sprite}${n.kind === 'seed' ? ' (种子)' : ''}`);
  if (need.length > 30) log(`  ... 其余 ${need.length - 30} 条`);

  if (!write) {
    log('\n（检查模式；加 --write 下载）');
    return 0;
  }

  // 建各 bundle 的资源索引
  log('\n加载资源清单...');
  const assetIndexes = [];
  for (const b of ICON_BUNDLES) {
    const vers = local.bundleVers[b];
    if (!vers) continue;
    try {
      const cfg = await fetchBundleConfig(b, vers);
      assetIndexes.push({ bundleName: b, index: buildAssetIndex(cfg), cfg, packIndex: null });
      log(`  ✓ ${b}: ${cfg.paths ? Object.keys(cfg.paths).length : 0} 个资源项`);
    } catch (e) {
      warn(`  ! ${b}: ${e.message}`);
    }
  }
  if (!assetIndexes.length) { warn('✗ 没有可用的资源清单'); return 2; }

  // 图集索引按需建立（只在「直接下载」全部未命中时建，避免无谓下载）
  let packIndexReady = false;
  async function ensurePackIndexes() {
    if (packIndexReady) return;
    log('\n建立图集索引（首次运行需下载资源图集清单，之后走缓存）...');
    for (const ai of assetIndexes) {
      try {
        ai.packIndex = await buildPackIndex(ai.cfg, ai.bundleName);
        log(`  ✓ ${ai.bundleName}: 图集索引 ${ai.packIndex.size} 个帧`);
      } catch (e) {
        warn(`  ! ${ai.bundleName}: ${e.message}`);
        ai.packIndex = new Map();
      }
    }
    packIndexReady = true;
  }

  let ok = 0, fail = 0, packOk = 0;
  const failed = [];
  for (const n of need) {
    try {
      // 1) 常规：清单里直接的 ImageAsset / spriteFrame
      const r = await downloadIcon(assetIndexes, n.id, n.sprite);
      if (r) {
        let ext = null;
        if (r.kind === 'png') ext = 'png';
        else if (r.kind === 'jpg') ext = 'jpg';
        if (ext) {
          const outName = `${n.id}_${n.sprite}.${ext}`;
          fs.writeFileSync(path.join(IMG_DIR, outName), r.body);
          ok++;
          log(`  ✓ ${n.id} ${n.name} -> ${outName} (${r.body.length}B)`);
          continue;
        }
      }
      // 2) 回退：图集（pack）里切图
      await ensurePackIndexes();
      let packHit = null;
      for (const ai of assetIndexes) {
        if (!ai.cfg) continue;
        packHit = await extractFromPack(ai.cfg, ai.bundleName, n.sprite, { packIndex: ai.packIndex });
        if (packHit) break;
      }
      if (packHit) {
        const outName = `${n.id}_${n.sprite}.png`;
        fs.writeFileSync(path.join(IMG_DIR, outName), packHit.body);
        packOk++;
        log(`  ✓ ${n.id} ${n.name} -> ${outName} (图集切图, ${packHit.body.length}B)`);
        continue;
      }
      // 3) 都不行
      fail++;
      failed.push(`${n.id} ${n.name} (${n.sprite}: 清单/图集均未找到)`);
    } catch (e) {
      fail++;
      failed.push(`${n.id} ${n.name}: ${e.message}`);
    }
  }

  log(`\n完成: 直接下载 ${ok}, 图集切图 ${packOk}, 失败 ${fail}`);
  if (failed.length) {
    log('失败明细:');
    for (const f of failed.slice(0, 20)) log(`  ✗ ${f}`);
    if (failed.length > 20) log(`  ... 其余 ${failed.length - 20} 条`);
  }
  return fail === 0 ? 0 : 1;
}

async function cmdTables(opts) {
  log('== 官方资源清单里的全部配置表 ==\n');
  const local = findLocalGameSettings();
  if (!local) { warn('✗ 找不到游戏本地缓存。'); return 2; }
  const bundle = opts.bundle || 'mainscene';
  const vers = local.bundleVers[bundle];
  if (!vers) { warn(`✗ 没有 ${bundle} 的版本号`); return 2; }
  const cfg = await fetchBundleConfig(bundle, vers);
  const tables = [];
  for (const [idxStr, v] of Object.entries(cfg.paths)) {
    const p = Array.isArray(v) ? v[0] : v;
    if (typeof p === 'string' && p.startsWith('config/')) {
      tables.push({ idx: Number(idxStr), name: p.slice('config/'.length) });
    }
  }
  tables.sort((a, b) => a.name.localeCompare(b.name));
  log(`${bundle}/${vers} 共 ${tables.length} 张配置表:`);
  for (const t of tables) log(`  ${t.name}`);
  return 0;
}

async function cmdRaw(opts) {
  const name = opts._[1];
  if (!name) { warn('用法: node scripts/sync-game-config.js raw <表名> [--bundle mainscene]'); return 2; }
  const local = findLocalGameSettings();
  if (!local) { warn('✗ 找不到游戏本地缓存。'); return 2; }
  const bundle = opts.bundle || 'mainscene';
  const vers = local.bundleVers[bundle];
  const cfg = await fetchBundleConfig(bundle, vers);
  const { data, url } = await fetchTable(bundle, cfg, name);
  const out = path.join(ROOT, 'tmp', `online-${name}.json`);
  fs.writeFileSync(out, JSON.stringify(data, null, 1), 'utf8');
  log(`✓ ${name}: ${data.length} 条 -> ${path.relative(ROOT, out)}`);
  return 0;
}

/**
 * 自动同步（供服务端定时/启动调用）：检测 bundleVers 是否变化，变化才联网同步。
 * 版本未变时零网络开销，只读本地文件。
 * @param {{write?: boolean, doIcons?: boolean}} opts
 * @returns {Promise<{ok: boolean, upToDate?: boolean, reason?: string, rcSync?: number, rcIcons?: number, bundleVers?: object}>}
 */
async function autoSync({ write = true, doIcons = true } = {}) {
  const local = findLocalGameSettings();
  if (!local) return { ok: false, reason: 'no-game-cache' };
  const meta = readMeta() || {};
  const norm = (vers) => JSON.stringify(
    Object.keys(vers || {}).sort().map((k) => [k, vers[k]])
  );
  if (meta.bundleVers && norm(meta.bundleVers) === norm(local.bundleVers)) {
    return { ok: true, upToDate: true, bundleVers: local.bundleVers };
  }
  const rcSync = await cmdSync({ write });
  const rcIcons = doIcons ? await cmdIcons({ write }) : 0;
  return {
    ok: rcSync === 0 && rcIcons === 0,
    upToDate: false,
    rcSync,
    rcIcons,
    bundleVers: local.bundleVers,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [], write: false };
  for (const a of argv) {
    if (a === '--write') out.write = true;
    else if (a.startsWith('--bundle=')) out.bundle = a.slice(9);
    else if (a.startsWith('--bundle')) { /* 下一参数形式忽略 */ }
    else if (!a.startsWith('--')) out._.push(a);
  }
  // --bundle xxx 形式
  const bi = argv.indexOf('--bundle');
  if (bi >= 0 && argv[bi + 1]) out.bundle = argv[bi + 1];
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0] || 'check';
  const cmds = {
    check: cmdCheck,
    sync: cmdSync,
    icons: cmdIcons,
    tables: cmdTables,
    raw: cmdRaw,
    auto: async (o) => {
      const r = await autoSync({ write: o.write !== false, doIcons: true });
      if (r.reason === 'no-game-cache') { warn('✗ 找不到游戏本地缓存'); return 2; }
      if (r.upToDate) { log('✓ 已是最新，无需同步'); return 0; }
      return r.ok ? 0 : 1;
    },
    all: async (o) => {
      const rc1 = await cmdSync(o);
      if (rc1 !== 0) return rc1;
      return cmdIcons(o);
    },
  };
  if (!cmds[cmd]) {
    warn(`未知命令: ${cmd}`);
    log('可用命令: check | sync | icons | tables | raw <表名> | all | auto');
    log('通用参数: --write 实际写入（默认 dry-run）');
    return 2;
  }
  return cmds[cmd](opts);
}

if (require.main === module) {
  main().then((rc) => process.exit(rc)).catch((e) => {
    console.error('执行失败:', e.message);
    process.exit(1);
  });
} else {
  // 作为模块被引用（测试用）：导出内部函数
  module.exports = {
    findLocalGameSettings,
    fetchBundleConfig,
    resolveTable,
    fetchTable,
    mergeTable,
    buildAssetIndex,
    downloadIcon,
    findInPacks,
    buildPackIndex,
    extractFromPack,
    decodePng,
    encodePng,
    cropFromAtlas,
    decryptXor,
    decodeUuid,
    detectImage,
    stableStringify,
    SYNC_TABLES,
    autoSync,
  };
}

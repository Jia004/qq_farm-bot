'use strict';

/**
 * QQ 农场 Bot - 抓包资源存档（capture asset store）
 *
 * 目的
 * ----
 * 游戏客户端启动时会从官方 CDN 下载 Cocos 资源清单（manifest.json）以及
 * .astc 纹理图集。官方 CDN 不公开目录，新物品的图标想补齐，就必须先从
 * 游戏客户端的真实流量里把这些资源抓下来（见 scripts/extract_item_icons.py）。
 *
 * 抓包代理（capture-mitm.js）原本只把请求 URL 记进事件流，响应体直接转给
 * 客户端、不落盘。本模块补上「把想要的响应体存下来」这一步：
 *
 *   1. createCaptureAssetStore：落盘器，按 URL 去重存到指定目录；
 *   2. createConnectionAssetTracker：按 HTTP/1.1 顺序应答模型，把同一 TLS
 *      连接上多个响应依次归因到对应请求（请求队列 + Content-Length /
 *      chunked 帧解析），收全后才提交落盘。
 *
 * 只存文本类（json/js/manifest/txt/xml/plist）与 ASTC 纹理，带体积上限；
 * 完全旁路：不参与转发、不影响抓包主功能（登录 code / 好友 gid），异常吞掉。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const TEXT_EXT = new Set(['.json', '.js', '.manifest', '.txt', '.xml', '.plist']);
const BINARY_EXT = new Set(['.astc', '.pkm', '.ktx']);
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_BINARY_BYTES = 32 * 1024 * 1024;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_RAW_BYTES = 48 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 4000;
const MAX_PENDING_REQUESTS = 64;
const MAX_TRAILER_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function detectExt(url) {
    let pathname = String(url || '');
    try {
        pathname = new URL(pathname, 'https://placeholder.invalid').pathname;
    } catch { /* 保底用原始串 */ }
    const base = pathname.split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return '';
    return base.slice(dot).toLowerCase();
}

function isWanted(url) {
    const ext = detectExt(url);
    return TEXT_EXT.has(ext) || BINARY_EXT.has(ext);
}

function looksJsonish(buffer) {
    if (!buffer || buffer.length === 0) return false;
    let i = 0;
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) i = 3;
    while (i < buffer.length && (buffer[i] === 0x20 || buffer[i] === 0x0A || buffer[i] === 0x0D || buffer[i] === 0x09)) i += 1;
    return buffer[i] === 0x7B || buffer[i] === 0x5B; // { 或 [
}

/**
 * 解析 HTTP 响应头块（含结尾空行）。
 * @param {Buffer|string} headBuffer
 * @returns {{ status:number, chunked:boolean, contentLength:number, contentEncoding:string, contentType:string }}
 */
function parseResponseHead(headBuffer) {
    const text = Buffer.isBuffer(headBuffer) ? headBuffer.toString('latin1') : String(headBuffer || '');
    const firstLine = text.split('\r\n')[0] || '';
    const statusMatch = firstLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    const lower = text.toLowerCase();
    const chunked = /transfer-encoding:\s*[^\r\n]*chunked/.test(lower);
    const lenMatch = lower.match(/content-length:\s*(\d+)/);
    const contentLength = lenMatch ? Number(lenMatch[1]) : -1;
    const encodingMatch = text.match(/content-encoding:\s*([^\r\n]+)/i);
    const contentTypeMatch = text.match(/content-type:\s*([^\r\n;]+)/i);
    return {
        status,
        chunked,
        contentLength,
        contentEncoding: encodingMatch ? encodingMatch[1].trim().toLowerCase() : '',
        contentType: contentTypeMatch ? contentTypeMatch[1].trim().toLowerCase() : '',
    };
}

/**
 * 解析完整 chunked 正文（buffer 从第一个 chunk-size 行开始）。
 * @returns {{ body: Buffer, consumed: number }|null} 未收全返回 null
 */
function decodeChunked(buffer) {
    const parts = [];
    let offset = 0;
    for (;;) {
        const lineEnd = buffer.indexOf('\r\n', offset, 'latin1');
        if (lineEnd < 0) return null;
        const sizeText = buffer.toString('latin1', offset, lineEnd).split(';')[0].trim();
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(size)) return null;
        const dataStart = lineEnd + 2;
        if (size === 0) {
            // 结束块；通常紧跟 \r\n（无 trailer），否则在有限窗口内找 trailer 终止
            if (buffer.length < dataStart + 2) return null;
            if (buffer.toString('latin1', dataStart, dataStart + 2) === '\r\n') {
                return { body: Buffer.concat(parts), consumed: dataStart + 2 };
            }
            const searchEnd = Math.min(buffer.length, dataStart + MAX_TRAILER_BYTES);
            const end = buffer.indexOf('\r\n\r\n', dataStart, 'latin1');
            if (end < 0 || end > searchEnd) return null;
            return { body: Buffer.concat(parts), consumed: end + 4 };
        }
        if (buffer.length < dataStart + size + 2) return null;
        parts.push(buffer.subarray(dataStart, dataStart + size));
        offset = dataStart + size + 2;
    }
}

function maybeGunzip(buffer, encoding) {
    const enc = String(encoding || '').toLowerCase();
    try {
        if (enc === 'gzip') return zlib.gunzipSync(buffer);
        if (enc === 'deflate') return zlib.inflateSync(buffer);
        if (enc === 'br') return zlib.brotliDecompressSync(buffer);
        if (buffer.length > 2 && buffer[0] === 0x1F && buffer[1] === 0x8B) return zlib.gunzipSync(buffer);
        if (buffer.length > 2 && buffer[0] === 0x78) return zlib.inflateSync(buffer);
    } catch { /* 不是压缩体，原样返回 */ }
    return buffer;
}

// ---------------------------------------------------------------------------
// 落盘器
// ---------------------------------------------------------------------------

/**
 * @param {{ dir:string, logger?:object, maxEntries?:number }} options
 */
function createCaptureAssetStore({ dir, logger = null, maxEntries = MAX_INDEX_ENTRIES, maxTotalBytes = 512 * 1024 * 1024 } = {}) {
    const index = new Map(); // id -> meta
    const aliasOwners = new Map(); // aliasName -> id
    let dirReady = false;
    let diskWarned = false;
    let totalBytes = 0;

    function ensureDir() {
        if (dirReady) return true;
        try {
            fs.mkdirSync(dir, { recursive: true });
            dirReady = true;
            return true;
        } catch (error) {
            if (!diskWarned) {
                diskWarned = true;
                logger?.warn?.(`[CaptureAssets] 无法创建资源目录 ${dir}: ${error.message}`);
            }
            return false;
        }
    }

    function keyFor(host, url) {
        return crypto.createHash('sha1').update(`${host}${url}`).digest('hex').slice(0, 16);
    }

    function saveIndex() {
        if (!dirReady) return;
        try {
            const list = [...index.values()].slice(-maxEntries);
            const tmp = path.join(dir, 'index.json.tmp');
            fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
            fs.renameSync(tmp, path.join(dir, 'index.json'));
        } catch { /* 索引写失败不影响资源本身 */ }
    }

    /**
     * 提交一个完整响应体。
     * @returns {string} 落盘文件名；未存储返回空串
     */
    function commit({ host, url, body, contentType = '', status = 200 }) {
        try {
            if (!body || body.length === 0) return '';
            if (status !== 200) return '';
            const ext = detectExt(url);
            const isBinary = BINARY_EXT.has(ext);
            if (!isBinary && !TEXT_EXT.has(ext) && !looksJsonish(body)) return '';
            const limit = isBinary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES;
            if (body.length > limit) return '';
            // 总量上限：避免长时间挂着代理无上限囤资源
            if (totalBytes + body.length > maxTotalBytes) {
                if (!diskWarned) {
                    diskWarned = true;
                    logger?.warn?.(`[CaptureAssets] 存档总量已达上限（${Math.round(maxTotalBytes / 1024 / 1024)}MB），后续资源不再落盘`);
                }
                return '';
            }
            if (!ensureDir()) return '';

            const id = keyFor(host, url);
            const fileName = `${id}${ext || (isBinary ? '.bin' : '.json')}`;
            fs.writeFileSync(path.join(dir, fileName), body);
            totalBytes += body.length;

            const meta = {
                id,
                file: fileName,
                host: String(host || ''),
                url: String(url || ''),
                status,
                size: body.length,
                contentType,
                isText: !isBinary,
                at: Date.now(),
            };

            // 命中资源清单（manifest）时额外写一份带原文件名的副本，方便直接喂给工具
            const base = String(url || '').split('?')[0].split('/').pop() || '';
            const manifestLike = /manifest/i.test(base)
                || (!isBinary && /"images"\s*:/.test(body.toString('utf8', 0, Math.min(body.length, 8192))));
            if (manifestLike) {
                let aliasName = base || `${id}-manifest.json`;
                const owner = aliasOwners.get(aliasName);
                if (owner && owner !== id) aliasName = `${id}-${aliasName}`;
                try {
                    fs.writeFileSync(path.join(dir, aliasName), body);
                    aliasOwners.set(aliasName, id);
                    meta.alias = aliasName;
                } catch { /* 副本失败不影响主存档 */ }
            }

            index.set(id, meta);
            saveIndex();
            logger?.info?.(`[CaptureAssets] 已存档 ${host}${String(url).split('?')[0]} -> ${fileName}（${body.length} 字节）`);
            return fileName;
        } catch (error) {
            if (!diskWarned) {
                diskWarned = true;
                logger?.warn?.(`[CaptureAssets] 资源写盘失败: ${error.message}`);
            }
            return '';
        }
    }

    function list() {
        return [...index.values()];
    }

    function reset() {
        index.clear();
        aliasOwners.clear();
        totalBytes = 0;
    }

    return {
        dir,
        commit,
        list,
        reset,
        getTotalBytes: () => totalBytes,
    };
}

// ---------------------------------------------------------------------------
// 连接级响应跟踪器
// ---------------------------------------------------------------------------

function createConnectionAssetTracker({ store, logger = null } = {}) {
    const queue = [];
    let current = null;
    let disabled = false;
    const stats = { requests: 0, responses: 0, stored: 0, dropped: 0 };

    function disable(reason) {
        if (!disabled) {
            disabled = true;
            logger?.warn?.(`[CaptureAssets] 连接跟踪已放弃：${reason}`);
        }
    }

    function startNext() {
        current = queue.length > 0
            ? { req: queue.shift(), raw: Buffer.alloc(0), head: null, headEnd: 0 }
            : null;
    }

    function enqueue(reqInfo) {
        if (disabled || !reqInfo) return;
        if (queue.length >= MAX_PENDING_REQUESTS) {
            queue.shift();
            stats.dropped += 1;
        }
        queue.push({
            host: String(reqInfo.host || ''),
            url: String(reqInfo.url || '/'),
            method: String(reqInfo.method || 'GET').toUpperCase(),
            at: Date.now(),
        });
        stats.requests += 1;
        if (!current) startNext();
    }

    function feed(chunk) {
        if (disabled || !chunk || chunk.length === 0) return;
        if (!current) return; // 无在途请求，字节无法归因，忽略
        try {
            ingest(chunk);
        } catch (error) {
            disable(`解析异常：${error.message}`);
        }
    }

    function ingest(chunk) {
        current.raw = Buffer.concat([current.raw, chunk]);
        if (current.raw.length > MAX_RAW_BYTES) {
            stats.dropped += 1;
            disable('响应体积超出上限');
            return;
        }

        if (!current.head) {
            const idx = current.raw.indexOf('\r\n\r\n');
            if (idx < 0) {
                if (current.raw.length > MAX_HEAD_BYTES) disable('响应头过大');
                return;
            }
            current.headEnd = idx + 4;
            current.head = parseResponseHead(current.raw.subarray(0, current.headEnd));
            const st = current.head.status;
            if (current.req.method === 'HEAD' || st === 204 || st === 304 || (st >= 100 && st < 200)) {
                completeResponse(null, current.raw.subarray(current.headEnd));
                return;
            }
        }

        const head = current.head;
        if (head.chunked) {
            const parsed = decodeChunked(current.raw.subarray(current.headEnd));
            if (!parsed) return; // 未收全
            completeResponse(parsed.body, current.raw.subarray(current.headEnd + parsed.consumed));
            return;
        }
        if (head.contentLength >= 0) {
            const need = current.headEnd + head.contentLength;
            if (current.raw.length < need) return;
            completeResponse(current.raw.subarray(current.headEnd, need), current.raw.subarray(need));
            return;
        }
        // 无长度信息：等连接关闭时在 close() 里收尾
    }

    function completeResponse(body, leftover) {
        const entry = current;
        current = null;
        stats.responses += 1;
        if (entry && body && entry.head && entry.head.status === 200) {
            let payload = body;
            if (entry.head.contentEncoding && payload.length > 0) {
                // 压缩体超过文本上限时不冒险解压
                payload = payload.length > MAX_TEXT_BYTES ? null : maybeGunzip(payload, entry.head.contentEncoding);
            }
            if (payload && payload.length > 0) {
                const stored = store.commit({
                    host: entry.req.host,
                    url: entry.req.url,
                    body: payload,
                    contentType: entry.head.contentType,
                    status: entry.head.status,
                });
                if (stored) stats.stored += 1;
            }
        }
        startNext();
        if (leftover && leftover.length > 0) {
            ingest(leftover); // 余量属于下一个响应
        }
    }

    function close() {
        if (!disabled && current && current.head) {
            const head = current.head;
            // 无长度信息的响应：连接关闭即视为收尾，尽力提交已收内容
            if (head.status === 200 && !head.chunked && head.contentLength < 0 && current.raw.length > current.headEnd) {
                try {
                    completeResponse(current.raw.subarray(current.headEnd), null);
                } catch { /* ignore */ }
            }
        }
        current = null;
        queue.length = 0;
        disabled = true;
    }

    return {
        enqueue,
        feed,
        close,
        getStats: () => ({ ...stats, pending: queue.length }),
    };
}

module.exports = {
    createCaptureAssetStore,
    createConnectionAssetTracker,
    detectExt,
    isWanted,
    parseResponseHead,
    decodeChunked,
    maybeGunzip,
    looksJsonish,
};

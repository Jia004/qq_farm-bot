'use strict';

/**
 * 内置抓包服务 - 会话管理器
 *
 * 对外提供与旧外部抓包服务完全一致的 REST API：
 *   GET  /api/health
 *   POST /api/sessions                      { sessionId, platform } -> { data: { proxy, publicInfo } }
 *   GET  /api/sessions/:id/state            -> 状态快照（channels/codes、friends、proxy、publicInfo）
 *   DELETE /api/sessions/:id
 *   POST /api/capture/start                 { mode, bypassHosts }
 *   POST /api/capture/stop
 *   GET  /cert/mitmproxy-ca-cert.cer        -> CA 证书 (DER)
 *
 * 抓取链路：
 *   手机 Wi-Fi 代理 -> MITM 代理(本服务) -> 真实游戏网关
 *   WS 升级 URL 的 code 立即入账；gid 来自 LoginReply 帧；
 *   好友 gid 来自 FriendService.GetAll / SyncAll 响应帧。
 */

const crypto = require('node:crypto');
const { CaptureMitmProxy } = require('./capture-mitm');
const { decodeFriendReply, decodeLoginReply } = require('./game-ws');
const { createCaptureAssetStore } = require('./capture-asset-store');
const { getDataFile } = require('../config/runtime-paths');

const FRIEND_COMPLETE_SOURCES = new Set([
    'gamepb.friendpb.FriendService.GetAll',
    'gamepb.friendpb.FriendService.SyncAll',
]);
const FRIEND_WAIT_MS = 15_000;
const MAX_CAPTURED_CODES = 5;

function createInternalCaptureService({ ca, logger }) {
    /** @type {Map<string, object>} sessionId -> session */
    const sessions = new Map();
    const state = {
        mitm: null,
        port: 0,
        bypassHosts: [],
        startedAt: Date.now(),
    };
    // 资源存档器：抓包期间把 CDN 资源清单/图集响应体落盘到 data/capture-assets/
    let assetStore = null;
    try {
        assetStore = createCaptureAssetStore({
            dir: getDataFile('capture-assets'),
            logger,
        });
    } catch (error) {
        logger?.warn?.(`[Capture] 资源存档器初始化失败: ${error.message}`);
    }

    function newSession(sessionId, platform) {
        const session = {
            id: sessionId,
            platform: platform === 'wx' ? 'wx' : 'qq',
            status: 'capturing',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            // channels[platform] = { status, codes: [{ code, gid, openid }] }
            channels: { qq: { status: 'capturing', codes: [] }, wx: { status: 'capturing', codes: [] } },
            // 从帧里补充 gid/openid（code 已在 ws-open 入账时占位）
            pendingCodeIndex: new Map(),
            friends: { source: '', items: [], complete: false, completedAt: 0 },
            autoStopAt: 0,
            remoteMeta: null,
        };
        sessions.set(sessionId, session);
        return session;
    }

    function pushCode(session, platform, entry) {
        const channel = session.channels[platform === 'wx' ? 'wx' : 'qq'];
        if (!channel) return;
        const existing = channel.codes.find(
            (item) => (entry.code && item.code === entry.code) || (entry.gid && entry.gid === item.gid),
        );
        if (existing) {
            if (entry.code && !existing.code) existing.code = entry.code;
            if (entry.gid && !existing.gid) existing.gid = entry.gid;
            if (entry.openid && !existing.openid) existing.openid = entry.openid;
            return;
        }
        channel.codes.push({ code: entry.code || '', gid: entry.gid || '', openid: entry.openid || '' });
        if (channel.codes.length > MAX_CAPTURED_CODES) channel.codes.shift();
    }

    function handleWsOpen(event) {
        // 幂等：同一 code 可能因重试出现多条 ws-open
        for (const session of sessions.values()) {
            const channel = session.channels[session.platform];
            if (!channel) continue;
            const hasCode = event.code && channel.codes.some((item) => item.code === event.code);
            const hasOpenId = event.openId && channel.codes.some((item) => item.openid === event.openId);
            if (hasCode || hasOpenId) return;
            if (channel.codes.length >= MAX_CAPTURED_CODES) return;
            const entry = { code: event.code || '', gid: '', openid: event.openId || '' };
            channel.codes.push(entry);
            if (event.code) session.pendingCodeIndex.set(event.code, entry);
            session.updatedAt = Date.now();
            logger?.info?.(`[Capture] 已捕获 ${session.platform.toUpperCase()} code（等待登录帧补 gid）`);
            return;
        }
    }

    function handleWsFrame(event) {
        const { direction, frame } = event;
        if (!frame) return;
        if (direction === 'c2s') return;
        for (const session of sessions.values()) {
            const channel = session.channels[session.platform];
            if (!channel || channel.codes.length === 0) continue;

            // 自己的 gid/openid：LoginReply
            if (frame.serviceName === 'gamepb.userpb.UserService' && frame.methodName === 'Login'
                && frame.messageType === 2 && frame.body.length > 0) {
                const login = decodeLoginReply(frame.body);
                if (login && (login.gid || login.openid)) {
                    const entry = (event.meta?.code && session.pendingCodeIndex.get(event.meta.code))
                        || channel.codes.find((item) => !item.gid)
                        || channel.codes[channel.codes.length - 1];
                    if (entry) {
                        if (login.gid && !entry.gid) entry.gid = login.gid;
                        if (login.openid && !entry.openid) entry.openid = login.openid;
                    }
                    session.updatedAt = Date.now();
                }
                continue;
            }

            // 好友列表：GetAll / SyncAll 响应
            const friends = decodeFriendReply(frame.serviceName, frame.methodName, frame.body);
            if (friends && friends.items.length > 0 && !session.friends.complete) {
                const merged = new Map(session.friends.items.map((item) => [item.gid, item]));
                for (const item of friends.items) merged.set(item.gid, item);
                session.friends.items = [...merged.values()].slice(0, 2000);
                session.friends.source = friends.source;
                if (FRIEND_COMPLETE_SOURCES.has(friends.source)) {
                    session.friends.complete = true;
                    session.friends.completedAt = Date.now();
                    session.updatedAt = Date.now();
                    logger?.info?.(`[Capture] 好友列表同步完成（${session.friends.items.length} 个）`);
                }
            }
        }
    }

    function scheduleAutoStop(session, delayMs) {
        if (!delayMs || delayMs <= 0) return;
        session.autoStopAt = Date.now() + delayMs;
        setTimeout(() => {
            const fresh = sessions.get(session.id);
            if (!fresh) return;
            fresh.status = 'stopped';
            fresh.channels.qq.status = 'stopped';
            fresh.channels.wx.status = 'stopped';
            fresh.updatedAt = Date.now();
            logger?.info?.(`[Capture] 会话 ${session.id.slice(0, 8)} 到达自动停止时间`);
        }, delayMs).unref?.();
    }

    async function ensureProxyRunning() {
        if (state.mitm && state.mitm.running) return state.port;
        if (!state.mitm) {
            state.mitm = new CaptureMitmProxy({
                ca,
                logger,
                assetStore,
                onEvent: (event) => {
                    if (event.type === 'ws-open') handleWsOpen(event);
                    else if (event.type === 'ws-frame') handleWsFrame(event);
                },
            });
        }
        state.port = await state.mitm.start({});
        state.startedAt = Date.now();
        return state.port;
    }

    async function stopProxy() {
        if (state.mitm) {
            await state.mitm.stop();
        }
        state.port = 0;
    }

    function serializeSession(session) {
        return {
            id: session.id,
            platform: session.platform,
            status: session.status,
            channels: {
                qq: {
                    status: session.channels.qq.status,
                    codes: session.channels.qq.codes.map((item) => ({ ...item })),
                },
                wx: {
                    status: session.channels.wx.status,
                    codes: session.channels.wx.codes.map((item) => ({ ...item })),
                },
            },
            friends: {
                source: session.friends.source,
                items: session.friends.items.map((item) => ({ ...item })),
                complete: session.friends.complete,
            },
            proxy: {
                running: !!(state.mitm && state.mitm.running),
                status: session.status,
                error: '',
                startedAt: new Date(state.startedAt).toISOString(),
            },
            publicInfo: {
                host: getLanHost(),
                mitmPort: state.port,
                autoStopSec: 0,
            },
        };
    }

    function getLanHost() {
        const os = require('node:os');
        const faces = os.networkInterfaces();
        for (const list of Object.values(faces)) {
            for (const face of list || []) {
                if (face.family === 'IPv4' && !face.internal) return face.address;
                if (face.family === 'IPv6' && !face.internal && face.address.includes(':')) {
                    // 跳过 IPv6 本机
                }
            }
        }
        return '127.0.0.1';
    }

    function createApiRouter() {
        const router = [];
        const json = (res, code, payload) => {
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(payload));
        };
        const readBody = (req) => new Promise((resolve) => {
            let data = '';
            req.on('data', (chunk) => {
                data += chunk;
                if (data.length > 64 * 1024) {
                    data = '';
                    req.destroy();
                    resolve({});
                }
            });
            req.on('end', () => {
                try {
                    resolve(data ? JSON.parse(data) : {});
                } catch {
                    resolve({});
                }
            });
            req.on('error', () => resolve({}));
        });

        const routes = [
            {
                method: 'GET',
                pattern: /^\/api\/health$/,
                handler: (req, res) => {
                    json(res, 200, {
                        ok: true,
                        uptime: Math.floor((Date.now() - state.startedAt) / 1000),
                        sessions: sessions.size,
                        portPool: [state.port].filter(Boolean),
                    });
                },
            },
            {
                method: 'GET',
                pattern: /^\/api\/assets$/,
                handler: (req, res) => {
                    const assets = assetStore ? assetStore.list() : [];
                    json(res, 200, {
                        ok: true,
                        data: {
                            dir: assetStore ? assetStore.dir : '',
                            count: assets.length,
                            assets: assets.slice(-200),
                        },
                    });
                },
            },
            {
                method: 'GET',
                pattern: /^\/cert\/mitmproxy-ca-cert\.cer$/,
                handler: (_req, res) => {
                    const certDer = Buffer.isBuffer(ca.certDer)
                        ? ca.certDer
                        : Buffer.from(String(ca.certPem).replace(/-----[^-]+-----|\s+/g, ''), 'base64');
                    res.writeHead(200, {
                        'Content-Type': 'application/x-x509-ca-cert',
                        'Content-Disposition': 'inline; filename="mitmproxy-ca-cert.cer"',
                    });
                    res.end(certDer);
                },
            },
            {
                method: 'POST',
                pattern: /^\/api\/sessions$/,
                handler: async (req, res) => {
                    const body = await readBody(req);
                    const sessionId = String(body.sessionId || '').trim();
                    if (!sessionId) {
                        return json(res, 400, { ok: false, error: '缺少 sessionId' });
                    }
                    if (sessions.has(sessionId)) {
                        return json(res, 409, { ok: false, error: '会话已存在' });
                    }
                    const session = newSession(sessionId, body.platform);
                    scheduleAutoStop(session, 0);
                    json(res, 200, { ok: true, data: serializeSession(session) });
                },
            },
            {
                method: 'POST',
                pattern: /^\/api\/capture\/start$/,
                handler: async (req, res) => {
                    const body = await readBody(req);
                    const mode = body.mode === 'wx' ? 'wx' : 'qq';
                    // 旧客户端把会话 ID 放在 x-capture-session-id 头里
                    const headerSessionId = String(req.headers['x-capture-session-id'] || '').trim();
                    const sessionId = headerSessionId || String(body.sessionId || '').trim();
                    let session = sessionId ? sessions.get(sessionId) : null;
                    if (!session) {
                        // 兼容 start 先于 sessions 创建的旧流程
                        session = newSession(sessionId || crypto.randomBytes(12).toString('hex'), mode);
                    }
                    session.platform = mode;
                    session.channels[mode].status = 'capturing';
                    if (Array.isArray(body.bypassHosts)) {
                        state.bypassHosts = body.bypassHosts.map((item) => String(item || '').toLowerCase());
                        state.mitm?.setBypassHosts(state.bypassHosts);
                    }
                    const port = await ensureProxyRunning();
                    json(res, 200, {
                        ok: true,
                        data: serializeSession(session),
                    });
                },
            },
            {
                method: 'GET',
                pattern: /^\/api\/sessions\/([^/]+)\/state$/,
                handler: (req, res, params) => {
                    const session = sessions.get(decodeURIComponent(params[0] || ''));
                    if (!session) return json(res, 404, { ok: false, error: '会话不存在' });
                    json(res, 200, { ok: true, data: serializeSession(session) });
                },
            },
            {
                method: 'POST',
                pattern: /^\/api\/capture\/stop$/,
                handler: async (req, res) => {
                    const headerSessionId = String(req.headers['x-capture-session-id'] || '').trim();
                    if (headerSessionId) sessions.delete(headerSessionId);
                    await stopProxy();
                    for (const session of sessions.values()) {
                        session.status = 'stopped';
                        session.channels.qq.status = 'stopped';
                        session.channels.wx.status = 'stopped';
                    }
                    json(res, 200, { ok: true });
                },
            },
            {
                method: 'DELETE',
                pattern: /^\/api\/sessions\/([^/]+)$/,
                handler: (req, res, params) => {
                    const session = sessions.get(decodeURIComponent(params[0] || ''));
                    if (session) {
                        sessions.delete(session.id);
                    }
                    json(res, 200, { ok: true });
                },
            },
        ];

        return async function handleApiRequest(req, res) {
            const urlPath = String(req.url || '').split('?')[0];
            for (const route of routes) {
                if (route.method !== req.method) continue;
                const match = urlPath.match(route.pattern);
                if (!match) continue;
                try {
                    await route.handler(req, res, match.slice(1));
                } catch (error) {
                    logger?.warn?.(`[Capture] API 处理失败 ${req.method} ${urlPath}: ${error.message}`);
                    if (!res.headersSent) {
                        json(res, 500, { ok: false, error: error.message });
                    }
                }
                return true;
            }
            return false;
        };
    }

    const handleApiRequest = createApiRouter();

    /**
     * HTTP 请求入口（由子进程 server 挂载）。
     * 命中 API/证书路由返回 true；否则 false（调用方可继续处理代理 CONNECT 等）。
     */
    async function handleRequest(req, res) {
        return handleApiRequest(req, res);
    }

    return {
        handleRequest,
        ensureProxyRunning,
        stopProxy,
        getPort: () => state.port,
        getStats: () => ({
            sessions: sessions.size,
            ...state.mitm?.stats,
        }),
        getAssetStore: () => assetStore,
        getLanHost,
    };
}

module.exports = { createInternalCaptureService };

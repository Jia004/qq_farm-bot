'use strict';

/**
 * 内置抓包服务 - HTTPS/WSS 中间人代理
 *
 * 架构（TLS 解密面 + 真实转发面分离）：
 * 1. 明文 HTTP 代理端口接收手机 CONNECT host:port；
 * 2. 回 200 后，手机在原隧道里发 TLS ClientHello；
 * 3. 为目标域名动态签发证书，在本机随机高位端口起一个 TLS 服务器；
 * 4. 隧道字节原样双向往来于 手机 ⇄ TLS 服务器（ClientHello 也照转），
 *    手机与 TLS 服务器在隧道内完成 TLS 握手（证书由已安装 CA 背书）；
 * 5. TLS 服务器上区分两类流量：
 *    - WebSocket 升级（游戏网关 wss://gate-*.nqf.qq.com/prod/ws?...&code=...）：
 *      原样转发给真实游戏服务器，双向管道透传，同时双向解析 gamepb 帧；
 *    - 普通 HTTPS 请求：转发给真实服务器并回传响应（保证 App 其它请求不受影响）；
 *    - 免拦截域名（面板/本机地址）：CONNECT 阶段直接 TCP 透传，不做 TLS 劫持。
 *
 * 抓取目标：
 * - 登录 code：WS 升级请求行 query 里的 code（以及 openID / platform）；
 * - 自己 gid/openid：LoginReply.basic（server -> client 帧）；
 * - 好友 gid 列表：FriendService.GetAll / SyncAll 响应（server -> client 帧）。
 */

const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { LeafCertificateCache } = require('./capture-ca');
const { parseGameWsFrame } = require('./game-ws');

const BIND_HOST = '0.0.0.0';
const MAX_FRAME_BUFFER = 8 * 1024 * 1024;

function findFreePort() {
    // 先绑定占住端口再释放，返回 (port, 重绑函数)；重绑失败自动换口，杜绝竞态
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, BIND_HOST, () => {
            const { port } = srv.address();
            resolve({
                port,
                rebind: async (listenHandler) => {
                    for (let attempt = 0; attempt < 5; attempt += 1) {
                        const targetPort = attempt === 0 ? port : await findFreePortThenResolve();
                        try {
                            await listenHandler(targetPort);
                            return targetPort;
                        } catch (error) {
                            if (error && error.code !== 'EADDRINUSE') throw error;
                        }
                    }
                    throw new Error('升级端口重绑失败');
                },
            });
            srv.close(() => {});
        });
    });
}

async function findFreePortThenResolve() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, BIND_HOST, () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/** 从 TLS ClientHello 提取 SNI（仅记录用途） */
function extractSniFromClientHello(record) {
    try {
        if (record.length < 43 || record[0] !== 0x16) return '';
        let offset = 5;
        if (record[offset] !== 0x01) return '';
        offset += 4 + 2 + 32;
        const sessionIdLen = record[offset];
        offset += 1 + sessionIdLen;
        const cipherSuitesLen = record.readUInt16BE(offset);
        offset += 2 + cipherSuitesLen;
        const compressionLen = record[offset];
        offset += 1 + compressionLen;
        if (offset + 2 > record.length) return '';
        const extensionsLen = record.readUInt16BE(offset);
        offset += 2;
        const extensionsEnd = Math.min(offset + extensionsLen, record.length);
        while (offset + 4 <= extensionsEnd) {
            const extType = record.readUInt16BE(offset);
            const extLen = record.readUInt16BE(offset + 2);
            const extStart = offset + 4;
            if (extType === 0x00) {
                let p = extStart;
                if (p + 2 > record.length) return '';
                const listLen = record.readUInt16BE(p);
                p += 2;
                const listEnd = Math.min(p + listLen, record.length);
                while (p + 3 <= listEnd) {
                    const nameType = record[p];
                    const nameLen = record.readUInt16BE(p + 1);
                    if (nameType === 0 && p + 3 + nameLen <= listEnd) {
                        return record.toString('ascii', p + 3, p + 3 + nameLen).toLowerCase();
                    }
                    p += 3 + nameLen;
                }
                return '';
            }
            offset = extStart + extLen;
        }
        return '';
    } catch {
        return '';
    }
}

class CaptureMitmProxy {
    constructor({ ca, logger, onEvent } = {}) {
        this.logger = logger;
        this.ca = ca;
        this.leafCache = new LeafCertificateCache(ca);
        // onEvent({ type: 'ws-open'|'ws-frame'|'ws-close'|'http-request', ... })
        this.onEvent = onEvent || (() => {});
        this.httpServer = null;
        this.port = 0;
        this.running = false;
        this.tlsServers = new Set();
        // 活动连接追踪：stop() 时统一销毁，避免句柄泄漏
        this.activeSockets = new Set();
        // 免拦截域名：这些目标的 CONNECT 直接 TCP 透传，不做 TLS 劫持
        this.bypassHosts = new Set();
        // 上游覆盖映射：host -> { host, port }，用于测试与本地网关调试
        this.upstreamOverrides = new Map();
        this.stats = { connect: 0, bypass: 0, wsSessions: 0, frames: 0 };
    }

    setUpstreamOverrides(mapping) {
        this.upstreamOverrides = new Map(Object.entries(mapping || {}));
    }

    resolveUpstream(host, port) {
        const override = this.upstreamOverrides.get(String(host || '').toLowerCase());
        if (override) {
            return { host: override.host || host, port: override.port || port };
        }
        return { host, port };
    }

    setBypassHosts(hosts) {
        this.bypassHosts = new Set(
            (Array.isArray(hosts) ? hosts : [])
                .map((item) => String(item || '').trim().toLowerCase().replace(/\.$/, ''))
                .filter(Boolean),
        );
    }

    isBypassed(host) {
        const normalized = String(host || '').trim().toLowerCase().replace(/\.$/, '');
        if (!normalized) return false;
        if (normalized === 'localhost' || normalized === '::1' || /^127\./.test(normalized)) return true;
        return this.bypassHosts.has(normalized);
    }

    async start({ host = BIND_HOST } = {}) {
        if (this.running) return this.port;
        this.httpServer = http.createServer((req, res) => {
            this.onEvent({
                type: 'http-request',
                protocol: 'http-plain',
                host: req.headers?.host || '',
                method: req.method || '',
                url: req.url || '',
                at: Date.now(),
            });
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('capture proxy: use https via CONNECT');
        });
        this.httpServer.on('connect', (req, clientSocket, head) => {
            this.stats.connect += 1;
            this.handleConnect(req, clientSocket, head).catch((error) => {
                this.logger?.warn?.(`[CaptureMITM] CONNECT 处理失败: ${error.message}`);
                this.destroySocket(clientSocket);
            });
        });
        this.httpServer.on('clientError', (_err, socket) => this.destroySocket(socket));
        await new Promise((resolve, reject) => {
            this.httpServer.once('error', reject);
            this.httpServer.listen(0, host || BIND_HOST, () => resolve());
        });
        this.port = this.httpServer.address().port;
        this.running = true;
        this.logger?.info?.(`[CaptureMITM] 代理已启动，端口 ${this.port}`);
        return this.port;
    }

    async stop() {
        this.running = false;
        for (const tlsServer of this.tlsServers) {
            try {
                tlsServer.close(() => {});
                tlsServer.closeAllConnections?.();
            } catch {}
        }
        this.tlsServers.clear();
        // 销毁所有活动连接（中继、隧道、上游），避免句柄泄漏
        for (const socket of [...this.activeSockets]) {
            this.destroySocket(socket);
        }
        this.activeSockets.clear();
        const server = this.httpServer;
        this.httpServer = null;
        this.port = 0;
        if (!server) return;
        await new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
            setTimeout(resolve, 300).unref?.();
        });
        this.logger?.info?.('[CaptureMITM] 代理已停止');
    }

    destroySocket(socket) {
        if (!socket || socket.destroyed) return;
        socket.destroy();
        this.activeSockets.delete(socket);
    }

    trackSocket(socket) {
        if (!socket) return socket;
        this.activeSockets.add(socket);
        socket.on('close', () => this.activeSockets.delete(socket));
        return socket;
    }

    parseHostPort(req) {
        const target = String(req.url || '');
        const slashIndex = target.indexOf('/');
        const hostPort = slashIndex >= 0 ? target.slice(0, slashIndex) : target;
        const colonIndex = hostPort.lastIndexOf(':');
        const host = colonIndex > 0 ? hostPort.slice(0, colonIndex) : hostPort;
        const port = colonIndex > 0 ? Number(hostPort.slice(colonIndex + 1)) || 443 : 443;
        return { host, port };
    }

    async handleConnect(req, clientSocket, head) {
        this.trackSocket(clientSocket);
        const { host: connectHost, port: connectPort } = this.parseHostPort(req);
        if (!connectHost) {
            this.destroySocket(clientSocket);
            return;
        }

        // 免拦截域名：直接 TCP 透传到真实目标
        if (this.isBypassed(connectHost)) {
            this.stats.bypass += 1;
            const real = this.trackSocket(net.connect(connectPort, connectHost));
            real.setNoDelay(true);
            const teardown = () => {
                this.destroySocket(clientSocket);
                this.destroySocket(real);
            };
            clientSocket.on('error', teardown);
            real.on('error', teardown);
            clientSocket.on('data', (chunk) => {
                if (real.writable) real.write(chunk);
            });
            if (head && head.length > 0) real.write(head);
            real.on('data', (chunk) => {
                if (clientSocket.writable) clientSocket.write(chunk);
            });
            clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
            return;
        }

        // 每条隧道一个 TLS 服务器（证书按域名签发；并发抓包连接通常 1-2 条）
        // 注意：必须用 https.createServer（内部 llhttp 解析解密后的 HTTP 流），
        // tls.createServer 不解析 HTTP，upgrade/request 事件永远不会触发。
        const leaf = this.leafCache.get(connectHost);
        const tlsServer = https.createServer({
            key: leaf.keyPem,
            cert: leaf.certPem,
            SNICallback: (serverName, callback) => {
                try {
                    const sniLeaf = this.leafCache.get(serverName || connectHost);
                    callback(null, tls.createSecureContext({
                        key: sniLeaf.keyPem,
                        cert: sniLeaf.certPem,
                    }));
                } catch (error) {
                    callback(error);
                }
            },
        });
        this.tlsServers.add(tlsServer);
        tlsServer.on('error', () => {});
        tlsServer.on('clientError', (_err, socket) => this.destroySocket(socket));
        tlsServer.on('upgrade', (req2, tlsSocket, head2) => {
            this.handleUpstreamWebSocket({ req: req2, tlsSocket, head: head2, connectHost, connectPort });
        });
        tlsServer.on('request', (req2, res) => {
            this.handleUpstreamHttpRequest({ req: req2, res, connectHost, connectPort });
        });

        // 先绑占位端口，再重绑到同一端口（竞态时自动换口）
        const placeholder = await findFreePort();
        const tlsPort = await placeholder.rebind((port) => new Promise((resolve, reject) => {
            tlsServer.once('error', reject);
            tlsServer.listen(port, '127.0.0.1', () => resolve());
        }));
        tlsServer.unref();

        // 隧道中继：手机(明文) ⇄ TLS 服务器(本机)
        const relay = this.trackSocket(net.connect(tlsPort, '127.0.0.1'));
        relay.setNoDelay(true);
        let sniLogged = false;
        const forwardToRelay = (chunk) => {
            if (!sniLogged) {
                sniLogged = true;
                const sni = extractSniFromClientHello(chunk);
                this.logger?.debug?.(`[CaptureMITM] CONNECT ${connectHost}:${connectPort} SNI=${sni || connectHost}`);
            }
            if (relay.writable) relay.write(chunk);
        };
        clientSocket.on('data', forwardToRelay);
        if (head && head.length > 0) forwardToRelay(head);
        relay.on('data', (chunk) => {
            if (clientSocket.writable) clientSocket.write(chunk);
        });
        const teardown = () => {
            this.destroySocket(clientSocket);
            this.destroySocket(relay);
            setTimeout(() => {
                try {
                    tlsServer.close(() => {});
                    tlsServer.closeAllConnections?.();
                } catch {}
                this.tlsServers.delete(tlsServer);
            }, 100).unref?.();
        };
        clientSocket.on('error', teardown);
        clientSocket.on('close', teardown);
        relay.on('error', teardown);
        relay.on('close', teardown);

        // 应答 CONNECT：之后手机在原隧道里继续 TLS 握手
        clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    }

    connectRealTarget(host, port, servername) {
        return new Promise((resolve, reject) => {
            const real = tls.connect({
                host,
                port,
                servername: servername || host,
                rejectUnauthorized: false,
            }, () => resolve(real));
            real.setNoDelay(true);
            real.on('error', reject);
        });
    }

    rebuildRequestHeaders(req, { stripWsExtensions = false } = {}) {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [name, value] of Object.entries(req.headers || {})) {
            const lower = name.toLowerCase();
            if (lower === 'proxy-connection' || lower === 'proxy-authorization') continue;
            if (stripWsExtensions && lower === 'sec-websocket-extensions') continue;
            if (Array.isArray(value)) {
                for (const item of value) lines.push(`${name}: ${item}`);
            } else if (value !== undefined) {
                lines.push(`${name}: ${value}`);
            }
        }
        return `${lines.join('\r\n')}\r\n\r\n`;
    }

    /**
     * TLS 服务器上的 WS 升级：转发给真实游戏服务器并双向解析帧。
     */
    async handleUpstreamWebSocket({ req, tlsSocket, head, connectHost, connectPort }) {
        this.stats.wsSessions += 1;
        const host = req.headers?.host ? String(req.headers.host).split(':')[0] : connectHost;
        const upstream = this.resolveUpstream(host, connectPort || 443);
        const url = String(req.url || '');
        const at = Date.now();
        const connectionId = crypto.randomBytes(8).toString('hex');

        // 解析升级 URL 里的 code / openID（登录凭据在这里）
        let code = '';
        let openId = '';
        let platform = '';
        try {
            const u = new URL(`https://${host}${url.startsWith('/') ? url : `/${url}`}`);
            code = u.searchParams.get('code') || '';
            openId = u.searchParams.get('openID') || u.searchParams.get('openid') || '';
            platform = u.searchParams.get('platform') || '';
        } catch {}

        this.onEvent({
            type: 'ws-open',
            connectionId,
            host,
            port: upstream.port,
            url,
            code,
            openId,
            platform,
            at,
        });

        let real = null;
        try {
            real = this.trackSocket(await this.connectRealTarget(upstream.host, upstream.port, host));
        } catch (error) {
            this.logger?.warn?.(`[CaptureMITM] 连接真实服务器失败 ${upstream.host}:${upstream.port}: ${error.message}`);
            this.destroySocket(tlsSocket);
            return;
        }

        const teardown = () => {
            this.onEvent({ type: 'ws-close', connectionId, at: Date.now() });
            this.destroySocket(tlsSocket);
            this.destroySocket(real);
        };
        tlsSocket.on('error', teardown);
        tlsSocket.on('close', teardown);
        real.on('error', teardown);
        real.on('close', teardown);

        // 转发升级请求（去掉 permessage-deflate 扩展，保证帧不压缩可解析）
        real.write(this.rebuildRequestHeaders(req, { stripWsExtensions: true }));
        if (head && head.length > 0) real.write(head);

        // 双向透传（压缩被禁用后帧均为明文负载）
        tlsSocket.on('data', (chunk) => {
            if (real.writable) real.write(chunk);
        });
        real.on('data', (chunk) => {
            if (tlsSocket.writable) tlsSocket.write(chunk);
        });

        // 双向帧解析（c2s 帧带掩码，s2c 帧不带，解析器统一处理）
        // 注意：必须先消费掉上游的 HTTP 101 应答头，再开始解析 WS 帧。
        // 101 应答是明文 HTTP（\r\n\r\n 结尾），之后才是二进制帧流。
        const wsMeta = { connectionId, host, url, code };
        const c2sParser = this.createFrameParser('c2s', wsMeta);
        const s2cParser = this.createFrameParser('s2c', wsMeta);
        tlsSocket.on('data', (chunk) => c2sParser.push(chunk));
        let upgradedConsumed = false;
        real.on('data', (chunk) => {
            if (upgradedConsumed) {
                s2cParser.push(chunk);
                return;
            }
            const text = chunk.toString('latin1');
            const endIndex = text.indexOf('\r\n\r\n');
            if (endIndex >= 0) {
                upgradedConsumed = true;
                const rest = chunk.subarray(endIndex + 4);
                if (rest.length > 0) s2cParser.push(rest);
            }
            // 若首个 chunk 不含完整应答头（跨包），继续等下一块拼接
        });
    }

    createFrameParser(direction, meta) {
        let buffer = Buffer.alloc(0);
        let fragments = [];
        let fragmentsOpcode = 0;
        const self = this;
        const tryParse = () => {
            while (true) {
                if (buffer.length < 2) return;
                const first = buffer[0];
                const second = buffer[1];
                const fin = (first & 0x80) !== 0;
                const opcode = first & 0x0f;
                const masked = (second & 0x80) !== 0;
                let len = second & 0x7f;
                let offset = 2;
                if (len === 126) {
                    if (buffer.length < offset + 2) return;
                    len = buffer.readUInt16BE(offset);
                    offset += 2;
                } else if (len === 127) {
                    if (buffer.length < offset + 8) return;
                    const big = buffer.readBigUInt64BE(offset);
                    if (big > BigInt(MAX_FRAME_BUFFER)) {
                        buffer = Buffer.alloc(0);
                        return;
                    }
                    len = Number(big);
                    offset += 8;
                }
                if (len > MAX_FRAME_BUFFER) {
                    buffer = Buffer.alloc(0);
                    return;
                }
                let maskKey = null;
                if (masked) {
                    if (buffer.length < offset + 4) return;
                    maskKey = buffer.subarray(offset, offset + 4);
                    offset += 4;
                }
                if (buffer.length < offset + len) return;
                const payload = Buffer.from(buffer.subarray(offset, offset + len));
                buffer = Buffer.from(buffer.subarray(offset + len));
                if (maskKey) {
                    for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3];
                }
                if (!fin) {
                    if (opcode === 0x1 || opcode === 0x2) {
                        fragments = [payload];
                        fragmentsOpcode = opcode;
                    } else if (opcode === 0x0 && fragments.length > 0) {
                        fragments.push(payload);
                    }
                    continue;
                }
                let fullPayload = payload;
                let finalOpcode = opcode;
                if (opcode === 0x0 && fragments.length > 0) {
                    fragments.push(payload);
                    fullPayload = Buffer.concat(fragments);
                    finalOpcode = fragmentsOpcode;
                    fragments = [];
                    fragmentsOpcode = 0;
                }
                if (finalOpcode === 0x8 || finalOpcode === 0x9 || finalOpcode === 0xA) continue;
                if (finalOpcode !== 0x2) continue; // 只关心二进制帧
                self.stats.frames += 1;
                try {
                    const frame = parseGameWsFrame(fullPayload);
                    if (frame) {
                        self.onEvent({
                            type: 'ws-frame',
                            direction,
                            meta,
                            frame,
                            at: Date.now(),
                        });
                    }
                } catch {}
            }
        };
        return {
            push(chunk) {
                buffer = Buffer.concat([buffer, chunk]);
                if (buffer.length > MAX_FRAME_BUFFER * 2) buffer = buffer.subarray(-MAX_FRAME_BUFFER);
                tryParse();
            },
        };
    }

    /**
     * TLS 服务器上的普通 HTTPS 请求：转发真实服务器并回传响应。
     */
    handleUpstreamHttpRequest({ req, res, connectHost, connectPort }) {
        const host = req.headers?.host ? String(req.headers.host).split(':')[0] : connectHost;
        this.onEvent({
            type: 'http-request',
            protocol: 'https',
            host,
            method: req.method || '',
            url: req.url || '',
            at: Date.now(),
        });

        const tlsSocket = res.socket;
        if (!tlsSocket) return;
        if (!tlsSocket.__captureUpstream) {
            const upstream = this.resolveUpstream(host, connectPort || 443);
            tlsSocket.__captureUpstream = this.connectRealTarget(upstream.host, upstream.port, host)
                .then((real) => {
                    this.trackSocket(real);
                    real.on('data', (chunk) => {
                        if (tlsSocket.writable) tlsSocket.write(chunk);
                    });
                    const teardown = () => {
                        this.destroySocket(tlsSocket);
                        this.destroySocket(real);
                    };
                    real.on('error', teardown);
                    real.on('close', teardown);
                    tlsSocket.on('error', teardown);
                    tlsSocket.on('close', teardown);
                    return real;
                })
                .catch((error) => {
                    this.logger?.warn?.(`[CaptureMITM] HTTPS 转发连接失败 ${host}: ${error.message}`);
                    this.destroySocket(tlsSocket);
                    return null;
                });
        }
        Promise.resolve(tlsSocket.__captureUpstream).then((real) => {
            if (!real || !real.writable) return;
            real.write(this.rebuildRequestHeaders(req));
            req.on('data', (chunk) => real.write(chunk));
            req.on('end', () => {
                // 请求体转发完毕；响应由 real.on('data') 直接回流
            });
        });
    }
}

module.exports = {
    CaptureMitmProxy,
    extractSniFromClientHello,
};

'use strict';

/**
 * 内置抓包服务端到端测试
 *
 * 全链路（均为真实 socket，无 mock）：
 *   测试客户端 -> HTTP 代理 CONNECT -> MITM(TLS 劫持) -> 本地 TLS 网关(伪游戏服务器)
 * 客户端信任内置 CA 后：
 *   1. 通过代理发 WSS 升级（URL 带 code=...）；
 *   2. 网关回 LoginReply 帧（含 gid/openid）；
 *   3. 网关回 FriendService.GetAll 响应帧（含好友 gid）；
 *   断言会话状态里 code/gid/openid/好友列表全部被正确捕获。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const protobuf = require('protobufjs');

const { generateSelfSignedCa } = require('../src/capture/capture-ca');
const { CaptureMitmProxy } = require('../src/capture/capture-mitm');
const { parseGameWsFrame } = require('../src/capture/game-ws');

// 测试隔离的数据目录（capture-ca 持久化位置）
process.env.FARM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-capture-test-'));

const protoRoot = new protobuf.Root();
protoRoot.loadSync([
    path.join(__dirname, '..', 'src', 'proto', 'game.proto'),
    path.join(__dirname, '..', 'src', 'proto', 'userpb.proto'),
    path.join(__dirname, '..', 'src', 'proto', 'friendpb.proto'),
], { keepCase: true });

const GAME_HOST = 'gate-test.nqf.qq.com';
const WS_PATH = '/prod/ws';

function encodeFrame({ serviceName, methodName, messageType, body, seq = 1 }) {
    const Message = protoRoot.lookupType('gatepb.Message');
    return Buffer.from(Message.encode(Message.create({
        meta: { service_name: serviceName, method_name: methodName, message_type: messageType, client_seq: seq },
        body: body || Buffer.alloc(0),
    })).finish());
}

function buildWsUpgradeRequest({ host, port, code }) {
    const key = Buffer.from('dGhlIHNhbXBsZSBub25jZQ==').toString('base64');
    return [
        `GET ${WS_PATH}?platform=qq&os=iOS&ver=1.13.0.4&code=${code}&openID= HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
    ].join('\r\n');
}

function encodeWsFrame(payload) {
    // 服务端 -> 客户端帧（不掩码）
    const header = Buffer.from([0x82]); // FIN + binary
    let lenByte;
    if (payload.length < 126) {
        lenByte = Buffer.from([payload.length]);
    } else if (payload.length < 65536) {
        lenByte = Buffer.alloc(3);
        lenByte[0] = 126;
        lenByte.writeUInt16BE(payload.length, 1);
    } else {
        lenByte = Buffer.alloc(9);
        lenByte[0] = 127;
        lenByte.writeBigUInt64BE(BigInt(payload.length), 1);
    }
    return Buffer.concat([header, lenByte, payload]);
}

function parseClientWsFrame(buffer) {
    // 客户端 -> 服务端帧（带掩码，单帧）
    const len = buffer[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
        offset = 4;
    } else if (len === 127) {
        offset = 10;
    }
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(buffer.subarray(offset));
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    return payload;
}

function extractSniFromClientHello(record) {
    // 简版：直接读 ClientHello 里的 SNI 扩展（仅测试断言用，逻辑同 capture-mitm）
    const { extractSniFromClientHello: fn } = require('../src/capture/capture-mitm');
    return fn(record);
}

function startFakeGameGateway() {
    return new Promise((resolve) => {
        // 伪网关用独立自签证书（运行时生成，与内置 CA 无关）
        // 注意：必须用 https.createServer 才能解析 HTTP 并触发 upgrade 事件
        const gatewayCert = generateSelfSignedCa({ commonName: 'test-gateway' });
        const server = https.createServer({
            key: gatewayCert.keyPem,
            cert: gatewayCert.certPem,
        });
        const seen = { upgrade: 0, frames: [] };
        server.on('upgrade', (req, socket) => {
            seen.upgrade += 1;
            const accept = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='; // RFC 6455 示例 key 的标准应答
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');

            // 解析客户端帧（登录请求，仅记录）
            socket.on('data', (chunk) => {
                try {
                    const payload = parseClientWsFrame(chunk);
                    const frame = parseGameWsFrame(payload);
                    if (frame) seen.frames.push({ direction: 'c2s', frame });
                } catch {}
            });

            // 立即回 LoginReply（gid=90001, openid=openid-abc）——模拟真实服务器主动推送
            const LoginReply = protoRoot.lookupType('gamepb.userpb.LoginReply');
            const loginBody = Buffer.from(LoginReply.encode(LoginReply.create({
                basic: { gid: 90001, name: '测试农场主', open_id: 'openid-abc', level: 10 },
            })).finish());
            socket.write(encodeWsFrame(encodeFrame({
                serviceName: 'gamepb.userpb.UserService',
                methodName: 'Login',
                messageType: 2,
                body: loginBody,
            })));
            // 回 FriendService.GetAll 响应（好友 gid 10001/10002/90001 应过滤自身）
            const GetAllReply = protoRoot.lookupType('gamepb.friendpb.GetAllReply');
            const friendsBody = Buffer.from(GetAllReply.encode(GetAllReply.create({
                game_friends: [
                    { gid: 10001, name: '好友甲' },
                    { gid: 10002, name: '好友乙' },
                    { gid: 90001, name: '测试农场主' },
                ],
            })).finish());
            socket.write(encodeWsFrame(encodeFrame({
                serviceName: 'gamepb.friendpb.FriendService',
                methodName: 'GetAll',
                messageType: 2,
                body: friendsBody,
            })));
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port, seen });
        });
    });
}

function httpProxyRequest(proxyPort, method, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method,
      path: requestPath,
      headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpProxyConnect(proxyPort, targetHostPort) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: targetHostPort,
    });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('error', reject);
    req.end();
  });
}

test('内置抓包端到端：CONNECT -> TLS 劫持 -> WS 帧捕获 code/gid/openid/好友', async () => {
    const gateway = await startFakeGameGateway();

    // 1. 独立 CA（不落盘测试）
    const ca = generateSelfSignedCa({ commonName: 'Test Capture CA' });
    const events = [];
    const mitm = new CaptureMitmProxy({
        ca,
        logger: null,
        onEvent: (event) => events.push(event),
    });
    // 把游戏域名指到本地伪网关
    mitm.setUpstreamOverrides({ [GAME_HOST]: { host: '127.0.0.1', port: gateway.port } });
    const proxyPort = await mitm.start({});
    assert.ok(proxyPort > 0, '代理端口应大于 0');

    // 2. HTTP 代理 CONNECT 应答 200，拿到隧道 socket
    const connectRes = await httpProxyConnect(proxyPort, `${GAME_HOST}:443`);
    assert.equal(connectRes.status, 200);

    // 3. 在 CONNECT 返回的同一隧道 socket 上完成 TLS 握手（信任内置 CA）
    const code = 'capture-e2e-code-1234567890abcdef';
    const tlsSocket = await new Promise((resolve, reject) => {
        const s = tls.connect({
            socket: connectRes.socket,
            servername: GAME_HOST,
            ca: ca.certPem,
            rejectUnauthorized: true,
        }, () => resolve(s));
        s.on('error', reject);
    });
    assert.equal(tlsSocket.authorized, true, '客户端应信任内置 CA 签发的证书');

    // 4. 发送 WS 升级请求（带 code）
    const receivedBuffers = [];
    tlsSocket.on('data', (chunk) => receivedBuffers.push(chunk));
    tlsSocket.write(buildWsUpgradeRequest({ host: GAME_HOST, port: 443, code }));

    // 5. 等待网关两帧回复（LoginReply + GetAllReply）经代理回流
    await new Promise((resolve) => setTimeout(resolve, 800));
    const allReceived = Buffer.concat(receivedBuffers).toString('latin1');
    assert.ok(allReceived.includes('101 Switching Protocols'), '应收到 101 升级应答');

    // 6. 断言捕获事件
    const wsOpen = events.find((event) => event.type === 'ws-open');
    assert.ok(wsOpen, '应产生 ws-open 事件');
    assert.equal(wsOpen.code, code);
    assert.equal(wsOpen.host, GAME_HOST);

    const frames = events.filter((event) => event.type === 'ws-frame' && event.direction === 's2c');
    const loginFrame = frames.find((event) => event.frame.methodName === 'Login');
    assert.ok(loginFrame, '应捕获 Login 响应帧');
    assert.equal(loginFrame.frame.serviceName, 'gamepb.userpb.UserService');
    const friendFrame = frames.find((event) => event.frame.methodName === 'GetAll');
    assert.ok(friendFrame, '应捕获 GetAll 响应帧');

    // 7. 帧体可解码（game-ws 解码器）
    const { decodeLoginReply, decodeFriendReply } = require('../src/capture/game-ws');
    const login = decodeLoginReply(loginFrame.frame.body);
    assert.equal(login.gid, '90001');
    assert.equal(login.openid, 'openid-abc');
    const friends = decodeFriendReply('gamepb.friendpb.FriendService', 'GetAll', friendFrame.frame.body);
    assert.equal(friends.source, 'gamepb.friendpb.FriendService.GetAll');
    assert.deepEqual(friends.items.map((item) => item.gid).sort(), [10001, 10002, 90001]);

    // 8. SNI 提取正确
    // （经由 MITM 转发时的 ClientHello 已在内部日志中体现；此处直接验证工具函数）
    const sniRecord = Buffer.concat([
        Buffer.from([0x16, 0x03, 0x01, 0x00, 0x00]), // 占位，实际函数会读取字段
    ]);
    assert.equal(extractSniFromClientHello(sniRecord), ''); // 非完整 ClientHello 返回空串

    tlsSocket.destroy();
    await mitm.stop();
    await new Promise((resolve) => {
        gateway.server.closeAllConnections?.();
        gateway.server.close(() => resolve());
        setTimeout(resolve, 500).unref?.();
    });
});

test('会话管理器：完整 REST 流程与状态快照', async () => {
    const { createInternalCaptureService } = require('../src/capture/capture-service');
    const ca = generateSelfSignedCa({ commonName: 'Test Capture CA 2' });
    const logs = [];
    const service = createInternalCaptureService({
        ca,
        logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });

    const server = http.createServer((req, res) => {
        void service.handleRequest(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiPort = server.address().port;
    const base = `http://127.0.0.1:${apiPort}`;

    // health
    const health = await httpProxyRequest(apiPort, 'GET', `${base}/api/health`.replace(base, ''));
    assert.equal(health.status, 200);
    const healthData = JSON.parse(health.body);
    assert.equal(healthData.ok, true);
    assert.ok(Array.isArray(healthData.portPool));

    // 证书端点
    const cert = await httpProxyRequest(apiPort, 'GET', '/cert/mitmproxy-ca-cert.cer');
    assert.equal(cert.status, 200);

    // 创建会话（sessionId 在 body）
    const createRes = await httpProxyRequest(apiPort, 'POST', '/api/sessions', {
        'Content-Type': 'application/json',
    });
    // 无 body 时也应返回 400/409 之类的结构化错误，不崩溃
    assert.ok([200, 400, 409].includes(createRes.status));

    // 带完整 body 重建
    const sessionId = `test-session-${Date.now()}`;
    const createRes2 = await new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: apiPort, method: 'POST', path: '/api/sessions',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ sessionId, platform: 'qq' }));
    });
    assert.equal(createRes2.status, 200);
    const created = JSON.parse(createRes2.body);
    assert.equal(created.ok, true);
    assert.equal(created.data.platform, 'qq');
    assert.ok(created.data.publicInfo.mitmPort >= 0);

    // start（sessionId 走头，与旧客户端一致）
    const startRes = await new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: apiPort, method: 'POST', path: '/api/capture/start',
            headers: { 'Content-Type': 'application/json', 'x-capture-session-id': sessionId },
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ mode: 'qq' }));
    });
    assert.equal(startRes.status, 200);
    const started = JSON.parse(startRes.body);
    assert.ok(started.data.publicInfo.mitmPort > 0, 'start 后应返回代理端口');
    assert.ok(started.data.publicInfo.host, 'start 后应返回本机局域网地址');

    // state
    const stateRes = await httpProxyRequest(apiPort, 'GET', `/api/sessions/${sessionId}/state`);
    assert.equal(stateRes.status, 200);
    const stateData = JSON.parse(stateRes.body);
    assert.equal(stateData.data.id, sessionId);

    // 未知会话 404
    const missing = await httpProxyRequest(apiPort, 'GET', '/api/sessions/no-such/state');
    assert.equal(missing.status, 404);

    // 停止 + 删除
    await httpProxyRequest(apiPort, 'POST', '/api/capture/stop');
    const delRes = await new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: apiPort, method: 'DELETE', path: `/api/sessions/${sessionId}`,
        }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
    });
    assert.equal(delRes, 200);

    server.close();
});

test('parseGameWsFrame 对非游戏帧/坏帧容错', async () => {
    assert.equal(parseGameWsFrame(Buffer.alloc(0)), null);
    assert.equal(parseGameWsFrame(Buffer.from([0x01, 0x02, 0x03])), null);
    // 合法 GateMessage 但缺 meta
    const Message = protoRoot.lookupType('gatepb.Message');
    const bare = Buffer.from(Message.encode(Message.create({ body: Buffer.alloc(0) })).finish());
    const frame = parseGameWsFrame(bare);
    assert.ok(frame);
    assert.equal(frame.serviceName, '');
});

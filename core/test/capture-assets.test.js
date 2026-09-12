'use strict';

/**
 * 抓包资源存档测试
 *
 * 覆盖三块：
 *   1. 纯函数：响应头解析 / chunked 解码 / 压缩还原；
 *   2. 连接跟踪器：同连接多请求的顺序归因（Content-Length 与 chunked）；
 *   3. 端到端：MITM 代理转发 HTTPS 请求时，响应体被正确存档到磁盘。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');

const {
    createCaptureAssetStore,
    createConnectionAssetTracker,
    detectExt,
    parseResponseHead,
    decodeChunked,
    looksJsonish,
} = require('../src/capture/capture-asset-store');

// ---------------------------------------------------------------------------
// 1. 纯函数
// ---------------------------------------------------------------------------

test('detectExt：从 URL 提取扩展名', () => {
    assert.equal(detectExt('https://cdn.example.com/a/b/manifest.json'), '.json');
    assert.equal(detectExt('/release/plant/xx.astc?v=1'), '.astc');
    assert.equal(detectExt('https://x.com/noext'), '');
    assert.equal(detectExt(''), '');
});

test('parseResponseHead：解析状态码 / chunked / Content-Length', () => {
    const head = Buffer.from([
        'HTTP/1.1 200 OK',
        'Content-Type: application/json',
        'Content-Length: 123',
        '',
        '',
    ].join('\r\n'));
    const parsed = parseResponseHead(head);
    assert.equal(parsed.status, 200);
    assert.equal(parsed.contentLength, 123);
    assert.equal(parsed.chunked, false);
    assert.equal(parsed.contentType, 'application/json');

    const chunkedHead = Buffer.from([
        'HTTP/1.1 200 OK',
        'Transfer-Encoding: chunked',
        '',
        '',
    ].join('\r\n'));
    const parsedChunked = parseResponseHead(chunkedHead);
    assert.equal(parsedChunked.chunked, true);
    assert.equal(parsedChunked.contentLength, -1);

    const gz = parseResponseHead(Buffer.from([
        'HTTP/1.1 200 OK',
        'Content-Encoding: gzip',
        '',
        '',
    ].join('\r\n')));
    assert.equal(gz.contentEncoding, 'gzip');
});

test('decodeChunked：完整/不完整/带 trailer', () => {
    const full = Buffer.from('4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n', 'latin1');
    const parsed = decodeChunked(full);
    assert.ok(parsed);
    assert.equal(parsed.body.toString(), 'Wikipedia');
    assert.equal(parsed.consumed, full.length);

    // 不完整：返回 null
    assert.equal(decodeChunked(Buffer.from('4\r\nWi', 'latin1')), null);
    assert.equal(decodeChunked(Buffer.from('4\r\nWiki\r\n5\r\np', 'latin1')), null);

    // 尾部有余量：只消费到 chunked 体结束
    const withTail = Buffer.concat([
        Buffer.from('3\r\nabc\r\n0\r\n\r\n', 'latin1'),
        Buffer.from('HTTP/1.1 200 OK\r\n', 'latin1'),
    ]);
    const parsed2 = decodeChunked(withTail);
    assert.ok(parsed2);
    assert.equal(parsed2.body.toString(), 'abc');
    assert.equal(parsed2.consumed, 13);
});

test('looksJsonish：识别 JSON 正文', () => {
    assert.equal(looksJsonish(Buffer.from('{"images":[]}')), true);
    assert.equal(looksJsonish(Buffer.from('  [1,2]')), true);
    assert.equal(looksJsonish(Buffer.from('\uFEFF{"a":1}')), true);
    assert.equal(looksJsonish(Buffer.from('PNG...')), false);
    assert.equal(looksJsonish(Buffer.alloc(0)), false);
});

// ---------------------------------------------------------------------------
// 2. 连接跟踪器
// ---------------------------------------------------------------------------

function makeStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-assets-test-'));
    const store = createCaptureAssetStore({ dir });
    return { dir, store };
}

test('跟踪器：Content-Length 响应按序落盘', () => {
    const { dir, store } = makeStore();
    const tracker = createConnectionAssetTracker({ store });

    const body1 = Buffer.from('{"images":[{"sprite_name":"Crop_516_Seed"}]}');
    tracker.enqueue({ host: 'cdn.example.com', url: '/release/manifest.json' });
    const res1 = Buffer.concat([
        Buffer.from(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body1.length}\r\n\r\n`,
            'latin1',
        ),
        body1,
    ]);
    tracker.feed(res1);

    const body2 = Buffer.from('console.log(1)');
    tracker.enqueue({ host: 'cdn.example.com', url: '/app.js' });
    tracker.feed(Buffer.concat([
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body2.length}\r\n\r\n`, 'latin1'),
        body2,
    ]));

    const assets = store.list();
    assert.equal(assets.length, 2);
    const manifest = assets.find((a) => a.url === '/release/manifest.json');
    assert.ok(manifest, '应存档 manifest.json');
    assert.equal(fs.readFileSync(path.join(dir, manifest.file)).toString(), body1.toString());
    // manifest 别名副本
    assert.ok(manifest.alias, 'manifest 应有别名副本');
    assert.equal(fs.readFileSync(path.join(dir, manifest.alias)).toString(), body1.toString());
});

test('跟踪器：同一 chunk 里含多个响应（跨请求）', () => {
    const { store } = makeStore();
    const tracker = createConnectionAssetTracker({ store });

    const b1 = Buffer.from('{"a":1}');
    const b2 = Buffer.from('{"b":2}');
    tracker.enqueue({ host: 'h', url: '/one.json' });
    tracker.enqueue({ host: 'h', url: '/two.json' });

    // 两个响应拼在一个 TCP chunk 里
    const combined = Buffer.concat([
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${b1.length}\r\n\r\n`, 'latin1'), b1,
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${b2.length}\r\n\r\n`, 'latin1'), b2,
    ]);
    tracker.feed(combined);

    const urls = store.list().map((a) => a.url).sort();
    assert.deepEqual(urls, ['/one.json', '/two.json']);
});

test('跟踪器：chunked 响应与跨包组合', () => {
    const { dir, store } = makeStore();
    const tracker = createConnectionAssetTracker({ store });
    tracker.enqueue({ host: 'h', url: '/chunked.json' });

    const head = Buffer.from(
        'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
        'latin1',
    );
    const part1 = Buffer.from('d\r\n{"ima', 'latin1');
    const part2 = Buffer.from('ges":[]}\r\n0\r\n\r\n', 'latin1');

    tracker.feed(Buffer.concat([head, part1]));
    tracker.feed(part2);

    const assets = store.list();
    assert.equal(assets.length, 1);
    assert.equal(
        fs.readFileSync(path.join(dir, assets[0].file)).toString(),
        '{"images":[]}',
    );
});

test('跟踪器：gzip 响应自动还原', () => {
    const { dir, store } = makeStore();
    const tracker = createConnectionAssetTracker({ store });
    tracker.enqueue({ host: 'h', url: '/gz.json' });

    const plain = Buffer.from('{"images":[1,2,3]}');
    const gz = zlib.gzipSync(plain);
    tracker.feed(Buffer.concat([
        Buffer.from(
            `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length}\r\n\r\n`,
            'latin1',
        ),
        gz,
    ]));

    const assets = store.list();
    assert.equal(assets.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, assets[0].file)).toString(), plain.toString());
});

test('跟踪器：不关心的 URL（图片等）不落地', () => {
    const { store } = makeStore();
    const tracker = createConnectionAssetTracker({ store });
    tracker.enqueue({ host: 'h', url: '/images/a.png' });
    const body = Buffer.from('89504E47', 'latin1');
    tracker.feed(Buffer.concat([
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`, 'latin1'),
        body,
    ]));
    assert.equal(store.list().length, 0);
});

// ---------------------------------------------------------------------------
// 3. 端到端：MITM 代理 → HTTPS 响应存档
// ---------------------------------------------------------------------------

test('端到端：MITM 转发 HTTPS 请求并存档 JSON 响应', async () => {
    const { generateSelfSignedCa } = require('../src/capture/capture-ca');
    const { CaptureMitmProxy } = require('../src/capture/capture-mitm');

    // 伪 CDN 服务器：GET /release/manifest.json 返回资源清单 JSON
    const cdnCert = generateSelfSignedCa({ commonName: 'test-cdn' });
    const manifestBody = JSON.stringify({
        images: [{ sprite_name: 'Crop_516_Seed', source: 'release/remote/plant/x.astc' }],
    });
    const cdnServer = https.createServer({
        key: cdnCert.keyPem,
        cert: cdnCert.certPem,
    }, (req, res) => {
        if (req.url.startsWith('/release/manifest.json')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(manifestBody);
            return;
        }
        res.writeHead(404);
        res.end('not found');
    });
    await new Promise((resolve) => cdnServer.listen(0, '127.0.0.1', resolve));
    const cdnPort = cdnServer.address().port;

    // 代理（带资源存档器）
    const proxyCa = generateSelfSignedCa({ commonName: 'Test Asset CA' });
    const { dir, store } = makeStore();
    const mitm = new CaptureMitmProxy({ ca: proxyCa, logger: null, assetStore: store });
    mitm.setUpstreamOverrides({ 'cdn-test.nqf.qq.com': { host: '127.0.0.1', port: cdnPort } });
    const proxyPort = await mitm.start({});

    // 客户端 CONNECT + TLS 握手
    const { socket } = await new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: proxyPort, method: 'CONNECT',
            path: 'cdn-test.nqf.qq.com:443',
        });
        req.on('connect', (res, s) => resolve({ status: res.statusCode, socket: s }));
        req.on('error', reject);
        req.end();
    });
    const tlsSocket = await new Promise((resolve, reject) => {
        const s = tls.connect({
            socket, servername: 'cdn-test.nqf.qq.com', ca: proxyCa.certPem, rejectUnauthorized: true,
        }, () => resolve(s));
        s.on('error', reject);
    });

    // 发 HTTPS 请求，读完整响应
    const received = await new Promise((resolve) => {
        const chunks = [];
        tlsSocket.on('data', (chunk) => chunks.push(chunk));
        tlsSocket.write(
            'GET /release/manifest.json HTTP/1.1\r\n'
            + 'Host: cdn-test.nqf.qq.com\r\n'
            + 'Connection: close\r\n\r\n',
        );
        tlsSocket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
        setTimeout(() => resolve(Buffer.concat(chunks).toString('latin1')), 1500);
    });
    assert.ok(received.includes('200 OK'), '客户端应收到 200');
    assert.ok(received.includes('Crop_516_Seed'), '客户端应收到原响应体');

    // 存档断言
    const assets = store.list();
    assert.equal(assets.length, 1, `应存档 1 个资源，实际 ${assets.length}`);
    assert.equal(assets[0].url, '/release/manifest.json');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, assets[0].file), 'utf8'));
    assert.equal(saved.images[0].sprite_name, 'Crop_516_Seed');
    assert.ok(assets[0].alias, 'manifest 别名应存在');

    tlsSocket.destroy();
    await mitm.stop();
    await new Promise((resolve) => {
        cdnServer.closeAllConnections?.();
        cdnServer.close(() => resolve());
        setTimeout(resolve, 300).unref?.();
    });
});

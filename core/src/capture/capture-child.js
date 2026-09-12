'use strict';

/**
 * 内置抓包服务 - 子进程入口
 *
 * 主进程 fork 本脚本（FARM_CAPTURE_SERVICE=1）：
 *   1. 加载/生成 CA（data/capture-ca.pem）；
 *   2. 创建会话管理器与 MITM 代理；
 *   3. 启动 API HTTP 服务器（随机端口）；
 *   4. IPC 通知主进程 { captureReady, apiPort }；
 *   5. 主进程按需通过 { captureStartProxy } / { captureStopProxy } 控制代理启停。
 *
 * 设计为常驻子进程：主进程退出时由 disconnect/exit 自动结束。
 */

if (process.env.FARM_CAPTURE_SERVICE !== '1') {
    // 防止被当作主入口直接运行
    process.exit(0);
}

const http = require('node:http');
const { loadOrCreateCa } = require('./capture-ca');
const { createInternalCaptureService } = require('./capture-service');

function main() {
    const ca = loadOrCreateCa();
    const service = createInternalCaptureService({ ca, logger: console });

    const server = http.createServer((req, res) => {
        void service.handleRequest(req, res);
    });
    server.on('clientError', (_err, socket) => {
        try {
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        } catch {}
    });
    server.on('connect', async (req, clientSocket, head) => {
        // CONNECT 由 MITM 代理监听处理；API 服务器只收明文 HTTP。
        // 理论上到不了这里，兜底关闭。
        try {
            clientSocket.destroy();
        } catch {}
    });

    server.listen(0, '127.0.0.1', () => {
        const apiPort = server.address().port;
        if (process.connected && typeof process.send === 'function') {
            process.send({
                captureReady: true,
                apiPort,
                caCertFingerprint: ca.certDer ? require('node:crypto').createHash('sha256').update(ca.certDer).digest('hex') : '',
                caCreated: !!ca.created,
            });
        }
    });

    process.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.captureStartProxy) {
            service.ensureProxyRunning().then((port) => {
                process.send?.({ captureProxyStarted: true, proxyPort: port });
            }).catch((error) => {
                process.send?.({ captureProxyStarted: false, error: error.message });
            });
            return;
        }
        if (message.captureStopProxy) {
            service.stopProxy().then(() => {
                process.send?.({ captureProxyStopped: true });
            }).catch((error) => {
                process.send?.({ captureProxyStopped: false, error: error.message });
            });
            return;
        }
        if (message.captureShutdown) {
            process.exit(0);
        }
    });

    process.on('disconnect', () => process.exit(0));
    process.on('uncaughtException', (error) => {
        console.error('[CaptureService] uncaughtException:', error);
        process.send?.({ captureServiceError: error.message });
    });
}

main();

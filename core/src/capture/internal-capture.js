'use strict';

/**
 * 内置抓包服务 - 主进程侧管理器
 *
 * 负责把 capture-child.js fork 起来（单例），等待 ready 握手，
 * 并向 admin-capture-routes 提供 apiBase / 代理启停控制。
 * 子进程崩溃后下次使用会自动重启；主进程退出时子进程随 IPC 断开自动结束。
 */

const { fork } = require('node:child_process');
const path = require('node:path');

const CHILD_SCRIPT = path.join(__dirname, 'capture-child.js');

const state = {
    child: null,
    apiPort: 0,
    proxyPort: 0,
    caFingerprint: '',
    caCreated: false,
    readyPromise: null,
    startProxyPromise: null,
    lastError: '',
    startedAt: 0,
};

function isAlive() {
    return !!(state.child && state.child.exitCode === null && !state.child.killed);
}

function resetState() {
    state.child = null;
    state.apiPort = 0;
    state.proxyPort = 0;
    state.readyPromise = null;
    state.startProxyPromise = null;
}

function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.captureReady) {
        state.apiPort = Number(message.apiPort) || 0;
        state.caFingerprint = String(message.caCertFingerprint || '');
        state.caCreated = message.caCreated === true;
        state.startedAt = Date.now();
        return;
    }
    if (message.captureProxyStarted) {
        state.proxyPort = Number(message.proxyPort) || 0;
        return;
    }
    if (message.captureServiceError) {
        state.lastError = String(message.error || '');
    }
}

/**
 * 确保子进程已启动且完成握手。
 * @returns {Promise<number>} apiPort
 */
function ensureStarted(logger = null) {
    if (isAlive() && state.apiPort > 0) return Promise.resolve(state.apiPort);
    if (state.readyPromise) return state.readyPromise;

    state.readyPromise = new Promise((resolve, reject) => {
        try {
            const child = fork(CHILD_SCRIPT, [], {
                stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
                env: {
                    ...process.env,
                    FARM_CAPTURE_SERVICE: '1',
                },
            });
            state.child = child;
            state.lastError = '';

            const timeout = setTimeout(() => {
                reject(new Error('内置抓包服务启动超时'));
            }, 20_000);
            if (typeof timeout.unref === 'function') timeout.unref();

            child.on('message', (message) => {
                handleMessage(message);
                if (message && message.captureReady && state.apiPort > 0) {
                    clearTimeout(timeout);
                    logger?.info?.(`[Capture] 内置抓包服务已就绪（API 端口 ${state.apiPort}，PID ${child.pid}）`);
                    resolve(state.apiPort);
                }
            });
            child.on('error', (error) => {
                clearTimeout(timeout);
                state.lastError = error.message;
                reject(error);
            });
            child.on('exit', (code, signal) => {
                clearTimeout(timeout);
                logger?.warn?.(`[Capture] 内置抓包服务退出（code=${code} signal=${signal || ''}）`);
                resetState();
                reject(new Error(`内置抓包服务已退出（code=${code}）`));
            });
        } catch (error) {
            resetState();
            reject(error);
        }
    });
    // 失败后允许下次重试
    state.readyPromise.catch(() => {
        if (state.readyPromise) {
            state.readyPromise = null;
        }
    });
    return state.readyPromise;
}

/** 确保代理端口已监听（幂等） */
function ensureProxyStarted(logger = null) {
    if (state.startProxyPromise) return state.startProxyPromise;
    state.startProxyPromise = ensureStarted(logger)
        .then(() => new Promise((resolve, reject) => {
            const child = state.child;
            if (!child) {
                reject(new Error('内置抓包服务未运行'));
                return;
            }
            const onMessage = (message) => {
                if (!message || typeof message !== 'object') return;
                if (message.captureProxyStarted) {
                    cleanup();
                    if (message.proxyPort > 0) {
                        resolve(message.proxyPort);
                    } else {
                        reject(new Error(String(message.error || '代理启动失败')));
                    }
                    return;
                }
            };
            const cleanup = () => {
                clearTimeout(timer);
                child.off('message', onMessage);
                state.startProxyPromise = null;
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('代理启动超时'));
            }, 20_000);
            if (typeof timer.unref === 'function') timer.unref();
            child.on('message', onMessage);
            child.send({ captureStartProxy: true });
        }))
        .catch((error) => {
            state.startProxyPromise = null;
            throw error;
        });
    return state.startProxyPromise;
}

/** 停止代理监听（保留子进程与 API） */
function stopProxy(logger = null) {
    const child = state.child;
    if (!isAlive() || !child) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(), 5000);
        if (typeof timer.unref === 'function') timer.unref();
        const onMessage = (message) => {
            if (message && message.captureProxyStopped) {
                clearTimeout(timer);
                child.off('message', onMessage);
                state.proxyPort = 0;
                resolve();
            }
        };
        child.on('message', onMessage);
        try {
            child.send({ captureStopProxy: true });
        } catch {
            clearTimeout(timer);
            resolve();
        }
    }).catch((error) => {
        logger?.warn?.(`[Capture] 代理停止失败: ${error.message}`);
    });
}

function getApiBase() {
    return state.apiPort > 0 ? `http://127.0.0.1:${state.apiPort}` : '';
}

function getStatus() {
    return {
        running: isAlive() && state.apiPort > 0,
        proxyRunning: state.proxyPort > 0,
        apiPort: state.apiPort,
        proxyPort: state.proxyPort,
        pid: state.child ? state.child.pid : 0,
        caFingerprint: state.caFingerprint,
        caCreated: state.caCreated,
        lastError: state.lastError,
    };
}

/** 主进程退出前的清理（可选调用） */
function shutdown() {
    const child = state.child;
    if (!child) return;
    try {
        child.send({ captureShutdown: true });
    } catch {}
    setTimeout(() => {
        try {
            child.kill();
        } catch {}
    }, 1000).unref?.();
}

module.exports = {
    ensureStarted,
    ensureProxyStarted,
    getApiBase,
    getStatus,
    stopProxy,
    shutdown,
};

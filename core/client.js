const process = require('node:process');
const dns = require('node:dns');

// DNS 兜底：部分 Windows 环境下 Node 的 c-ares 解析器读不到系统 DNS
// （导致 gate-*.nqf.qq.com 出现 getaddrinfo ENOTFOUND），
// 这里显式补充公共 DNS，避免游戏网关域名解析失败。
try {
    const servers = dns.getServers();
    const fallback = ['114.114.114.114', '223.5.5.5', '8.8.8.8'];
    const merged = [...new Set([...servers, ...fallback])];
    dns.setServers(merged);
} catch (_) { /* 忽略：设置失败时沿用系统默认 */ }

const {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
} = require('./src/controllers/admin');
const internalCapture = require('./src/capture/internal-capture');
const systemProxy = require('./src/capture/system-proxy');
const { createRuntimeEngine } = require('./src/runtime/runtime-engine');
const { createModuleLogger } = require('./src/services/logger');
const { verifyAndRun } = require('./src/services/license');
const configSyncScheduler = require('./src/services/config-sync-scheduler');

const mainLogger = createModuleLogger('main');
const isWorkerProcess = process.env.FARM_WORKER === '1';

async function bootstrap() {
    if (isWorkerProcess) {
        require('./src/core/worker');
        return;
    }

    const licenseValid = await verifyAndRun();
    if (!licenseValid) {
        console.error('');
        console.error('[Error] License verification failed, exiting.');
        console.error('');
        process.exit(1);
        return;
    }

    // 上次运行遗留的系统代理（抓包异常退出）在启动时自动还原
    try {
        if (systemProxy.isEnabled()) {
            await systemProxy.disable();
            mainLogger.warn('检测到上次抓包遗留的系统代理，已自动恢复');
        }
    } catch (error) {
        mainLogger.warn(`恢复遗留系统代理失败: ${error.message}`);
    }
    // 进程退出安全网：抓包期间崩溃/退出时还原系统代理
    internalCapture.installProxyRestoreGuards(mainLogger);

    const runtimeEngine = createRuntimeEngine({
        processRef: process,
        mainEntryPath: __filename,
        startAdminServer,
        onStatusSync: (accountId, status) => {
            emitRealtimeStatus(accountId, status);
        },
        onLog: (entry, accountId) => {
            if (accountId && entry) {
                entry.accountId = accountId;
            }
            emitRealtimeLog(entry);
        },
        onAccountLog: (entry) => {
            emitRealtimeAccountLog(entry);
        },
    });

    runtimeEngine.start({
        startAdminServer: true,
        autoStartAccounts: false,
    }).catch((err) => {
        mainLogger.error('runtime bootstrap failed', {
            error: err && err.message ? err.message : String(err),
        });
    });

    // 官方配置自动同步：服务启动后自动检查游戏版本，有更新才联网同步（数据 + 图标）
    // 6 小时巡检一次；本机无游戏缓存时静默跳过，不影响服务
    try {
        configSyncScheduler.start({
            intervalMs: 6 * 60 * 60 * 1000,
            startupDelayMs: 90 * 1000,
            onSynced: (result) => {
                mainLogger.info('官方配置已自动同步（新道具/新作物已就绪）', {
                    bundleVers: result.bundleVers || {},
                });
            },
        });
    } catch (error) {
        mainLogger.warn(`配置自动同步启动失败: ${error.message}`);
    }
}

bootstrap().catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
});

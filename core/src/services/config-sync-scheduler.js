/**
 * 官方配置自动同步调度器
 * ==========================
 *
 * 作用
 * ----
 * 让「官方出新道具/新作物」这件事自动完成，无需人工跑脚本：
 *   1. 服务启动后延迟一小段时间（等游戏缓存就绪）自动检查一次；
 *   2. 之后每 `intervalMs`（默认 6 小时）巡检一次；
 *   3. 仅在「检测到 bundleVers 变化」时才联网同步（数据 + 图标），
 *      版本未变时只读本地文件，零网络请求；
 *   4. 同步完成后通过回调通知上层（写日志 / 广播给面板）。
 *
 * 依赖
 * ----
 * - `scripts/sync-game-config.js` 的 `autoSync()`（版本感知 + 拉取 + 合并 + 图标）
 * - 游戏客户端本地缓存（%APPDATA%/QQEX/.../miniapp_src）：官方更新时客户端会刷新它
 *
 * 注意
 * ----
 * 若本机没有游戏客户端缓存（例如部署在服务器上），autoSync 会返回
 * `no-game-cache`，调度器静默跳过并在日志中说明，不影响服务运行。
 */
'use strict';

const path = require('node:path');
const { createModuleLogger } = require('./logger');

const logger = createModuleLogger('config-sync');

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
const DEFAULT_STARTUP_DELAY_MS = 90 * 1000;     // 启动后 90 秒（等缓存/服务就绪）

let timer = null;
let running = false;
let lastResult = null;

function loadSyncTool() {
  // scripts/ 在仓库根目录（core 的上一级）
  return require(path.join(__dirname, '..', '..', '..', 'scripts', 'sync-game-config.js'));
}

/** 同步完成后热加载配置（gameConfig 的 loadConfigs 可重入：内部 Map 会清空重填） */
function reloadGameConfig() {
  try {
    const gameConfig = require('../config/gameConfig');
    if (gameConfig && typeof gameConfig.loadConfigs === 'function') {
      gameConfig.loadConfigs();
      return true;
    }
  } catch (error) {
    logger.warn(`配置热加载失败（下次重启生效）: ${error.message}`);
  }
  return false;
}

/**
 * 跑一次自动同步（并发安全：上一次未结束则跳过本轮）
 * @param {{verbose?: boolean}} opts - verbose=true 时「已是最新」也写 info 日志（用于启动首检）
 * @returns {Promise<object>} autoSync 的结果对象
 */
async function runOnce({ verbose = false } = {}) {
  if (running) {
    logger.debug('上一轮同步仍在进行，跳过本轮');
    return { ok: true, skipped: 'busy' };
  }
  running = true;
  try {
    const tool = loadSyncTool();
    const result = await tool.autoSync({ write: true, doIcons: true });
    lastResult = { ...result, at: new Date().toISOString() };

    if (result.reason === 'no-game-cache') {
      logger.info('未检测到游戏客户端缓存（可能部署在服务器且无客户端），跳过配置自动同步');
    } else if (result.upToDate) {
      if (verbose) logger.info('配置自动同步首检完成：官方配置已是最新，无需同步');
      else logger.debug('官方配置已是最新，无需同步');
    } else if (result.ok) {
      const reloaded = reloadGameConfig();
      logger.info('官方配置已自动同步完成' + (reloaded ? '（已热加载生效）' : '（下次重启生效）'), {
        bundleVers: result.bundleVers || {},
      });
    } else {
      logger.warn('官方配置自动同步未完全成功', {
        rcSync: result.rcSync,
        rcIcons: result.rcIcons,
      });
    }
    return lastResult;
  } catch (error) {
    logger.warn(`配置自动同步异常: ${error.message}`);
    lastResult = { ok: false, error: error.message, at: new Date().toISOString() };
    return lastResult;
  } finally {
    running = false;
  }
}

/**
 * 启动调度器
 * @param {{intervalMs?: number, startupDelayMs?: number, onSynced?: Function}} opts
 */
function start(opts = {}) {
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : DEFAULT_INTERVAL_MS;
  const startupDelayMs = Number(opts.startupDelayMs) >= 0
    ? Number(opts.startupDelayMs)
    : DEFAULT_STARTUP_DELAY_MS;

  if (timer) return; // 已启动

  // 启动延迟检查
  const startupTimer = setTimeout(() => {
    runOnce({ verbose: true }).then((r) => {
      if (typeof opts.onSynced === 'function' && !r.upToDate && r.reason !== 'no-game-cache') {
        try { opts.onSynced(r); } catch { /* 回调异常不影响调度 */ }
      }
    });
  }, startupDelayMs);
  if (startupTimer.unref) startupTimer.unref();

  // 周期巡检
  timer = setInterval(() => {
    runOnce().then((r) => {
      if (typeof opts.onSynced === 'function' && !r.upToDate && r.reason !== 'no-game-cache' && !r.skipped) {
        try { opts.onSynced(r); } catch { /* 忽略 */ }
      }
    });
  }, intervalMs);
  if (timer.unref) timer.unref();

  logger.info(`配置自动同步已启用（启动后 ${Math.round(startupDelayMs / 1000)}s 首检，每 ${Math.round(intervalMs / 3600000)}h 巡检）`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function getLastResult() {
  return lastResult;
}

module.exports = {
  start,
  stop,
  runOnce,
  getLastResult,
  DEFAULT_INTERVAL_MS,
};

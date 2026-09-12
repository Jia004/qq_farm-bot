'use strict';

/**
 * 抓包登录 - PC 桌面模式适配
 *
 * 与手机模式的区别：
 * 1. 手机需要手动设 Wi-Fi 代理 + 安装 CA；PC 模式由本模块自动：
 *    - 把 Windows 系统代理指向内置 MITM 端口（system-proxy.js）；
 *    - 把内置 CA 装进"当前用户 → 受信任的根证书颁发机构"（certutil，无需管理员）。
 * 2. 手机抓的是 Wi-Fi 流量里的 WS 升级 URL（含 code）；
 *    PC 版 QQ 农场是 miniapp 内嵌页面，登录 URL 形如
 *    wss://gate-obt.nqf.qq.com/prod/ws?platform=qq&os=Windows&ver=...&code=xxx
 *    解析逻辑与手机完全一致（ws-open 事件的 code 参数）。
 * 3. 用 PC 模式时不需要"下载证书/设置 Wi-Fi"提示，直接开游戏即可。
 */

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { getDataFile } = require('../config/runtime-paths');
const systemProxy = require('./system-proxy');

const CA_CERT_FILE = 'capture-ca.pem';
const CA_CERT_NAME = 'QQFarm Bot Capture CA';

function runCertUtil(args, timeout = 20000) {
    return new Promise((resolve, reject) => {
        execFile('certutil.exe', args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(String(stderr || stdout || error.message || 'certutil 执行失败').trim()));
                return;
            }
            resolve(String(stdout || ''));
        });
    });
}

/** 检查内置 CA 是否已在本机"受信任的根证书颁发机构"里 */
async function isCaTrusted() {
    if (process.platform !== 'win32') return false;
    try {
        const script = [
            `$cert = Get-ChildItem Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue |`,
            `  Where-Object { $_.Subject -match '${CA_CERT_NAME.replace(/'/g, "''")}' }`,
            `if ($cert) { Write-Output 'trusted' } else { Write-Output 'missing' }`,
        ].join('\n');
        const out = await new Promise((resolve, reject) => {
            execFile('powershell.exe',
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
                { timeout: 15000, windowsHide: true },
                (error, stdout, stderr) => {
                    if (error) return reject(new Error(String(stderr || error.message).trim()));
                    resolve(String(stdout || ''));
                });
        });
        return out.includes('trusted');
    } catch {
        return false;
    }
}

/** 把内置 CA 装进当前用户根证书存储（无需管理员权限） */
async function trustCa() {
    if (process.platform !== 'win32') throw new Error('PC 模式暂仅支持 Windows');
    const certPath = getDataFile(CA_CERT_FILE);
    if (!fs.existsSync(certPath)) throw new Error('内置 CA 证书不存在，请先启动一次抓包服务');
    const out = await runCertUtil(['-user', '-addstore', '-f', 'Root', certPath]);
    if (!/成功|completed|added|success/i.test(out) && !out.includes('added')) {
        // certutil 输出为本地化文本（如"添加到存储"），只要 exit code 0 即可
    }
    return true;
}

/**
 * 启动 PC 抓包：系统代理 → 本机 MITM 端口 + 信任内置 CA。
 * @param {number} proxyPort 内置 MITM 端口
 * @param {string[]} bypassHosts 额外豁免域名（面板地址等）
 * @returns {Promise<{proxyServer: string, caTrusted: boolean}>}
 */
async function startPcCapture(proxyPort, bypassHosts = []) {
    if (!systemProxy.isSupported()) throw new Error('PC 抓包目前仅支持 Windows 系统');
    const { proxyServer } = await systemProxy.enable(proxyPort, bypassHosts);
    let caTrusted = false;
    let caError = '';
    try {
        caTrusted = await isCaTrusted();
        if (!caTrusted) {
            await trustCa();
            caTrusted = await isCaTrusted();
        }
    } catch (error) {
        // 证书信任失败不阻断流程（用户仍可手动装证书），把错误带给上层展示
        caError = error.message;
    }
    return { proxyServer, caTrusted, caError };
}

/** 停止 PC 抓包：还原系统代理 */
async function stopPcCapture() {
    await systemProxy.disable();
}

/** PC 模式状态（供前端展示） */
async function getPcStatus(proxyPort) {
    const supported = systemProxy.isSupported();
    let caTrusted = false;
    let proxyActive = false;
    if (supported) {
        caTrusted = await isCaTrusted().catch(() => false);
        proxyActive = systemProxy.isEnabled();
    }
    return {
        supported,
        proxyPort: Number(proxyPort) || 0,
        caTrusted,
        proxyActive,
        mode: 'pc',
    };
}

module.exports = {
    getPcStatus,
    isCaTrusted,
    startPcCapture,
    stopPcCapture,
    trustCa,
};

'use strict';

/**
 * 内置抓包服务 - 系统代理管理（PC 模式）
 *
 * 抓包时把 Windows 系统代理指向本机 MITM 端口，让电脑 QQ 农场的流量
 * 自动经过内置代理；停止抓包或异常退出时恢复原设置。
 *
 * - 原设置备份到 data/capture-proxy-backup.json，进程重启后可恢复"残留代理"；
 * - 只操作 HKCU 用户级设置，不需要管理员权限；
 * - 修改注册表后用 wininet InternetSetOption 立即通知已运行的程序。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { getDataFile } = require('../config/runtime-paths');

const BACKUP_FILE = 'capture-proxy-backup.json';
const REG_PATH = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function runPowerShell(script, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
        execFile('powershell.exe', args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(String(stderr || error.message || 'PowerShell 执行失败').trim()));
                return;
            }
            resolve(String(stdout || '').trim());
        });
    });
}

function isSupported() {
    return process.platform === 'win32';
}

function readBackup() {
    try {
        const raw = fs.readFileSync(getDataFile(BACKUP_FILE), 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') return data;
    } catch {}
    return null;
}

function writeBackup(data) {
    try {
        fs.writeFileSync(getDataFile(BACKUP_FILE), JSON.stringify(data, null, 1), 'utf8');
    } catch {}
}

function clearBackup() {
    try {
        fs.unlinkSync(getDataFile(BACKUP_FILE));
    } catch {}
}

/** 读取当前系统代理设置 */
async function readCurrent() {
    const script = [
        `$reg = Get-ItemProperty -Path '${REG_PATH}' -ErrorAction SilentlyContinue`,
        `$out = [ordered]@{`,
        `  proxyEnable = if ($reg) { [int]$reg.ProxyEnable } else { 0 }`,
        `  proxyServer = if ($reg) { [string]$reg.ProxyServer } else { '' }`,
        `  proxyOverride = if ($reg) { [string]$reg.ProxyOverride } else { '' }`,
        `}`,
        `$out | ConvertTo-Json -Compress`,
    ].join('\n');
    const out = await runPowerShell(script);
    try {
        const parsed = JSON.parse(out);
        return {
            proxyEnable: Number(parsed.proxyEnable) || 0,
            proxyServer: String(parsed.proxyServer || ''),
            proxyOverride: String(parsed.proxyOverride || ''),
        };
    } catch {
        return { proxyEnable: 0, proxyServer: '', proxyOverride: '' };
    }
}

const WININET_REFRESH = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinInetRefresh {
    [DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
    public static void Apply() {
        InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0);
        InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0);
    }
}
'@ -ErrorAction SilentlyContinue
[WinInetRefresh]::Apply() | Out-Null
`;

/** 写入代理设置并立即生效 */
async function applyProxy({ proxyEnable, proxyServer, proxyOverride }) {
    const overrideLiteral = String(proxyOverride || '').replace(/'/g, "''");
    const serverLiteral = String(proxyServer || '').replace(/'/g, "''");
    const script = [
        `$path = '${REG_PATH}'`,
        `Set-ItemProperty -Path $path -Name ProxyEnable -Value ${proxyEnable ? 1 : 0} -Type DWord`,
        `Set-ItemProperty -Path $path -Name ProxyServer -Value '${serverLiteral}' -Type String`,
        `Set-ItemProperty -Path $path -Name ProxyOverride -Value '${overrideLiteral}' -Type String`,
        WININET_REFRESH,
        `Write-Output 'ok'`,
    ].join('\n');
    const out = await runPowerShell(script);
    if (!out.includes('ok')) throw new Error('系统代理设置失败');
}

/**
 * 启用系统代理指向本机 MITM 端口。
 * @param {number} port 本机 MITM 代理端口
 * @param {string[]} extraBypass 额外豁免域名（面板地址等，防止面板自身流量被劫持）
 * @returns {Promise<{proxyServer: string}>}
 */
async function enable(port, extraBypass = []) {
    if (!isSupported()) throw new Error('PC 抓包目前仅支持 Windows 系统');
    const numericPort = Number(port) || 0;
    if (numericPort <= 0) throw new Error('代理端口无效');

    // 已有备份说明之前已启用（重复点击），保留最早的原设置
    const existing = readBackup();
    if (!existing) {
        const current = await readCurrent();
        writeBackup(current);
    }

    const bypass = ['<local>', 'localhost', '127.*', '192.168.*', '10.*', '172.16.*', '172.17.*', '172.18.*'];
    for (const host of extraBypass) {
        const value = String(host || '').trim();
        if (value && !bypass.includes(value)) bypass.push(value);
    }

    const proxyServer = `127.0.0.1:${numericPort}`;
    await applyProxy({
        proxyEnable: 1,
        proxyServer,
        proxyOverride: bypass.join(';'),
    });
    return { proxyServer };
}

/**
 * 恢复抓包前的系统代理设置（无备份时关闭代理）。
 */
async function disable() {
    if (!isSupported()) return;
    const backup = readBackup();
    if (!backup) {
        // 没有备份：至少确保不残留指向本机的代理
        const current = await readCurrent();
        if (/127\.0\.0\.1:/.test(String(current.proxyServer || '')) && current.proxyEnable) {
            await applyProxy({ proxyEnable: 0, proxyServer: current.proxyServer, proxyOverride: current.proxyOverride });
        }
        return;
    }
    await applyProxy({
        proxyEnable: Number(backup.proxyEnable) ? 1 : 0,
        proxyServer: String(backup.proxyServer || ''),
        proxyOverride: String(backup.proxyOverride || ''),
    });
    clearBackup();
}

/** 是否处于"抓包代理已启用"状态（进程重启后可据此恢复） */
function isEnabled() {
    return isSupported() && !!readBackup();
}

module.exports = {
    disable,
    enable,
    isEnabled,
    isSupported,
    readCurrent,
};

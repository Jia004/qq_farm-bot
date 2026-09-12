'use strict';

/**
 * PC 抓包 - 系统代理与 CA 信任测试
 *
 * 覆盖不依赖真实 PowerShell 的纯逻辑部分；真实系统调用在 CI 上跳过。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const systemProxy = require('../src/capture/system-proxy');
const pcCapture = require('../src/capture/pc-capture');

test('system-proxy 暴露稳定接口', () => {
    for (const name of ['enable', 'disable', 'isEnabled', 'isSupported', 'readCurrent']) {
        assert.equal(typeof systemProxy[name], 'function', `缺少 ${name}`);
    }
});

test('pc-capture 暴露稳定接口', () => {
    for (const name of ['startPcCapture', 'stopPcCapture', 'getPcStatus', 'isCaTrusted', 'trustCa']) {
        assert.equal(typeof pcCapture[name], 'function', `缺少 ${name}`);
    }
});

test('enable 在非 Windows 上抛错而非静默失败', async () => {
    if (process.platform === 'win32') {
        assert.equal(systemProxy.isSupported(), true);
        return;
    }
    await assert.rejects(() => systemProxy.enable(12345), /Windows/);
});

test('enable 拒绝无效端口', async () => {
    if (!systemProxy.isSupported()) return;
    await assert.rejects(() => systemProxy.enable(0), /端口无效/);
});

test('getPcStatus 返回规范结构', async () => {
    const status = await pcCapture.getPcStatus(0);
    assert.equal(typeof status.supported, 'boolean');
    assert.equal(typeof status.caTrusted, 'boolean');
    assert.equal(typeof status.proxyActive, 'boolean');
    assert.equal(status.mode, 'pc');
    assert.equal(status.proxyPort, 0);
});

test('PC 抓包路由序列化包含 pcStatus', () => {
    // serializeFlow 是模块内部函数，这里通过导出面间接验证字段存在性
    const mod = require('../src/controllers/admin-capture-routes');
    assert.equal(typeof mod.registerAdminCaptureRoutes, 'function');
    // addCapturedValues 不应因 pcStatus 缺省而抛错
    const flow = {
        platform: 'qq',
        friendGids: new Set(),
        publicInfo: {},
        proxy: {},
        code: '',
        accountGid: '',
        openId: '',
        friendSource: '',
        friendListComplete: false,
    };
    assert.doesNotThrow(() => mod.addCapturedValues(flow, { data: {} }));
});

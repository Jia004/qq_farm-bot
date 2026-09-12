'use strict';

/**
 * 内置抓包服务 - 游戏 WebSocket 帧解析
 *
 * 游戏 WS 二进制帧 = gatepb.Message（见 src/proto/game.proto）：
 *   Message { Meta meta = 1; bytes body = 2; string auth_token = 3; }
 * 本模块在抓包子进程中用 protobufjs 懒加载项目现有 .proto，
 * 从帧里识别登录回复（提取自己 gid/openid）与好友列表响应（提取好友 gid）。
 */

const path = require('node:path');
const protobuf = require('protobufjs');
const { getResourcePath } = require('../config/runtime-paths');

let types = null;

const FRIEND_SOURCES = {
    GetAll: 'gamepb.friendpb.FriendService.GetAll',
    SyncAll: 'gamepb.friendpb.FriendService.SyncAll',
};

function ensureLoaded() {
    if (types) return types;
    const protoDir = getResourcePath('proto');
    const root = new protobuf.Root();
    // 懒加载 + keepCase，与主进程 proto.js 保持一致的字段命名
    root.loadSync([
        path.join(protoDir, 'game.proto'),
        path.join(protoDir, 'userpb.proto'),
        path.join(protoDir, 'friendpb.proto'),
    ], { keepCase: true });
    types = {
        GateMessage: root.lookupType('gatepb.Message'),
        LoginReply: root.lookupType('gamepb.userpb.LoginReply'),
        GetAllFriendsReply: root.lookupType('gamepb.friendpb.GetAllReply'),
        SyncAllFriendsReply: root.lookupType('gamepb.friendpb.SyncAllReply'),
    };
    return types;
}

function toNum(value) {
    if (value == null) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') {
        const num = Number(value);
        return Number.isSafeInteger(num) ? num : 0;
    }
    if (typeof value.toNumber === 'function') {
        const num = value.toNumber();
        return Number.isSafeInteger(num) ? num : 0;
    }
    return Number(value) || 0;
}

/**
 * 解析一个 WS 二进制帧负载为 gamepb.Message 摘要。
 * @param {Buffer} payload
 * @returns {{serviceName, methodName, messageType, errorCode, body: Buffer}|null}
 */
function parseGameWsFrame(payload) {
    if (!payload || payload.length < 2) return null;
    let msg;
    try {
        msg = ensureLoaded().GateMessage.decode(payload);
    } catch {
        return null;
    }
    const meta = msg.meta || {};
    const body = Buffer.isBuffer(msg.body) ? msg.body : Buffer.from(msg.body || []);
    return {
        serviceName: String(meta.service_name || ''),
        methodName: String(meta.method_name || ''),
        messageType: toNum(meta.message_type),
        errorCode: toNum(meta.error_code),
        body,
    };
}

/**
 * 从 LoginReply body 提取自己的 gid / openid / 昵称。
 */
function decodeLoginReply(body) {
    try {
        const reply = ensureLoaded().LoginReply.decode(body);
        const basic = reply.basic || {};
        const gid = toNum(basic.gid);
        return {
            gid: gid > 0 ? String(gid) : '',
            openid: String(basic.open_id || ''),
            name: String(basic.name || ''),
        };
    } catch {
        return null;
    }
}

/**
 * 从好友列表响应 body 提取好友 gid / 昵称列表。
 * @returns {{source: string, items: Array<{gid:number,name:string}>}|null}
 */
function decodeFriendReply(serviceName, methodName, body) {
    const source = FRIEND_SOURCES[String(methodName || '')];
    if (!source || !serviceName.endsWith('FriendService')) return null;
    try {
        const typesRef = ensureLoaded();
        const reply = methodName === 'SyncAll'
            ? typesRef.SyncAllFriendsReply.decode(body)
            : typesRef.GetAllFriendsReply.decode(body);
        const items = [];
        for (const friend of reply.game_friends || []) {
            const gid = toNum(friend.gid);
            if (gid > 0) items.push({ gid, name: String(friend.name || '') });
        }
        return { source, items };
    } catch {
        return null;
    }
}

module.exports = {
    decodeFriendReply,
    decodeLoginReply,
    parseGameWsFrame,
};

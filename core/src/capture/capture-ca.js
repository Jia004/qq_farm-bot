'use strict';

/**
 * 内置抓包服务 - 自签 CA 与动态域名证书
 *
 * 用 node:crypto 手工构造 X.509v3 DER，不引入任何第三方依赖：
 * 1. 首次启动生成一个 10 年期自签 CA（持久化到 data/capture-ca.pem / capture-ca.key）；
 * 2. MITM 握手时按 SNI 域名即时签发 30 天期叶子证书（含 SAN），由手机已信任的 CA 背书。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');

const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_CN = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';

const CA_COMMON_NAME = 'QQFarm Bot Capture CA';
const CA_CERT_FILE = 'capture-ca.pem';
const CA_KEY_FILE = 'capture-ca.key';
const LEAF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------- 最小 ASN.1 DER 编码器 ----------

function derLength(len) {
    if (len < 0x80) return Buffer.from([len]);
    const bytes = [];
    let value = len;
    while (value > 0) {
        bytes.unshift(value & 0xff);
        value >>= 8;
    }
    return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

function tlv(tag, content) {
    return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSequence(...parts) {
    return tlv(0x30, Buffer.concat(parts));
}

function derInteger(value) {
    let buf = Buffer.isBuffer(value) ? value : Buffer.from([value]);
    // 正整数且最高位为 1 时补 0x00 避免被解释为负数
    if (buf.length === 0) buf = Buffer.from([0]);
    if ((buf[0] & 0x80) !== 0) buf = Buffer.concat([Buffer.from([0]), buf]);
    return tlv(0x02, buf);
}

function derOid(dotted) {
    const parts = dotted.split('.').map(Number);
    const bytes = [parts[0] * 40 + parts[1]];
    for (let i = 2; i < parts.length; i += 1) {
        let value = parts[i];
        const stack = [value & 0x7f];
        value >>= 7;
        while (value > 0) {
            stack.push((value & 0x7f) | 0x80);
            value >>= 7;
        }
        bytes.push(...stack.reverse());
    }
    return tlv(0x06, Buffer.from(bytes));
}

function derUtf8String(text) {
    return tlv(0x0c, Buffer.from(text, 'utf8'));
}

function derUtcTime(date) {
    // UTCTime: YYMMDDHHMMSSZ
    const iso = date.toISOString().replace(/[-:T]/g, '');
    return tlv(0x17, Buffer.from(`${iso.slice(2, 14)}Z`, 'ascii'));
}

function derBitString(payload, unusedBits = 0) {
    return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), payload]));
}

function derOctetString(payload) {
    return tlv(0x04, payload);
}

function derNull() {
    return Buffer.from([0x05, 0x00]);
}

// context-specific 构造类型（explicit tagging）
function derCtxConstructed(tagNumber, content) {
    return tlv(0xa0 | tagNumber, content);
}

function nameDer(commonName) {
    // X.501 Name = SEQUENCE OF RelativeDistinguishedName
    // RDN = SET OF AttributeTypeAndValue（RFC 5280 要求 SET，严格校验器如 Windows/Apple 会检查）
    const atn = derSequence(derOid(OID_CN), derUtf8String(commonName));
    const rdn = tlv(0x31, atn);
    return derSequence(rdn);
}

function algorithmIdentifier() {
    return derSequence(derOid(OID_SHA256_RSA), derNull());
}

function randomSerial() {
    return crypto.randomBytes(16);
}

function extension(oid, innerDer, critical = false) {
    const parts = [derOid(oid)];
    if (critical) parts.push(tlv(0x01, Buffer.from([0xff])));
    parts.push(derOctetString(innerDer));
    return derSequence(...parts);
}

function basicConstraints(ca) {
    const inner = ca ? derSequence(tlv(0x01, Buffer.from([0xff]))) : derSequence();
    return extension(OID_BASIC_CONSTRAINTS, inner, true);
}

function keyUsage(bits, unusedBits) {
    return extension(OID_KEY_USAGE, derBitString(Buffer.from([bits]), unusedBits), true);
}

function keyUsageCa() {
    // keyCertSign(5) | cRLSign(6) -> 0x86, 1 unused bit
    return keyUsage(0x86, 1);
}

function keyUsageLeaf() {
    // digitalSignature(0) | keyEncipherment(2) -> 0xa0, 5 unused bits
    return keyUsage(0xa0, 5);
}

function subjectAltName(hosts) {
    const names = hosts.map((host) => tlv(0x82, Buffer.from(host, 'ascii')));
    return extension(OID_SUBJECT_ALT_NAME, derSequence(...names), false);
}

function spkiDer(publicKey) {
    return publicKey.export({ type: 'spki', format: 'der' });
}

function buildTbsCertificate({ subjectName, issuerName, publicKey, notBefore, notAfter, extensions: exts }) {
    // subjectName/issuerName 已是完整的 X.501 Name DER（外层 SEQUENCE 由 nameDer 产出），
    // 这里绝不能再包一层 SEQUENCE，否则 issuer/subject 会变成非法结构
    return derSequence(
        derCtxConstructed(0, derInteger(2)),
        derInteger(randomSerial()),
        algorithmIdentifier(),
        issuerName,
        derSequence(derUtcTime(notBefore), derUtcTime(notAfter)),
        subjectName,
        spkiDer(publicKey),
        derCtxConstructed(3, derSequence(...exts)),
    );
}

function signDer(tbs, signerPrivateKeyPem) {
    const signature = crypto.createSign('SHA256').update(tbs).sign(signerPrivateKeyPem);
    return derSequence(tbs, algorithmIdentifier(), derBitString(signature));
}

function derToPem(der, label) {
    const base64 = der.toString('base64');
    const lines = base64.match(/.{1,64}/g) || [];
    return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function generateKeyPair() {
    return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
}

// ---------- CA 与叶子证书 ----------

function generateSelfSignedCa({ commonName = CA_COMMON_NAME, notAfterMs = 10 * 365 * 24 * 60 * 60 * 1000 } = {}) {
    const { publicKey, privateKey } = generateKeyPair();
    const now = new Date();
    const notAfter = new Date(now.getTime() + notAfterMs);
    const name = nameDer(commonName);
    const tbs = buildTbsCertificate({
        subjectName: name,
        issuerName: name,
        publicKey,
        notBefore: now,
        notAfter,
        extensions: [basicConstraints(true), keyUsageCa()],
    });
    const certDer = signDer(tbs, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    return {
        commonName,
        certPem: derToPem(certDer, 'CERTIFICATE'),
        certDer,
        keyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }),
        name,
    };
}

function generateLeafCertificate({ host, ca }) {
    const { publicKey, privateKey } = generateKeyPair();
    const now = new Date();
    const notAfter = new Date(now.getTime() + LEAF_TTL_MS);
    const tbs = buildTbsCertificate({
        subjectName: nameDer(host),
        issuerName: ca.name,
        publicKey,
        notBefore: now,
        notAfter,
        extensions: [basicConstraints(false), keyUsageLeaf(), subjectAltName([host])],
    });
    const certDer = signDer(tbs, ca.keyPem);
    return {
        host,
        keyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }),
        certPem: `${derToPem(certDer, 'CERTIFICATE')}${ca.certPem}`,
    };
}

// ---------- CA 持久化 ----------

function loadOrCreateCa() {
    const certPath = getDataFile(CA_CERT_FILE);
    const keyPath = getDataFile(CA_KEY_FILE);
    try {
        const certPem = fs.readFileSync(certPath, 'utf8');
        const keyPem = fs.readFileSync(keyPath, 'utf8');
        const cert = new crypto.X509Certificate(certPem);
        const name = nameDer(cert.subject.CN || CA_COMMON_NAME);
        return {
            commonName: cert.subject.CN || CA_COMMON_NAME,
            certPem,
            certDer: cert.raw,
            keyPem,
            name,
            created: false,
            certPath,
        };
    } catch {
        const ca = generateSelfSignedCa();
        const dataDir = path.dirname(certPath);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(certPath, ca.certPem, { mode: 0o644 });
        fs.writeFileSync(keyPath, ca.keyPem, { mode: 0o600 });
        return { ...ca, created: true, certPath };
    }
}

// 域名 -> 叶子证书缓存（带简单上限淘汰）
class LeafCertificateCache {
    constructor(ca, maxSize = 256) {
        this.ca = ca;
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(host) {
        const normalized = String(host || '').trim().toLowerCase().replace(/\.$/, '');
        if (!normalized) throw new Error('SNI 域名为空，无法签发证书');
        const cached = this.cache.get(normalized);
        if (cached) {
            // LRU 刷新
            this.cache.delete(normalized);
            this.cache.set(normalized, cached);
            return cached;
        }
        const fresh = generateLeafCertificate({ host: normalized, ca: this.ca });
        this.cache.set(normalized, fresh);
        if (this.cache.size > this.maxSize) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
        }
        return fresh;
    }
}

module.exports = {
    LeafCertificateCache,
    derToPem,
    generateLeafCertificate,
    generateSelfSignedCa,
    loadOrCreateCa,
};

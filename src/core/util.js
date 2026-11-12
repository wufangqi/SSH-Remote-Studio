'use strict';
// Shared helpers for the SSH core. Kept Electron-free so it can be unit-tested
// with plain Node.
const crypto = require('node:crypto');
const path = require('node:path');

// POSIX path helpers for REMOTE paths (remote hosts are assumed POSIX).
const posix = path.posix;

const RemotePath = {
  join: (...parts) => posix.join(...parts),
  normalize: (p) => posix.normalize(p),
  dirname: (p) => posix.dirname(p),
  basename: (p) => posix.basename(p),
  extname: (p) => posix.extname(p),
  resolve: (p) => posix.resolve('/', p),
  isAbsolute: (p) => posix.isAbsolute(p),
};

// SHA256 fingerprint of a raw host-key blob, formatted like OpenSSH.
function fingerprint(hostKey) {
  const buf = Buffer.isBuffer(hostKey) ? hostKey : Buffer.from(hostKey);
  return 'SHA256:' + crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

function isValidPort(n) {
  return Number.isInteger(n) && n >= 0 && n <= 65535;
}

function assertPort(n, label = 'port') {
  if (!isValidPort(n)) {
    const err = new Error(`无效的${label}: ${n}（应为 0-65535 的整数）`);
    err.code = 'EINVAL';
    throw err;
  }
  return n;
}

// Wrap a node-style callback method into a Promise.
function pcall(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, ...rest) => {
      if (err) reject(err);
      else resolve(rest.length <= 1 ? rest[0] : rest);
    });
  });
}

function genId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// Map common ssh2 / system errors to friendly Chinese messages while keeping
// the original code for programmatic handling.
function friendlyError(err, context = '') {
  if (!err) return err;
  const code = err.code || '';
  const map = {
    ENOTFOUND: '无法解析主机名（DNS 失败）',
    ECONNREFUSED: '连接被拒绝（端口未开放或 SSH 服务未运行）',
    ETIMEDOUT: '连接超时',
    ECONNRESET: '连接被重置',
    EHOSTUNREACH: '主机不可达',
    ENETUNREACH: '网络不可达',
    EACCES: '权限不足',
    EPERM: '操作不被允许',
    ENOENT: '文件或目录不存在',
    EEXIST: '文件已存在',
    ENOTEMPTY: '目录非空',
  };
  let msg = err.message || String(err);
  if (code === 'ERR_UNC_HOST_NOT_ALLOWED') msg = '主机密钥校验失败（与已记录的不一致）';
  if (map[code]) msg = `${map[code]} [${code}]`;
  if (/All configured authentication methods failed/i.test(err.message)) {
    msg = '认证失败：用户名/密码/密钥不正确，或服务器不接受该认证方式';
    err.code = 'EAUTH';
  }
  if (/Timed out while waiting for handshake/i.test(err.message)) {
    msg = 'SSH 握手超时';
    err.code = 'ETIMEDOUT';
  }
  err.friendly = context ? `${context}：${msg}` : msg;
  return err;
}

module.exports = { RemotePath, fingerprint, isValidPort, assertPort, pcall, genId, friendlyError, posix };

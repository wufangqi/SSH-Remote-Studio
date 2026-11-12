'use strict';
// JSON-file persistence for connection profiles, known hosts and settings.
// Electron-free: secret encryption is injected via an optional cipher
// ({encrypt,decrypt}); in Electron main we pass safeStorage, in tests none.
const fs = require('node:fs');
const path = require('node:path');
const { genId } = require('./util');

const SECRET_FIELDS = ['password', 'passphrase', 'privateKey'];
const DEFAULTS = { connections: [], knownHosts: {}, settings: {}, forwards: {} };

class Store {
  constructor(dir, { cipher = null } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.cipher = cipher;
    this.data = structuredClone(DEFAULTS);
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...structuredClone(DEFAULTS), ...parsed };
      }
    } catch (e) {
      // Preserve a corrupt file for inspection rather than silently dropping it.
      try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      this.data = structuredClone(DEFAULTS);
    }
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  _encryptSecret(value) {
    if (value == null || value === '') return undefined;
    if (!this.cipher) return value;
    return { __enc: true, v: this.cipher.encrypt(String(value)) };
  }

  _decryptSecret(value) {
    if (value == null) return undefined;
    if (typeof value === 'object' && value.__enc) {
      if (!this.cipher) {
        const err = new Error('无法解密已保存的凭据：当前运行环境未提供加密存储。请在连接设置中重新输入密码。');
        err.code = 'EDECRYPT';
        throw err;
      }
      try {
        return this.cipher.decrypt(value.v);
      } catch {
        const err = new Error('无法解密已保存的凭据（运行环境或用户配置发生变化）。请在连接设置中重新输入密码。');
        err.code = 'EDECRYPT';
        throw err;
      }
    }
    return value;
  }

  // ---- connections ----
  _sanitize(conn) {
    const out = { ...conn };
    for (const f of SECRET_FIELDS) {
      const has = out[f] != null && out[f] !== '';
      delete out[f];
      out[`has_${f}`] = !!has;
    }
    return out;
  }

  listConnections() {
    return this.data.connections.map((c) => this._sanitize(c));
  }

  // Full config WITH decrypted secrets — for main-process use only.
  getConnectConfig(id) {
    const conn = this.data.connections.find((c) => c.id === id);
    if (!conn) throw Object.assign(new Error(`连接不存在: ${id}`), { code: 'ENOENT' });
    const out = { ...conn };
    for (const f of SECRET_FIELDS) {
      const dec = this._decryptSecret(conn[f]);
      if (dec !== undefined) out[f] = dec;
      else delete out[f];
    }
    return out;
  }

  saveConnection(input) {
    const conn = { ...input };
    if (!conn.id) conn.id = genId('conn');
    if (!conn.name) conn.name = `${conn.username}@${conn.host}:${conn.port || 22}`;
    for (const f of SECRET_FIELDS) {
      if (conn[f] != null && conn[f] !== '') conn[f] = this._encryptSecret(conn[f]);
      else delete conn[f];
    }
    const idx = this.data.connections.findIndex((c) => c.id === conn.id);
    if (idx >= 0) {
      // preserve previously stored secrets if not re-supplied
      const prev = this.data.connections[idx];
      for (const f of SECRET_FIELDS) {
        if (conn[f] === undefined && prev[f] !== undefined) conn[f] = prev[f];
      }
      this.data.connections[idx] = conn;
    } else {
      this.data.connections.push(conn);
    }
    this._save();
    return this._sanitize(conn);
  }

  deleteConnection(id) {
    const before = this.data.connections.length;
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    if (this.data.forwards) delete this.data.forwards[id];
    if (Array.isArray(this.data.settings.activeSessions)) {
      this.data.settings.activeSessions = this.data.settings.activeSessions.filter((x) => x !== id);
    }
    this._save();
    return before !== this.data.connections.length;
  }

  // ---- known hosts (TOFU) ----
  getHostKey(host, port) {
    return this.data.knownHosts[`${host}:${port}`] || null;
  }

  setHostKey(host, port, fp) {
    this.data.knownHosts[`${host}:${port}`] = fp;
    this._save();
  }

  hostKeyStore() {
    return {
      get: (h, p) => this.getHostKey(h, p),
      set: (h, p, fp) => this.setHostKey(h, p, fp),
    };
  }

  // ---- persisted forward definitions (per connection) ----
  // Saved as the user requested them (bindPort may be 0 = auto-assign) so a
  // restart can re-establish the same tunnels.
  listForwards(connId) {
    return (this.data.forwards && this.data.forwards[connId]) || [];
  }

  setForwards(connId, list) {
    if (!this.data.forwards) this.data.forwards = {};
    if (list && list.length) this.data.forwards[connId] = list;
    else delete this.data.forwards[connId];
    this._save();
  }

  // ---- settings ----
  getSetting(key, def) {
    return this.data.settings[key] !== undefined ? this.data.settings[key] : def;
  }

  setSetting(key, value) {
    this.data.settings[key] = value;
    this._save();
    return value;
  }
}

module.exports = { Store, SECRET_FIELDS };

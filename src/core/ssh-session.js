'use strict';
// A single SSH connection lifecycle wrapper around ssh2.Client.
// Electron-free: depends only on ssh2 + node builtins + ./util.
const { Client } = require('ssh2');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const { fingerprint, genId, friendlyError } = require('./util');

const STATE = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
};

function normalizeConfig(config = {}) {
  const c = { ...config };
  if (!c.id) c.id = genId('conn');
  if (!c.host) throw Object.assign(new Error('缺少主机地址 host'), { code: 'EINVAL' });
  if (!c.username) throw Object.assign(new Error('缺少用户名 username'), { code: 'EINVAL' });
  c.port = Number(c.port || 22);
  c.name = c.name || `${c.username}@${c.host}:${c.port}`;
  if (!c.authType) {
    if (c.privateKey || c.privateKeyPath) c.authType = 'key';
    else if (c.agent) c.authType = 'agent';
    else c.authType = 'password';
  }
  return c;
}

class SshSession extends EventEmitter {
  /**
   * @param {object} config connection config
   * @param {object} [opts]
   * @param {{get:Function,set:Function}} [opts.hostKeyStore] TOFU known-hosts store
   * @param {'tofu'|'accept'|'strict'} [opts.hostKeyPolicy]
   */
  constructor(config, opts = {}) {
    super();
    this.config = normalizeConfig(config);
    this.id = this.config.id;
    this.state = STATE.DISCONNECTED;
    this.client = null;
    this._sftp = null;
    this._connectPromise = null;
    this._hostKeyStore = opts.hostKeyStore || null;
    this._hostKeyPolicy = opts.hostKeyPolicy || this.config.hostKeyPolicy || 'tofu';
    this.lastError = null;
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s, this.id);
  }

  _buildConnectOptions() {
    const c = this.config;
    const opts = {
      host: c.host,
      port: c.port,
      username: c.username,
      readyTimeout: c.readyTimeout || 20000,
      keepaliveInterval: c.keepaliveInterval || 10000,
      keepaliveCountMax: c.keepaliveCountMax || 3,
      tryKeyboard: true,
    };
    if (c.password != null && c.password !== '') opts.password = c.password;
    if (c.privateKeyPath) {
      opts.privateKey = fs.readFileSync(c.privateKeyPath);
    } else if (c.privateKey) {
      opts.privateKey = c.privateKey;
    }
    if (c.passphrase) opts.passphrase = c.passphrase;
    if (c.authType === 'agent') {
      // Windows has no SSH_AUTH_SOCK convention: default to Pageant. On POSIX
      // use the agent socket only; passing 'pageant' there would make ssh2
      // attempt a Windows-only agent and fail with a confusing error.
      const envAgent = process.env.SSH_AUTH_SOCK;
      const agent = c.agent || envAgent || (process.platform === 'win32' ? 'pageant' : undefined);
      if (agent) opts.agent = agent;
    }
    if (c.algorithms) opts.algorithms = c.algorithms;
    return opts;
  }

  // ssh2 hostVerifier (callback form). Implements trust-on-first-use.
  _verifyHostKey(key, cb) {
    try {
      const buf = Buffer.isBuffer(key) ? key : Buffer.from(key);
      const fp = fingerprint(buf);
      const { host, port } = this.config;
      const policy = this._hostKeyPolicy;
      if (policy === 'accept') return cb(true);
      const store = this._hostKeyStore;
      const known = store ? store.get(host, port) : null;
      if (!known) {
        if (policy === 'strict') return cb(false);
        if (store) store.set(host, port, fp);
        this.emit('hostkey-new', { host, port, fingerprint: fp }, this.id);
        return cb(true);
      }
      if (known === fp) return cb(true);
      this.emit('hostkey-mismatch', { host, port, expected: known, got: fp }, this.id);
      return cb(false);
    } catch (e) {
      this.emit('error', e, this.id);
      return cb(false);
    }
  }

  connect() {
    if (this.state === STATE.CONNECTED) return Promise.resolve(this);
    if (this._connectPromise) return this._connectPromise;
    this._setState(STATE.CONNECTING);
    const client = new Client();
    this.client = client;
    this.lastError = null;

    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const readyTimeout = this.config.readyTimeout || 20000;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { client.end(); } catch {}
        const err = Object.assign(new Error(`连接超时 (${readyTimeout}ms): ${this.config.host}:${this.config.port}`), { code: 'ETIMEDOUT' });
        this.lastError = err;
        this._setState(STATE.DISCONNECTED);
        reject(friendlyError(err, '连接'));
      }, readyTimeout + 3000);

      client.on('ready', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._setState(STATE.CONNECTED);
        this.emit('ready', this.id);
        resolve(this);
      });
      client.on('error', (err) => {
        this.lastError = err;
        this.emit('error', friendlyError(err, '连接'), this.id);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this._setState(STATE.DISCONNECTED);
          reject(friendlyError(err, '连接'));
        }
      });
      client.on('close', () => {
        this._sftp = null;
        this._connectPromise = null;
        this._setState(STATE.DISCONNECTED);
        this.emit('close', this.id);
      });
      client.on('end', () => this.emit('end', this.id));
      client.on('banner', (b) => this.emit('banner', b, this.id));
      client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        // Answer interactive prompts with the configured password when present.
        if (this.config.password != null) finish(prompts.map(() => this.config.password));
        else finish([]);
      });

      const opts = this._buildConnectOptions();
      opts.hostVerifier = (key, cb) => this._verifyHostKey(key, cb);
      try {
        client.connect(opts);
      } catch (e) {
        clearTimeout(timer);
        settled = true;
        this._setState(STATE.DISCONNECTED);
        reject(friendlyError(e, '连接'));
      }
    });
    return this._connectPromise;
  }

  async getSftp() {
    if (this._sftp) return this._sftp;
    if (this.state !== STATE.CONNECTED) await this.connect();
    const sftp = await new Promise((resolve, reject) => {
      this.client.sftp((err, s) => (err ? reject(friendlyError(err, 'SFTP')) : resolve(s)));
    });
    this._sftp = sftp;
    sftp.on('close', () => { if (this._sftp === sftp) this._sftp = null; });
    sftp.on('error', (e) => this.emit('error', friendlyError(e, 'SFTP'), this.id));
    return sftp;
  }

  async exec(command) {
    if (this.state !== STATE.CONNECTED) await this.connect();
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(friendlyError(err, '执行命令'));
        let stdout = '';
        let stderr = '';
        stream.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
        stream.on('data', (d) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      });
    });
  }

  disconnect() {
    this._connectPromise = null;
    this._sftp = null;
    if (this.client) {
      try { this.client.end(); } catch {}
    }
    this._setState(STATE.DISCONNECTED);
  }

  destroy() {
    this.disconnect();
    this.removeAllListeners();
  }

  toJSON() {
    return {
      id: this.id,
      name: this.config.name,
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      authType: this.config.authType,
      state: this.state,
    };
  }
}

module.exports = { SshSession, STATE, normalizeConfig };

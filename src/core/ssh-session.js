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
  // ProxyJump chain: outermost hop first. Each hop carries its own auth so it
  // can be resolved from ~/.ssh/config at import time.
  if (Array.isArray(c.jump)) {
    c.jump = c.jump
      .filter((h) => h && h.host)
      .map((h) => ({
        ...h,
        host: String(h.host).trim(),
        port: Number(h.port || 22),
        username: h.username || c.username,
      }));
  } else {
    delete c.jump;
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
    this._sftpPromise = null;
    this._connectPromise = null;
    this._hostKeyStore = opts.hostKeyStore || null;
    // A per-connection policy overrides the manager-wide default.
    this._hostKeyPolicy = this.config.hostKeyPolicy || opts.hostKeyPolicy || 'tofu';
    this._jumpClients = [];
    this.lastError = null;
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s, this.id);
  }

  _buildConnectOptions(cfg = this.config, extra = {}) {
    const c = cfg;
    const opts = {
      host: c.host,
      port: c.port,
      username: c.username,
      readyTimeout: c.readyTimeout || 20000,
      keepaliveInterval: c.keepaliveInterval || 10000,
      keepaliveCountMax: c.keepaliveCountMax || 3,
      tryKeyboard: true,
    };
    if (c.authType === 'password' && c.password != null && c.password !== '') opts.password = c.password;
    if (c.authType === 'key') {
      if (c.privateKeyPath) opts.privateKey = fs.readFileSync(c.privateKeyPath);
      else if (c.privateKey) opts.privateKey = c.privateKey;
      if (c.passphrase) opts.passphrase = c.passphrase;
    }
    if (c.authType === 'agent') {
      // Windows has no SSH_AUTH_SOCK convention: default to Pageant. On POSIX
      // use the agent socket only; passing 'pageant' there would make ssh2
      // attempt a Windows-only agent and fail with a confusing error.
      const envAgent = process.env.SSH_AUTH_SOCK;
      const agent = c.agent || envAgent || (process.platform === 'win32' ? 'pageant' : undefined);
      if (agent) opts.agent = agent;
    }
    if (c.algorithms) opts.algorithms = c.algorithms;
    return { ...opts, ...extra };
  }

  // ssh2 hostVerifier (callback form). Implements trust-on-first-use for the
  // target and for every ProxyJump hop (each one is stored under its own
  // host:port, so a jump host cannot impersonate the final server).
  _verifyHostKeyFor(host, port, key, cb, meta = {}) {
    try {
      const buf = Buffer.isBuffer(key) ? key : Buffer.from(key);
      const fp = fingerprint(buf);
      const policy = this._hostKeyPolicy;
      if (policy === 'accept') return cb(true);
      const store = this._hostKeyStore;
      const known = store ? store.get(host, port) : null;
      if (!known) {
        if (policy === 'strict') return cb(false);
        if (store) store.set(host, port, fp);
        this.emit('hostkey-new', { host, port, fingerprint: fp, ...meta }, this.id);
        return cb(true);
      }
      if (known === fp) return cb(true);
      this.emit('hostkey-mismatch', { host, port, expected: known, got: fp, ...meta }, this.id);
      return cb(false);
    } catch (e) {
      this.emit('error', e, this.id);
      return cb(false);
    }
  }

  // Start one ssh2 client and resolve when its handshake completes. For the
  // final target `sock` is the last ProxyJump channel; for the first hop it is
  // null and ssh2 opens a normal TCP socket.
  _startClient(cfg, sock, { label = '连接', isTarget = false } = {}) {
    const client = new Client();
    if (isTarget) this.client = client;
    const readyTimeout = cfg.readyTimeout || 20000;
    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        try { client.end(); } catch {}
        finish(friendlyError(
          Object.assign(new Error(`连接超时 (${readyTimeout}ms): ${cfg.host}:${cfg.port}`), { code: 'ETIMEDOUT' }),
          label,
        ));
      }, readyTimeout + 3000);

      client.once('ready', () => finish());
      client.on('error', (err) => {
        // A superseded client can still emit while a newer one is live; its
        // failures must not surface as errors of the current connection.
        if (isTarget && this.client !== client) return;
        const fe = friendlyError(err, label);
        this.lastError = fe;
        if (!settled) finish(fe);
        else this.emit('error', fe, this.id);
      });
      client.once('close', () => {
        if (!settled) finish(friendlyError(new Error('连接在握手完成前关闭'), label));
      });
      client.on('keyboard-interactive', (name, instructions, lang, prompts, finishPrompt) => {
        // Answer interactive prompts with the configured password when present.
        if (cfg.authType === 'password' && cfg.password != null) finishPrompt(prompts.map(() => cfg.password));
        else finishPrompt([]);
      });

      let opts;
      try {
        opts = this._buildConnectOptions(cfg, sock ? { sock } : {});
        opts.hostVerifier = (key, cb) => this._verifyHostKeyFor(cfg.host, cfg.port || 22, key, cb, { label });
        client.connect(opts);
      } catch (e) {
        finish(friendlyError(e, label));
      }
    });
    return { client, ready };
  }

  _forwardOut(client, host, port, label) {
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
        if (err) reject(friendlyError(err, label));
        else resolve(stream);
      });
    });
  }

  _cleanupJumps() {
    for (const c of this._jumpClients) {
      try { c.end(); } catch {}
    }
    this._jumpClients = [];
  }

  _attachTargetLifecycle(client) {
    client.on('close', () => {
      // Same guard: a late 'close' from an old client must not tear down the
      // state (or the forwards) of the connection that replaced it.
      if (this.client !== client) return;
      this._sftp = null;
      this._sftpPromise = null;
      this._connectPromise = null;
      this._cleanupJumps();
      this._setState(STATE.DISCONNECTED);
      this.emit('close', this.id);
    });
    client.on('end', () => this.emit('end', this.id));
    client.on('banner', (b) => this.emit('banner', b, this.id));
  }

  connect() {
    if (this.state === STATE.CONNECTED) return Promise.resolve(this);
    if (this._connectPromise) return this._connectPromise;
    this._setState(STATE.CONNECTING);
    this._sftp = null;
    this._sftpPromise = null;
    this.lastError = null;

    this._connectPromise = (async () => {
      try {
        let sock = null;
        const jumps = Array.isArray(this.config.jump) ? this.config.jump : [];
        for (let i = 0; i < jumps.length; i++) {
          const hop = jumps[i];
          const { client, ready } = this._startClient(hop, sock, { label: `跳板机 ${i + 1}` });
          this._jumpClients.push(client);
          await ready;
          const next = jumps[i + 1] || this.config;
          sock = await this._forwardOut(client, next.host, next.port, `跳板机 ${i + 1}`);
        }

        const { client, ready } = this._startClient(this.config, sock, { label: '连接', isTarget: true });
        this._attachTargetLifecycle(client);
        await ready;
        this._setState(STATE.CONNECTED);
        this.emit('ready', this.id);
        return this;
      } catch (e) {
        this.lastError = e;
        this._cleanupJumps();
        try { if (this.client) this.client.end(); } catch {}
        this.client = null;
        this._connectPromise = null;
        this._setState(STATE.DISCONNECTED);
        this.emit('error', e, this.id);
        throw e;
      }
    })();
    return this._connectPromise;
  }

  // Concurrent callers share one in-flight channel request instead of each
  // opening its own SFTP subsystem.
  async getSftp() {
    if (this._sftp) return this._sftp;
    if (this.state !== STATE.CONNECTED) await this.connect();
    if (this._sftp) return this._sftp;
    if (!this._sftpPromise) {
      this._sftpPromise = new Promise((resolve, reject) => {
        this.client.sftp((err, s) => (err ? reject(friendlyError(err, 'SFTP')) : resolve(s)));
      }).then((sftp) => {
        this._sftpPromise = null;
        this._sftp = sftp;
        sftp.on('close', () => { if (this._sftp === sftp) this._sftp = null; });
        sftp.on('error', (e) => this.emit('error', friendlyError(e, 'SFTP'), this.id));
        return sftp;
      }, (e) => {
        this._sftpPromise = null;
        throw e;
      });
    }
    return this._sftpPromise;
  }

  // Output is capped and the command is time-boxed: a remote command that
  // prints without end must not grow the main process heap until it dies.
  async exec(command, { maxBytes = 1024 * 1024, timeoutMs = 30000 } = {}) {
    if (this.state !== STATE.CONNECTED) await this.connect();
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(friendlyError(err, '执行命令'));
        let stdout = '';
        let stderr = '';
        let bytes = 0;
        let truncated = false;
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { stream.destroy(); } catch {}
          reject(Object.assign(new Error(`命令执行超时 (${timeoutMs}ms)`), { code: 'ETIMEDOUT' }));
        }, timeoutMs);
        const settle = (fn, arg) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(arg);
        };
        const collect = (chunk, intoStderr) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            if (!truncated) {
              truncated = true;
              try { stream.destroy(); } catch {}
            }
            return;
          }
          if (intoStderr) stderr += chunk.toString('utf8');
          else stdout += chunk.toString('utf8');
        };
        stream.on('close', (code, signal) => settle(resolve, { code, signal, stdout, stderr, truncated }));
        stream.on('error', (e) => settle(reject, friendlyError(e, '执行命令')));
        stream.on('data', (d) => collect(d, false));
        stream.stderr.on('data', (d) => collect(d, true));
      });
    });
  }

  disconnect() {
    this._connectPromise = null;
    this._sftp = null;
    this._sftpPromise = null;
    this._cleanupJumps();
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

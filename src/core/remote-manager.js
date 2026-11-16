'use strict';
// Facade that owns live SSH sessions and their SFTP + forwarding services,
// and delegates persistence to a Store. This is the single surface the
// Electron IPC layer talks to. Electron-free.
const EventEmitter = require('node:events');
const { SshSession } = require('./ssh-session');
const { SftpService } = require('./sftp-service');
const { ForwardService } = require('./forward-service');

function serializeError(e) {
  if (!e) return null;
  return { message: e.friendly || e.message || String(e), code: e.code || null };
}

class RemoteManager extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {object|null} [opts.store]
   * @param {string} [opts.hostKeyPolicy]
   * @param {{attempts?:number, delayMs?:number}} [opts.forwardRetry] bind-failure retry budget
   */
  constructor({ store = null, hostKeyPolicy = 'tofu', forwardRetry = null } = {}) {
    super();
    this.store = store;
    this.hostKeyPolicy = hostKeyPolicy;
    this.forwardRetry = forwardRetry || {};
    this.sessions = new Map(); // id -> { session, sftp, forwards }
  }

  _createEntry(config) {
    const session = new SshSession(config, {
      hostKeyStore: this.store ? this.store.hostKeyStore() : null,
      hostKeyPolicy: this.hostKeyPolicy,
    });
    const sftp = new SftpService(session);
    const forwards = new ForwardService(session, {
      maxAttempts: this.forwardRetry.attempts ?? 5,
      retryDelayMs: this.forwardRetry.delayMs ?? 1000,
    });
    const id = session.id;
    const entry = { session, sftp, forwards };
    this.sessions.set(id, entry);

    session.on('state', (state) => {
      this.emit('state', { id, state });
      this._persistActiveSessions();
    });
    // NB: use a non-special event name; emitting 'error' with no listener throws.
    session.on('error', (error) => this.emit('session-error', { id, error: serializeError(error) }));
    session.on('close', () => this.emit('close', { id }));
    session.on('ready', () => this.emit('ready', { id }));
    session.on('hostkey-new', (info) => this.emit('hostkey-new', { id, ...info }));
    session.on('hostkey-mismatch', (info) => this.emit('hostkey-mismatch', { id, ...info }));
    forwards.on('added', (forward) => this.emit('forward-added', { id, forward }));
    forwards.on('removed', (info) => this.emit('forward-removed', { id, ...info }));
    forwards.on('forward-error', (info) => this.emit('forward-error', { id, ...info }));
    forwards.on('changed', (list) => this.emit('forward-changed', { id, forwards: list }));
    return entry;
  }

  require(id) {
    const entry = this.sessions.get(id);
    if (!entry) throw Object.assign(new Error(`会话不存在: ${id}（请先连接）`), { code: 'ENOSESSION' });
    return entry;
  }

  async connect(configOrId) {
    const config = typeof configOrId === 'string'
      ? this.store.getConnectConfig(configOrId)
      : configOrId;
    if (!config) throw Object.assign(new Error('缺少连接配置'), { code: 'EINVAL' });
    let entry = this.sessions.get(config.id);
    if (!entry) entry = this._createEntry(config);
    await entry.session.connect();
    this._restoreForwards(config.id, entry);
    return entry.session.toJSON();
  }

  async disconnect(id) {
    const entry = this.sessions.get(id);
    if (entry) entry.session.disconnect();
    return { id };
  }

  async disconnectAll() {
    for (const entry of this.sessions.values()) entry.session.disconnect();
  }

  status() {
    return [...this.sessions.values()].map((e) => e.session.toJSON());
  }

  // ---- SFTP delegates ----
  home(id) { return this.require(id).sftp.home(); }
  realpath(id, p) { return this.require(id).sftp.realpath(p); }
  list(id, p) { return this.require(id).sftp.list(p); }
  stat(id, p) { return this.require(id).sftp.stat(p); }
  readFile(id, p, opts) { return this.require(id).sftp.readFile(p, opts); }
  writeFile(id, p, content, opts) { return this.require(id).sftp.writeFile(p, content, opts); }
  mkdir(id, p, opts) { return this.require(id).sftp.mkdir(p, opts); }
  rename(id, oldP, newP) { return this.require(id).sftp.rename(oldP, newP); }
  remove(id, p, opts) { return this.require(id).sftp.remove(p, opts); }
  upload(id, local, remote) { return this.require(id).sftp.upload(local, remote); }
  download(id, remote, local) { return this.require(id).sftp.download(remote, local); }
  exec(id, cmd, opts) { return this.require(id).session.exec(cmd, opts); }

  // ---- forwarding delegates ----
  async addForward(id, def) {
    // Re-adding the same endpoint (typically after a restart) must not create
    // a second definition/listener. Auto-assigned ports (0) are excluded
    // because each add intentionally asks the OS for a fresh port.
    if (Number(def.bindPort) !== 0) {
      const same = this.listForwards(id).find((f) => f.type === def.type
        && f.bindHost === (def.bindHost || '127.0.0.1')
        && Number(f.bindPort) === Number(def.bindPort)
        && f.destHost === (def.destHost || '')
        && Number(f.destPort) === Number(def.destPort || 0));
      if (same) {
        if (same.status === 'active' || same.status === 'starting') return same;
        return this.restartForward(id, same.id);
      }
    }
    const fwd = await this.require(id).forwards.add(def);
    this._persistForwardDef(id, def, fwd.id);
    return fwd;
  }
  // Stop keeps the persisted definition (record survives, status disconnected).
  async stopForward(id, fid) {
    return this.require(id).forwards.stop(fid);
  }
  // Only an explicit remove drops the record and its persisted definition.
  async removeForward(id, fid) {
    const res = await this.require(id).forwards.remove(fid);
    if (this.store) this.store.setForwards(id, this.store.listForwards(id).filter((f) => f.id !== fid));
    return res;
  }
  async restartForward(id, fid) {
    return this.require(id).forwards.restart(fid);
  }
  listForwards(id) { return this.require(id).forwards.list(); }

  // Persist the requested definition (not the resolved ephemeral port) so it
  // can be re-established after a restart.
  _persistForwardDef(connId, def, fwdId, oldId) {
    if (!this.store) return;
    const list = this.store.listForwards(connId).filter((f) => f.id !== fwdId && f.id !== oldId);
    list.push({
      id: fwdId, type: def.type,
      bindHost: def.bindHost || '127.0.0.1', bindPort: def.bindPort,
      destHost: def.destHost, destPort: def.destPort,
    });
    this.store.setForwards(connId, list);
  }

  // Re-establish saved forwards after (re)connect. Runs in the background so
  // a failing tunnel never blocks or fails the connection itself. Records that
  // already exist in the session (kept across a disconnect) are restarted
  // under the same id instead of being duplicated.
  _restoreForwards(connId, entry) {
    if (!this.store) return;
    const defs = this.store.listForwards(connId);
    if (!defs.length) return;
    // Always surface the saved definitions, even when auto-start is off.
    // The setting only controls whether listeners are opened, not whether the
    // user can see and manually start their configuration.
    entry.forwards.load(defs);
    if (this.store.getSetting('restoreForwards', true) === false) return;
    (async () => {
      for (const d of defs) {
        try {
          if (entry.forwards.get(d.id)) await entry.forwards.restart(d.id);
          else await entry.forwards.add(d);
        } catch { /* keep the definition persisted; error surfaced via events */ }
      }
    })();
  }

  // Snapshot of sessions to auto-reconnect on next launch. Includes sessions
  // still 'connecting' so a restart mid-handshake doesn't drop the snapshot
  // (and the renderer's workspace-resume can still see it). Skipped during
  // shutdown so the snapshot survives for the restart.
  _persistActiveSessions() {
    if (!this.store || this._shuttingDown) return;
    const ids = [...this.sessions.values()]
      .filter((e) => e.session.state === 'connected' || e.session.state === 'connecting')
      .map((e) => e.session.id);
    this.store.setSetting('activeSessions', ids);
  }

  // ---- persistence delegates ----
  listConnections() { return this.store ? this.store.listConnections() : []; }
  saveConnection(conn) { return this.store.saveConnection(conn); }

  // Import profiles produced by the ~/.ssh/config importer. Re-importing the
  // same alias updates the existing profile (so a saved password is kept)
  // instead of creating duplicates; imported forwards are merged by their
  // endpoint key so manual forwards are never dropped.
  importConnections(profiles = []) {
    if (!this.store) return [];
    const existing = this.store.listConnections();
    const saved = [];
    for (const input of profiles) {
      const { forwards, ...profile } = input;
      const match = existing.find((c) => c.name === profile.name
        && c.host === profile.host
        && c.port === (profile.port || 22)
        && c.username === profile.username);
      if (match) profile.id = match.id;
      const conn = this.store.saveConnection(profile);
      if (Array.isArray(forwards) && forwards.length) {
        const key = (f) => `${f.type}|${f.bindHost}|${f.bindPort}|${f.destHost}|${f.destPort}`;
        const merged = this.store.listForwards(conn.id).slice();
        const seen = new Set(merged.map(key));
        for (const f of forwards) {
          if (!seen.has(key(f))) { merged.push(f); seen.add(key(f)); }
        }
        this.store.setForwards(conn.id, merged);
      }
      saved.push(conn);
    }
    return saved;
  }
  deleteConnection(id) {
    const entry = this.sessions.get(id);
    if (entry) { entry.session.destroy(); entry.forwards.destroy(); this.sessions.delete(id); }
    if (this.store) {
      this.store.setForwards(id, []);
      this._persistActiveSessions();
    }
    return this.store ? this.store.deleteConnection(id) : false;
  }

  async destroy() {
    this._shuttingDown = true;
    for (const entry of this.sessions.values()) {
      entry.forwards.destroy();
      entry.session.destroy();
    }
    this.sessions.clear();
    this.removeAllListeners();
  }
}

module.exports = { RemoteManager, serializeError };

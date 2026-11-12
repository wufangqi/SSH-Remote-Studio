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
  constructor({ store = null, hostKeyPolicy = 'tofu' } = {}) {
    super();
    this.store = store;
    this.hostKeyPolicy = hostKeyPolicy;
    this.sessions = new Map(); // id -> { session, sftp, forwards }
  }

  _createEntry(config) {
    const session = new SshSession(config, {
      hostKeyStore: this.store ? this.store.hostKeyStore() : null,
      hostKeyPolicy: this.hostKeyPolicy,
    });
    const sftp = new SftpService(session);
    const forwards = new ForwardService(session);
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
  upload(id, local, remote, opts) { return this.require(id).sftp.upload(local, remote, opts); }
  download(id, remote, local, opts) { return this.require(id).sftp.download(remote, local, opts); }
  exec(id, cmd) { return this.require(id).session.exec(cmd); }

  // ---- forwarding delegates ----
  async addForward(id, def) {
    const fwd = await this.require(id).forwards.add(def);
    this._persistForwardDef(id, def, fwd.id);
    return fwd;
  }
  async stopForward(id, fid) {
    const r = await this.require(id).forwards.stop(fid);
    if (this.store) this.store.setForwards(id, this.store.listForwards(id).filter((f) => f.id !== fid));
    return r;
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
  // a failing tunnel never blocks or fails the connection itself; failed
  // definitions stay persisted for the next attempt.
  _restoreForwards(connId, entry) {
    if (!this.store || this.store.getSetting('restoreForwards', true) === false) return;
    const defs = this.store.listForwards(connId);
    if (!defs.length) return;
    (async () => {
      for (const d of defs) {
        try {
          const fwd = await entry.forwards.add(d);
          this._persistForwardDef(connId, d, fwd.id, d.id);
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

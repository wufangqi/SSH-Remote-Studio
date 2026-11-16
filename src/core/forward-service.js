'use strict';
// TCP port forwarding over an SSH connection: local (-L), remote (-R) and
// dynamic SOCKS5 (-D). Electron-free.
//
// Lifecycle: a forward definition gets one live record. Starting it may fail
// (port in use, remote refused...), in which case it is retried up to
// `maxAttempts` times; after that it is marked 'disconnected' and left alone
// until the user restarts it or the session reconnects. Records are never
// dropped implicitly: `stop()` keeps the record, only `remove()` deletes it.
const net = require('node:net');
const EventEmitter = require('node:events');
const { assertPort, genId, pcall, friendlyError } = require('./util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(friendlyError(err, '监听')); };
    const onListening = () => { server.removeListener('error', onError); resolve(server.address()); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// Buffered, promise-based reader for a socket during the SOCKS5 handshake.
class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.chunks = [];
    this.len = 0;
    this.waiters = [];
    this.ended = false;
    this._onData = (d) => { this.chunks.push(d); this.len += d.length; this._flush(); };
    this._onEnd = () => { this.ended = true; this._rejectAll(new Error('SOCKS 连接提前关闭')); };
    socket.on('data', this._onData);
    socket.on('end', this._onEnd);
    socket.on('error', this._onEnd);
    socket.on('close', this._onEnd);
  }
  _flush() {
    while (this.waiters.length && this.len >= this.waiters[0].n) {
      const w = this.waiters.shift();
      w.resolve(this._take(w.n));
    }
  }
  _take(n) {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const need = n - off;
      if (c.length <= need) { out.set(c, off); off += c.length; this.chunks.shift(); }
      else { out.set(c.subarray(0, need), off); this.chunks[0] = c.subarray(need); off += need; }
    }
    this.len -= n;
    return out;
  }
  read(n) {
    if (this.len >= n) return Promise.resolve(this._take(n));
    if (this.ended) return Promise.reject(new Error('SOCKS 连接提前关闭'));
    return new Promise((resolve, reject) => this.waiters.push({ n, resolve, reject }));
  }
  _rejectAll(e) { for (const w of this.waiters) w.reject(e); this.waiters = []; }
  drain() { const buf = Buffer.concat(this.chunks); this.chunks = []; this.len = 0; return buf; }
  detach() {
    this.socket.removeListener('data', this._onData);
    this.socket.removeListener('end', this._onEnd);
    this.socket.removeListener('error', this._onEnd);
    this.socket.removeListener('close', this._onEnd);
    this._rejectAll(new Error('reader detached'));
  }
}

function socksReply(socket, rep) {
  // VER=5, REP, RSV=0, ATYP=1 (IPv4), BND.ADDR=0.0.0.0, BND.PORT=0
  try { socket.write(Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch {}
}

function pipePair(socket, stream, onBytes) {
  socket.pipe(stream).pipe(socket);
  const cleanup = () => { try { socket.destroy(); } catch {} try { stream.destroy(); } catch {} };
  socket.on('error', cleanup);
  stream.on('error', cleanup);
  socket.on('close', cleanup);
  stream.on('close', cleanup);
  if (onBytes) {
    socket.on('data', (d) => onBytes(d.length, 'up'));
    stream.on('data', (d) => onBytes(d.length, 'down'));
  }
}

class ForwardService extends EventEmitter {
  /**
   * @param {import('./ssh-session').SshSession} session
   * @param {{maxAttempts?:number, retryDelayMs?:number}} [opts]
   */
  constructor(session, { maxAttempts = 5, retryDelayMs = 1000 } = {}) {
    super();
    this.session = session;
    this.forwards = new Map();
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 5);
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
    this._remoteHandler = null;
    this._remoteHandlerClient = null;
    this._onSessionClose = () => this._markAllStopped('SSH 连接已关闭', 'ECLOSED');
    session.on('close', this._onSessionClose);
  }

  get client() { return this.session.client; }

  _public(rec) {
    return {
      id: rec.id,
      type: rec.type,
      bindHost: rec.bindHost,
      bindPort: rec.bindPort,
      destHost: rec.destHost,
      destPort: rec.destPort,
      status: rec.status,
      error: rec.error || null,
      errorCode: rec.errorCode || null,
      attempts: rec.attempts || 0,
      maxAttempts: this.maxAttempts,
      connections: rec.connections,
      bytesUp: rec.bytesUp,
      bytesDown: rec.bytesDown,
      createdAt: rec.createdAt,
      label: this._label(rec),
    };
  }

  // Language-neutral: the UI localizes the type badge, so the label carries
  // only addresses and never prose.
  _label(rec) {
    if (rec.type === 'dynamic') return `SOCKS5 ${rec.bindHost}:${rec.bindPort}`;
    return `${rec.bindHost}:${rec.bindPort} → ${rec.destHost}:${rec.destPort}`;
  }

  _newRecord(def, type) {
    const id = def.id || genId('fwd');
    return {
      id, type,
      bindHost: def.bindHost || '127.0.0.1',
      bindPort: def.bindPort,
      // What the user asked for. bindPort becomes the resolved port once
      // listening, but a restart must re-request 0 rather than pin the
      // ephemeral port that happened to be free last time.
      requestedBindPort: def.bindPort,
      destHost: def.destHost,
      destPort: def.destPort,
      status: 'starting',
      error: null,
      errorCode: null,
      attempts: 0,
      connections: 0,
      bytesUp: 0,
      bytesDown: 0,
      createdAt: Date.now(),
      server: null,
    };
  }

  get(id) { return this.forwards.get(id) || null; }

  // Load saved definitions as disconnected records without opening listeners.
  // This keeps the user's forward configuration visible after a restart even
  // when "restore on startup" is off; they can start each row manually.
  load(defs = []) {
    const added = [];
    for (const def of defs) {
      if (!def || !['local', 'remote', 'dynamic'].includes(def.type)) continue;
      if (this.forwards.has(def.id)) continue;
      const rec = this._newRecord(def, def.type);
      rec.status = 'stopped';
      rec.attempts = 0;
      this.forwards.set(rec.id, rec);
      added.push(this._public(rec));
    }
    if (added.length) this.emit('changed', this.list());
    return added;
  }

  // Create a record and start it, retrying up to maxAttempts. Resolves with
  // the record even when it ends 'disconnected' (the caller decides what to
  // report); only invalid definitions reject.
  async add(def) {
    if (!['local', 'remote', 'dynamic'].includes(def.type)) {
      throw Object.assign(new Error(`未知转发类型: ${def.type}`), { code: 'EINVAL' });
    }
    if (def.type === 'local') {
      assertPort(def.bindPort, '本地监听端口');
      assertPort(def.destPort, '目标端口');
      if (!def.destHost) throw Object.assign(new Error('缺少目标主机 destHost'), { code: 'EINVAL' });
    } else if (def.type === 'remote') {
      assertPort(def.bindPort, '远程监听端口');
      assertPort(def.destPort, '目标端口');
      if (!def.destHost) throw Object.assign(new Error('缺少目标主机 destHost'), { code: 'EINVAL' });
    } else {
      assertPort(def.bindPort, 'SOCKS 监听端口');
    }
    await this.session.connect();
    const rec = this._newRecord(def, def.type);
    this.forwards.set(rec.id, rec);
    await this._startWithRetry(rec);
    return this._public(rec);
  }

  // Restart a stopped/disconnected record (same id, fresh retry budget).
  async restart(id) {
    const rec = this.forwards.get(id);
    if (!rec) return null;
    if (rec.status === 'active') return this._public(rec);
    await this.session.connect();
    rec.attempts = 0;
    rec.error = null;
    rec.errorCode = null;
    await this._startWithRetry(rec);
    return this._public(rec);
  }

  async _startWithRetry(rec) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      rec.attempts = attempt;
      try {
        await this._bind(rec);
        rec.status = 'active';
        rec.error = null;
        rec.errorCode = null;
        rec.attempts = 0;
        this.emit('added', this._public(rec));
        return true;
      } catch (e) {
        const fe = friendlyError(e, rec.type === 'remote' ? '远程转发' : '监听');
        rec.status = 'error';
        rec.error = fe.friendly || e.message;
        rec.errorCode = fe.code || null;
        this.emit('changed', this.list());
        if (attempt < this.maxAttempts) await sleep(this.retryDelayMs);
      }
    }
    // Give up: mark disconnected, keep the record for the user to restart or
    // delete. No further automatic retries in this session.
    rec.status = 'disconnected';
    rec.attempts = this.maxAttempts;
    this.emit('changed', this.list());
    return false;
  }

  async _bind(rec) {
    if (rec.type === 'local') return this._bindLocal(rec);
    if (rec.type === 'dynamic') return this._bindDynamic(rec);
    return this._bindRemote(rec);
  }

  async _listen(rec, server) {
    try {
      const addr = await listen(server, rec.bindHost, rec.requestedBindPort);
      rec.bindPort = addr.port;
      rec.server = server;
      // listen() drops its one-shot error handler once bound; keep a permanent
      // one so a later server error cannot become an uncaught exception.
      server.on('error', (e) => this.emit('forward-error', { id: rec.id, error: friendlyError(e, '监听') }));
    } catch (e) {
      try { server.close(); } catch {}
      if (rec.sockets) {
        for (const s of rec.sockets) { try { s.destroy(); } catch {} }
        rec.sockets.clear();
      }
      throw e;
    }
  }

  async _bindLocal(rec) {
    const client = this.client;
    const sockets = new Set();
    rec.sockets = sockets;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      rec.connections++;
      this.emit('connection', { id: rec.id, type: 'local' });
      client.forwardOut(rec.bindHost, rec.bindPort, rec.destHost, rec.destPort, (err, stream) => {
        if (err) {
          this.emit('forward-error', { id: rec.id, error: friendlyError(err, '本地转发') });
          socket.destroy();
          return;
        }
        pipePair(socket, stream, (n, dir) => { if (dir === 'up') rec.bytesUp += n; else rec.bytesDown += n; });
      });
    });
    await this._listen(rec, server);
  }

  async _bindDynamic(rec) {
    const client = this.client;
    const sockets = new Set();
    rec.sockets = sockets;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      rec.connections++;
      this.emit('connection', { id: rec.id, type: 'dynamic' });
      this._handleSocks(socket, rec, client).catch(() => { try { socket.destroy(); } catch {} });
    });
    await this._listen(rec, server);
  }

  async _bindRemote(rec) {
    const client = this.client;
    this._ensureRemoteHandler();
    let boundPort;
    try {
      boundPort = await pcall(client.forwardIn.bind(client), rec.bindHost, rec.requestedBindPort);
    } catch (e) {
      throw friendlyError(e, '远程转发');
    }
    if (typeof boundPort === 'number' && boundPort > 0) rec.bindPort = boundPort;
  }

  _ensureRemoteHandler() {
    const client = this.client;
    if (this._remoteHandler && this._remoteHandlerClient === client) return;
    // The session may have been replaced by a reconnect; the handler belongs
    // to a specific ssh2 Client and must be re-attached to the live one.
    this._detachRemoteHandler();
    // ssh2 Client emits 'tcp connection' (info, accept, reject) for incoming
    // remote-forwarded connections; accept() yields the channel stream.
    const handler = (info, accept, reject) => {
      const candidates = [...this.forwards.values()].filter(
        (r) => r.type === 'remote' && r.status === 'active' && r.bindPort === info.destPort
      );
      const rec = candidates.find((r) => r.bindHost === info.destIP) || candidates[0];
      if (!rec) { reject(); return; }
      const stream = accept();
      rec.connections++;
      this.emit('connection', { id: rec.id, type: 'remote' });
      const socket = net.connect(rec.destPort, rec.destHost, () => {
        pipePair(socket, stream, (n, dir) => { if (dir === 'up') rec.bytesUp += n; else rec.bytesDown += n; });
      });
      socket.on('error', () => stream.destroy());
    };
    client.on('tcp connection', handler);
    this._remoteHandler = handler;
    this._remoteHandlerClient = client;
  }

  _detachRemoteHandler() {
    if (this._remoteHandler && this._remoteHandlerClient) {
      try { this._remoteHandlerClient.removeListener('tcp connection', this._remoteHandler); } catch {}
    }
    this._remoteHandler = null;
    this._remoteHandlerClient = null;
  }

  async _handleSocks(socket, rec, client) {
    const reader = new SocketReader(socket);
    const greet = await reader.read(2);
    if (greet[0] !== 0x05) { socket.destroy(); return; }
    const methods = await reader.read(greet[1]);
    if (!methods.includes(0x00)) { socket.end(Buffer.from([0x05, 0xff])); return; }
    socket.write(Buffer.from([0x05, 0x00])); // no authentication required
    const head = await reader.read(4);
    const [, cmd, , atyp] = head;
    if (cmd !== 0x01) { socksReply(socket, 0x07); socket.end(); return; } // only CONNECT
    let host;
    if (atyp === 0x01) {
      const b = await reader.read(4);
      host = `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
    } else if (atyp === 0x03) {
      const len = (await reader.read(1))[0];
      host = (await reader.read(len)).toString('utf8');
    } else if (atyp === 0x04) {
      const b = await reader.read(16);
      const groups = [];
      for (let i = 0; i < 16; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
      host = groups.join(':');
    } else {
      socksReply(socket, 0x08); socket.end(); return;
    }
    const portBuf = await reader.read(2);
    const port = (portBuf[0] << 8) | portBuf[1];

    await new Promise((resolve) => {
      client.forwardOut(rec.bindHost, rec.bindPort, host, port, (err, stream) => {
        if (err) {
          socksReply(socket, 0x05); // connection refused / general failure
          socket.end();
          this.emit('forward-error', { id: rec.id, error: friendlyError(err, `SOCKS → ${host}:${port}`) });
          return resolve();
        }
        socksReply(socket, 0x00);
        const leftover = reader.drain();
        reader.detach();
        if (leftover.length) stream.write(leftover);
        pipePair(socket, stream, (n, dir) => { if (dir === 'up') rec.bytesUp += n; else rec.bytesDown += n; });
        resolve();
      });
    });
  }

  // Stop listening but KEEP the record (status 'stopped', i.e. disconnected).
  async stop(id) {
    const rec = this.forwards.get(id);
    if (!rec) return null;
    await this._teardown(rec);
    rec.status = 'stopped';
    rec.error = null;
    rec.errorCode = null;
    this.emit('changed', this.list());
    return this._public(rec);
  }

  // Delete the record entirely (the only operation that drops it).
  async remove(id) {
    const rec = this.forwards.get(id);
    if (!rec) return null;
    await this._teardown(rec);
    this.forwards.delete(id);
    this.emit('removed', { id });
    return { id };
  }

  async _teardown(rec) {
    if (rec.server) {
      const server = rec.server;
      rec.server = null;
      // Drop live tunnelled connections so close() settles immediately
      // instead of waiting for remote peers to hang up.
      if (rec.sockets) {
        for (const s of rec.sockets) { try { s.destroy(); } catch {} }
        rec.sockets.clear();
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        try { server.close(() => { clearTimeout(timer); resolve(); }); } catch { clearTimeout(timer); resolve(); }
      });
    }
    if (rec.type === 'remote' && this.client && this.session.state === 'connected') {
      try { await pcall(this.client.unforwardIn.bind(this.client), rec.bindHost, rec.bindPort); } catch {}
      const stillRemote = [...this.forwards.values()].some(
        (r) => r.type === 'remote' && r.id !== rec.id && r.status === 'active'
      );
      if (!stillRemote) this._detachRemoteHandler();
    }
  }

  _markAllStopped(reason, code) {
    for (const rec of this.forwards.values()) {
      if (rec.server) { try { rec.server.close(); } catch {} rec.server = null; }
      if (rec.sockets) {
        for (const s of rec.sockets) { try { s.destroy(); } catch {} }
        rec.sockets.clear();
      }
      // Only live states transition; records the user stopped stay stopped
      // and keep their clean (error-free) state.
      if (rec.status === 'active' || rec.status === 'starting' || rec.status === 'error') {
        rec.status = 'disconnected';
        rec.error = reason;
        rec.errorCode = code || null;
      }
    }
    this._detachRemoteHandler();
    this.emit('changed', this.list());
  }

  async stopAll() {
    for (const id of [...this.forwards.keys()]) await this.stop(id);
  }

  list() {
    return [...this.forwards.values()].map((r) => this._public(r));
  }

  destroy() {
    this.session.removeListener('close', this._onSessionClose);
    this._detachRemoteHandler();
    for (const rec of this.forwards.values()) {
      if (rec.server) { try { rec.server.close(); } catch {} rec.server = null; }
      // server.close() alone leaves established connections open, which would
      // keep the process alive past quit.
      if (rec.sockets) {
        for (const s of rec.sockets) { try { s.destroy(); } catch {} }
        rec.sockets.clear();
      }
    }
    this.forwards.clear();
    this.removeAllListeners();
  }
}

module.exports = { ForwardService, SocketReader };

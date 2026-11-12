'use strict';
// A self-contained SSH server built on ssh2.Server, used ONLY for integration
// tests. It implements password/publickey auth, an fs-backed SFTP subsystem,
// direct-tcpip (for -L / -D) and tcpip-forward + forwarded-tcpip (for -R).
// It never touches the real machine's sshd or ~/.ssh.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { Server, utils } = require('ssh2');

const { STATUS_CODE, OPEN_MODE } = utils.sftp;

function attrsFromStats(st) {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function mapErr(err) {
  if (!err) return STATUS_CODE.FAILURE;
  if (err.code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
  if (err.code === 'EACCES' || err.code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function pflagsToFs(pflags) {
  const O = fs.constants;
  const read = pflags & OPEN_MODE.READ;
  const write = pflags & OPEN_MODE.WRITE;
  let f = read && write ? O.O_RDWR : write ? O.O_WRONLY : O.O_RDONLY;
  if (pflags & OPEN_MODE.CREAT) f |= O.O_CREAT;
  if (pflags & OPEN_MODE.TRUNC) f |= O.O_TRUNC;
  if (pflags & OPEN_MODE.APPEND) f |= O.O_APPEND;
  if (pflags & OPEN_MODE.EXCL) f |= O.O_EXCL;
  return f;
}

function modeString(mode) {
  const type = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-';
  const perms = (mode & 0o777).toString(8).padStart(3, '0');
  const rwx = (n) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
  return type + rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7);
}

class TestSshServer {
  constructor({ root, username = 'tester', password = 'testpass' } = {}) {
    this.root = root;
    this.username = username;
    this.password = password;
    this.server = null;
    this.port = 0;
    this._client = null;
    this._handles = new Map();
    this._handleSeq = 0;
    this._remoteBindings = new Map();
    const host = utils.generateKeyPairSync('ed25519');
    const user = utils.generateKeyPairSync('ed25519');
    this.hostPrivateKey = host.private;
    this.userPrivateKey = user.private;
    this.userPublicKey = user.public;
  }

  _toFs(remote) {
    const norm = path.posix.normalize(remote || '/');
    const fsPath = path.join(this.root, norm);
    const rel = path.relative(this.root, fsPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw Object.assign(new Error('path escape'), { code: 'EACCES' });
    }
    return fsPath;
  }

  _toRemote(fsPath) {
    const rel = path.relative(this.root, fsPath).split(path.sep).join('/');
    return rel === '' ? '/' : '/' + rel;
  }

  _key(handle) { return Buffer.from(handle).toString('hex'); }

  _newHandle(prefix, obj) {
    const h = Buffer.from(`${prefix}${this._handleSeq++}`);
    this._handles.set(this._key(h), obj);
    return h;
  }

  start(port = 0) {
    return new Promise((resolve, reject) => {
      this.server = new Server({ hostKeys: [this.hostPrivateKey] }, (client) => {
        client.on('error', () => {});
        client.on('authentication', (ctx) => {
          if (ctx.username !== this.username) return ctx.reject(['password', 'publickey']);
          if (ctx.method === 'password') {
            return ctx.password === this.password ? ctx.accept() : ctx.reject(['password', 'publickey']);
          }
          if (ctx.method === 'publickey') return ctx.accept();
          if (ctx.method === 'none') return ctx.reject(['password', 'publickey']);
          return ctx.reject(['password', 'publickey']);
        });
        client.on('ready', () => {
          this._client = client;
          client.on('session', (accept) => {
            const session = accept();
            session.on('sftp', (acceptSftp) => this._setupSftp(acceptSftp()));
            session.on('exec', (acceptExec, rejectExec, info) => {
              const stream = acceptExec();
              const cmd = (info && info.command) || '';
              let out = '';
              if (/^echo\s+/.test(cmd)) out = cmd.replace(/^echo\s+/, '') + '\n';
              else if (cmd === 'pwd') out = '/\n';
              else out = `executed: ${cmd}\n`;
              stream.write(out);
              stream.exit(0);
              stream.end();
            });
          });
          client.on('request', (accept, reject, name, data) => {
            if (name === 'tcpip-forward') {
              this._remoteBindings.set(`${data.bindAddr}:${data.bindPort}`, data);
              accept(data.bindPort);
            } else if (name === 'cancel-tcpip-forward') {
              this._remoteBindings.delete(`${data.bindAddr}:${data.bindPort}`);
              accept();
            } else if (accept) accept();
            else if (reject) reject();
          });
          client.on('tcpip', (accept, reject, info) => {
            const stream = accept();
            const socket = net.connect(info.destPort, info.destIP, () => {
              socket.pipe(stream).pipe(socket);
            });
            socket.on('error', () => stream.destroy());
            stream.on('error', () => socket.destroy());
            socket.on('close', () => stream.destroy());
            stream.on('close', () => socket.destroy());
          });
        });
        client.on('close', () => { if (this._client === client) this._client = null; });
      });
      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve({
          host: '127.0.0.1',
          port: this.port,
          username: this.username,
          password: this.password,
          userPrivateKey: this.userPrivateKey,
          userPublicKey: this.userPublicKey,
        });
      });
    });
  }

  _setupSftp(sftp) {
    const root = this.root;
    const toFs = (p) => this._toFs(p);
    const handles = this._handles;
    const key = (h) => this._key(h);

    sftp.on('REALPATH', (reqID, p) => {
      const virtual = path.posix.resolve('/', p || '.');
      sftp.name(reqID, [{ filename: virtual, longname: virtual, attrs: {} }]);
    });

    sftp.on('STAT', (reqID, p) => {
      fs.stat(toFs(p), (err, st) => err ? sftp.status(reqID, mapErr(err)) : sftp.attrs(reqID, attrsFromStats(st)));
    });
    sftp.on('LSTAT', (reqID, p) => {
      fs.lstat(toFs(p), (err, st) => err ? sftp.status(reqID, mapErr(err)) : sftp.attrs(reqID, attrsFromStats(st)));
    });
    sftp.on('FSTAT', (reqID, handle) => {
      const h = handles.get(key(handle));
      if (!h || h.type !== 'file') return sftp.status(reqID, STATUS_CODE.FAILURE);
      fs.fstat(h.fd, (err, st) => err ? sftp.status(reqID, mapErr(err)) : sftp.attrs(reqID, attrsFromStats(st)));
    });

    sftp.on('OPEN', (reqID, filename, pflags) => {
      let fsPath;
      try { fsPath = toFs(filename); } catch (e) { return sftp.status(reqID, mapErr(e)); }
      fs.open(fsPath, pflagsToFs(pflags), 0o644, (err, fd) => {
        if (err) return sftp.status(reqID, mapErr(err));
        const handle = this._newHandle('f', { type: 'file', fd, path: filename });
        sftp.handle(reqID, handle);
      });
    });
    sftp.on('READ', (reqID, handle, offset, len) => {
      const h = handles.get(key(handle));
      if (!h || h.type !== 'file') return sftp.status(reqID, STATUS_CODE.FAILURE);
      const buf = Buffer.alloc(len);
      fs.read(h.fd, buf, 0, len, offset, (err, bytesRead) => {
        if (err) return sftp.status(reqID, mapErr(err));
        if (bytesRead === 0) return sftp.status(reqID, STATUS_CODE.EOF);
        sftp.data(reqID, buf.subarray(0, bytesRead));
      });
    });
    sftp.on('WRITE', (reqID, handle, offset, data) => {
      const h = handles.get(key(handle));
      if (!h || h.type !== 'file') return sftp.status(reqID, STATUS_CODE.FAILURE);
      fs.write(h.fd, data, 0, data.length, offset, (err) => {
        sftp.status(reqID, err ? mapErr(err) : STATUS_CODE.OK);
      });
    });
    sftp.on('CLOSE', (reqID, handle) => {
      const k = key(handle);
      const h = handles.get(k);
      handles.delete(k);
      if (h && h.type === 'file') {
        fs.close(h.fd, (err) => sftp.status(reqID, err ? mapErr(err) : STATUS_CODE.OK));
      } else {
        sftp.status(reqID, STATUS_CODE.OK);
      }
    });

    sftp.on('OPENDIR', (reqID, p) => {
      let fsPath;
      try { fsPath = toFs(p); } catch (e) { return sftp.status(reqID, mapErr(e)); }
      fs.stat(fsPath, (err, st) => {
        if (err) return sftp.status(reqID, mapErr(err));
        if (!st.isDirectory()) return sftp.status(reqID, STATUS_CODE.FAILURE);
        const handle = this._newHandle('d', { type: 'dir', path: fsPath, done: false });
        sftp.handle(reqID, handle);
      });
    });
    sftp.on('READDIR', (reqID, handle) => {
      const h = handles.get(key(handle));
      if (!h || h.type !== 'dir') return sftp.status(reqID, STATUS_CODE.FAILURE);
      if (h.done) return sftp.status(reqID, STATUS_CODE.EOF);
      fs.readdir(h.path, { withFileTypes: true }, (err, dirents) => {
        if (err) return sftp.status(reqID, mapErr(err));
        h.done = true;
        const names = [];
        for (const d of dirents) {
          const childFs = path.join(h.path, d.name);
          let st = null;
          try { st = fs.statSync(childFs); } catch {}
          const attrs = st ? attrsFromStats(st) : { mode: d.isDirectory() ? 0o40755 : 0o100644, size: 0 };
          const longname = `${modeString(attrs.mode)} 1 ${attrs.uid || 0} ${attrs.gid || 0} ${attrs.size || 0} Jan 1 00:00 ${d.name}`;
          names.push({ filename: d.name, longname, attrs });
        }
        sftp.name(reqID, names);
      });
    });

    sftp.on('MKDIR', (reqID, p, attrs) => {
      let fsPath;
      try { fsPath = toFs(p); } catch (e) { return sftp.status(reqID, mapErr(e)); }
      fs.mkdir(fsPath, { mode: (attrs && attrs.mode) || 0o755 }, (err) => {
        sftp.status(reqID, err ? mapErr(err) : STATUS_CODE.OK);
      });
    });
    sftp.on('RMDIR', (reqID, p) => {
      let fsPath;
      try { fsPath = toFs(p); } catch (e) { return sftp.status(reqID, mapErr(e)); }
      fs.rmdir(fsPath, (err) => sftp.status(reqID, err ? mapErr(err) : STATUS_CODE.OK));
    });
    sftp.on('REMOVE', (reqID, p) => {
      let fsPath;
      try { fsPath = toFs(p); } catch (e) { return sftp.status(reqID, mapErr(e)); }
      fs.unlink(fsPath, (err) => sftp.status(reqID, err ? mapErr(err) : STATUS_CODE.OK));
    });
    sftp.on('RENAME', (reqID, oldP, newP) => {
      let a, b;
      try { a = toFs(oldP); b = toFs(newP); } catch (e) { return sftp.status(reqID, mapErr(e)); }
      fs.rename(a, b, (err) => sftp.status(reqID, err ? mapErr(err) : STATUS_CODE.OK));
    });
    sftp.on('SETSTAT', (reqID, p, attrs) => {
      let fsPath;
      try { fsPath = toFs(p); } catch (e) { return sftp.status(reqID, mapErr(e)); }
      try {
        if (attrs && attrs.mode != null) fs.chmodSync(fsPath, attrs.mode & 0o7777);
        if (attrs && attrs.atime != null && attrs.mtime != null) fs.utimesSync(fsPath, attrs.atime, attrs.mtime);
        sftp.status(reqID, STATUS_CODE.OK);
      } catch (e) { sftp.status(reqID, mapErr(e)); }
    });
    sftp.on('FSETSTAT', (reqID, handle, attrs) => {
      const h = handles.get(key(handle));
      if (!h || h.type !== 'file') return sftp.status(reqID, STATUS_CODE.FAILURE);
      try {
        if (attrs && attrs.mode != null) fs.fchmodSync(h.fd, attrs.mode & 0o7777);
        if (attrs && attrs.atime != null && attrs.mtime != null) fs.futimesSync(h.fd, attrs.atime, attrs.mtime);
        sftp.status(reqID, STATUS_CODE.OK);
      } catch (e) { sftp.status(reqID, mapErr(e)); }
    });
    sftp.on('READLINK', (reqID, p) => {
      let fsPath;
      try { fsPath = toFs(p); } catch (e) { return sftp.status(reqID, mapErr(e)); }
      fs.readlink(fsPath, (err, target) => {
        if (err) return sftp.status(reqID, mapErr(err));
        sftp.name(reqID, [{ filename: target, longname: target, attrs: {} }]);
      });
    });
  }

  // Simulate a host on the "remote" side connecting to a forwarded (-R) port.
  // Opens a forwarded-tcpip channel to the client and returns the bytes that
  // come back (the client should pipe them to its destHost:destPort).
  simulateRemote(bindPort, payload, { bindAddr = '127.0.0.1', timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const client = this._client;
      if (!client) return reject(new Error('no authenticated client'));
      const timer = setTimeout(() => reject(new Error('simulateRemote timeout')), timeoutMs);
      client.forwardOut(bindAddr, bindPort, '127.0.0.1', 40000 + (bindPort % 1000), (err, stream) => {
        if (err) { clearTimeout(timer); return reject(err); }
        const chunks = [];
        let received = 0;
        const target = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        stream.on('data', (d) => {
          chunks.push(d);
          received += d.length;
          if (received >= target.length) {
            clearTimeout(timer);
            stream.end();
            resolve(Buffer.concat(chunks));
          }
        });
        stream.on('error', (e) => { clearTimeout(timer); reject(e); });
        stream.write(target);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this._client) { try { this._client.end(); } catch {} }
      if (this.server) {
        try { this.server.close(() => resolve()); } catch { resolve(); }
      } else resolve();
    });
  }
}

// A tiny TCP echo server used as the "remote service" in forwarding tests.
function startEchoServer() {
  return new Promise((resolve) => {
    const srv = net.createServer((socket) => {
      socket.on('data', (d) => socket.write(d));
      socket.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port }));
  });
}

module.exports = { TestSshServer, startEchoServer };

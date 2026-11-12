'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { RemoteManager } = require('../src/core/remote-manager');
const { Store } = require('../src/core/store');
const { TestSshServer, startEchoServer } = require('./test-server');

function tmpRoot() {
  const dir = path.join(__dirname, `.tmp-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tcpEcho(port, payload) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(payload));
    const chunks = [];
    let n = 0;
    const t = setTimeout(() => { s.destroy(); reject(new Error('tcp echo timeout')); }, 6000);
    s.on('data', (d) => {
      chunks.push(d); n += d.length;
      if (n >= payload.length) { clearTimeout(t); s.end(); resolve(Buffer.concat(chunks)); }
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function socks5(proxyPort, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let step = 0;
    const timer = setTimeout(() => { s.destroy(); reject(new Error('socks timeout')); }, 6000);
    const fail = (e) => { clearTimeout(timer); s.destroy(); reject(e); };
    s.on('error', fail);
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (step === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('socks greeting failed'));
        buf = buf.subarray(2); step = 1;
        const ip = destHost.split('.').map(Number);
        s.write(Buffer.from([5, 1, 0, 1, ip[0], ip[1], ip[2], ip[3], (destPort >> 8) & 255, destPort & 255]));
      } else if (step === 1) {
        if (buf.length < 10) return;
        if (buf[1] !== 0) return fail(new Error('socks reply code ' + buf[1]));
        buf = buf.subarray(10); step = 2;
        clearTimeout(timer);
        if (buf.length) s.unshift(buf);
        s.removeAllListeners('data');
        s.removeListener('error', fail);
        resolve(s);
      }
    });
  });
}

describe('SSH Remote Studio core integration', () => {
  let server, info, echo, root, storeDir;

  before(async () => {
    root = tmpRoot();
    storeDir = tmpRoot();
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hello.txt'), 'hello remote\n');
    fs.writeFileSync(path.join(root, 'sub', 'nested.txt'), 'nested content');
    server = new TestSshServer({ root });
    info = await server.start(0);
    echo = await startEchoServer();
  });

  after(async () => {
    if (echo) echo.server.close();
    if (server) await server.stop();
    for (const d of [root, storeDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  function newManager() {
    const store = new Store(storeDir);
    return new RemoteManager({ store, hostKeyPolicy: 'accept' });
  }

  function baseConfig(extra = {}) {
    return {
      id: 'conn-' + crypto.randomBytes(3).toString('hex'),
      host: info.host, port: info.port, username: info.username,
      password: info.password, ...extra,
    };
  }

  it('connects with password and runs exec', async () => {
    const m = newManager();
    const cfg = baseConfig();
    const status = await m.connect(cfg);
    assert.equal(status.state, 'connected');
    const res = await m.exec(cfg.id, 'echo integration-ok');
    assert.equal(res.code, 0);
    assert.match(res.stdout, /integration-ok/);
    await m.destroy();
  });

  it('rejects a wrong password', async () => {
    const m = newManager();
    await assert.rejects(() => m.connect(baseConfig({ password: 'wrong-pass' })), (e) => {
      assert.ok(/认证失败|authentication/i.test(e.message));
      return true;
    });
    await m.destroy();
  });

  it('connects with a public key', async () => {
    const m = newManager();
    const cfg = baseConfig({ password: undefined, authType: 'key', privateKey: info.userPrivateKey });
    const status = await m.connect(cfg);
    assert.equal(status.state, 'connected');
    await m.destroy();
  });

  it('SFTP: home, list, read, write, stat, rename, mkdir, remove', async () => {
    const m = newManager();
    const cfg = baseConfig();
    await m.connect(cfg);
    const id = cfg.id;

    const home = await m.home(id);
    assert.equal(home, '/');

    const listing = await m.list(id, '/');
    const names = listing.entries.map((e) => e.name);
    assert.ok(names.includes('hello.txt'));
    assert.ok(names.includes('sub'));
    const dirEntry = listing.entries.find((e) => e.name === 'sub');
    assert.equal(dirEntry.type, 'dir');

    const file = await m.readFile(id, '/hello.txt');
    assert.equal(file.content, 'hello remote\n');
    assert.equal(file.binary, false);

    await m.writeFile(id, '/written.txt', '新内容 line\n');
    const back = await m.readFile(id, '/written.txt');
    assert.equal(back.content, '新内容 line\n');

    const st = await m.stat(id, '/written.txt');
    assert.equal(st.type, 'file');
    assert.ok(st.size > 0);

    await m.rename(id, '/written.txt', '/renamed.txt');
    assert.equal(await m.readFile(id, '/renamed.txt').then((f) => f.content), '新内容 line\n');

    await m.mkdir(id, '/a/b/c', { recursive: true });
    assert.ok((await m.list(id, '/a/b')).entries.some((e) => e.name === 'c'));

    await m.remove(id, '/a', { recursive: true });
    const after = await m.list(id, '/');
    assert.ok(!after.entries.some((e) => e.name === 'a'));

    await m.remove(id, '/renamed.txt');
    await m.destroy();
  });

  it('SFTP: detects binary files and guards oversized reads', async () => {
    const m = newManager();
    const cfg = baseConfig();
    await m.connect(cfg);
    const id = cfg.id;
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    const bin = await m.readFile(id, '/bin.dat');
    assert.equal(bin.binary, true);
    assert.equal(bin.content, null);
    await assert.rejects(() => m.readFile(id, '/hello.txt', { maxBytes: 2 }), (e) => e.code === 'ETOOLARGE');
    await m.destroy();
  });

  it('SFTP: upload and download round-trip', async () => {
    const m = newManager();
    const cfg = baseConfig();
    await m.connect(cfg);
    const id = cfg.id;
    const localUp = path.join(storeDir, 'up.bin');
    const payload = crypto.randomBytes(64 * 1024);
    fs.writeFileSync(localUp, payload);
    await m.upload(id, localUp, '/uploaded.bin');
    const localDown = path.join(storeDir, 'down.bin');
    await m.download(id, '/uploaded.bin', localDown);
    assert.ok(fs.readFileSync(localDown).equals(payload));
    await m.destroy();
  });

  it('local forward (-L) tunnels to a TCP service', async () => {
    const m = newManager();
    const cfg = baseConfig();
    await m.connect(cfg);
    const fwd = await m.addForward(cfg.id, {
      type: 'local', bindHost: '127.0.0.1', bindPort: 0,
      destHost: '127.0.0.1', destPort: echo.port,
    });
    assert.equal(fwd.status, 'active');
    assert.ok(fwd.bindPort > 0);
    const payload = Buffer.from('local-forward-payload');
    const echoed = await tcpEcho(fwd.bindPort, payload);
    assert.ok(echoed.equals(payload));
    const list = m.listForwards(cfg.id);
    assert.equal(list.length, 1);
    assert.ok(list[0].connections >= 1);
    await m.stopForward(cfg.id, fwd.id);
    assert.equal(m.listForwards(cfg.id).length, 0);
    await m.destroy();
  });

  it('dynamic forward (-D) speaks SOCKS5', async () => {
    const m = newManager();
    const cfg = baseConfig();
    await m.connect(cfg);
    const fwd = await m.addForward(cfg.id, { type: 'dynamic', bindHost: '127.0.0.1', bindPort: 0 });
    assert.equal(fwd.status, 'active');
    const socket = await socks5(fwd.bindPort, '127.0.0.1', echo.port);
    const payload = Buffer.from('socks5-dynamic-payload');
    const echoed = await new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      const t = setTimeout(() => { socket.destroy(); reject(new Error('socks echo timeout')); }, 6000);
      socket.on('data', (d) => { chunks.push(d); n += d.length; if (n >= payload.length) { clearTimeout(t); socket.end(); resolve(Buffer.concat(chunks)); } });
      socket.on('error', (e) => { clearTimeout(t); reject(e); });
      socket.write(payload);
    });
    assert.ok(echoed.equals(payload));
    await m.destroy();
  });

  it('remote forward (-R) delivers connections back to a local service', async () => {
    const m = newManager();
    const cfg = baseConfig();
    await m.connect(cfg);
    const bindPort = 18080;
    const fwd = await m.addForward(cfg.id, {
      type: 'remote', bindHost: '127.0.0.1', bindPort,
      destHost: '127.0.0.1', destPort: echo.port,
    });
    assert.equal(fwd.status, 'active');
    const payload = Buffer.from('remote-forward-payload');
    const echoed = await server.simulateRemote(bindPort, payload);
    assert.ok(echoed.equals(payload));
    await m.stopForward(cfg.id, fwd.id);
    await m.destroy();
  });

  it('TOFU host-key verification trusts then detects mismatch', async () => {
    const store = new Store(tmpRoot());
    const m = new RemoteManager({ store, hostKeyPolicy: 'tofu' });
    const cfg = baseConfig();
    await m.connect(cfg);
    const fp = store.getHostKey(info.host, info.port);
    assert.ok(fp && fp.startsWith('SHA256:'));
    await m.destroy();

    // second connect with same store succeeds
    const m2 = new RemoteManager({ store, hostKeyPolicy: 'tofu' });
    await m2.connect(baseConfig());
    await m2.destroy();

    // tamper -> mismatch rejects
    store.setHostKey(info.host, info.port, 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const m3 = new RemoteManager({ store, hostKeyPolicy: 'tofu' });
    await assert.rejects(() => m3.connect(baseConfig()));
    await m3.destroy();
  });

  it('Store encrypts secrets and never leaks them in listings', async () => {
    const dir = tmpRoot();
    const cipher = {
      encrypt: (s) => Buffer.from(s, 'utf8').toString('base64'),
      decrypt: (s) => Buffer.from(s, 'base64').toString('utf8'),
    };
    const store = new Store(dir, { cipher });
    const saved = store.saveConnection({ host: 'h', port: 22, username: 'u', password: 's3cret', privateKey: 'KEYDATA' });
    assert.equal(saved.has_password, true);
    assert.equal(saved.password, undefined);
    assert.equal(saved.privateKey, undefined);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.ok(!JSON.stringify(raw).includes('s3cret'));
    assert.ok(!JSON.stringify(raw).includes('KEYDATA'));
    const full = store.getConnectConfig(saved.id);
    assert.equal(full.password, 's3cret');
    assert.equal(full.privateKey, 'KEYDATA');
    const list = store.listConnections();
    assert.equal(list[0].password, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

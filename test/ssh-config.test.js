'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { parseSshConfig, resolveHost, listImportableHosts, buildImportProfiles } = require('../src/core/ssh-config');

const CONFIG = `
Host web
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_web
  ProxyJump bastion
  LocalForward 5432 db.internal:5432
  LocalForward 127.0.0.1:8080 localhost:80
  RemoteForward 9000 localhost:3000
  DynamicForward 1080

Host bastion
  HostName jump.example.com
  User jump
  Port 2200
  IdentityFile ~/.ssh/id_bastion

Host prod-* !prod-db
  User prod

Host prod-db
  User db

Host *
  User fallback
  ServerAliveInterval 30
`;

describe('OpenSSH config parser', () => {
  it('resolves hostname, user, port, key and forwards', () => {
    const parsed = parseSshConfig(CONFIG);
    const web = resolveHost(parsed, 'web', { homeDir: '/home/me', defaultUser: 'local' });

    assert.equal(web.hostName, '10.0.0.5');
    assert.equal(web.user, 'deploy');
    assert.equal(web.port, 2222);
    assert.ok(web.identityFile.endsWith('id_web'));
    assert.equal(web.jump.length, 1);
    assert.deepEqual(
      { host: web.jump[0].host, port: web.jump[0].port, username: web.jump[0].username, authType: web.jump[0].authType },
      { host: 'jump.example.com', port: 2200, username: 'jump', authType: 'key' },
    );
    assert.equal(web.forwards.length, 4);
    const local = web.forwards.find((f) => f.type === 'local' && f.bindPort === 5432);
    assert.deepEqual(
      { bindHost: local.bindHost, destHost: local.destHost, destPort: local.destPort },
      { bindHost: '127.0.0.1', destHost: 'db.internal', destPort: 5432 },
    );
    assert.ok(web.forwards.some((f) => f.type === 'remote' && f.bindPort === 9000));
    assert.ok(web.forwards.some((f) => f.type === 'dynamic' && f.bindPort === 1080));
  });

  it('applies Host * defaults and first-value-wins semantics', () => {
    const parsed = parseSshConfig(CONFIG);
    const unknown = resolveHost(parsed, 'unknown.example', { homeDir: '/home/me', defaultUser: 'local' });
    assert.equal(unknown.hostName, 'unknown.example');
    assert.equal(unknown.user, 'fallback');
    assert.equal(unknown.port, 22);

    const dup = parseSshConfig(`
Host dup
  HostName one.example
  User first
Host dup
  HostName two.example
  User second
`);
    const r = resolveHost(dup, 'dup', { defaultUser: 'local' });
    assert.equal(r.hostName, 'one.example');
    assert.equal(r.user, 'first');
  });

  it('supports wildcard and negated Host patterns', () => {
    const parsed = parseSshConfig(CONFIG);
    assert.equal(resolveHost(parsed, 'prod-web', { defaultUser: 'local' }).user, 'prod');
    assert.equal(resolveHost(parsed, 'prod-db', { defaultUser: 'local' }).user, 'db');
    const importable = listImportableHosts(parsed);
    assert.ok(importable.includes('web'));
    assert.ok(importable.includes('bastion'));
    assert.ok(importable.includes('prod-db'));
    assert.ok(!importable.includes('prod-*'));
    assert.ok(!importable.includes('*'));
  });

  it('builds importable profiles with jump chain and forwards', () => {
    const parsed = parseSshConfig(`
Host a
  ProxyJump b
Host b
  ProxyJump c
Host c
  HostName c.example.com
  User cu
`);
    const { hosts } = buildImportProfiles(parsed, { defaultUser: 'local' });
    const a = hosts.find((h) => h.name === 'a');
    assert.ok(a);
    assert.deepEqual(a.jump.map((h) => h.host), ['c.example.com', 'b']);
  });

  it('reports Match/Include rather than half-expanding them', () => {
    const parsed = parseSshConfig(`
Host direct
  HostName 10.1.1.1
Include ~/.ssh/config.d/*
Match host *.internal
  User internal
Host after
  User after
`);
    assert.ok(parsed.warnings.some((w) => w.includes('Include')));
    assert.ok(parsed.warnings.some((w) => w.includes('Match')));
    const importable = listImportableHosts(parsed);
    assert.deepEqual(importable, ['direct', 'after']);
    assert.equal(resolveHost(parsed, 'after', { defaultUser: 'local' }).user, 'after');
  });

  it('does not recurse forever on a ProxyJump cycle', () => {
    const parsed = parseSshConfig(`
Host a
  ProxyJump b
Host b
  ProxyJump a
`);
    const r = resolveHost(parsed, 'a', { defaultUser: 'local' });
    assert.ok(r.warnings.some((w) => w.includes('循环')));
    assert.ok(r.jump.length <= 2, 'cycle must be bounded');
  });
});

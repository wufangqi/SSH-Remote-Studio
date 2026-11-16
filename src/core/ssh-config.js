'use strict';
// Minimal, dependency-free OpenSSH client-config parser.
//
// Scope (deliberately small and predictable):
//   Host, HostName, User, Port, IdentityFile, ProxyJump,
//   LocalForward, RemoteForward, DynamicForward
// Wildcards and negated patterns are supported for matching. Include and
// Match blocks are reported as warnings instead of being half-expanded.
//
// The importer never reads private key material: it only carries the path.
const os = require('node:os');
const path = require('node:path');
const { genId } = require('./util');

const SCALAR_KEYS = new Set(['hostname', 'user', 'port', 'proxyjump']);
const LIST_KEYS = new Set(['identityfile', 'localforward', 'remoteforward', 'dynamicforward']);

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value) {
  const s = String(value || '').trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1).replace(/\\(["'])/g, '$1');
  }
  return s;
}

function splitTokens(value) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === '\\' && i + 1 < value.length) { cur += value[++i]; continue; }
      if (ch === quote) { quote = null; continue; }
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseLine(raw) {
  const line = stripComment(raw).trim();
  if (!line) return null;
  const eq = line.indexOf('=');
  const space = line.search(/\s/);
  let key;
  let value;
  if (eq > 0 && (space === -1 || eq < space)) {
    key = line.slice(0, eq).trim();
    value = line.slice(eq + 1).trim();
  } else if (space > 0) {
    key = line.slice(0, space).trim();
    value = line.slice(space + 1).trim();
  } else {
    key = line;
    value = '';
  }
  if (!key) return null;
  return { key: key.toLowerCase(), value: unquote(value) };
}

function parseSshConfig(text) {
  const blocks = [];
  const warnings = [];
  let current = null;
  let skippingMatch = false;
  let warnedInclude = false;
  let warnedMatch = false;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const entry = parseLine(raw);
    if (!entry) continue;

    if (entry.key === 'host') {
      const patterns = splitTokens(entry.value);
      current = { patterns, options: {}, global: patterns.includes('*') && patterns.length === 1 };
      blocks.push(current);
      skippingMatch = false;
      continue;
    }
    if (entry.key === 'match') {
      skippingMatch = true;
      current = null;
      if (!warnedMatch) { warnings.push('未导入 Match 块'); warnedMatch = true; }
      continue;
    }
    if (entry.key === 'include') {
      if (!warnedInclude) { warnings.push('未展开 Include 指令；请直接导入其中主机或稍后补充'); warnedInclude = true; }
      continue;
    }
    if (skippingMatch) continue;

    // Options before the first Host block are OpenSSH global defaults.
    if (!current) {
      current = { patterns: ['*'], options: {}, global: true };
      blocks.push(current);
    }
    if (SCALAR_KEYS.has(entry.key)) {
      if (current.options[entry.key] === undefined) current.options[entry.key] = entry.value;
    } else if (LIST_KEYS.has(entry.key)) {
      if (!current.options[entry.key]) current.options[entry.key] = [];
      current.options[entry.key].push(entry.value);
    }
  }

  return { blocks, warnings };
}

function globToRegExp(pattern) {
  let src = '^';
  for (const ch of String(pattern)) {
    if (ch === '*') src += '.*';
    else if (ch === '?') src += '.';
    else src += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(src + '$', 'i');
}

function hostMatches(block, alias) {
  const positive = block.patterns.filter((p) => !p.startsWith('!'));
  const negative = block.patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  if (negative.some((p) => globToRegExp(p).test(alias))) return false;
  return positive.some((p) => globToRegExp(p).test(alias));
}

function expandTokens(value, ctx) {
  if (value == null) return value;
  return String(value).replace(/%([dhpr%])/g, (m, key) => {
    if (key === 'd') return ctx.homeDir || os.homedir();
    if (key === 'h') return ctx.alias || '';
    if (key === 'r') return ctx.user || '';
    if (key === 'p') return String(ctx.port || '');
    return '%';
  });
}

function expandHome(value, homeDir) {
  const s = String(value || '');
  if (s === '~') return homeDir || os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(homeDir || os.homedir(), s.slice(2));
  return s;
}

function parseJumpSpec(spec) {
  let rest = String(spec || '').trim();
  let user;
  const at = rest.lastIndexOf('@');
  if (at > 0) { user = rest.slice(0, at); rest = rest.slice(at + 1); }

  let host = rest;
  let port;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close > 0) {
      host = rest.slice(1, close);
      const tail = rest.slice(close + 1);
      if (tail.startsWith(':')) port = Number(tail.slice(1)) || undefined;
    }
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon > 0 && rest.indexOf(':') === colon) {
      host = rest.slice(0, colon);
      port = Number(rest.slice(colon + 1)) || undefined;
    }
  }
  return { user: user || undefined, host, port };
}

function parseHostPort(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close < 0) return null;
    const host = s.slice(1, close);
    const tail = s.slice(close + 1);
    if (!tail.startsWith(':')) return null;
    return { host, port: Number(tail.slice(1)) };
  }
  const colon = s.lastIndexOf(':');
  if (colon <= 0) return null;
  return { host: s.slice(0, colon), port: Number(s.slice(colon + 1)) };
}

function parseListen(spec, defaultHost = '127.0.0.1') {
  const s = String(spec || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return { bindHost: defaultHost, bindPort: Number(s) };
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close < 0) return null;
    const host = s.slice(1, close);
    const tail = s.slice(close + 1);
    if (!tail.startsWith(':')) return null;
    return { bindHost: host === '*' ? '0.0.0.0' : host, bindPort: Number(tail.slice(1)) };
  }
  const colon = s.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = s.slice(0, colon);
  return { bindHost: host === '*' ? '0.0.0.0' : host, bindPort: Number(s.slice(colon + 1)) };
}

function parseForwardSpec(spec, type) {
  const parts = splitTokens(String(spec || '').trim());
  if (!parts.length) return null;
  if (type === 'dynamic') {
    const listen = parseListen(parts[0]);
    if (!listen || !Number.isFinite(listen.bindPort)) return null;
    return { type, bindHost: listen.bindHost, bindPort: listen.bindPort, destHost: '', destPort: 0 };
  }
  if (parts.length < 2) return null;
  const listen = parseListen(parts[0]);
  const dest = parseHostPort(parts[1]);
  if (!listen || !dest || !Number.isFinite(listen.bindPort) || !Number.isFinite(dest.port)) return null;
  return {
    type,
    bindHost: listen.bindHost,
    bindPort: listen.bindPort,
    destHost: dest.host,
    destPort: dest.port,
  };
}

function buildForwards(options) {
  const out = [];
  for (const spec of options.localforward || []) {
    const f = parseForwardSpec(spec, 'local');
    if (f) out.push({ id: genId('fwd'), ...f });
  }
  for (const spec of options.remoteforward || []) {
    const f = parseForwardSpec(spec, 'remote');
    if (f) out.push({ id: genId('fwd'), ...f });
  }
  for (const spec of options.dynamicforward || []) {
    const f = parseForwardSpec(spec, 'dynamic');
    if (f) out.push({ id: genId('fwd'), ...f });
  }
  return out;
}

function defaultUser() {
  try { return os.userInfo().username; } catch { return process.env.USER || process.env.USERNAME || 'root'; }
}

function resolveJump(blocks, spec, opts, state) {
  const hops = [];
  for (const token of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const parsed = parseJumpSpec(token);
    if (!parsed.host) continue;
    const hop = resolveHost(blocks, parsed.host, opts, state);
    // A hop may itself declare ProxyJump; connect its chain first.
    if (hop.jump.length) hops.push(...hop.jump);
    hops.push({
      host: hop.hostName,
      port: parsed.port || hop.port,
      username: parsed.user || hop.user,
      authType: hop.identityFile ? 'key' : 'agent',
      ...(hop.identityFile ? { privateKeyPath: hop.identityFile } : {}),
    });
  }
  return hops;
}

function resolveHost(parsedOrBlocks, alias, opts = {}, state = null) {
  const blocks = Array.isArray(parsedOrBlocks) ? parsedOrBlocks : (parsedOrBlocks && parsedOrBlocks.blocks) || [];
  const st = state || { seen: new Set(), warnings: [] };
  const key = String(alias || '').toLowerCase();
  const blank = {
    alias,
    hostName: alias,
    user: opts.defaultUser || defaultUser(),
    port: 22,
    identityFile: null,
    jump: [],
    forwards: [],
  };
  if (!key) return blank;
  if (st.seen.has(key)) {
    st.warnings.push(`ProxyJump 存在循环: "${alias}"`);
    return blank;
  }
  const nextSeen = new Set(st.seen);
  nextSeen.add(key);

  const acc = {
    hostname: undefined,
    user: undefined,
    port: undefined,
    proxyjump: undefined,
    identityfile: [],
    localforward: [],
    remoteforward: [],
    dynamicforward: [],
  };

  for (const block of blocks) {
    if (!hostMatches(block, alias)) continue;
    for (const k of ['hostname', 'user', 'port', 'proxyjump']) {
      if (acc[k] === undefined && block.options[k] !== undefined) acc[k] = block.options[k];
    }
    for (const k of ['identityfile', 'localforward', 'remoteforward', 'dynamicforward']) {
      if (block.options[k]) acc[k].push(...block.options[k]);
    }
  }

  const homeDir = opts.homeDir || os.homedir();
  const user = acc.user || opts.defaultUser || defaultUser();
  const port = Number(acc.port || 22);
  const hostName = expandTokens(acc.hostname || alias, { alias, user, port, homeDir });
  const identityFile = acc.identityfile.length
    ? expandHome(expandTokens(acc.identityfile[0], { alias, user, port, homeDir }), homeDir)
    : null;

  let jump = [];
  const proxy = (acc.proxyjump || '').trim();
  if (proxy && !/^none$/i.test(proxy)) {
    jump = resolveJump(blocks, proxy, { ...opts, homeDir, defaultUser: user }, { seen: nextSeen, warnings: st.warnings });
  }

  return {
    alias,
    hostName,
    user,
    port: Number.isFinite(port) && port > 0 ? port : 22,
    identityFile,
    jump,
    forwards: buildForwards(acc),
    warnings: st.warnings,
  };
}

function listImportableHosts(parsedOrBlocks) {
  const blocks = Array.isArray(parsedOrBlocks) ? parsedOrBlocks : (parsedOrBlocks && parsedOrBlocks.blocks) || [];
  const seen = new Set();
  const out = [];
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (!pattern || pattern.startsWith('!') || /[*?]/.test(pattern)) continue;
      const key = pattern.toLowerCase();
      if (key === '*' || seen.has(key)) continue;
      seen.add(key);
      out.push(pattern);
    }
  }
  return out;
}

function buildImportProfiles(parsed, opts = {}) {
  const blocks = Array.isArray(parsed) ? parsed : (parsed && parsed.blocks) || [];
  const warnings = [...((parsed && parsed.warnings) || [])];
  const hosts = [];
  for (const alias of listImportableHosts(blocks)) {
    const r = resolveHost(blocks, alias, opts);
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
    hosts.push({
      name: alias,
      host: r.hostName,
      port: r.port,
      username: r.user,
      authType: r.identityFile ? 'key' : 'agent',
      ...(r.identityFile ? { privateKeyPath: r.identityFile } : {}),
      ...(r.jump.length ? { jump: r.jump } : {}),
      ...(r.forwards.length ? { forwards: r.forwards } : {}),
    });
  }
  return { hosts, warnings };
}

module.exports = {
  parseSshConfig,
  resolveHost,
  listImportableHosts,
  buildImportProfiles,
  // exported for focused unit tests
  _internal: { splitTokens, parseJumpSpec, parseForwardSpec, globToRegExp },
};

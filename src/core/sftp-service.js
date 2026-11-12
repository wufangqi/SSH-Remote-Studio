'use strict';
// Remote filesystem operations over SFTP. Electron-free.
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { RemotePath, pcall, friendlyError } = require('./util');

const DEFAULT_MAX_READ = 8 * 1024 * 1024; // 8 MiB guard for the in-app editor

function attrsToEntry(name, attrs, parentPath) {
  const isDir = typeof attrs.isDirectory === 'function' ? attrs.isDirectory() : false;
  const isLink = typeof attrs.isSymbolicLink === 'function' ? attrs.isSymbolicLink() : false;
  const type = isLink ? 'symlink' : isDir ? 'dir' : 'file';
  const rawMtime = attrs.mtime || 0;
  const mtime = rawMtime > 1e12 ? rawMtime : rawMtime * 1000; // ssh2 uses seconds
  return {
    name,
    path: RemotePath.join(parentPath, name),
    type,
    size: attrs.size || 0,
    mtime,
    mode: attrs.mode,
    uid: attrs.uid,
    gid: attrs.gid,
  };
}

class SftpService {
  /** @param {import('./ssh-session').SshSession} session */
  constructor(session) {
    this.session = session;
  }

  async _sftp() {
    return this.session.getSftp();
  }

  async realpath(p = '.') {
    const sftp = await this._sftp();
    return pcall(sftp.realpath.bind(sftp), p);
  }

  async home() {
    return this.realpath('.');
  }

  async stat(p) {
    const sftp = await this._sftp();
    try {
      const attrs = await pcall(sftp.stat.bind(sftp), p);
      return attrsToEntry(RemotePath.basename(p), attrs, RemotePath.dirname(p));
    } catch (e) {
      throw friendlyError(e, `stat ${p}`);
    }
  }

  async exists(p) {
    const sftp = await this._sftp();
    return new Promise((resolve) => sftp.exists(p, (ok) => resolve(!!ok)));
  }

  async list(dirPath) {
    const sftp = await this._sftp();
    let entries;
    try {
      entries = await pcall(sftp.readdir.bind(sftp), dirPath);
    } catch (e) {
      throw friendlyError(e, `列出目录 ${dirPath}`);
    }
    const items = entries
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => attrsToEntry(e.filename, e.attrs, dirPath));
    items.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (b.type === 'dir' && a.type !== 'dir') return 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    return { path: dirPath, entries: items };
  }

  async readFile(p, { maxBytes = DEFAULT_MAX_READ, encoding = 'utf8' } = {}) {
    const sftp = await this._sftp();
    let st;
    try {
      st = await pcall(sftp.stat.bind(sftp), p);
    } catch (e) {
      throw friendlyError(e, `读取 ${p}`);
    }
    if (st.isDirectory && st.isDirectory()) {
      throw Object.assign(new Error('目标是目录，不是文件'), { code: 'EISDIR' });
    }
    if (st.size > maxBytes) {
      throw Object.assign(
        new Error(`文件过大（${st.size} 字节），超过编辑器上限 ${maxBytes} 字节`),
        { code: 'ETOOLARGE', size: st.size }
      );
    }
    let buf;
    try {
      buf = await pcall(sftp.readFile.bind(sftp), p);
    } catch (e) {
      throw friendlyError(e, `读取 ${p}`);
    }
    const sample = buf.subarray(0, Math.min(buf.length, 8000));
    const binary = sample.includes(0);
    return {
      path: p,
      size: buf.length,
      mtime: st.mtime ? (st.mtime > 1e12 ? st.mtime : st.mtime * 1000) : 0,
      mode: st.mode,
      binary,
      content: binary ? null : buf.toString(encoding),
      encoding: binary ? null : encoding,
    };
  }

  async writeFile(p, content, { encoding = 'utf8', mode } = {}) {
    const sftp = await this._sftp();
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, encoding);
    try {
      await pcall(sftp.writeFile.bind(sftp), p, data);
      if (mode != null) await pcall(sftp.chmod.bind(sftp), p, mode);
    } catch (e) {
      throw friendlyError(e, `写入 ${p}`);
    }
    const st = await pcall(sftp.stat.bind(sftp), p).catch(() => null);
    return { path: p, size: data.length, mtime: st && st.mtime ? st.mtime * 1000 : Date.now() };
  }

  async mkdir(p, { recursive = false } = {}) {
    const sftp = await this._sftp();
    if (!recursive) {
      try {
        await pcall(sftp.mkdir.bind(sftp), p);
      } catch (e) {
        throw friendlyError(e, `创建目录 ${p}`);
      }
      return { path: p };
    }
    const parts = RemotePath.normalize(p).split('/').filter(Boolean);
    let cur = RemotePath.isAbsolute(p) ? '/' : '.';
    for (const part of parts) {
      cur = RemotePath.join(cur, part);
      const ok = await this.exists(cur);
      if (!ok) {
        try {
          await pcall(sftp.mkdir.bind(sftp), cur);
        } catch (e) {
          // tolerate race where it was created concurrently
          if (!(await this.exists(cur))) throw friendlyError(e, `创建目录 ${cur}`);
        }
      }
    }
    return { path: p };
  }

  async rename(oldPath, newPath) {
    const sftp = await this._sftp();
    try {
      await pcall(sftp.rename.bind(sftp), oldPath, newPath);
    } catch (e) {
      throw friendlyError(e, `重命名 ${oldPath}`);
    }
    return { oldPath, newPath };
  }

  async remove(p, { recursive = false } = {}) {
    const sftp = await this._sftp();
    let st;
    try {
      st = await pcall(sftp.stat.bind(sftp), p);
    } catch (e) {
      throw friendlyError(e, `删除 ${p}`);
    }
    const isDir = st.isDirectory && st.isDirectory();
    if (isDir) {
      if (!recursive) {
        try {
          await pcall(sftp.rmdir.bind(sftp), p);
        } catch (e) {
          throw friendlyError(e, `删除目录 ${p}（非空目录需 recursive）`);
        }
      } else {
        const { entries } = await this.list(p);
        for (const child of entries) {
          await this.remove(child.path, { recursive: true });
        }
        await pcall(sftp.rmdir.bind(sftp), p);
      }
    } else {
      await pcall(sftp.unlink.bind(sftp), p);
    }
    return { path: p, recursive };
  }

  async upload(localPath, remotePath, { onProgress } = {}) {
    const sftp = await this._sftp();
    const total = fs.statSync(localPath).size;
    let transferred = 0;
    const src = fs.createReadStream(localPath);
    src.on('data', (chunk) => {
      transferred += chunk.length;
      if (onProgress) onProgress({ transferred, total });
    });
    const dst = sftp.createWriteStream(remotePath);
    try {
      await pipeline(src, dst);
    } catch (e) {
      throw friendlyError(e, `上传到 ${remotePath}`);
    }
    return { localPath, remotePath, size: total };
  }

  async download(remotePath, localPath, { onProgress } = {}) {
    const sftp = await this._sftp();
    const st = await pcall(sftp.stat.bind(sftp), remotePath);
    const total = st.size || 0;
    let transferred = 0;
    const src = sftp.createReadStream(remotePath);
    src.on('data', (chunk) => {
      transferred += chunk.length;
      if (onProgress) onProgress({ transferred, total });
    });
    const dst = fs.createWriteStream(localPath);
    try {
      await pipeline(src, dst);
    } catch (e) {
      throw friendlyError(e, `下载 ${remotePath}`);
    }
    return { remotePath, localPath, size: total };
  }
}

module.exports = { SftpService, attrsToEntry, DEFAULT_MAX_READ };

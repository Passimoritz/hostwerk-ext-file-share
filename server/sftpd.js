'use strict';
/*
 * Small SFTP server for sharing folders: each account has its own password (scrypt hash), its own folder and may be
 * read-only. Nobody gets out of their folder (every path is resolved inside it). After 5 wrong passwords an address is
 * locked for 10 minutes. ssh2 is passed in (Hostwerk bundles it: host.lib('ssh2')), so the tests can run without Hostwerk.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Password hash for storage: scrypt$<salt>$<hash> */
function hashPass(pass) { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(String(pass), salt, 32).toString('base64')}`; }
function checkPass(pass, stored) {
  const [k, s, h] = String(stored || '').split('$'); if (k !== 'scrypt' || !s || !h) return false;
  const a = crypto.scryptSync(String(pass), Buffer.from(s, 'base64'), 32); const b = Buffer.from(h, 'base64');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Client path ("/sub/../x") → real path inside root, or null if it would leave the root. */
function jail(root, p) {
  const clean = path.posix.normalize(`/${String(p || '/').replace(/\\/g, '/')}`);
  const real = path.resolve(root, `.${clean}`);
  const r = path.resolve(root);
  return real === r || real.startsWith(r + path.sep) ? real : null;
}
/** Like jail, but also follows links: a symlink inside the folder must not point outside (checks the parent for new files). */
function safe(root, p) {
  const r = jail(root, p); if (!r) return null;
  let rootReal; try { rootReal = fs.realpathSync(root); } catch { return null; }
  const inside = (x) => x === rootReal || x.startsWith(rootReal + path.sep);
  try { return inside(fs.realpathSync(r)) ? r : null; } catch { /* does not exist yet */ }
  try { return inside(fs.realpathSync(path.dirname(r))) ? r : null; } catch { return null; }
}

/** Real path → path the client sees ("/…") */
function virt(root, real) { const rel = path.relative(path.resolve(root), real).split(path.sep).join('/'); return `/${rel}`.replace(/\/$/, '') || '/'; }

/** Lock-out after wrong passwords per address */
class Guard {
  constructor({ max = 5, ms = 10 * 60000 } = {}) { this.max = max; this.ms = ms; this.fails = new Map(); }
  locked(ip) { const f = this.fails.get(ip); return !!(f && f.n >= this.max && Date.now() - f.t < this.ms); }
  fail(ip) { const f = this.fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > this.ms) f.n = 0; f.n++; f.t = Date.now(); this.fails.set(ip, f); }
  ok(ip) { this.fails.delete(ip); }
}

const attrsOf = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
const longname = (name, st) => `${st.isDirectory() ? 'd' : '-'}rw-r--r-- 1 hostwerk hostwerk ${String(st.size).padStart(10)} ${new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')} ${name}`;

class Share {
  /** ssh2 = require('ssh2'), hostKey = private key (PEM/OpenSSH), accounts() → [{ name, hash, folder, readOnly }], onEvent({ type, user, ip, path }) */
  constructor({ ssh2, hostKey, accounts, onEvent = () => {}, guard = new Guard() }) { Object.assign(this, { ssh2, hostKey, accounts, onEvent, guard }); this.server = null; this.sessions = new Set(); }

  async start(port, host = '0.0.0.0') {
    if (this.server) return;
    const { Server, utils } = this.ssh2;
    const { STATUS_CODE, OPEN_MODE } = utils.sftp;
    const srv = new Server({ hostKeys: [this.hostKey], banner: 'Hostwerk file share' }, (client, info) => {
      const ip = (info && info.ip) || '?';
      let acc = null;
      client.on('authentication', (ctx) => {
        if (this.guard.locked(ip)) return ctx.reject();
        if (ctx.method !== 'password') return ctx.reject(['password']);
        const a = this.accounts().find((x) => x.name === ctx.username);
        if (a && checkPass(ctx.password, a.hash) && fs.existsSync(a.folder)) { this.guard.ok(ip); acc = a; this.onEvent({ type: 'login', user: a.name, ip }); return ctx.accept(); }
        this.guard.fail(ip); this.onEvent({ type: 'fail', user: ctx.username, ip });
        return ctx.reject();
      });
      client.on('error', () => {});
      client.on('ready', () => {
        this.sessions.add(client); client.on('close', () => this.sessions.delete(client));
        client.on('session', (accept) => {
          const session = accept();
          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp();
            const root = acc.folder; const ro = !!acc.readOnly;
            const handles = new Map(); let next = 0;
            const newHandle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next++, 0); handles.set(h.toString('hex'), v); return h; };
            const getH = (h) => handles.get(Buffer.from(h).toString('hex'));
            const deny = (id) => sftp.status(id, STATUS_CODE.PERMISSION_DENIED);
            const fail = (id, e) => sftp.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
            sftp.on('REALPATH', (id, p) => { const r = safe(root, p); if (!r) return deny(id); const v = virt(root, r); sftp.name(id, [{ filename: v, longname: v, attrs: {} }]); });
            const stat = (id, p) => { const r = safe(root, p); if (!r) return deny(id); fs.stat(r, (e, st) => (e ? fail(id, e) : sftp.attrs(id, attrsOf(st)))); };
            sftp.on('STAT', stat); sftp.on('LSTAT', stat);
            sftp.on('FSTAT', (id, h) => { const x = getH(h); if (!x || x.fd == null) return fail(id); fs.fstat(x.fd, (e, st) => (e ? fail(id, e) : sftp.attrs(id, attrsOf(st)))); });
            sftp.on('OPENDIR', (id, p) => { const r = safe(root, p); if (!r) return deny(id); fs.readdir(r, (e, list) => { if (e) return fail(id, e); sftp.handle(id, newHandle({ dir: r, list, done: false })); }); });
            sftp.on('READDIR', (id, h) => {
              const x = getH(h); if (!x || !x.list) return fail(id);
              if (x.done) return sftp.status(id, STATUS_CODE.EOF);
              x.done = true;
              const out = []; for (const n of x.list) { try { const st = fs.statSync(path.join(x.dir, n)); out.push({ filename: n, longname: longname(n, st), attrs: attrsOf(st) }); } catch { /* vanished */ } }
              sftp.name(id, out);
            });
            sftp.on('OPEN', (id, p, flags) => {
              const r = safe(root, p); if (!r) return deny(id);
              const write = (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) !== 0;
              if (write && ro) return deny(id);
              fs.open(r, utils.sftp.flagsToString(flags) || 'r', (e, fd) => { if (e) return fail(id, e); if (write) this.onEvent({ type: 'upload', user: acc.name, ip, path: virt(root, r) }); sftp.handle(id, newHandle({ fd })); });
            });
            sftp.on('READ', (id, h, offset, len) => { const x = getH(h); if (!x || x.fd == null) return fail(id); const buf = Buffer.alloc(Math.min(len, 256 * 1024)); fs.read(x.fd, buf, 0, buf.length, offset, (e, n) => { if (e) return fail(id, e); if (!n) return sftp.status(id, STATUS_CODE.EOF); sftp.data(id, buf.subarray(0, n)); }); });
            sftp.on('WRITE', (id, h, offset, data) => { if (ro) return deny(id); const x = getH(h); if (!x || x.fd == null) return fail(id); fs.write(x.fd, data, 0, data.length, offset, (e) => sftp.status(id, e ? STATUS_CODE.FAILURE : STATUS_CODE.OK)); });
            sftp.on('CLOSE', (id, h) => { const k = Buffer.from(h).toString('hex'); const x = handles.get(k); handles.delete(k); if (x && x.fd != null) fs.close(x.fd, () => sftp.status(id, STATUS_CODE.OK)); else sftp.status(id, STATUS_CODE.OK); });
            const mutate = (fn) => (id, ...a) => { if (ro) return deny(id); fn(id, ...a); };
            sftp.on('MKDIR', mutate((id, p) => { const r = safe(root, p); if (!r) return deny(id); fs.mkdir(r, (e) => sftp.status(id, e ? STATUS_CODE.FAILURE : STATUS_CODE.OK)); }));
            sftp.on('RMDIR', mutate((id, p) => { const r = safe(root, p); if (!r || r === path.resolve(root)) return deny(id); fs.rmdir(r, (e) => sftp.status(id, e ? STATUS_CODE.FAILURE : STATUS_CODE.OK)); }));
            sftp.on('REMOVE', mutate((id, p) => { const r = safe(root, p); if (!r) return deny(id); fs.unlink(r, (e) => { if (!e) this.onEvent({ type: 'delete', user: acc.name, ip, path: virt(root, r) }); sftp.status(id, e ? STATUS_CODE.FAILURE : STATUS_CODE.OK); }); }));
            sftp.on('RENAME', mutate((id, a, b) => { const x = safe(root, a); const y = safe(root, b); if (!x || !y) return deny(id); fs.rename(x, y, (e) => sftp.status(id, e ? STATUS_CODE.FAILURE : STATUS_CODE.OK)); }));
            sftp.on('SETSTAT', (id) => sftp.status(id, ro ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.OK));
            sftp.on('FSETSTAT', (id) => sftp.status(id, ro ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.OK));
            sftp.on('close', () => { for (const x of handles.values()) if (x.fd != null) try { fs.closeSync(x.fd); } catch { /* egal */ } handles.clear(); });
          });
        });
      });
    });
    await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, host, resolve); }).catch((e) => { throw Object.assign(new Error(e.code === 'EADDRINUSE' ? `Port ${port} is in use – choose another one.` : e.message), { status: 409 }); });
    this.server = srv; this.port = port; this.host = host;
  }

  async stop() {
    if (!this.server) return;
    for (const c of this.sessions) try { c.end(); } catch { /* egal */ }
    const s = this.server; this.server = null;
    await new Promise((r) => s.close(() => r()));
  }
}

module.exports = { Share, Guard, hashPass, checkPass, jail, safe, virt };

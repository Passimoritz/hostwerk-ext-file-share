'use strict';
/*
 * Small SFTP server for sharing folders: each account has its own password (scrypt hash) and/or SSH keys, its own folder
 * and may be read-only, time-limited or capped in size. Team members (extension "Team & users") sign in with their
 * Hostwerk password and see one folder per shared service. Nobody gets out of their folder (every path is resolved inside
 * it). After 5 wrong passwords an address is locked for 10 minutes; password checks run off the main thread (async scrypt),
 * one at a time per address – guessing cannot make Hostwerk stutter. ssh2 is passed in (Hostwerk bundles it:
 * host.lib('ssh2')), so the tests can run without Hostwerk.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Password hash for storage: scrypt$<salt>$<hash> */
function hashPass(pass) { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(String(pass), salt, 32).toString('base64')}`; }
/** Check against the stored hash (synchronous – only for tests and small tools). */
function checkPass(pass, stored) {
  const [k, s, h] = String(stored || '').split('$'); if (k !== 'scrypt' || !s || !h) return false;
  const a = crypto.scryptSync(String(pass), Buffer.from(s, 'base64'), 32); const b = Buffer.from(h, 'base64');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** Same check without blocking Hostwerk: scrypt runs in libuv's thread pool. */
function checkPassAsync(pass, stored) {
  const [k, s, h] = String(stored || '').split('$');
  if (k !== 'scrypt' || !s || !h) return Promise.resolve(false);
  return new Promise((resolve) => crypto.scrypt(String(pass), Buffer.from(s, 'base64'), 32, (e, a) => {
    if (e) return resolve(false);
    const b = Buffer.from(h, 'base64');
    resolve(a.length === b.length && crypto.timingSafeEqual(a, b));
  }));
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

/** Real path → path the client sees ("/…"), with the mount prefix of team members ("/survival/…"). */
function virt(root, real, prefix = '') { const rel = path.relative(path.resolve(root), real).split(path.sep).join('/'); return `${prefix}/${rel}`.replace(/\/$/, '') || '/'; }

/**
 * Where a client path lands for an account: { root, sub, prefix } inside its folder (or one of its mounts), { top: true } for
 * the virtual top folder of an account with mounts (lists the mounts, read-only), null if there is no such place.
 */
function locate(acc, p) {
  if (!acc.mounts) return { root: acc.folder, sub: p, prefix: '' };
  const clean = path.posix.normalize(`/${String(p || '/').replace(/\\/g, '/')}`);
  const parts = clean.split('/').filter(Boolean);
  if (!parts.length) return { top: true };
  const m = acc.mounts.find((x) => x.name === parts[0]);
  return m ? { root: m.folder, sub: `/${parts.slice(1).join('/')}`, prefix: `/${m.name}` } : null;
}

/** May this account sign in right now? Not expired, folder (or at least one mount) there. */
function usable(a, now = Date.now()) {
  if (!a) return false;
  if (a.expires && a.expires <= now) return false;
  return a.mounts ? a.mounts.length > 0 : !!a.folder && fs.existsSync(a.folder);
}

/** Size of a folder in bytes (async, stops after 200 000 entries – a quota check must not take forever). */
async function dirSize(dir) {
  let total = 0; let seen = 0; const stack = [dir];
  while (stack.length && seen < 200000) {
    const d = stack.pop();
    let list; try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      seen++;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { total += (await fs.promises.stat(p)).size; } catch { /* vanished */ } }
    }
  }
  return total;
}

/** Public key line ("ssh-ed25519 AAAA… comment") → parsed key or null. */
function parseKey(ssh2, line) {
  const k = ssh2.utils.parseKey(String(line || '').trim());
  return !k || k instanceof Error || Array.isArray(k) ? null : k;
}
/** Matching key of the account for the key the client offers (compared by the public key blob). */
function keyFor(ssh2, acc, offered) {
  if (!acc || !offered || !offered.data) return null;
  for (const line of acc.keys || []) { const k = parseKey(ssh2, line); if (k && k.getPublicSSH().equals(offered.data)) return k; }
  return null;
}

/** Lock-out after wrong passwords per address */
class Guard {
  constructor({ max = 5, ms = 10 * 60000 } = {}) { this.max = max; this.ms = ms; this.fails = new Map(); }
  locked(ip) { const f = this.fails.get(ip); return !!(f && f.n >= this.max && Date.now() - f.t < this.ms); }
  fail(ip) { const f = this.fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > this.ms) f.n = 0; f.n++; f.t = Date.now(); this.fails.set(ip, f); }
  ok(ip) { this.fails.delete(ip); }
}

const attrsOf = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
const longname = (name, st) => `${st.isDirectory() ? 'd' : '-'}rw-r--r-- 1 hostwerk hostwerk ${String(st.size).padStart(10)} ${new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')} ${name}`;
const TOP_MODE = 0o40555; // virtual top folder: directory, read-only

class Share {
  /**
   * ssh2 = require('ssh2'), hostKey = private key (PEM/OpenSSH), accounts() → [{ name, hash, keys, folder, readOnly, expires, quotaMB }],
   * members(name, password) → Promise<account with mounts | null> (team members, optional), onEvent({ type, user, ip, path })
   */
  constructor({ ssh2, hostKey, accounts, members = null, onEvent = () => {}, guard = new Guard() }) {
    Object.assign(this, { ssh2, hostKey, accounts, members, onEvent, guard });
    this.server = null; this.sessions = new Set(); this.busy = new Set(); this.sizes = new Map();
  }

  /** Used bytes of an account's folder, cached for 30 seconds (quota). */
  async used(acc) {
    const c = this.sizes.get(acc.name);
    if (c && Date.now() - c.t < 30000) return c;
    const v = { n: await dirSize(acc.folder), t: Date.now() };
    this.sizes.set(acc.name, v);
    return v;
  }

  /** Sign-in: SSH key or password (own accounts first, then team members). Resolves to the account or null. */
  async auth(ctx, ip) {
    const a = this.accounts().find((x) => x.name === ctx.username);
    if (ctx.method === 'publickey') {
      const k = usable(a) ? keyFor(this.ssh2, a, ctx.key) : null;
      if (!k) return null; // trying keys is normal for SSH programs – not a wrong password
      if (!ctx.signature) return 'probe'; // the key would do – the client signs next
      return k.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? a : null;
    }
    if (ctx.method !== 'password') return null;
    if (a) return usable(a) && (await checkPassAsync(ctx.password, a.hash)) ? a : false;
    if (this.members) { const m = await this.members(ctx.username, ctx.password); if (m && usable(m)) return m; }
    return false;
  }

  async start(port, host = '0.0.0.0') {
    if (this.server) return;
    const { Server, utils } = this.ssh2;
    const { STATUS_CODE, OPEN_MODE } = utils.sftp;
    const srv = new Server({ hostKeys: [this.hostKey], banner: 'Hostwerk file share' }, (client, info) => {
      const ip = (info && info.ip) || '?';
      let acc = null;
      client.on('authentication', (ctx) => {
        if (this.guard.locked(ip)) return ctx.reject();
        if (ctx.method !== 'password' && ctx.method !== 'publickey') return ctx.reject(['password', 'publickey']);
        // Eine Prüfung je Adresse gleichzeitig – Raten mit vielen Verbindungen bremst sich selbst
        if (ctx.method === 'password' && this.busy.has(ip)) return ctx.reject();
        if (ctx.method === 'password') this.busy.add(ip);
        this.auth(ctx, ip).then((r) => {
          if (r === 'probe') return ctx.accept();
          if (r) { this.guard.ok(ip); acc = r; this.onEvent({ type: 'login', user: r.name, ip, via: ctx.method === 'publickey' ? 'key' : r.mounts ? 'team' : 'password' }); return ctx.accept(); }
          if (r === false || (ctx.method === 'publickey' && ctx.signature)) { this.guard.fail(ip); this.onEvent({ type: 'fail', user: ctx.username, ip }); }
          return ctx.reject(['password', 'publickey']);
        }).catch(() => ctx.reject()).finally(() => { if (ctx.method === 'password') this.busy.delete(ip); });
      });
      client.on('error', () => {});
      client.on('ready', () => {
        this.sessions.add(client); client.on('close', () => this.sessions.delete(client));
        client.on('session', (accept) => {
          const session = accept();
          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp();
            const ro = !!acc.readOnly;
            const quota = acc.quotaMB ? acc.quotaMB * 1048576 : 0;
            const handles = new Map(); let next = 0;
            const newHandle = (v) => { const h = Buffer.alloc(4); h.writeUInt32BE(next++, 0); handles.set(h.toString('hex'), v); return h; };
            const getH = (h) => handles.get(Buffer.from(h).toString('hex'));
            const deny = (id) => sftp.status(id, STATUS_CODE.PERMISSION_DENIED);
            const fail = (id, e) => sftp.status(id, e && e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
            /** Client path → { real, root, prefix } or { top } or null (outside). */
            const where = (p) => { const l = locate(acc, p); if (!l) return null; if (l.top) return l; const real = safe(l.root, l.sub); return real ? { real, root: l.root, prefix: l.prefix } : null; };
            const mountsList = () => (acc.mounts || []).filter((m) => fs.existsSync(m.folder));
            sftp.on('REALPATH', (id, p) => { const w = where(p); if (!w) return deny(id); const v = w.top ? '/' : virt(w.root, w.real, w.prefix); sftp.name(id, [{ filename: v, longname: v, attrs: {} }]); });
            const stat = (id, p) => {
              const w = where(p); if (!w) return deny(id);
              if (w.top) return sftp.attrs(id, { mode: TOP_MODE, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 });
              fs.stat(w.real, (e, st) => (e ? fail(id, e) : sftp.attrs(id, attrsOf(st))));
            };
            sftp.on('STAT', stat); sftp.on('LSTAT', stat);
            sftp.on('FSTAT', (id, h) => { const x = getH(h); if (!x || x.fd == null) return fail(id); fs.fstat(x.fd, (e, st) => (e ? fail(id, e) : sftp.attrs(id, attrsOf(st)))); });
            sftp.on('OPENDIR', (id, p) => {
              const w = where(p); if (!w) return deny(id);
              if (w.top) return sftp.handle(id, newHandle({ top: true, done: false }));
              fs.readdir(w.real, (e, list) => { if (e) return fail(id, e); sftp.handle(id, newHandle({ dir: w.real, list, done: false })); });
            });
            sftp.on('READDIR', (id, h) => {
              const x = getH(h); if (!x || !(x.list || x.top)) return fail(id);
              if (x.done) return sftp.status(id, STATUS_CODE.EOF);
              x.done = true;
              const out = [];
              if (x.top) { for (const m of mountsList()) { try { const st = fs.statSync(m.folder); out.push({ filename: m.name, longname: longname(m.name, st), attrs: attrsOf(st) }); } catch { /* vanished */ } } }
              else for (const n of x.list) { try { const st = fs.statSync(path.join(x.dir, n)); out.push({ filename: n, longname: longname(n, st), attrs: attrsOf(st) }); } catch { /* vanished */ } }
              sftp.name(id, out);
            });
            sftp.on('OPEN', async (id, p, flags) => {
              const w = where(p); if (!w || w.top) return deny(id);
              const write = (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) !== 0;
              if (write && ro) return deny(id);
              let used = null;
              if (write && quota) { used = await this.used(acc); if (used.n >= quota) { this.onEvent({ type: 'quota', user: acc.name, ip, path: virt(w.root, w.real, w.prefix) }); return sftp.status(id, STATUS_CODE.FAILURE); } }
              fs.open(w.real, utils.sftp.flagsToString(flags) || 'r', (e, fd) => { if (e) return fail(id, e); if (write) this.onEvent({ type: 'upload', user: acc.name, ip, path: virt(w.root, w.real, w.prefix) }); sftp.handle(id, newHandle({ fd, used })); });
            });
            sftp.on('READ', (id, h, offset, len) => { const x = getH(h); if (!x || x.fd == null) return fail(id); const buf = Buffer.alloc(Math.min(len, 256 * 1024)); fs.read(x.fd, buf, 0, buf.length, offset, (e, n) => { if (e) return fail(id, e); if (!n) return sftp.status(id, STATUS_CODE.EOF); sftp.data(id, buf.subarray(0, n)); }); });
            sftp.on('WRITE', (id, h, offset, data) => {
              if (ro) return deny(id);
              const x = getH(h); if (!x || x.fd == null) return fail(id);
              // Speichergrenze: jedes geschriebene Byte zählt (vorsichtig – Überschreiben zählt auch), bis neu gezählt wird
              if (quota && x.used) { if (x.used.n + data.length > quota) return sftp.status(id, STATUS_CODE.FAILURE); x.used.n += data.length; }
              fs.write(x.fd, data, 0, data.length, offset, (e) => sftp.status(id, e ? STATUS_CODE.FAILURE : STATUS_CODE.OK));
            });
            sftp.on('CLOSE', (id, h) => { const k = Buffer.from(h).toString('hex'); const x = handles.get(k); handles.delete(k); if (x && x.fd != null) fs.close(x.fd, () => sftp.status(id, STATUS_CODE.OK)); else sftp.status(id, STATUS_CODE.OK); });
            const mutate = (fn) => (id, ...a) => { if (ro) return deny(id); fn(id, ...a); };
            sftp.on('MKDIR', mutate((id, p) => { const w = where(p); if (!w || w.top) return deny(id); fs.mkdir(w.real, (e) => sftp.status(id, e ? STATUS_CODE.FAILURE : STATUS_CODE.OK)); }));
            sftp.on('RMDIR', mutate((id, p) => { const w = where(p); if (!w || w.top || w.real === path.resolve(w.root)) return deny(id); fs.rmdir(w.real, (e) => sftp.status(id, e ? STATUS_CODE.FAILURE : STATUS_CODE.OK)); }));
            sftp.on('REMOVE', mutate((id, p) => { const w = where(p); if (!w || w.top) return deny(id); fs.unlink(w.real, (e) => { if (!e) this.onEvent({ type: 'delete', user: acc.name, ip, path: virt(w.root, w.real, w.prefix) }); sftp.status(id, e ? STATUS_CODE.FAILURE : STATUS_CODE.OK); }); }));
            sftp.on('RENAME', mutate((id, a, b) => { const x = where(a); const y = where(b); if (!x || !y || x.top || y.top || x.root !== y.root) return deny(id); fs.rename(x.real, y.real, (e) => sftp.status(id, e ? STATUS_CODE.FAILURE : STATUS_CODE.OK)); }));
            sftp.on('SETSTAT', (id) => sftp.status(id, ro ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.OK));
            sftp.on('FSETSTAT', (id) => sftp.status(id, ro ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.OK));
            sftp.on('close', () => { for (const x of handles.values()) if (x.fd != null) try { fs.closeSync(x.fd); } catch { /* egal */ } handles.clear(); this.sizes.delete(acc.name); });
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

module.exports = { Share, Guard, hashPass, checkPass, checkPassAsync, jail, safe, virt, locate, usable, dirSize, parseKey, keyFor };

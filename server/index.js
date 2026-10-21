'use strict';
/*
 * File share (SFTP) – server part (SDK 2.7 native extension).
 *   GET    /api/file-share                    → state: running, port, addresses, fingerprint, accounts, links, team, recent events
 *   PUT    /api/file-share/settings           → { port, network: 'lan' | 'local', team: { enabled, readOnly } }
 *   POST   /api/file-share/accounts           → { name, password, keys, folder, readOnly, expires, quotaMB }
 *   PUT    /api/file-share/accounts/:name     → { password?, keys?, folder?, readOnly?, expires?, quotaMB? }
 *   DELETE /api/file-share/accounts/:name
 *   POST   /api/file-share/start | stop
 *   POST   /api/file-share/forward            → port forwarding in the router (extension "Router & port forwarding")
 *   GET    /api/file-share/qr?text=sftp://…   → { svg } QR code for the address
 *   POST   /api/file-share/links              → { folder, label, days } download link; DELETE /api/file-share/links/:token
 *   GET    /api/file-share/pub/<token>/…      → public, read-only: folder listing and downloads (also through remote access)
 * Data: data/file-share/{settings,accounts,links,events}.json + host_key (private key of this server, never leaves the PC)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Share, Guard, hashPass, parseKey } = require('./sftpd');
const links = require('./links');

let share = null;

/** Folders of the services a team member may use: one mount per service with a folder (name = readable, unique). */
function memberMounts(ctx, u, all) {
  const ids = u.role === 'admin' ? all.map((s) => s.id) : (u.services || []);
  const out = []; const taken = new Set();
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'service';
  for (const id of ids) {
    const [kind, sid] = String(id).split(':');
    let folder = null; let name = sid;
    try {
      if (kind === 'mc' && ctx.minecraft) { folder = ctx.minecraft.dir(sid); name = (ctx.minecraft.list().find((x) => x.id === sid) || {}).name || sid; }
      else if (kind === 'game' && ctx.games) { const g = ctx.games.get(sid); folder = ctx.games.dir(g); name = g.name; }
      else if (kind === 'web' && ctx.web) { const w = ctx.web.list().find((x) => x.id === sid); folder = w && w.docRoot; name = w ? w.name : sid; }
      else if (kind === 'apps' && ctx.apps) { const a = ctx.apps.list().find((x) => x.id === sid); folder = a && (a.dir || ctx.apps.dataDir(sid)); name = a ? a.name : sid; }
    } catch { folder = null; }
    if (!folder || !fs.existsSync(folder)) continue;
    let n = slug(name); for (let i = 2; taken.has(n); i++) n = `${slug(name)}-${i}`;
    taken.add(n); out.push({ name: n, folder, service: id });
  }
  return out;
}

function activate(host) {
  const { ctx } = host;
  const ssh2 = host.lib('ssh2');
  const dir = path.join(ctx.paths.data, 'file-share');
  fs.mkdirSync(dir, { recursive: true });
  const file = (n) => path.join(dir, `${n}.json`);
  const read = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
  const write = (n, v) => { fs.writeFileSync(`${file(n)}.tmp`, JSON.stringify(v, null, 1)); fs.renameSync(`${file(n)}.tmp`, file(n)); };
  const keyFile = path.join(dir, 'host_key');
  if (!fs.existsSync(keyFile)) { const k = ssh2.utils.generateKeyPairSync('ed25519'); fs.writeFileSync(keyFile, k.private, { mode: 0o600 }); }
  const hostKey = fs.readFileSync(keyFile);
  const parsed = ssh2.utils.parseKey(hostKey);
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const settings = () => { const s = { port: 2222, network: 'lan', ...read('settings', {}) }; s.team = { enabled: false, readOnly: false, ...(s.team || {}) }; return s; };
  const accounts = () => read('accounts', []);
  const linkList = () => read('links', []);
  const events = [];
  const onEvent = (e) => { events.unshift({ t: Date.now(), ...e }); events.splice(50); if (e.type !== 'fail') write('events', events); host.broadcast({ type: 'file-share' }); };
  for (const e of read('events', [])) events.push(e);

  // Team-Mitglieder (Erweiterung „Team & Benutzer“): Anmeldung mit ihrem Hostwerk-Passwort, je freigegebenem Dienst ein Ordner
  const members = async (name, password) => {
    const s = settings(); const users = ctx.users;
    if (!s.team.enabled || !users || typeof users.login !== 'function') return null;
    const u = users.login(name, password);
    if (!u) return null;
    return { name: u.name.toLowerCase(), readOnly: s.team.readOnly, mounts: memberMounts(ctx, u, typeof users.services === 'function' ? users.services() : []) };
  };
  share = new Share({ ssh2, hostKey, accounts, members, onEvent });

  const addresses = () => {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push({ name, address: a.address });
    return out;
  };
  /** Addresses where download links work from outside: Hostwerk's remote access (own domain first), else nothing. */
  const linkBases = () => {
    try { const st = ctx.remote && ctx.remote.status(); if (!st || !st.running) return []; return [...(st.domain ? [`https://${st.domain}${st.port === 443 ? '' : `:${st.port}`}`] : []), ...st.urls.map((u) => u.replace(/\/$/, ''))]; } catch { return []; }
  };
  const view = () => {
    const s = settings(); const now = Date.now();
    return {
      running: !!share.server, port: share.server ? share.port : s.port, network: s.network,
      addresses: s.network === 'lan' ? addresses() : [{ name: 'localhost', address: '127.0.0.1' }], fingerprint,
      accounts: accounts().map(({ hash, keys, ...a }) => ({ ...a, hasPassword: !!hash, keys: (keys || []).map((k) => { const p = parseKey(ssh2, k); return { line: k, type: p ? p.type : '?', comment: p ? p.comment || '' : '' }; }), exists: fs.existsSync(a.folder), expired: !!(a.expires && a.expires <= now) })),
      links: linkList().map((l) => ({ ...l, expired: !!(l.expires && l.expires <= now), exists: fs.existsSync(l.folder) })), linkBases: linkBases(),
      team: { available: !!(ctx.users && typeof ctx.users.login === 'function'), ...s.team, members: ctx.users && Array.isArray(ctx.users.list) ? ctx.users.list.filter((u) => u.enabled !== false && u.passHash).length : 0 },
      router: !!(ctx.router && typeof ctx.router.forward === 'function'), passwords: !!ctx.pw,
      events: events.slice(0, 30),
    };
  };
  const start = async () => { const s = settings(); await share.start(s.port, s.network === 'lan' ? '0.0.0.0' : '127.0.0.1'); write('settings', { ...s, running: true }); };
  const NAME = /^[a-z][a-z0-9_.-]{1,31}$/;
  const checkFolder = (f) => { const p = path.resolve(String(f || '')); if (!f || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw host.error(400, 'The folder does not exist.'); if (p === path.parse(p).root) throw host.error(400, 'A whole drive cannot be shared – pick a folder.'); return p; };
  const checkPass = (p) => { if (String(p || '').length < 10) throw host.error(400, 'The password needs at least 10 characters.'); return String(p); };
  const checkKeys = (list) => {
    const out = [];
    for (const raw of (Array.isArray(list) ? list : String(list || '').split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean)) {
      if (/PRIVATE KEY/.test(raw)) throw host.error(400, 'That is a private key – paste the public key (.pub) instead.');
      if (!parseKey(ssh2, raw)) throw host.error(400, 'This is not a valid public SSH key.');
      out.push(raw);
    }
    return out.slice(0, 10);
  };
  /** Ablaufdatum: Zeitstempel in der Zukunft oder null (unbefristet). */
  const checkExpires = (v) => { if (v === null || v === '' || v === undefined || v === 0) return null; const n = Number(v); if (!Number.isFinite(n) || n <= Date.now()) throw host.error(400, 'The expiry date must be in the future.'); return n; };
  const checkQuota = (v) => { if (!v) return 0; const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < 1 || n > 10 * 1048576) throw host.error(400, 'The storage limit must be between 1 MB and 10 TB.'); return n; };

  if (settings().running) start().catch((e) => host.log('start failed:', e.message));

  host.router.get('/file-share', (req, res) => res.json(view()));
  host.router.put('/file-share/settings', async (req, res) => {
    const b = req.body || {}; const s = settings();
    if (b.port !== undefined) { const n = Number(b.port); if (!Number.isInteger(n) || n < 1024 || n > 65535) throw host.error(400, 'The port must be between 1024 and 65535.'); s.port = n; }
    if (['lan', 'local'].includes(b.network)) s.network = b.network;
    if (b.team && typeof b.team === 'object') { if (typeof b.team.enabled === 'boolean') s.team.enabled = b.team.enabled; if (typeof b.team.readOnly === 'boolean') s.team.readOnly = b.team.readOnly; }
    write('settings', s);
    if (share.server && (b.port !== undefined || b.network !== undefined)) { await share.stop(); await start(); }
    res.json(view());
  });
  host.router.post('/file-share/accounts', (req, res) => {
    const b = req.body || {}; const list = accounts();
    const name = String(b.name || '').trim().toLowerCase();
    if (!NAME.test(name)) throw host.error(400, 'User name: 2–32 small letters, digits, _ . -, starting with a letter.');
    if (list.some((a) => a.name === name)) throw host.error(409, 'This user name exists already.');
    const keys = checkKeys(b.keys);
    if (!b.password && !keys.length) throw host.error(400, 'Give the user a password or an SSH key.');
    list.push({ name, hash: b.password ? hashPass(checkPass(b.password)) : null, keys, folder: checkFolder(b.folder), readOnly: !!b.readOnly, expires: checkExpires(b.expires), quotaMB: checkQuota(b.quotaMB), created: Date.now() });
    write('accounts', list); res.json(view());
  });
  host.router.put('/file-share/accounts/:name', (req, res) => {
    const b = req.body || {}; const list = accounts(); const a = list.find((x) => x.name === req.params.name);
    if (!a) throw host.error(404, 'User not found');
    if (b.password) a.hash = hashPass(checkPass(b.password));
    if (b.keys !== undefined) a.keys = checkKeys(b.keys);
    if (!a.hash && !(a.keys || []).length) throw host.error(400, 'Give the user a password or an SSH key.');
    if (b.folder !== undefined) a.folder = checkFolder(b.folder);
    if (b.readOnly !== undefined) a.readOnly = !!b.readOnly;
    if (b.expires !== undefined) a.expires = checkExpires(b.expires);
    if (b.quotaMB !== undefined) a.quotaMB = checkQuota(b.quotaMB);
    write('accounts', list); res.json(view());
  });
  host.router.delete('/file-share/accounts/:name', (req, res) => { write('accounts', accounts().filter((a) => a.name !== req.params.name)); res.json(view()); });
  host.router.post('/file-share/start', async (req, res) => { const s = settings(); if (!accounts().length && !s.team.enabled) throw host.error(409, 'Add a user first.'); await start(); res.json(view()); });
  host.router.post('/file-share/stop', async (req, res) => { await share.stop(); write('settings', { ...settings(), running: false }); res.json(view()); });

  // Portfreigabe über die Erweiterung „Router & Portfreigaben“ – gemerkt wie dort von Hand angelegte (Router-Automatik hält sie)
  host.router.post('/file-share/forward', async (req, res) => {
    const r = ctx.router;
    if (!r || typeof r.forward !== 'function') throw host.error(409, 'Install the extension “Router & port forwarding” first.');
    const port = settings().port;
    const x = await r.forward({ port, protocol: 'TCP', label: 'SFTP (file share)' });
    if (r.cfg && Array.isArray(r.cfg.extra)) { r.cfg.extra = [...r.cfg.extra.filter((e) => !(e.port === x.port && e.protocol === x.protocol)), { port: x.port, protocol: x.protocol, label: 'SFTP (file share)' }]; ctx.settings.save(); }
    res.json({ ok: true, port: x.port, client: x.client });
  });
  host.router.get('/file-share/qr', async (req, res) => {
    const text = String(req.query.text || '');
    if (text.length > 300 || !/^(sftp|https?):\/\/[^\s<>"]+$/.test(text)) throw host.error(400, 'Invalid address');
    res.json({ svg: await host.lib('qrcode').toString(text, { type: 'svg', margin: 1, width: 220 }) });
  });

  // Download-Links (nur lesen, im Browser)
  host.router.post('/file-share/links', (req, res) => {
    const b = req.body || {}; const list = linkList();
    if (list.length >= 50) throw host.error(409, 'At most 50 links – remove old ones first.');
    const days = Number(b.days) || 0;
    if (days < 0 || days > 365) throw host.error(400, 'A link is valid for 1 to 365 days (or without limit).');
    list.push({ token: links.newToken(), folder: checkFolder(b.folder), label: String(b.label || '').trim().slice(0, 60), expires: days ? Date.now() + days * 86400000 : null, created: Date.now() });
    write('links', list); res.json(view());
  });
  host.router.delete('/file-share/links/:token', (req, res) => { write('links', linkList().filter((l) => l.token !== req.params.token)); res.json(view()); });
  const pubGuard = new Guard({ max: 20, ms: 10 * 60000 });
  host.publicRouter.use('/file-share/pub/:token', (req, res) => {
    const ip = req.ip || '?';
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
    if (pubGuard.locked(ip)) return res.status(429).type('text').send('Too many attempts – try again later.');
    const link = links.find(linkList(), req.params.token);
    if (!link) { pubGuard.fail(ip); return res.status(404).type('text').send('This link does not exist or has expired.'); }
    const real = links.resolve(link, req.path);
    if (!real || !fs.existsSync(real)) return res.status(404).type('text').send('Not found');
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const st = fs.statSync(real);
    if (st.isDirectory()) {
      if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(301, `${req.originalUrl.split('?')[0]}/`);
      const base = req.baseUrl; // /api/file-share/pub/<token>
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      return res.type('html').send(links.listing(link, real, base, String(req.headers['accept-language'] || '').startsWith('de') ? 'de' : 'en'));
    }
    if (req.method === 'GET') onEvent({ type: 'download', user: link.label || path.basename(link.folder), ip, path: path.relative(link.folder, real).split(path.sep).join('/') });
    res.download(real, path.basename(real), { dotfiles: 'allow' });
  });
  host.on('shutdown', () => share && share.stop());
}

function deactivate() { if (share) share.stop(); share = null; }

module.exports = { activate, deactivate, memberMounts };

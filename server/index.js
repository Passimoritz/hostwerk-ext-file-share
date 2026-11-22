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
 *   POST   /api/file-share/links              → { folder, label, days, maxDownloads, password } download link; DELETE /api/file-share/links/:token
 *   PUT    /api/file-share/links/:token       → { days } extend an expired link (resets a used-up download limit)
 *   POST   /api/file-share/sessions/:id/drop  → end one open SFTP connection (list: state.connected)
 *   GET    /api/file-share/folder-check?folder= → { sensitive } – folder is or contains Hostwerk's data/config folder
 *   GET    /api/file-share/pub/<token>/…      → public, read-only: folder listing and downloads (also through remote access)
 *   GET    /api/file-share/resolve?root=&path= → { full } folder from Hostwerk's file roots (file browser, SDK 3.2)
 *   GET    /api/file-share/marks?root=&path=   → { children: { name: { users, links } }, self: [shares of this folder] }
 * Data: data/file-share/{settings,accounts,links,events}.json + host_key (private key of this server, never leaves the PC)
 *       + link_secret (signs the cookie of password-protected links)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Share, Guard, hashPass, checkPassAsync, parseKey } = require('./sftpd');
const links = require('./links');
const shares = require('./shares');

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
  share = new Share({ ssh2, hostKey, accounts, members, onEvent, onSessions: () => host.broadcast({ type: 'file-share' }) });
  const secretFile = path.join(dir, 'link_secret');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const linkSecret = fs.readFileSync(secretFile, 'utf8').trim();
  // Hostwerks eigene Ordner (Schlüssel, Konten, Einstellungen) – beim Freigeben warnen
  const sensitiveDirs = [ctx.paths.data, ctx.paths.config].filter(Boolean);

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
    const s = settings(); const now = Date.now(); const used = shares.lastUse(events); // zuletzt benutzt (Anmeldung, Upload, Download)
    return {
      running: !!share.server, port: share.server ? share.port : s.port, network: s.network,
      addresses: s.network === 'lan' ? addresses() : [{ name: 'localhost', address: '127.0.0.1' }], fingerprint,
      accounts: accounts().map(({ hash, keys, ...a }) => ({ ...a, hasPassword: !!hash, keys: (keys || []).map((k) => { const p = parseKey(ssh2, k); return { line: k, type: p ? p.type : '?', comment: p ? p.comment || '' : '' }; }), exists: fs.existsSync(a.folder), expired: !!(a.expires && a.expires <= now), last: used[a.name] || null })),
      links: linkList().map(({ passHash, ...l }) => ({ ...l, downloads: l.downloads || 0, maxDownloads: l.maxDownloads || 0, hasPassword: !!passHash, exhausted: links.exhausted(l), expired: !!(l.expires && l.expires <= now), exists: fs.existsSync(l.folder), last: used[l.label || path.basename(l.folder)] || null })), linkBases: linkBases(),
      connected: share.connected(),
      team: { available: !!(ctx.users && typeof ctx.users.login === 'function'), ...s.team, members: ctx.users && Array.isArray(ctx.users.list) ? ctx.users.list.filter((u) => u.enabled !== false && u.passHash).length : 0 },
      router: !!(ctx.router && typeof ctx.router.forward === 'function'), passwords: !!ctx.pw,
      events: events.slice(0, 30),
    };
  };
  const LABEL = 'SFTP (file share)';
  /** Port im Router freigeben und merken: router.forwards (mit Besitzer) oder – Router-Erweiterung vor 1.2 – cfg.extra. */
  const forwardPort = async (r, port) => {
    if (r.forwards && typeof r.forwards.add === 'function') return r.forwards.add({ port, protocol: 'TCP', label: LABEL }, host.id);
    const x = await r.forward({ port, protocol: 'TCP', label: LABEL });
    if (r.cfg && Array.isArray(r.cfg.extra)) { r.cfg.extra = [...r.cfg.extra.filter((e) => !(e.port === x.port && e.protocol === x.protocol)), { port: x.port, protocol: x.protocol, label: LABEL }]; ctx.settings.save(); }
    return x;
  };
  /** Neuer Port: eine eigene Freigabe des alten Ports zieht mit (nur mit router.forwards – sonst weiß niemand, wem sie gehört). */
  const moveForward = async (from, to) => {
    const r = ctx.router;
    if (!r || !r.forwards || typeof r.forwards.owned !== 'function' || from === to) return;
    if (!r.forwards.owned(host.id).some((f) => f.port === from && f.protocol === 'TCP')) return;
    await r.forwards.remove({ port: from, protocol: 'TCP' }, host.id).catch(() => {});
    await r.forwards.add({ port: to, protocol: 'TCP', label: LABEL }, host.id).catch((e) => host.log('forwarding the new port failed:', e.message));
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
  const checkDays = (v) => { const d = Number(v) || 0; if (!Number.isInteger(d) || d < 0 || d > 365) throw host.error(400, 'A link is valid for 1 to 365 days (or without limit).'); return d; };
  const checkQuota = (v) => { if (!v) return 0; const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < 1 || n > 10 * 1048576) throw host.error(400, 'The storage limit must be between 1 MB and 10 TB.'); return n; };

  if (settings().running) start().catch((e) => host.log('start failed:', e.message));

  host.router.get('/file-share', (req, res) => res.json(view()));
  host.router.put('/file-share/settings', async (req, res) => {
    const b = req.body || {}; const s = settings(); const oldPort = s.port; const oldTeam = { ...s.team };
    if (b.port !== undefined) { const n = Number(b.port); if (!Number.isInteger(n) || n < 1024 || n > 65535) throw host.error(400, 'The port must be between 1024 and 65535.'); s.port = n; }
    if (['lan', 'local'].includes(b.network)) s.network = b.network;
    if (b.team && typeof b.team === 'object') { if (typeof b.team.enabled === 'boolean') s.team.enabled = b.team.enabled; if (typeof b.team.readOnly === 'boolean') s.team.readOnly = b.team.readOnly; }
    write('settings', s);
    if (s.team.enabled !== oldTeam.enabled || s.team.readOnly !== oldTeam.readOnly) share.drop({ team: true });
    if (share.server && (b.port !== undefined || b.network !== undefined)) { await share.stop(); await start(); }
    if (s.port !== oldPort) await moveForward(oldPort, s.port);
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
    write('accounts', list); share.drop({ name: a.name }); // offene Verbindungen bekommen die neuen Rechte erst nach neuem Anmelden
    res.json(view());
  });
  host.router.delete('/file-share/accounts/:name', (req, res) => { write('accounts', accounts().filter((a) => a.name !== req.params.name)); share.drop({ name: req.params.name }); res.json(view()); });
  host.router.post('/file-share/start', async (req, res) => { const s = settings(); if (!accounts().length && !s.team.enabled) throw host.error(409, 'Add a user first.'); await start(); res.json(view()); });
  host.router.post('/file-share/stop', async (req, res) => { await share.stop(); write('settings', { ...settings(), running: false }); res.json(view()); });

  // Portfreigabe über die Erweiterung „Router & Portfreigaben“ – mit Besitzer über router.forwards (ab Router 1.2: die
  // Automatik hält sie, die Router-Seite zeigt „Dateifreigabe“ als Herkunft); ältere Router-Erweiterung: wie von Hand gemerkt
  host.router.post('/file-share/forward', async (req, res) => {
    const r = ctx.router;
    if (!r || typeof r.forward !== 'function') throw host.error(409, 'Install the extension “Router & port forwarding” first.');
    const x = await forwardPort(r, settings().port);
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
    const days = checkDays(b.days);
    const max = Number(b.maxDownloads) || 0;
    if (!Number.isInteger(max) || max < 0 || max > 100000) throw host.error(400, 'The download limit must be a whole number between 1 and 100000 (or empty).');
    const pass = String(b.password || '');
    if (pass && pass.length < 6) throw host.error(400, 'The link password needs at least 6 characters.');
    list.push({ token: links.newToken(), folder: checkFolder(b.folder), label: String(b.label || '').trim().slice(0, 60), expires: days ? Date.now() + days * 86400000 : null, maxDownloads: max, downloads: 0, ...(pass ? { passHash: hashPass(pass) } : {}), created: Date.now() });
    write('links', list); res.json(view());
  });
  // Abgelaufenen (oder aufgebrauchten) Link verlängern: neues Ablaufdatum ab heute, Download-Zähler wieder bei 0
  host.router.put('/file-share/links/:token', (req, res) => {
    const list = linkList(); const l = list.find((x) => x.token === req.params.token);
    if (!l) throw host.error(404, 'Link not found');
    const days = checkDays((req.body || {}).days);
    l.expires = days ? Date.now() + days * 86400000 : null;
    if (links.exhausted(l)) l.downloads = 0;
    write('links', list); res.json(view());
  });
  host.router.delete('/file-share/links/:token', (req, res) => { write('links', linkList().filter((l) => l.token !== req.params.token)); res.json(view()); });
  host.router.post('/file-share/sessions/:id/drop', (req, res) => { if (!share.dropId(req.params.id)) throw host.error(404, 'This connection has already ended.'); res.json(view()); });
  host.router.get('/file-share/folder-check', (req, res) => res.json({ sensitive: shares.sensitive(String(req.query.folder || ''), sensitiveDirs) }));
  // Datei-Browser (Hostwerk mit SDK 3.2): Ordner aus Hostwerks Datei-Wurzeln auflösen, Kennzeichen und Freigaben je Ordner
  const resolveIn = (root, rel) => { if (!ctx.files || typeof ctx.files.resolve !== 'function') throw host.error(501, 'Not available'); return ctx.files.resolve(String(root || ''), String(rel || '')).full; };
  host.router.get('/file-share/resolve', (req, res) => res.json({ full: resolveIn(req.query.root, req.query.path) }));
  host.router.get('/file-share/marks', (req, res) => {
    const full = resolveIn(req.query.root, req.query.path);
    res.json({ folder: full, children: shares.marksIn(full, accounts(), linkList()), self: shares.sharesOf(full, accounts(), linkList(), events) });
  });
  const pubGuard = new Guard({ max: 20, ms: 10 * 60000 });
  /** Formular-Inhalt (application/x-www-form-urlencoded, höchstens 4 KB) – der Kern liest für öffentliche Routen nur JSON. */
  const formBody = (req) => new Promise((resolve) => {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return resolve(req.body);
    let raw = ''; let over = false;
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 4096) { over = true; req.destroy(); } });
    req.on('end', () => resolve(over ? {} : Object.fromEntries(new URLSearchParams(raw))));
    req.on('error', () => resolve({}));
  });
  host.publicRouter.use('/file-share/pub/:token', async (req, res) => {
    const ip = req.ip || '?';
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return res.status(405).end();
    if (pubGuard.locked(ip)) return res.status(429).type('text').send('Too many attempts – try again later.');
    const link = links.find(linkList(), req.params.token);
    if (!link) { pubGuard.fail(ip); return res.status(404).type('text').send('This link does not exist or has expired.'); }
    res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const lang = String(req.headers['accept-language'] || '').startsWith('de') ? 'de' : 'en';
    const here = req.originalUrl.split('?')[0];
    // Link mit Passwort: erst das Formular, nach dem richtigen Passwort ein Cookie nur für diesen Link
    if (link.passHash && (req.method === 'POST' || !links.unlocked(linkSecret, link, req.headers.cookie))) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'POST') return res.status(401).type('html').send(links.passwordPage(link, here, lang));
      const body = await formBody(req);
      if (!(await checkPassAsync(String(body.password || ''), link.passHash))) { pubGuard.fail(ip); onEvent({ type: 'fail', user: link.label || path.basename(link.folder), ip }); return res.status(401).type('html').send(links.passwordPage(link, here, lang, true)); }
      pubGuard.ok(ip);
      res.setHeader('Set-Cookie', links.unlockCookie(linkSecret, link, req.baseUrl, req.secure || req.headers['x-forwarded-proto'] === 'https'));
      return res.redirect(303, here);
    }
    if (req.method === 'POST') return res.status(405).end();
    const real = links.resolve(link, req.path);
    if (!real || !fs.existsSync(real)) return res.status(404).type('text').send('Not found');
    const st = fs.statSync(real);
    if (st.isDirectory()) {
      if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(301, `${req.originalUrl.split('?')[0]}/`);
      const base = req.baseUrl; // /api/file-share/pub/<token>
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      return res.type('html').send(links.listing(link, real, base, lang));
    }
    // Ein Download zählt einmal (erstes Stück) – weitere Range-Stücke schreiben weder Protokoll noch Zähler neu
    if (req.method === 'GET' && links.firstPiece(req.headers.range)) {
      if (link.maxDownloads > 0) { const list = linkList(); const l = list.find((x) => x.token === link.token); if (l) { l.downloads = (l.downloads || 0) + 1; write('links', list); } }
      onEvent({ type: 'download', user: link.label || path.basename(link.folder), ip, path: path.relative(link.folder, real).split(path.sep).join('/') });
    }
    res.download(real, path.basename(real), { dotfiles: 'allow' });
  });
  host.on('shutdown', () => share && share.stop());
}

function deactivate() { if (share) share.stop(); share = null; }

module.exports = { activate, deactivate, memberMounts };

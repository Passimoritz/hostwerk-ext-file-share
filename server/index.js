'use strict';
/*
 * File share (SFTP) – server part (SDK 2.7 native extension).
 *   GET    /api/file-share                    → state: running, port, addresses, fingerprint, accounts, recent events
 *   PUT    /api/file-share/settings           → { port, network: 'lan' | 'local' }
 *   POST   /api/file-share/accounts           → { name, password, folder, readOnly }
 *   PUT    /api/file-share/accounts/:name     → { password?, folder?, readOnly? }
 *   DELETE /api/file-share/accounts/:name
 *   POST   /api/file-share/start | stop
 * Data: data/file-share/{settings,accounts,events}.json + host_key (private key of this server, never leaves the PC)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Share, hashPass } = require('./sftpd');

let share = null;

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
  const settings = () => ({ port: 2222, network: 'lan', ...read('settings', {}) });
  const accounts = () => read('accounts', []);
  const events = [];
  const onEvent = (e) => { events.unshift({ t: Date.now(), ...e }); events.splice(50); if (e.type !== 'fail') write('events', events); host.broadcast({ type: 'file-share' }); };
  for (const e of read('events', [])) events.push(e);
  share = new Share({ ssh2, hostKey, accounts, onEvent });

  const addresses = () => {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push({ name, address: a.address });
    return out;
  };
  const view = () => { const s = settings(); return { running: !!share.server, port: share.server ? share.port : s.port, network: s.network, addresses: s.network === 'lan' ? addresses() : [{ name: 'localhost', address: '127.0.0.1' }], fingerprint, accounts: accounts().map(({ hash, ...a }) => ({ ...a, exists: fs.existsSync(a.folder) })), events: events.slice(0, 30) }; };
  const start = async () => { const s = settings(); await share.start(s.port, s.network === 'lan' ? '0.0.0.0' : '127.0.0.1'); write('settings', { ...s, running: true }); };
  const NAME = /^[a-z][a-z0-9_.-]{1,31}$/;
  const checkFolder = (f) => { const p = path.resolve(String(f || '')); if (!f || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw host.error(400, 'The folder does not exist.'); if (p === path.parse(p).root) throw host.error(400, 'A whole drive cannot be shared – pick a folder.'); return p; };
  const checkPass = (p) => { if (String(p || '').length < 10) throw host.error(400, 'The password needs at least 10 characters.'); return String(p); };

  if (settings().running) start().catch((e) => host.log('start failed:', e.message));

  host.router.get('/file-share', (req, res) => res.json(view()));
  host.router.put('/file-share/settings', async (req, res) => {
    const b = req.body || {}; const s = settings();
    if (b.port !== undefined) { const n = Number(b.port); if (!Number.isInteger(n) || n < 1024 || n > 65535) throw host.error(400, 'The port must be between 1024 and 65535.'); s.port = n; }
    if (['lan', 'local'].includes(b.network)) s.network = b.network;
    write('settings', s);
    if (share.server) { await share.stop(); await start(); }
    res.json(view());
  });
  host.router.post('/file-share/accounts', (req, res) => {
    const b = req.body || {}; const list = accounts();
    const name = String(b.name || '').trim().toLowerCase();
    if (!NAME.test(name)) throw host.error(400, 'User name: 2–32 small letters, digits, _ . -, starting with a letter.');
    if (list.some((a) => a.name === name)) throw host.error(409, 'This user name exists already.');
    list.push({ name, hash: hashPass(checkPass(b.password)), folder: checkFolder(b.folder), readOnly: !!b.readOnly, created: Date.now() });
    write('accounts', list); res.json(view());
  });
  host.router.put('/file-share/accounts/:name', (req, res) => {
    const b = req.body || {}; const list = accounts(); const a = list.find((x) => x.name === req.params.name);
    if (!a) throw host.error(404, 'User not found');
    if (b.password) a.hash = hashPass(checkPass(b.password));
    if (b.folder !== undefined) a.folder = checkFolder(b.folder);
    if (b.readOnly !== undefined) a.readOnly = !!b.readOnly;
    write('accounts', list); res.json(view());
  });
  host.router.delete('/file-share/accounts/:name', (req, res) => { write('accounts', accounts().filter((a) => a.name !== req.params.name)); res.json(view()); });
  host.router.post('/file-share/start', async (req, res) => { if (!accounts().length) throw host.error(409, 'Add a user first.'); await start(); res.json(view()); });
  host.router.post('/file-share/stop', async (req, res) => { await share.stop(); write('settings', { ...settings(), running: false }); res.json(view()); });
  host.on('shutdown', () => share && share.stop());
}

function deactivate() { if (share) share.stop(); share = null; }

module.exports = { activate, deactivate };

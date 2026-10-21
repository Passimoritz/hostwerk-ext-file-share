'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const S = require('../server/sftpd');
const L = require('../server/links');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-')));
const find = (n) => { for (const p of [n, path.join(__dirname, '..', '..', '..', 'hostwerk', 'node_modules', n)]) { try { return require(p); } catch { /* next */ } } return null; };
const ssh2 = find('ssh2'); const Client = find('ssh2-sftp-client');
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('password check runs async (does not block) and gives the same answer', async () => {
  const h = S.hashPass('correct horse');
  let ticked = false; setImmediate(() => { ticked = true; });
  const p = S.checkPassAsync('correct horse', h);
  assert.ok(p instanceof Promise);
  assert.strictEqual(await p, true); assert.ok(ticked, 'event loop kept running during the check');
  assert.strictEqual(await S.checkPassAsync('wrong', h), false); assert.strictEqual(await S.checkPassAsync('x', 'plain'), false);
});

test('locate: own folder or the mounts of a team member', () => {
  const acc = { mounts: [{ name: 'survival', folder: '/srv/mc' }, { name: 'shop', folder: '/srv/web' }] };
  assert.deepStrictEqual(S.locate(acc, '/'), { top: true });
  assert.deepStrictEqual(S.locate(acc, '/survival/world/level.dat'), { root: '/srv/mc', sub: '/world/level.dat', prefix: '/survival' });
  assert.deepStrictEqual(S.locate(acc, '/../shop'), { root: '/srv/web', sub: '/', prefix: '/shop' });
  assert.strictEqual(S.locate(acc, '/other'), null);
  assert.deepStrictEqual(S.locate({ folder: '/x' }, '/a'), { root: '/x', sub: '/a', prefix: '' });
});

test('usable: expired or missing folder cannot sign in', () => {
  const f = tmp();
  assert.ok(S.usable({ folder: f })); assert.ok(!S.usable({ folder: f, expires: Date.now() - 1 })); assert.ok(S.usable({ folder: f, expires: Date.now() + 60000 }));
  assert.ok(!S.usable({ folder: path.join(f, 'gone') })); assert.ok(!S.usable({ mounts: [] })); assert.ok(!S.usable(null));
});

test('dirSize counts files in sub folders', async () => {
  const f = tmp(); fs.mkdirSync(path.join(f, 'a')); fs.writeFileSync(path.join(f, 'a', 'x'), '12345'); fs.writeFileSync(path.join(f, 'y'), '123');
  assert.strictEqual(await S.dirSize(f), 8);
});

test('links: token format, expiry, jail and listing', () => {
  const f = tmp(); fs.writeFileSync(path.join(f, 'a&b.txt'), 'x'); fs.mkdirSync(path.join(f, 'sub'));
  const tok = L.newToken(); assert.match(tok, L.TOKEN);
  const list = [{ token: tok, folder: f, label: 'Fotos' }, { token: L.newToken(), folder: f, expires: Date.now() - 1 }];
  assert.ok(L.find(list, tok)); assert.strictEqual(L.find(list, list[1].token), null); assert.strictEqual(L.find(list, '../etc'), null);
  assert.strictEqual(L.resolve(list[0], '/a%26b.txt'), path.join(f, 'a&b.txt'));
  const up = L.resolve(list[0], '/../../sub'); assert.strictEqual(up, path.join(f, 'sub'), '.. stays inside');
  assert.strictEqual(L.resolve(list[0], '/%E0%A4%A'), null);
  const html = L.listing(list[0], f, '/api/file-share/pub/' + tok, 'de');
  assert.ok(html.includes('a&amp;b.txt') && !html.includes('>a&b.txt'), 'names are escaped');
  assert.ok(html.includes('lang="de"') && html.includes('sub/'));
});

test('SFTP: SSH key, team member mounts, expired account, storage limit', { skip: !ssh2 || !Client ? 'ssh2 not available' : false }, async () => {
  const folder = tmp(); const mc = tmp(); fs.writeFileSync(path.join(mc, 'server.properties'), 'motd=hi');
  const kp = ssh2.utils.generateKeyPairSync('ed25519');
  const accounts = [
    { name: 'keyuser', hash: null, keys: [kp.public], folder },
    { name: 'old', hash: S.hashPass('old-pass-1234'), folder, expires: Date.now() - 1000 },
    { name: 'small', hash: S.hashPass('small-pass-123'), folder, quotaMB: 1 },
  ];
  const members = async (name, pw) => (name === 'lena' && pw === 'team-pass-123' ? { name: 'lena', readOnly: false, mounts: [{ name: 'survival', folder: mc }] } : null);
  const share = new S.Share({ ssh2, hostKey: ssh2.utils.generateKeyPairSync('ed25519').private, accounts: () => accounts, members, guard: new S.Guard({ max: 50, ms: 60000 }) });
  const port = await freePort();
  await share.start(port, '127.0.0.1');
  try {
    const k = new Client();
    await k.connect({ host: '127.0.0.1', port, username: 'keyuser', privateKey: kp.private });
    await k.put(Buffer.from('via key'), '/k.txt'); assert.strictEqual(fs.readFileSync(path.join(folder, 'k.txt'), 'utf8'), 'via key');
    await k.end();
    await assert.rejects(new Client().connect({ host: '127.0.0.1', port, username: 'keyuser', privateKey: ssh2.utils.generateKeyPairSync('ed25519').private, readyTimeout: 5000 }), 'other key refused');
    await assert.rejects(new Client().connect({ host: '127.0.0.1', port, username: 'old', password: 'old-pass-1234', readyTimeout: 5000 }), 'expired');
    const m = new Client();
    await m.connect({ host: '127.0.0.1', port, username: 'lena', password: 'team-pass-123' });
    assert.deepStrictEqual((await m.list('/')).map((x) => x.name), ['survival']);
    assert.strictEqual((await m.get('/survival/server.properties')).toString(), 'motd=hi');
    await assert.rejects(m.put(Buffer.from('x'), '/top.txt'), 'top folder is read-only');
    await m.end();
    const q = new Client();
    await q.connect({ host: '127.0.0.1', port, username: 'small', password: 'small-pass-123' });
    await q.put(Buffer.alloc(600 * 1024), '/a.bin');
    await q.put(Buffer.alloc(600 * 1024), '/b.bin').catch(() => {}); // manche Programme melden den Fehler nicht – entscheidend ist, was ankommt
    assert.ok(fs.statSync(path.join(folder, 'a.bin')).size + fs.statSync(path.join(folder, 'b.bin')).size <= 1048576, 'stays within 1 MB');
    await q.end();
  } finally { await share.stop(); }
});

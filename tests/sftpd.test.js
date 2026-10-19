'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const S = require('../server/sftpd');
const de = require('../locales/de.json');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-')));

test('passwords: hash, check, wrong one fails', () => {
  const h = S.hashPass('correct horse'); assert.ok(h.startsWith('scrypt$'));
  assert.ok(S.checkPass('correct horse', h)); assert.ok(!S.checkPass('wrong', h)); assert.ok(!S.checkPass('x', 'plain'));
});

test('jail: nobody gets above the folder', () => {
  const r = tmp();
  assert.strictEqual(S.jail(r, '/'), path.resolve(r));
  assert.strictEqual(S.jail(r, '/a/../b'), path.join(r, 'b'));
  assert.strictEqual(S.jail(r, '../../etc'), path.resolve(r, 'etc'), '.. at the top stays at the top');
  assert.strictEqual(S.jail(r, '..\\..\\Windows'), path.resolve(r, 'Windows'));
  assert.strictEqual(S.virt(r, path.join(r, 'x', 'y')), '/x/y'); assert.strictEqual(S.virt(r, r), '/');
});

test('safe: a link inside the folder that points outside is refused', () => {
  const r = tmp(); const outside = tmp(); fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  let linked = true;
  try { fs.symlinkSync(outside, path.join(r, 'escape'), 'junction'); } catch { linked = false; }
  if (linked) { assert.strictEqual(S.safe(r, '/escape/secret.txt'), null); assert.strictEqual(S.safe(r, '/escape/new.txt'), null); }
  assert.strictEqual(S.safe(r, '/fine.txt'), path.join(r, 'fine.txt'));
});

test('guard: locks an address after 5 wrong passwords', () => {
  const g = new S.Guard({ max: 5, ms: 60000 });
  for (let i = 0; i < 4; i++) g.fail('1.2.3.4');
  assert.ok(!g.locked('1.2.3.4')); g.fail('1.2.3.4'); assert.ok(g.locked('1.2.3.4')); assert.ok(!g.locked('5.6.7.8'));
  g.ok('1.2.3.4'); assert.ok(!g.locked('1.2.3.4'));
});

// Real SFTP round trip – needs ssh2 and ssh2-sftp-client (Hostwerk bundles both); skipped where they are missing
const find = (n) => { for (const p of [n, path.join(__dirname, '..', '..', '..', 'hostwerk', 'node_modules', n)]) { try { return require(p); } catch { /* next */ } } return null; };
const ssh2 = find('ssh2'); const Client = find('ssh2-sftp-client');
test('SFTP: sign in, list, upload, download; read-only user may not write; wrong password locks', { skip: !ssh2 || !Client ? 'ssh2 not available' : false }, async () => {
  const folder = tmp(); fs.writeFileSync(path.join(folder, 'hello.txt'), 'hi');
  const accounts = [{ name: 'lena', hash: S.hashPass('lena-pass-123'), folder, readOnly: false }, { name: 'gast', hash: S.hashPass('gast-pass-123'), folder, readOnly: true }];
  const events = [];
  const key = ssh2.utils.generateKeyPairSync('ed25519').private;
  const share = new S.Share({ ssh2, hostKey: key, accounts: () => accounts, onEvent: (e) => events.push(e.type), guard: new S.Guard({ max: 3, ms: 60000 }) });
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  await share.start(port, '127.0.0.1');
  try {
    const c = new Client();
    await c.connect({ host: '127.0.0.1', port, username: 'lena', password: 'lena-pass-123' });
    assert.deepStrictEqual((await c.list('/')).map((x) => x.name), ['hello.txt']);
    await c.put(Buffer.from('uploaded'), '/up.txt');
    assert.strictEqual(fs.readFileSync(path.join(folder, 'up.txt'), 'utf8'), 'uploaded');
    assert.strictEqual((await c.get('/hello.txt')).toString(), 'hi');
    await c.mkdir('/sub'); assert.ok(fs.existsSync(path.join(folder, 'sub')));
    assert.strictEqual(await c.realPath('/../..'), '/');
    await c.end();
    const g = new Client();
    await g.connect({ host: '127.0.0.1', port, username: 'gast', password: 'gast-pass-123' });
    await assert.rejects(g.put(Buffer.from('x'), '/nope.txt'));
    await assert.rejects(g.delete('/hello.txt'));
    assert.ok(fs.existsSync(path.join(folder, 'hello.txt')));
    await g.end();
    for (let i = 0; i < 3; i++) await assert.rejects(new Client().connect({ host: '127.0.0.1', port, username: 'lena', password: 'nope', readyTimeout: 5000 }));
    await assert.rejects(new Client().connect({ host: '127.0.0.1', port, username: 'lena', password: 'lena-pass-123', readyTimeout: 5000 }), 'locked after 3 wrong passwords');
    assert.ok(events.includes('login') && events.includes('upload') && events.includes('fail'));
  } finally { await share.stop(); }
});

test('messages have German', () => {
  for (const s of ['The password needs at least 10 characters.', 'A whole drive cannot be shared – pick a folder.', 'This user name exists already.']) assert.ok(de[s], s);
});

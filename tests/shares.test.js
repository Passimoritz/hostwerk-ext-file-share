'use strict';
/* 1.3: Freigaben je Ordner für den Datei-Browser (Kennzeichen, Abschnitt) und „zuletzt benutzt“. */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const S = require('../server/shares');

const base = path.resolve('/srv/share');
const acc = [{ name: 'lena', folder: path.join(base, 'Welten'), readOnly: true, expires: 1000 }, { name: 'tom', folder: path.join(base, 'welten') + path.sep, readOnly: false }, { name: 'max', folder: path.join(base, 'Mods', 'tief') }];
const links = [{ token: 'a', folder: path.join(base, 'Fotos'), label: 'Urlaub', expires: null }, { token: 'b', folder: path.join(base, 'Alt'), label: '', expires: 1 }];
const events = [{ t: 5, user: 'lena', type: 'login' }, { t: 9, user: 'lena', type: 'fail' }, { t: 7, user: 'Urlaub', type: 'download' }, { t: 3, user: 'lena', type: 'upload' }];

test('zuletzt benutzt: jüngstes Ereignis, Fehlversuche zählen nicht', () => {
  assert.deepStrictEqual(S.lastUse(events), { lena: 5, Urlaub: 7 });
});

test('Freigaben genau dieses Ordners (unter Windows ohne Groß/Klein, Schrägstrich am Ende egal)', () => {
  const win = S.sharesOf(path.join(base, 'Welten'), acc, links, events, 2000, true);
  assert.deepStrictEqual(win.map((x) => [x.kind, x.name, x.readOnly, x.expired, x.last]), [['account', 'lena', true, true, 5], ['account', 'tom', false, false, null]]);
  const posix = S.sharesOf(path.join(base, 'Welten'), acc, links, events, 2000, false);
  assert.deepStrictEqual(posix.map((x) => x.name), ['lena']);
  const fotos = S.sharesOf(path.join(base, 'Fotos'), acc, links, events, 2000, false);
  assert.deepStrictEqual(fotos.map((x) => [x.kind, x.name, x.last, x.token]), [['link', 'Urlaub', 7, 'a']]);
});

test('Kennzeichen: nur direkte Unterordner, abgelaufene Links zählen nicht', () => {
  const m = S.marksIn(base, acc, links, false);
  assert.deepStrictEqual(Object.keys(m).sort(), ['Fotos', 'Welten', 'welten']);
  assert.deepStrictEqual(m.Fotos, { users: [], links: 1 });
  assert.deepStrictEqual(m.Welten.users, ['lena']);
  assert.deepStrictEqual(S.marksIn(path.join(base, 'Mods'), acc, links, false), { tief: { users: ['max'], links: 0 } });
});

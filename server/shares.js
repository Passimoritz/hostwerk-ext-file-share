'use strict';
/*
 * Freigaben je Ordner – für den Datei-Browser (Hostwerk mit SDK 3.2): Kennzeichen an freigegebenen Unterordnern und der
 * Abschnitt „Freigaben dieses Ordners“. Pfade werden normalisiert verglichen (unter Windows ohne Groß/Klein).
 * Außerdem: wann ein Zugang oder Link zuletzt benutzt wurde (aus dem Protokoll).
 */
const path = require('path');

const norm = (p, win = process.platform === 'win32') => { const r = path.resolve(String(p || '')).replace(/[\\/]+$/, ''); return win ? r.toLowerCase() : r; };

/** Zuletzt benutzt: user/label → Zeitpunkt des jüngsten Ereignisses (Anmeldung, Upload, Download …, keine Fehlversuche). */
function lastUse(events) {
  const out = {};
  for (const e of events || []) if (e && e.user && e.type !== 'fail' && (!out[e.user] || e.t > out[e.user])) out[e.user] = e.t;
  return out;
}

/** Einträge (Zugänge und Links) für genau diesen Ordner: [{ kind, name, readOnly, expires, expired, last }] */
function sharesOf(folder, accounts, links, events, now = Date.now(), win) {
  const f = norm(folder, win);
  const used = lastUse(events);
  const acc = (accounts || []).filter((a) => a && norm(a.folder, win) === f).map((a) => ({ kind: 'account', name: a.name, readOnly: !!a.readOnly, expires: a.expires || null, expired: !!(a.expires && a.expires <= now), last: used[a.name] || null }));
  const lnk = (links || []).filter((l) => l && norm(l.folder, win) === f).map((l) => { const name = l.label || path.basename(String(l.folder)); return { kind: 'link', name, token: l.token, readOnly: true, expires: l.expires || null, expired: !!(l.expires && l.expires <= now), last: used[name] || null }; });
  return [...acc, ...lnk];
}

/**
 * Kennzeichen für die Einträge eines Ordners: { <name des Unterordners>: { users: [...], links: n } } für alle
 * freigegebenen direkten Unterordner von dir.
 */
function marksIn(dir, accounts, links, win) {
  const d = norm(dir, win);
  const out = {};
  const add = (folder, fn) => {
    const f = norm(folder, win);
    if (path.dirname(f) !== d || f === d) return;
    const name = path.basename(path.resolve(String(folder)));
    out[name] = out[name] || { users: [], links: 0 };
    fn(out[name]);
  };
  for (const a of accounts || []) if (a && a.folder) add(a.folder, (m) => m.users.push(a.name));
  for (const l of links || []) if (l && l.folder && !(l.expires && l.expires <= Date.now())) add(l.folder, (m) => { m.links++; });
  return out;
}

module.exports = { norm, lastUse, sharesOf, marksIn };

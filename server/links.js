'use strict';
/*
 * Download links: a folder (or a single file) read-only in the browser, without an SFTP program – e.g. through Hostwerk's
 * remote access. Each link has a random token (192 bit), optionally an expiry date, and only ever shows what is inside its
 * folder (same jail as SFTP, links pointing outside are refused). Listing and download only – no upload, no delete.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safe } = require('./sftpd');

const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const newToken = () => crypto.randomBytes(24).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Download limit used up? (maxDownloads 0/empty = no limit) */
const exhausted = (l) => !!(l && l.maxDownloads > 0 && (l.downloads || 0) >= l.maxDownloads);

/** Valid link for a token, or null (unknown, expired, download limit reached, folder gone). */
function find(links, token, now = Date.now()) {
  if (!TOKEN.test(String(token || ''))) return null;
  const l = links.find((x) => x.token === token);
  if (!l || (l.expires && l.expires <= now) || exhausted(l) || !fs.existsSync(l.folder)) return null;
  return l;
}

/**
 * Counts this request as a download? Only the first piece: no Range header or a range from byte 0 – browsers and download
 * managers fetch big files in many pieces, which must neither use up the limit nor rewrite the log each time.
 */
function firstPiece(rangeHeader) {
  const r = String(rangeHeader || '').trim();
  if (!r) return true;
  const m = /^bytes=\s*(\d*)\s*-/.exec(r);
  return !!m && (m[1] === '' ? false : Number(m[1]) === 0);
}

/* ---- Link with password: the browser gets a cookie bound to this link and its password hash (HMAC with a secret) ---- */
const cookieName = (token) => `hwfs_${token.slice(0, 12)}`;
const cookieValue = (secret, link) => crypto.createHmac('sha256', secret).update(`${link.token}\n${link.passHash || ''}`).digest('base64url');
/** Does the request carry the right cookie for this password-protected link? */
function unlocked(secret, link, cookieHeader) {
  if (!link.passHash) return true;
  const want = Buffer.from(cookieValue(secret, link));
  for (const part of String(cookieHeader || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    if (part.slice(0, i).trim() !== cookieName(link.token)) continue;
    const got = Buffer.from(part.slice(i + 1).trim());
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return true;
  }
  return false;
}
/** Set-Cookie line after the right password (only for the path of this link, not readable by scripts). */
function unlockCookie(secret, link, base, secure) {
  return `${cookieName(link.token)}=${cookieValue(secret, link)}; Path=${base}/; HttpOnly; SameSite=Lax; Max-Age=43200${secure ? '; Secure' : ''}`;
}
/** Small password page (no JavaScript; posts back to the same address). */
function passwordPage(link, action, lang = 'en', wrong = false) {
  const de = lang === 'de';
  const title = esc(link.label || path.basename(link.folder));
  return `<!doctype html><html lang="${de ? 'de' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:420px;margin:0 auto;padding:48px 16px;line-height:1.5}form{display:flex;flex-direction:column;gap:10px}input,button{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 30%,transparent)}button{cursor:pointer}p.err{color:#d33}small{opacity:.7}</style></head>
<body><h1>${title}</h1><form method="post" action="${esc(action)}"><label for="p">${de ? 'Dieser Link ist mit einem Passwort geschützt.' : 'This link is protected with a password.'}</label>
<input id="p" name="password" type="password" autocomplete="current-password" required autofocus>${wrong ? `<p class="err" role="alert">${de ? 'Das Passwort stimmt nicht.' : 'Wrong password.'}</p>` : ''}
<button type="submit">${de ? 'Öffnen' : 'Open'}</button></form><small>${de ? 'Freigegeben mit Hostwerk.' : 'Shared with Hostwerk.'}</small></body></html>`;
}

/** Path below the link ("/sub/file.zip", URL-decoded) → real path inside the folder, or null. */
function resolve(link, sub) {
  let p; try { p = decodeURIComponent(String(sub || '/')); } catch { return null; }
  if (p.includes('\0')) return null;
  // Versteckte Dateien/Ordner (.env, .git …) zeigt die Liste nicht – dann dürfen sie auch nicht per erratener Adresse ladbar sein
  if (path.posix.normalize(`/${p.replace(/\\/g, '/')}`).split('/').some((s) => s.startsWith('.'))) return null;
  return safe(link.folder, p);
}

const SIZE = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let x = n; while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; } return `${x.toFixed(x >= 10 || i === 0 ? 0 : 1)} ${u[i]}`; };

/** Plain HTML listing of a folder (works without JavaScript, readable in light and dark mode). */
function listing(link, real, base, lang = 'en') {
  const de = lang === 'de';
  const rel = path.relative(path.resolve(link.folder), real).split(path.sep).filter(Boolean);
  let entries = [];
  try { entries = fs.readdirSync(real, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')); } catch { /* leer */ }
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const href = (parts) => `${base}/${parts.map(encodeURIComponent).join('/')}`;
  const rows = entries.map((e) => {
    const p = [...rel, e.name];
    let size = ''; try { if (e.isFile()) size = SIZE(fs.statSync(path.join(real, e.name)).size); } catch { /* weg */ }
    return `<li><a href="${esc(href(p))}${e.isDirectory() ? '/' : ''}">${e.isDirectory() ? '📁 ' : ''}${esc(e.name)}</a><span>${esc(size)}</span></li>`;
  }).join('');
  const crumbs = [`<a href="${esc(base)}/">${esc(link.label || path.basename(link.folder))}</a>`, ...rel.map((n, i) => `<a href="${esc(href(rel.slice(0, i + 1)))}/">${esc(n)}</a>`)].join(' / ');
  const title = esc(link.label || path.basename(link.folder));
  return `<!doctype html><html lang="${de ? 'de' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:760px;margin:0 auto;padding:24px 16px;line-height:1.5}ul{list-style:none;padding:0;margin:16px 0}li{display:flex;justify-content:space-between;gap:12px;padding:8px 4px;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent)}a{color:inherit;text-underline-offset:2px;min-height:24px;display:inline-block}span,small{opacity:.7}</style></head>
<body><h1>${title}</h1><nav aria-label="${de ? 'Pfad' : 'Path'}">${crumbs}</nav><ul>${rows || `<li>${de ? 'Dieser Ordner ist leer.' : 'This folder is empty.'}</li>`}</ul>
<small>${de ? 'Nur zum Herunterladen – freigegeben mit Hostwerk.' : 'Download only – shared with Hostwerk.'}${link.expires ? ` ${de ? 'Gültig bis' : 'Valid until'} ${esc(new Date(link.expires).toLocaleString(de ? 'de-DE' : 'en-US'))}.` : ''}</small></body></html>`;
}

module.exports = { find, resolve, listing, newToken, TOKEN, exhausted, firstPiece, unlocked, unlockCookie, passwordPage, cookieName };

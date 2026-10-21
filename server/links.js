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

/** Valid link for a token, or null (unknown, expired, folder gone). */
function find(links, token, now = Date.now()) {
  if (!TOKEN.test(String(token || ''))) return null;
  const l = links.find((x) => x.token === token);
  if (!l || (l.expires && l.expires <= now) || !fs.existsSync(l.folder)) return null;
  return l;
}

/** Path below the link ("/sub/file.zip", URL-decoded) → real path inside the folder, or null. */
function resolve(link, sub) {
  let p; try { p = decodeURIComponent(String(sub || '/')); } catch { return null; }
  if (p.includes('\0')) return null;
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

module.exports = { find, resolve, listing, newToken, TOKEN };

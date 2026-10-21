import { useEffect, useState } from 'react';
import { FolderUp, Play, Square, UserPlus, Trash2, KeyRound, Copy, Settings2, Lock, Eye, Upload, LogIn, ShieldAlert, Network, QrCode, Router, Link2, Download, Users, AlertTriangle, RotateCcw, CalendarClock, HardDrive } from 'lucide-react';
import { get, post, put, del, useApi, on } from '@hostwerk/api';
import { Btn, Seg, Field, Modal, Empty, Loading, Callout, InfoTip, PathInput, Switch, toast, confirmDialog } from '@hostwerk/ui';
import { contextMenu } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';
import { AddonTabs } from './addons';
import './style.css';

/*
 * File share (SFTP): server on/off with the address to hand out (copy, QR code, router forwarding), users with their own
 * folder (password and/or SSH keys, time limit, storage limit), team members, download links, recent activity.
 * Texts are English; German comes from locales/de.json (also inside JSX).
 */
const genPass = () => { const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = new Uint32Array(16); crypto.getRandomValues(b); return [...b].map((x) => a[x % a.length]).join(''); };
const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); toast.success(t('{what} copied', { what: t(what) })); } catch { toast.error('Could not copy'); } };
/** Datum und Uhrzeit in der Sprache von Hostwerk */
const locale = () => (document.documentElement.lang === 'en' ? 'en-US' : document.documentElement.lang || 'de-DE');
const when = (ts) => new Date(ts).toLocaleString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (ts) => new Date(ts).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
const toInputDate = (ts) => (ts ? new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '');
const EVENT = { login: { icon: LogIn, text: 'signed in' }, fail: { icon: ShieldAlert, text: 'wrong password' }, upload: { icon: Upload, text: 'uploaded' }, delete: { icon: Trash2, text: 'deleted' }, download: { icon: Download, text: 'downloaded' }, quota: { icon: HardDrive, text: 'hit the storage limit' } };

function UserForm({ user, s, onClose, onSaved }) {
  const isNew = !user;
  const [f, setF] = useState({ name: user ? user.name : '', password: isNew ? genPass() : '', keys: user ? user.keys.map((k) => k.line).join('\n') : '', folder: user ? user.folder : '', readOnly: user ? user.readOnly : false, expires: toInputDate(user && user.expires), quotaMB: user && user.quotaMB ? String(user.quotaMB) : '', vault: false });
  const [busy, setBusy] = useState(false);
  const addr = (s.addresses[0] || {}).address || '127.0.0.1';
  const save = async () => {
    setBusy(true);
    try {
      // Ablauf: Ende des gewählten Tages (lokale Zeit)
      const expires = f.expires ? new Date(`${f.expires}T23:59:59`).getTime() : null;
      const body = { folder: f.folder, readOnly: f.readOnly, keys: f.keys, expires, quotaMB: Number(f.quotaMB) || 0, ...(f.password ? { password: f.password } : {}) };
      const r = isNew ? await post('/file-share/accounts', { name: f.name, ...body }) : await put(`/file-share/accounts/${user.name}`, body);
      onSaved(r);
      if (f.vault && f.password) {
        try {
          const pw = await get('/pw');
          const v = (pw.instances || []).find((x) => x.id === pw.defaultId) || (pw.instances || [])[0];
          if (!v) toast.error('No password vault yet – set one up under Passwords.');
          else if (v.locked) toast.error('Unlock the password vault first – the password was not stored.');
          else { await post(`/pw/${v.id}/items`, { type: 'login', name: `SFTP ${f.name}`, username: f.name, password: f.password, urls: [`sftp://${addr}:${s.port}`], notes: t('Folder: {folder}', { folder: f.folder }) }); toast.success('Password stored in the vault'); }
        } catch (e) { toast.error(e); }
      }
      if (f.password) toast.success('Saved – pass the password on safely (not in the same message as the address).'); else toast.success('Saved');
      onClose();
    } catch (e) { toast.error(e); }
    setBusy(false);
  };
  const can = f.name && f.folder && (!isNew || f.password || f.keys.trim());
  return (
    <Modal title={isNew ? 'New user' : t('User {name}', { name: user.name })} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" disabled={!can || busy} onClick={save}>Save</Btn></>}>
      <div className="stack">
        <Field label="User name" hint="small letters, digits, _ . -"><input className="input mono" value={f.name} disabled={!isNew} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} placeholder="e.g. lena" /></Field>
        <Field label={isNew ? 'Password' : 'New password (empty = keep)'} hint="At least 10 characters. Hostwerk only keeps a hash – it cannot show the password again.">
          <div className="row-tight"><input className="input mono grow" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} aria-label="Password" /><Btn className="sm" icon={KeyRound} onClick={() => setF({ ...f, password: genPass() })}>New</Btn><Btn className="sm ghost icon" icon={Copy} title="Copy" aria-label="Copy" disabled={!f.password} onClick={() => copy(f.password, 'Password')} /></div>
        </Field>
        {s.passwords && f.password && <label className="check"><Switch checked={f.vault} onChange={(v) => setF({ ...f, vault: v })} /> Also store the password in the password vault</label>}
        <Field label="SSH keys (optional)" hint="One public key per line (ssh-ed25519 … or ssh-rsa …, from the .pub file). Then the user signs in without a password.">
          <textarea className="input mono fs-keys" rows={3} value={f.keys} onChange={(e) => setF({ ...f, keys: e.target.value })} placeholder="ssh-ed25519 AAAA… lena@laptop" aria-label="SSH keys (optional)" />
        </Field>
        <Field label="Folder this user sees" hint="The user cannot go above it."><PathInput mode="folder" title="Shared folder" value={f.folder} onChange={(v) => setF({ ...f, folder: v })} /></Field>
        <div className="grid grid-2">
          <Field label="Valid until (optional)" hint="After this day the user can no longer sign in – handy for guests."><input className="input" type="date" value={f.expires} min={toInputDate(Date.now())} onChange={(e) => setF({ ...f, expires: e.target.value })} aria-label="Valid until (optional)" /></Field>
          <Field label="Storage limit in MB (optional)" hint="Uploads stop when the folder reaches this size. Empty = no limit."><input className="input" inputMode="numeric" value={f.quotaMB} onChange={(e) => setF({ ...f, quotaMB: e.target.value.replace(/\D/g, '') })} placeholder="e.g. 2048" aria-label="Storage limit in MB (optional)" /></Field>
        </div>
        <label className="check"><Switch checked={f.readOnly} onChange={(v) => setF({ ...f, readOnly: v })} /> Read only (download, no upload or delete)</label>
      </div>
    </Modal>
  );
}

function Settings({ s, onClose, onSaved }) {
  const [port, setPort] = useState(String(s.port));
  const [network, setNetwork] = useState(s.network);
  const [team, setTeam] = useState({ enabled: !!s.team.enabled, readOnly: !!s.team.readOnly });
  const save = async () => { try { onSaved(await put('/file-share/settings', { port: Number(port), network, team })); onClose(); } catch (e) { toast.error(e); } };
  return (
    <Modal title="Share settings" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" onClick={save}>Save</Btn></>}>
      <div className="stack">
        <Field label="Port" hint="Standard for SFTP is 22 – Hostwerk uses 2222 so it does not collide with an SSH server."><input className="input" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} /></Field>
        <Field label="Who can connect?"><Seg options={[{ id: 'lan', label: 'Home network (and the internet through a router forwarding)' }, { id: 'local', label: 'Only this PC' }]} value={network} onChange={setNetwork} /></Field>
        {s.team.available && <Field label="Team members" hint="Members of “Team & users” sign in with their Hostwerk name and password and see one folder per service shared with them.">
          <div className="stack">
            <label className="check"><Switch checked={team.enabled} onChange={(v) => setTeam({ ...team, enabled: v })} /> Team members may sign in</label>
            <label className="check"><Switch checked={team.readOnly} disabled={!team.enabled} onChange={(v) => setTeam({ ...team, readOnly: v })} /> Team members only read</label>
          </div>
        </Field>}
      </div>
    </Modal>
  );
}

function QrDialog({ text, onClose }) {
  const [svg, setSvg] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { get(`/file-share/qr?text=${encodeURIComponent(text)}`).then((r) => setSvg(r.svg), (e) => setErr(e.message)); }, [text]);
  return (
    <Modal title="Connect with the phone" onClose={onClose} footer={<Btn onClick={onClose}>Close</Btn>}>
      <div className="stack fs-qr-wrap">
        {err ? <Callout kind="err" dismissible={false}>{err}</Callout> : svg ? <div className="fs-qr" role="img" aria-label={t('QR code for {text}', { text })} dangerouslySetInnerHTML={{ __html: svg }} /> : <Loading />}
        <code className="fs-qr-text">{text}</code>
        <span className="small muted">Scan with an SFTP app on the phone – the user name and password are entered there.</span>
      </div>
    </Modal>
  );
}

function LinkForm({ onClose, onSaved }) {
  const [f, setF] = useState({ folder: '', label: '', days: '7' });
  const save = async () => { try { onSaved(await post('/file-share/links', { folder: f.folder, label: f.label, days: Number(f.days) })); toast.success('Link created'); onClose(); } catch (e) { toast.error(e); } };
  return (
    <Modal title="New download link" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" disabled={!f.folder} onClick={save}>Create</Btn></>}>
      <div className="stack">
        <Field label="Folder" hint="Everyone with the link can see and download what is inside – nothing else, and nothing can be changed."><PathInput mode="folder" title="Folder for the link" value={f.folder} onChange={(v) => setF({ ...f, folder: v })} /></Field>
        <Field label="Name (optional)"><input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. Holiday photos" /></Field>
        <Field label="Valid for"><Seg value={f.days} onChange={(v) => setF({ ...f, days: v })} options={[{ id: '1', label: '1 day' }, { id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '0', label: 'No limit' }]} /></Field>
      </div>
    </Modal>
  );
}

function FileSharePage({ ext }) {
  const st = useApi('/file-share', [], { live: false });
  const [user, setUser] = useState(undefined);
  const [cfg, setCfg] = useState(false);
  const [qr, setQr] = useState(null);
  const [linkForm, setLinkForm] = useState(false);
  const s = st.data;
  useEffect(() => on('file-share', () => st.reload({ silent: true })), [st.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return st.error ? <div className="page"><Empty icon={AlertTriangle} title="The file share could not be loaded" text={st.error} action={<Btn icon={RotateCcw} onClick={() => st.reload()}>Try again</Btn>} /></div> : <Loading />;
  const act = async (p) => { try { st.setData(await post(`/file-share/${p}`)); } catch (e) { toast.error(e); } };
  const remove = async (u) => { if (await confirmDialog({ title: t('Remove the user “{name}”?', { name: u.name }), text: 'The folder and its files stay.', confirm: 'Remove', danger: true })) st.setData(await del(`/file-share/accounts/${u.name}`)); };
  const removeLink = async (l) => { if (await confirmDialog({ title: 'Delete this link?', text: 'Whoever has it can no longer open it. The files stay.', confirm: 'Delete', danger: true })) st.setData(await del(`/file-share/links/${l.token}`)); };
  const forward = async () => { try { const r = await post('/file-share/forward'); toast.success(t('Port {port} is forwarded to this PC', { port: r.port })); } catch (e) { toast.error(e); } };
  const addr = (s.addresses[0] || {}).address || '127.0.0.1';
  const linkBase = s.linkBases[0] || location.origin;
  const linkUrl = (l) => `${linkBase}/api/file-share/pub/${l.token}/`;
  const userMenu = (e, u) => contextMenu(e, [{ label: 'Edit', icon: Settings2, onClick: () => setUser(u) }, { label: 'Copy address', icon: Copy, onClick: () => copy(`sftp://${u.name}@${addr}:${s.port}`, 'Address') }, { label: 'Remove', icon: Trash2, danger: true, onClick: () => remove(u) }]);
  const canStart = s.accounts.length || s.team.enabled;
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><FolderUp /> File share</h1>
          <p>Share a folder over SFTP – e.g. so friends can upload worlds, mods or photos. Every user has their own password and folder.</p>
        </div>
        <div className="actions">
          <Btn className="sm ghost" icon={Settings2} onClick={() => setCfg(true)}>Settings</Btn>
          {s.running ? <Btn className="sm" icon={Square} onClick={() => act('stop')}>Stop</Btn> : <Btn className="sm primary" icon={Play} disabled={!canStart} title={canStart ? '' : 'Add a user first'} onClick={() => act('start')}>Start</Btn>}
        </div>
      </div>
      <AddonTabs ext={ext}>
      <div className="card mb"><div className="card-body stack fs-gap">
        <div className="row-tight fs-row"><span className={`badge ${s.running ? 'ok' : ''}`}>{s.running ? 'Running' : 'Off'}</span><span className="small muted">Address for the SFTP program (WinSCP, FileZilla, Cyberduck):</span></div>
        {s.addresses.map((a) => <div key={a.address} className="row-tight fs-row"><Network size={13} className="muted" /><code>sftp://{a.address}:{s.port}</code><span className="tiny muted">{a.name}</span>
          <button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(`sftp://${a.address}:${s.port}`, 'Address')}><Copy size={12} /></button>
          <button type="button" className="btn ghost xs icon" title="Show as QR code" aria-label="Show as QR code" onClick={() => setQr(`sftp://${a.address}:${s.port}`)}><QrCode size={12} /></button></div>)}
        <div className="row-tight fs-row"><Lock size={13} className="muted" /><span className="small muted">Server fingerprint:</span><code className="ellipsis">{s.fingerprint}</code><InfoTip pop title="Fingerprint">On the first connection the SFTP program shows this fingerprint. If it is the same, the connection really goes to this PC.</InfoTip></div>
        {s.network === 'lan' && (s.router
          ? <div className="row-tight fs-row"><Router size={13} className="muted" /><span className="small muted">{t('From outside your home network, port {port} must be forwarded in the router.', { port: s.port })}</span><Btn className="xs" icon={Router} onClick={forward}>Forward port</Btn><InfoTip pop title="Router">Windows may ask once whether Hostwerk may receive connections – allow it for private networks.</InfoTip></div>
          : <Callout kind="info" dismissible>{t('From outside your home network, friends need a forwarding of port {port} in your router (extension “Router & port forwarding”). Windows may ask once whether Hostwerk may receive connections – allow it for private networks.', { port: s.port })}</Callout>)}
        {s.team.enabled && <div className="row-tight fs-row"><Users size={13} className="muted" /><span className="small muted">{t('Team members sign in with their Hostwerk name and password ({n} members).', { n: s.team.members })}</span></div>}
      </div></div>
      <div className="grid grid-2 fs-top">
        <div className="card">
          <div className="card-head"><UserPlus size={16} /><h3>Users</h3><div className="right"><Btn className="sm" icon={UserPlus} onClick={() => setUser(null)}>New user</Btn></div></div>
          {!s.accounts.length ? <Empty icon={UserPlus} title="No user yet" text={t('Add a user with a folder – then start the share and pass on the address sftp://{addr}:{port}.', { addr, port: s.port })} /> : s.accounts.map((u) => (
            <div key={u.name} className="list-item" onContextMenu={(e) => userMenu(e, u)}>
              <div className="grow fs-min0">
                <div className="row-tight fs-row"><b className="mono">{u.name}</b>{u.readOnly ? <span className="badge"><Eye size={11} /> read only</span> : <span className="badge accent">read and write</span>}
                  {u.keys.length > 0 && <span className="badge" title={u.keys.map((k) => `${k.type} ${k.comment}`).join('\n')}><KeyRound size={11} /> {t('{n} SSH keys', { n: u.keys.length })}</span>}
                  {u.expires && <span className={`badge ${u.expired ? 'err' : ''}`}><CalendarClock size={11} /> {u.expired ? 'expired' : t('until {date}', { date: day(u.expires) })}</span>}
                  {u.quotaMB > 0 && <span className="badge"><HardDrive size={11} /> {t('max. {n} MB', { n: u.quotaMB.toLocaleString(locale()) })}</span>}
                  {!u.exists && <span className="badge err">folder missing</span>}</div>
                <div className="small muted ellipsis" title={u.folder}>{u.folder}</div>
              </div>
              <Btn className="xs ghost" onClick={() => setUser(u)}>Edit</Btn>
              <Btn className="xs ghost icon" icon={Trash2} title="Remove" aria-label="Remove" onClick={() => remove(u)} />
            </div>
          ))}
        </div>
        <div className="card">
          <div className="card-head"><LogIn size={16} /><h3>Activity</h3></div>
          {!s.events.length ? <div className="card-body small muted">Sign-ins, uploads and wrong passwords appear here.</div> : (
            <ul className="fs-events">{s.events.map((e, i) => { const E = EVENT[e.type] || EVENT.login; return <li key={i} className={e.type === 'fail' || e.type === 'quota' ? 'c-err' : ''}><E.icon size={13} /><span className="small"><b>{e.user}</b> {E.text}{e.path ? <> <code>{e.path}</code></> : null}</span><span className="tiny muted">{e.ip} · {when(e.t)}</span></li>; })}</ul>
          )}
        </div>
      </div>
      <div className="card fs-links">
        <div className="card-head"><Link2 size={16} /><h3>Download links</h3><InfoTip pop title="Download links">A folder to download in the browser, without an SFTP program – read only. From outside it works through Hostwerk’s remote access.</InfoTip><div className="right"><Btn className="sm" icon={Link2} onClick={() => setLinkForm(true)}>New link</Btn></div></div>
        {!s.linkBases.length && s.links.length > 0 && <div className="card-body"><Callout kind="warn" dismissible={false}>Remote access is off – the links only work on this PC. Turn it on under Live → Remote access.</Callout></div>}
        {!s.links.length ? <div className="card-body small muted">No links yet. A link shows one folder in the browser – handy for photos or a world download.</div> : s.links.map((l) => (
          <div key={l.token} className="list-item">
            <div className="grow fs-min0">
              <div className="row-tight fs-row"><b>{l.label || l.folder.split(/[\\/]/).filter(Boolean).pop()}</b>{l.expires ? <span className={`badge ${l.expired ? 'err' : ''}`}>{l.expired ? 'expired' : t('until {date}', { date: day(l.expires) })}</span> : <span className="badge">no limit</span>}{!l.exists && <span className="badge err">folder missing</span>}</div>
              <div className="small muted ellipsis" title={l.folder}>{l.folder}</div>
            </div>
            <Btn className="xs ghost icon" icon={Copy} title="Copy link" aria-label="Copy link" disabled={l.expired} onClick={() => copy(linkUrl(l), 'Link')} />
            <Btn className="xs ghost icon" icon={QrCode} title="Show as QR code" aria-label="Show as QR code" disabled={l.expired} onClick={() => setQr(linkUrl(l))} />
            <Btn className="xs ghost icon" icon={Trash2} title="Delete" aria-label="Delete" onClick={() => removeLink(l)} />
          </div>
        ))}
      </div>
      </AddonTabs>
      {user !== undefined && <UserForm user={user} s={s} onClose={() => setUser(undefined)} onSaved={(d) => st.setData(d)} />}
      {cfg && <Settings s={s} onClose={() => setCfg(false)} onSaved={(d) => st.setData(d)} />}
      {qr && <QrDialog text={qr} onClose={() => setQr(null)} />}
      {linkForm && <LinkForm onClose={() => setLinkForm(false)} onSaved={(d) => st.setData(d)} />}
    </div>
  );
}

export default {
  pages: { main: FileSharePage },
};

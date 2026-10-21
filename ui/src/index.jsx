import { useEffect, useState } from 'react';
import { FolderUp, Play, Square, UserPlus, Trash2, KeyRound, Copy, Settings2, Lock, Eye, Upload, LogIn, ShieldAlert, Network, QrCode, Router, Link2, Download, Users, AlertTriangle, RotateCcw, CalendarClock, HardDrive, Share2, Check, ChevronRight, ChevronLeft, Monitor, Laptop, Smartphone, AppWindow, Pencil } from 'lucide-react';
import { get, post, put, del, useApi, on } from '@hostwerk/api';
import { Btn, Seg, Field, Modal, Empty, Loading, Callout, InfoTip, PathInput, Switch, toast, confirmDialog } from '@hostwerk/ui';
import { contextMenu } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';
import { AddonTabs } from './addons';
import './style.css';

/*
 * File share (SFTP). 1.3: one clear way in – “Share a folder” as a guided flow (folder → for whom → rights → limits →
 * done with address, QR code and “Copy”), the shares as one calm list (who, what, until when, last used), short
 * connection guides per device, the SFTP state on top. In Hostwerk's file browser (SDK 3.2): right-click a folder →
 * “Share …”, a small mark on shared folders and a section with the shares of the open folder. Without those slots
 * (older Hostwerk) the page works on its own as before.
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
const folderName = (f) => String(f || '').split(/[\\/]/).filter(Boolean).pop() || f;
/** Ordner aus dem Datei-Browser: „<root>|<pfad>“ (root kann selbst „:“ enthalten, z. B. mc:survival) */
const shareHref = (root, rel) => `/ext/file-share?action=share&target=${encodeURIComponent(`${root}|${rel}`)}&at=${Date.now()}`;

/* ---------------- Zugang bearbeiten (bestehende Zugänge) ---------------- */
function UserForm({ user, s, onClose, onSaved }) {
  const [f, setF] = useState({ password: '', keys: user.keys.map((k) => k.line).join('\n'), folder: user.folder, readOnly: user.readOnly, expires: toInputDate(user.expires), quotaMB: user.quotaMB ? String(user.quotaMB) : '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const expires = f.expires ? new Date(`${f.expires}T23:59:59`).getTime() : null;
      onSaved(await put(`/file-share/accounts/${user.name}`, { folder: f.folder, readOnly: f.readOnly, keys: f.keys, expires, quotaMB: Number(f.quotaMB) || 0, ...(f.password ? { password: f.password } : {}) }));
      toast.success(f.password ? 'Saved – pass the password on safely (not in the same message as the address).' : 'Saved');
      onClose();
    } catch (e) { toast.error(e); }
    setBusy(false);
  };
  return (
    <Modal title={t('User {name}', { name: user.name })} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" disabled={!f.folder || busy} onClick={save}>Save</Btn></>}>
      <div className="stack">
        <Field label="Folder this user sees"><PathInput mode="folder" title="Shared folder" value={f.folder} onChange={(v) => setF({ ...f, folder: v })} /></Field>
        <Field label="Rights"><Seg value={f.readOnly ? 'read' : 'write'} onChange={(v) => setF({ ...f, readOnly: v === 'read' })} options={[{ id: 'read', label: 'Read only' }, { id: 'write', label: 'Read and write' }]} /></Field>
        <Field label="New password (empty = keep)">
          <div className="row-tight"><input className="input mono grow" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} aria-label="New password (empty = keep)" /><Btn className="sm" icon={KeyRound} onClick={() => setF({ ...f, password: genPass() })}>New</Btn><Btn className="sm ghost icon" icon={Copy} title="Copy" aria-label="Copy" disabled={!f.password} onClick={() => copy(f.password, 'Password')} /></div>
        </Field>
        <Field label="SSH keys (optional)"><textarea className="input mono fs-keys" rows={3} value={f.keys} onChange={(e) => setF({ ...f, keys: e.target.value })} placeholder="ssh-ed25519 AAAA… lena@laptop" aria-label="SSH keys (optional)" /></Field>
        <div className="grid grid-2">
          <Field label="Valid until (optional)"><input className="input" type="date" value={f.expires} min={toInputDate(Date.now())} onChange={(e) => setF({ ...f, expires: e.target.value })} aria-label="Valid until (optional)" /></Field>
          <Field label="Storage limit in MB (optional)"><input className="input" inputMode="numeric" value={f.quotaMB} onChange={(e) => setF({ ...f, quotaMB: e.target.value.replace(/\D/g, '') })} placeholder="e.g. 2048" aria-label="Storage limit in MB (optional)" /></Field>
        </div>
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

function QrBox({ text }) {
  const [svg, setSvg] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { get(`/file-share/qr?text=${encodeURIComponent(text)}`).then((r) => setSvg(r.svg), (e) => setErr(e.message)); }, [text]);
  if (err) return <Callout kind="err" dismissible={false}>{err}</Callout>;
  return svg ? <div className="fs-qr" role="img" aria-label={t('QR code for {text}', { text })} dangerouslySetInnerHTML={{ __html: svg }} /> : <Loading />;
}
function QrDialog({ text, onClose }) {
  return (
    <Modal title="Connect with the phone" onClose={onClose} footer={<Btn onClick={onClose}>Close</Btn>}>
      <div className="stack fs-qr-wrap"><QrBox text={text} /><code className="fs-qr-text">{text}</code><span className="small muted">Scan with an SFTP app on the phone – the user name and password are entered there.</span></div>
    </Modal>
  );
}

/* ---------------- Geführter Ablauf „Ordner freigeben“ ---------------- */
const STEPS = ['Folder', 'For whom', 'Access', 'Limits', 'Done'];
function ShareWizard({ s, folder: startFolder = '', onClose, onSaved }) {
  const [step, setStep] = useState(startFolder ? 1 : 0);
  const [f, setF] = useState({ folder: startFolder, kind: 'account', name: '', password: genPass(), keys: '', readOnly: true, vault: false, label: '', expires: '', days: '7', quotaMB: '', teamRead: !!s.team.readOnly });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { kind, address | url, password? }
  const addr = (s.addresses[0] || {}).address || '127.0.0.1';
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const kinds = [
    { id: 'account', icon: KeyRound, title: 'Access with password or SSH key', text: 'For SFTP programs and phone apps – read only or also upload.' },
    { id: 'link', icon: Link2, title: 'Download link', text: 'Opens in the browser, read only – no program needed.' },
    ...(s.team.available ? [{ id: 'team', icon: Users, title: 'Team members', text: 'Members sign in with their Hostwerk password and see the folders of their services.' }] : []),
  ];
  const can = [
    !!f.folder,
    !!f.kind,
    f.kind === 'account' ? /^[a-z0-9_.-]{2,32}$/.test(f.name) && (f.password.length >= 10 || f.keys.trim()) : true,
    true,
  ][step];
  const finish = async () => {
    setBusy(true);
    try {
      if (f.kind === 'account') {
        const expires = f.expires ? new Date(`${f.expires}T23:59:59`).getTime() : null;
        onSaved(await post('/file-share/accounts', { name: f.name, folder: f.folder, readOnly: f.readOnly, keys: f.keys, expires, quotaMB: Number(f.quotaMB) || 0, ...(f.password ? { password: f.password } : {}) }));
        if (f.vault && f.password) await toVault(f, s, addr);
        setDone({ kind: 'account', address: `sftp://${f.name}@${addr}:${s.port}`, password: f.password });
      } else if (f.kind === 'link') {
        const before = new Set(s.links.map((l) => l.token));
        const d = await post('/file-share/links', { folder: f.folder, label: f.label, days: Number(f.days) });
        onSaved(d);
        const l = d.links.find((x) => !before.has(x.token));
        const base = d.linkBases[0] || location.origin;
        setDone({ kind: 'link', url: l ? `${base}/api/file-share/pub/${l.token}/` : '', local: !d.linkBases.length });
      } else {
        onSaved(await put('/file-share/settings', { port: s.port, network: s.network, team: { enabled: true, readOnly: f.teamRead } }));
        setDone({ kind: 'team', address: `sftp://${addr}:${s.port}` });
      }
      window.dispatchEvent(new Event('hw:files-marks'));
      setStep(4);
    } catch (e) { toast.error(e); }
    setBusy(false);
  };
  const next = () => (step === 3 ? finish() : setStep(step + (step === 1 && f.kind === 'team' ? 2 : 1)));
  const back = () => setStep(step - (step === 3 && f.kind === 'team' ? 2 : 1));
  const footer = step === 4
    ? <Btn className="primary" onClick={onClose}>Done</Btn>
    : <>{step > 0 && <Btn icon={ChevronLeft} onClick={back}>Back</Btn>}<span className="grow" /><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={step === 3 ? Check : ChevronRight} disabled={!can || busy} onClick={next}>{step === 3 ? 'Share' : 'Next'}</Btn></>;
  return (
    <Modal title="Share a folder" onClose={onClose} footer={footer}>
      <ol className="fs-steps" aria-label={t('Steps')}>{STEPS.map((x, i) => <li key={x} className={i === step ? 'on' : i < step ? 'past' : ''} aria-current={i === step ? 'step' : undefined}>{t(x)}</li>)}</ol>
      {step === 0 && (
        <Field label="Which folder?" hint="Others only see this folder and what is inside – nothing above it."><PathInput mode="folder" title="Shared folder" value={f.folder} onChange={set('folder')} autoFocus /></Field>
      )}
      {step === 1 && (
        <div className="stack">
          <div className="small muted ellipsis" title={f.folder}><FolderUp size={13} /> {f.folder}</div>
          <div className="fs-kinds" role="radiogroup" aria-label={t('For whom')}>
            {kinds.map((k) => (
              <button key={k.id} type="button" role="radio" aria-checked={f.kind === k.id} className={`fs-kind ${f.kind === k.id ? 'on' : ''}`} onClick={() => set('kind')(k.id)}>
                <k.icon size={18} aria-hidden="true" /><span className="fs-kind-text"><b>{k.title}</b><span className="small muted">{k.text}</span></span>
              </button>
            ))}
          </div>
        </div>
      )}
      {step === 2 && f.kind === 'account' && (
        <div className="stack">
          <Field label="User name"><input className="input mono" value={f.name} onChange={(e) => set('name')(e.target.value.toLowerCase())} placeholder="e.g. lena" aria-label="User name" autoFocus /></Field>
          <Field label="Rights"><Seg value={f.readOnly ? 'read' : 'write'} onChange={(v) => set('readOnly')(v === 'read')} options={[{ id: 'read', label: 'Read only' }, { id: 'write', label: 'Read and write' }]} /></Field>
          <Field label="Password">
            <div className="row-tight"><input className="input mono grow" value={f.password} onChange={(e) => set('password')(e.target.value)} aria-label="Password" /><Btn className="sm" icon={KeyRound} onClick={() => set('password')(genPass())}>New</Btn><InfoTip pop title="Password">At least 10 characters. Hostwerk only keeps a hash – copy it now, it cannot be shown again later.</InfoTip></div>
          </Field>
          {s.passwords && <label className="check"><Switch checked={f.vault} onChange={set('vault')} /> Also store the password in the password vault</label>}
          <details className="fs-more"><summary className="small">SSH keys (optional)</summary>
            <textarea className="input mono fs-keys" rows={3} value={f.keys} onChange={(e) => set('keys')(e.target.value)} placeholder="ssh-ed25519 AAAA… lena@laptop" aria-label="SSH keys (optional)" />
          </details>
        </div>
      )}
      {step === 2 && f.kind === 'link' && (
        <div className="stack">
          <Field label="Name (optional)"><input className="input" value={f.label} onChange={(e) => set('label')(e.target.value)} placeholder="e.g. Holiday photos" autoFocus /></Field>
          <div className="small muted"><Eye size={13} /> {t('Read only – everyone with the link can see and download, nothing can be changed.')}</div>
        </div>
      )}
      {step === 3 && f.kind === 'account' && (
        <div className="grid grid-2">
          <Field label="Valid until (optional)"><input className="input" type="date" value={f.expires} min={toInputDate(Date.now())} onChange={(e) => set('expires')(e.target.value)} aria-label="Valid until (optional)" /></Field>
          <Field label="Storage limit in MB (optional)"><input className="input" inputMode="numeric" value={f.quotaMB} disabled={f.readOnly} onChange={(e) => set('quotaMB')(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 2048" aria-label="Storage limit in MB (optional)" /></Field>
        </div>
      )}
      {step === 3 && f.kind === 'link' && (
        <Field label="Valid for"><Seg value={f.days} onChange={set('days')} options={[{ id: '1', label: '1 day' }, { id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '0', label: 'No limit' }]} /></Field>
      )}
      {step === 3 && f.kind === 'team' && (
        <div className="stack">
          <label className="check"><Switch checked={f.teamRead} onChange={set('teamRead')} /> Team members only read</label>
          <span className="small muted">Team members see one folder per service they may use – not the folder chosen above.</span>
        </div>
      )}
      {step === 4 && done && <Finished done={done} s={s} />}
    </Modal>
  );
}
async function toVault(f, s, addr) {
  try {
    const pw = await get('/pw');
    const v = (pw.instances || []).find((x) => x.id === pw.defaultId) || (pw.instances || [])[0];
    if (!v) toast.error('No password vault yet – set one up under Passwords.');
    else if (v.locked) toast.error('Unlock the password vault first – the password was not stored.');
    else { await post(`/pw/${v.id}/items`, { type: 'login', name: `SFTP ${f.name}`, username: f.name, password: f.password, urls: [`sftp://${addr}:${s.port}`], notes: t('Folder: {folder}', { folder: f.folder }) }); toast.success('Password stored in the vault'); }
  } catch (e) { toast.error(e); }
}
function Finished({ done, s }) {
  const text = done.kind === 'link' ? done.url : done.address;
  return (
    <div className="stack fs-done">
      <div className="row-tight"><Check size={18} className="c-ok" aria-hidden="true" /><b>{done.kind === 'link' ? 'Link ready' : done.kind === 'team' ? 'Team members may sign in' : 'Access ready'}</b></div>
      <div className="row-tight fs-row"><code className="grow fs-qr-text">{text}</code><Btn className="sm" icon={Copy} onClick={() => copy(text, done.kind === 'link' ? 'Link' : 'Address')}>Copy</Btn></div>
      {done.password && <div className="row-tight fs-row"><span className="small muted">{t('Password')}:</span><code className="grow">{done.password}</code><Btn className="sm ghost" icon={Copy} onClick={() => copy(done.password, 'Password')}>Copy</Btn></div>}
      <div className="fs-qr-wrap"><QrBox text={text} /></div>
      {done.password && <Callout kind="info" dismissible={false}>Pass the password on separately – not in the same message as the address.</Callout>}
      {done.local && <Callout kind="warn" dismissible={false}>Remote access is off – the links only work on this PC. Turn it on under Live → Remote access.</Callout>}
      {!s.running && done.kind !== 'link' && <Callout kind="info" dismissible={false}>The SFTP server is still off – start it on the page so others can connect.</Callout>}
    </div>
  );
}

/* ---------------- So verbinden sich andere ---------------- */
const GUIDES = {
  windows: { icon: Monitor, label: 'Windows', steps: ['Install WinSCP (free).', 'New site: protocol SFTP, host, port, user name and password from the share.', 'On the first connection compare the fingerprint, then accept.'], info: 'Windows Explorer cannot open SFTP on its own. With SSHFS-Win the folder also appears as a drive letter.' },
  mac: { icon: Laptop, label: 'macOS', steps: ['Install Cyberduck (free).', 'Open connection → SFTP, host, port, user name and password.', 'Compare the fingerprint on the first connection.'], info: 'The Finder’s “Connect to server” does not speak SFTP – Cyberduck or Transmit do, and can show the folder in the Finder.' },
  phone: { icon: Smartphone, label: 'Phone', steps: ['Android: Material Files or Solid Explorer · iPhone: FE File Explorer or Secure ShellFish.', 'Add an SFTP server – or scan the QR code of the address.', 'Enter user name and password in the app.'], info: 'The iPhone “Files” app does not speak SFTP on its own; apps like Secure ShellFish add it there.' },
  filezilla: { icon: AppWindow, label: 'FileZilla', steps: ['File → Site Manager → New site.', 'Protocol “SFTP – SSH File Transfer Protocol”, host, port, user name and password.', 'Connect and compare the fingerprint.'], info: 'Download FileZilla only from filezilla-project.org – other sites bundle extra software.' },
};
function ConnectGuide() {
  const [cur, setCur] = useState('windows');
  const g = GUIDES[cur];
  return (
    <div className="card">
      <div className="card-head"><Network size={16} /><h3>How others connect</h3><InfoTip pop title="How others connect">{g.info}</InfoTip></div>
      <div className="card-body stack">
        <Seg value={cur} onChange={setCur} options={Object.entries(GUIDES).map(([id, x]) => ({ id, label: x.label, icon: x.icon }))} />
        <ol className="fs-guide">{g.steps.map((x) => <li key={x} className="small">{t(x)}</li>)}</ol>
      </div>
    </div>
  );
}

/* ---------------- Seite ---------------- */
function FileSharePage({ ext, query }) {
  const st = useApi('/file-share', [], { live: false });
  const [user, setUser] = useState(null);
  const [cfg, setCfg] = useState(false);
  const [qr, setQr] = useState(null);
  const [wizard, setWizard] = useState(null); // { folder }
  const s = st.data;
  useEffect(() => on('file-share', () => st.reload({ silent: true })), [st.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  // Aus dem Datei-Browser: ?action=share&target=<root>|<pfad> → Ablauf mit vorgewähltem Ordner
  useEffect(() => {
    const q = new URLSearchParams(String(query || '').replace(/^\?/, ''));
    if (q.get('action') !== 'share') return;
    const target = q.get('target') || '';
    const i = target.lastIndexOf('|');
    if (i < 0) { setWizard({ folder: '' }); return; }
    get(`/file-share/resolve?root=${encodeURIComponent(target.slice(0, i))}&path=${encodeURIComponent(target.slice(i + 1))}`).then((r) => setWizard({ folder: r.full }), () => setWizard({ folder: '' }));
  }, [query]);
  if (!s) return st.error ? <div className="page"><Empty icon={AlertTriangle} title="The file share could not be loaded" text={st.error} action={<Btn icon={RotateCcw} onClick={() => st.reload()}>Try again</Btn>} /></div> : <Loading />;
  const act = async (p) => { try { st.setData(await post(`/file-share/${p}`)); } catch (e) { toast.error(e); } };
  const removeUser = async (u) => { if (await confirmDialog({ title: t('Remove the user “{name}”?', { name: u.name }), text: 'The folder and its files stay.', confirm: 'Remove', danger: true })) { st.setData(await del(`/file-share/accounts/${u.name}`)); window.dispatchEvent(new Event('hw:files-marks')); } };
  const removeLink = async (l) => { if (await confirmDialog({ title: 'Delete this link?', text: 'Whoever has it can no longer open it. The files stay.', confirm: 'Delete', danger: true })) { st.setData(await del(`/file-share/links/${l.token}`)); window.dispatchEvent(new Event('hw:files-marks')); } };
  const forward = async () => { try { const r = await post('/file-share/forward'); toast.success(t('Port {port} is forwarded to this PC', { port: r.port })); } catch (e) { toast.error(e); } };
  const addr = (s.addresses[0] || {}).address || '127.0.0.1';
  const linkBase = s.linkBases[0] || location.origin;
  const linkUrl = (l) => `${linkBase}/api/file-share/pub/${l.token}/`;
  const canStart = s.accounts.length || s.team.enabled;
  const rows = [
    ...s.accounts.map((u) => ({ key: `u:${u.name}`, kind: 'account', who: u.name, folder: u.folder, readOnly: u.readOnly, expires: u.expires, expired: u.expired, last: u.last, missing: !u.exists, u, link: `sftp://${u.name}@${addr}:${s.port}` })),
    ...s.links.map((l) => ({ key: `l:${l.token}`, kind: 'link', who: l.label || folderName(l.folder), folder: l.folder, readOnly: true, expires: l.expires, expired: l.expired, last: l.last, missing: !l.exists, l, link: linkUrl(l) })),
  ];
  const menu = (e, r) => contextMenu(e, [
    { label: r.kind === 'link' ? 'Copy link' : 'Copy address', icon: Copy, disabled: r.expired, onClick: () => copy(r.link, r.kind === 'link' ? 'Link' : 'Address') },
    { label: 'Show as QR code', icon: QrCode, disabled: r.expired, onClick: () => setQr(r.link) },
    r.kind === 'account' && { label: 'Edit', icon: Pencil, onClick: () => setUser(r.u) },
    '-',
    { label: r.kind === 'link' ? 'Delete' : 'Remove', icon: Trash2, danger: true, onClick: () => (r.kind === 'link' ? removeLink(r.l) : removeUser(r.u)) },
  ]);
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><FolderUp /> File share</h1>
          <p>Share a folder over SFTP or as a download link – for worlds, mods or photos.</p>
        </div>
        <div className="actions">
          <Btn className="sm ghost" icon={Settings2} onClick={() => setCfg(true)}>Settings</Btn>
          <Btn className="sm primary" icon={Share2} onClick={() => setWizard({ folder: '' })}>Share a folder</Btn>
        </div>
      </div>
      <AddonTabs ext={ext}>
      <div className={`card mb fs-status ${s.running ? 'is-on' : ''}`}><div className="card-body stack fs-gap">
        <div className="row-tight fs-row">
          <span className={`fs-dot ${s.running ? 'on' : ''}`} aria-hidden="true" /><b>{s.running ? 'SFTP server is running' : 'SFTP server is off'}</b>
          <span className="small muted">{s.running ? t('Port {port} · {where}', { port: s.port, where: t(s.network === 'local' ? 'only this PC' : 'home network') }) : canStart ? 'Download links work anyway.' : 'Share a folder first – then start it here.'}</span>
          <span className="grow" />
          {s.running ? <Btn className="sm" icon={Square} onClick={() => act('stop')}>Stop</Btn> : <Btn className="sm primary" icon={Play} disabled={!canStart} title={canStart ? '' : 'Share a folder first'} onClick={() => act('start')}>Start</Btn>}
        </div>
        {s.addresses.map((a) => <div key={a.address} className="row-tight fs-row"><Network size={13} className="muted" aria-hidden="true" /><code>sftp://{a.address}:{s.port}</code><span className="tiny muted">{a.name}</span>
          <button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(`sftp://${a.address}:${s.port}`, 'Address')}><Copy size={12} /></button>
          <button type="button" className="btn ghost xs icon" title="Show as QR code" aria-label="Show as QR code" onClick={() => setQr(`sftp://${a.address}:${s.port}`)}><QrCode size={12} /></button></div>)}
        <div className="row-tight fs-row"><Lock size={13} className="muted" aria-hidden="true" /><span className="small muted">Server fingerprint</span><code className="ellipsis fs-min0">{s.fingerprint}</code><InfoTip pop title="Fingerprint">On the first connection the SFTP program shows this fingerprint. If it is the same, the connection really goes to this PC.</InfoTip></div>
        {s.network === 'lan' && (s.router
          ? <div className="row-tight fs-row"><Router size={13} className="muted" aria-hidden="true" /><span className="small muted">{t('From outside: forward port {port} in the router.', { port: s.port })}</span><Btn className="xs" icon={Router} onClick={forward}>Forward port</Btn><InfoTip pop title="Router">Windows may ask once whether Hostwerk may receive connections – allow it for private networks.</InfoTip></div>
          : <div className="row-tight fs-row"><Router size={13} className="muted" aria-hidden="true" /><span className="small muted">{t('From outside: forward port {port} in the router.', { port: s.port })}</span><InfoTip pop title="Router">{t('The extension “Router & port forwarding” does it with one click. Windows may ask once whether Hostwerk may receive connections – allow it for private networks.')}</InfoTip></div>)}
        {s.team.enabled && <div className="row-tight fs-row"><Users size={13} className="muted" aria-hidden="true" /><span className="small muted">{t('Team members sign in with their Hostwerk name and password ({n} members).', { n: s.team.members })}</span></div>}
      </div></div>
      <div className="card mb">
        <div className="card-head"><Share2 size={16} /><h3>Shares</h3><span className="badge">{rows.length}</span></div>
        {!rows.length ? <Empty icon={Share2} title="Nothing shared yet" text="Pick a folder and decide who gets it – an access for SFTP programs or a download link." action={<Btn className="primary" icon={Share2} onClick={() => setWizard({ folder: '' })}>Share a folder</Btn>} /> : (
          <ul className="fs-shares">{rows.map((r) => (
            <li key={r.key} className={`fs-share ${r.expired ? 'is-old' : ''}`} onContextMenu={(e) => menu(e, r)}>
              {r.kind === 'link' ? <Link2 size={16} className="muted" aria-hidden="true" /> : <KeyRound size={16} className="muted" aria-hidden="true" />}
              <div className="grow fs-min0">
                <div className="row-tight fs-row"><b className={r.kind === 'account' ? 'mono' : ''}>{r.who}</b><span className="small muted">{r.kind === 'link' ? t('download link') : r.readOnly ? t('reads') : t('reads and writes')}</span>
                  {r.missing && <span className="badge err">folder missing</span>}</div>
                <div className="small muted ellipsis" title={r.folder}>{r.folder}</div>
                <div className="tiny muted">{r.expired ? t('expired') : r.expires ? t('until {date}', { date: day(r.expires) }) : t('no end date')} · {r.last ? t('last used {when}', { when: when(r.last) }) : t('not used yet')}{r.kind === 'account' && r.u.quotaMB > 0 ? ` · ${t('max. {n} MB', { n: r.u.quotaMB.toLocaleString(locale()) })}` : ''}</div>
              </div>
              <Btn className="xs ghost icon" icon={Copy} title={r.kind === 'link' ? 'Copy link' : 'Copy address'} aria-label={r.kind === 'link' ? 'Copy link' : 'Copy address'} disabled={r.expired} onClick={() => copy(r.link, r.kind === 'link' ? 'Link' : 'Address')} />
              <Btn className="xs ghost icon" icon={QrCode} title="Show as QR code" aria-label="Show as QR code" disabled={r.expired} onClick={() => setQr(r.link)} />
              {r.kind === 'account' && <Btn className="xs ghost icon" icon={Pencil} title="Edit" aria-label="Edit" onClick={() => setUser(r.u)} />}
              <Btn className="xs ghost icon" icon={Trash2} title="Remove" aria-label="Remove" onClick={() => (r.kind === 'link' ? removeLink(r.l) : removeUser(r.u))} />
            </li>
          ))}</ul>
        )}
      </div>
      <div className="grid grid-2 fs-top">
        <ConnectGuide />
        <div className="card">
          <div className="card-head"><LogIn size={16} /><h3>Activity</h3></div>
          {!s.events.length ? <div className="card-body small muted">Sign-ins, uploads and wrong passwords appear here.</div> : (
            <ul className="fs-events">{s.events.map((e, i) => { const E = EVENT[e.type] || EVENT.login; return <li key={i} className={e.type === 'fail' || e.type === 'quota' ? 'c-err' : ''}><E.icon size={13} aria-hidden="true" /><span className="small"><b>{e.user}</b> {t(E.text)}{e.path ? <> <code>{e.path}</code></> : null}</span><span className="tiny muted">{e.ip} · {when(e.t)}</span></li>; })}</ul>
          )}
        </div>
      </div>
      </AddonTabs>
      {user && <UserForm user={user} s={s} onClose={() => setUser(null)} onSaved={(d) => st.setData(d)} />}
      {cfg && <Settings s={s} onClose={() => setCfg(false)} onSaved={(d) => st.setData(d)} />}
      {qr && <QrDialog text={qr} onClose={() => setQr(null)} />}
      {wizard && <ShareWizard s={s} folder={wizard.folder} onClose={() => { setWizard(null); st.reload({ silent: true }); }} onSaved={(d) => st.setData(d)} />}
    </div>
  );
}

/* ---------------- Datei-Browser (Hostwerk mit SDK 3.2) ---------------- */
const selfCache = new Map(); // "<root>|<pfad>" → Freigaben genau dieses Ordners (aus der letzten Abfrage)
function FolderShares({ ctx }) {
  const key = `${ctx.root}|${ctx.path}`;
  const [list, setList] = useState(selfCache.get(key) || null);
  useEffect(() => {
    let alive = true;
    get(`/file-share/marks?root=${encodeURIComponent(ctx.root)}&path=${encodeURIComponent(ctx.path)}`).then((r) => { selfCache.set(key, r.self); if (alive) setList(r.self); }, () => alive && setList([]));
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return <Loading />;
  return (
    <div className="card-body stack fs-folder">
      {list.length === 0 ? <span className="small muted">Not shared.</span> : list.map((x) => (
        <div key={`${x.kind}:${x.name}`} className="row-tight fs-row">
          {x.kind === 'link' ? <Link2 size={14} className="muted" aria-hidden="true" /> : <KeyRound size={14} className="muted" aria-hidden="true" />}
          <b className={x.kind === 'account' ? 'mono' : ''}>{x.name}</b>
          <span className="small muted">{x.kind === 'link' ? t('download link') : x.readOnly ? t('reads') : t('reads and writes')}</span>
          <span className="tiny muted">{x.expired ? t('expired') : x.expires ? t('until {date}', { date: day(x.expires) }) : ''}{x.last ? ` · ${t('last used {when}', { when: when(x.last) })}` : ''}</span>
        </div>
      ))}
      <div className="row-tight"><a className="btn sm" href={`#${shareHref(ctx.root, ctx.path)}`}><Share2 size={13} />{t('Share …')}</a><a className="btn sm ghost" href="#/ext/file-share">{t('Manage shares')}</a></div>
    </div>
  );
}

export default {
  pages: { main: FileSharePage },
  slots: {
    // Rechtsklick auf einen Ordner (oder die freie Fläche = offener Ordner): geführter Ablauf mit diesem Ordner
    'files.actions': [{ id: 'share', title: 'Share …', icon: Share2, when: (e) => e.dir, run: (e) => { location.hash = shareHref(e.root, e.path); } }],
    // Kleines Zeichen an freigegebenen Ordnern, Tooltip „freigegeben für …“
    'files.marks': [{
      id: 'shared', title: 'Shared', icon: Share2,
      marks: async ({ root, path }) => {
        const r = await get(`/file-share/marks?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
        selfCache.set(`${root}|${path}`, r.self || []);
        return Object.fromEntries(Object.entries(r.children || {}).map(([name, m]) => [name, { title: t('Shared with {who}', { who: [...m.users, ...(m.links ? [t('{n} download links', { n: m.links })] : [])].join(', ') }) }]));
      },
    }],
  },
  // Abschnitt rechts im Datei-Browser, solange der offene Ordner freigegeben ist
  sections: { 'files.folder': [{ id: 'shares', title: 'Shares of this folder', icon: Share2, when: (ctx) => (selfCache.get(`${ctx.root}|${ctx.path}`) || []).length > 0, Component: FolderShares }] },
};

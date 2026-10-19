import { useEffect, useState } from 'react';
import { FolderUp, Play, Square, UserPlus, Trash2, KeyRound, Copy, Settings2, Lock, Eye, Upload, LogIn, ShieldAlert, Network } from 'lucide-react';
import { post, put, del, useApi, on } from '@hostwerk/api';
import { Btn, Seg, Field, Modal, Empty, Loading, Callout, InfoTip, PathInput, Switch, toast, confirmDialog } from '@hostwerk/ui';
import './style.css';

/*
 * File share (SFTP): server on/off with the address to hand out, users with their own folder, recent activity.
 * Texts are English; German comes from locales/de.json (also inside JSX).
 */
const genPass = () => { const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = new Uint32Array(16); crypto.getRandomValues(b); return [...b].map((x) => a[x % a.length]).join(''); };
const copy = async (t, what) => { try { await navigator.clipboard.writeText(t); toast.success(`${what} copied`); } catch { toast.error('Could not copy'); } };
const EVENT = { login: { icon: LogIn, text: 'signed in' }, fail: { icon: ShieldAlert, text: 'wrong password' }, upload: { icon: Upload, text: 'uploaded' }, delete: { icon: Trash2, text: 'deleted' } };

function UserForm({ user, onClose, onSaved }) {
  const isNew = !user;
  const [f, setF] = useState({ name: user ? user.name : '', password: isNew ? genPass() : '', folder: user ? user.folder : '', readOnly: user ? user.readOnly : false });
  const save = async () => {
    try {
      const r = isNew ? await post('/file-share/accounts', f) : await put(`/file-share/accounts/${user.name}`, { folder: f.folder, readOnly: f.readOnly, ...(f.password ? { password: f.password } : {}) });
      onSaved(r);
      if (f.password) toast.success('Saved – pass the password on safely (not in the same message as the address).'); else toast.success('Saved');
      onClose();
    } catch (e) { toast.error(e); }
  };
  return (
    <Modal title={isNew ? 'New user' : `User ${user.name}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" disabled={!f.name || !f.folder || (isNew && !f.password)} onClick={save}>Save</Btn></>}>
      <div className="stack">
        <Field label="User name" hint="small letters, digits, _ . -"><input className="input mono" value={f.name} disabled={!isNew} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} placeholder="e.g. lena" /></Field>
        <Field label={isNew ? 'Password' : 'New password (empty = keep)'} hint="At least 10 characters. Hostwerk only keeps a hash – it cannot show the password again.">
          <div className="row-tight"><input className="input mono grow" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /><Btn className="sm" icon={KeyRound} onClick={() => setF({ ...f, password: genPass() })}>New</Btn><Btn className="sm ghost icon" icon={Copy} title="Copy" aria-label="Copy" disabled={!f.password} onClick={() => copy(f.password, 'Password')} /></div>
        </Field>
        <Field label="Folder this user sees" hint="The user cannot go above it."><PathInput mode="folder" title="Shared folder" value={f.folder} onChange={(v) => setF({ ...f, folder: v })} /></Field>
        <label className="check"><Switch checked={f.readOnly} onChange={(v) => setF({ ...f, readOnly: v })} /> Read only (download, no upload or delete)</label>
      </div>
    </Modal>
  );
}

function Settings({ s, onClose, onSaved }) {
  const [port, setPort] = useState(String(s.port));
  const [network, setNetwork] = useState(s.network);
  const save = async () => { try { onSaved(await put('/file-share/settings', { port: Number(port), network })); onClose(); } catch (e) { toast.error(e); } };
  return (
    <Modal title="Share settings" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" onClick={save}>Save</Btn></>}>
      <div className="stack">
        <Field label="Port" hint="Standard for SFTP is 22 – Hostwerk uses 2222 so it does not collide with an SSH server."><input className="input" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} /></Field>
        <Field label="Who can connect?"><Seg options={[{ id: 'lan', label: 'Home network (and the internet through a router forwarding)' }, { id: 'local', label: 'Only this PC' }]} value={network} onChange={setNetwork} /></Field>
      </div>
    </Modal>
  );
}

function FileSharePage() {
  const st = useApi('/file-share', [], { live: false });
  const [user, setUser] = useState(undefined);
  const [cfg, setCfg] = useState(false);
  const s = st.data;
  useEffect(() => on('file-share', () => st.reload({ silent: true })), [st.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <Loading />;
  const act = async (p) => { try { st.setData(await post(`/file-share/${p}`)); } catch (e) { toast.error(e); } };
  const remove = async (u) => { if (await confirmDialog({ title: `Remove the user “${u.name}”?`, text: 'The folder and its files stay.', confirm: 'Remove', danger: true })) st.setData(await del(`/file-share/accounts/${u.name}`)); };
  const addr = (s.addresses[0] || {}).address || '127.0.0.1';
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><FolderUp /> File share</h1>
          <p>Share a folder over SFTP – e.g. so friends can upload worlds, mods or photos. Every user has their own password and folder.</p>
        </div>
        <div className="actions">
          <Btn className="sm ghost" icon={Settings2} onClick={() => setCfg(true)}>Settings</Btn>
          {s.running ? <Btn className="sm" icon={Square} onClick={() => act('stop')}>Stop</Btn> : <Btn className="sm primary" icon={Play} disabled={!s.accounts.length} title={s.accounts.length ? '' : 'Add a user first'} onClick={() => act('start')}>Start</Btn>}
        </div>
      </div>
      <div className="card mb"><div className="card-body stack" style={{ gap: 10 }}>
        <div className="row-tight fs-row"><span className={`badge ${s.running ? 'ok' : ''}`}>{s.running ? 'Running' : 'Off'}</span><span className="small muted">Address for the SFTP program (WinSCP, FileZilla, Cyberduck):</span></div>
        {s.addresses.map((a) => <div key={a.address} className="row-tight fs-row"><Network size={13} className="muted" /><code>sftp://{a.address}:{s.port}</code><span className="tiny muted">{a.name}</span><button type="button" className="btn ghost xs icon" title="Copy" aria-label="Copy" onClick={() => copy(`sftp://${a.address}:${s.port}`, 'Address')}><Copy size={12} /></button></div>)}
        <div className="row-tight fs-row"><Lock size={13} className="muted" /><span className="small muted">Server fingerprint:</span><code className="ellipsis">{s.fingerprint}</code><InfoTip pop title="Fingerprint">On the first connection the SFTP program shows this fingerprint. If it is the same, the connection really goes to this PC.</InfoTip></div>
        {s.network === 'lan' && <Callout kind="info" dismissible>{`From outside your home network, friends need a forwarding of port ${s.port} in your router (extension “Router & port forwarding”). Windows may ask once whether Hostwerk may receive connections – allow it for private networks.`}</Callout>}
      </div></div>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-head"><UserPlus size={16} /><h3>Users</h3><div className="right"><Btn className="sm" icon={UserPlus} onClick={() => setUser(null)}>New user</Btn></div></div>
          {!s.accounts.length ? <Empty icon={UserPlus} title="No user yet" text={`Add a user with a folder – then start the share and pass on the address sftp://${addr}:${s.port}.`} /> : s.accounts.map((u) => (
            <div key={u.name} className="list-item">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row-tight"><b className="mono">{u.name}</b>{u.readOnly ? <span className="badge"><Eye size={11} /> read only</span> : <span className="badge accent">read and write</span>}{!u.exists && <span className="badge err">folder missing</span>}</div>
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
            <ul className="fs-events">{s.events.map((e, i) => { const E = EVENT[e.type] || EVENT.login; return <li key={i} className={e.type === 'fail' ? 'c-err' : ''}><E.icon size={13} /><span className="small"><b>{e.user}</b> {E.text}{e.path ? <> <code>{e.path}</code></> : null}</span><span className="tiny muted">{e.ip} · {new Date(e.t).toLocaleString()}</span></li>; })}</ul>
          )}
        </div>
      </div>
      {user !== undefined && <UserForm user={user} onClose={() => setUser(undefined)} onSaved={(d) => st.setData(d)} />}
      {cfg && <Settings s={s} onClose={() => setCfg(false)} onSaved={(d) => st.setData(d)} />}
    </div>
  );
}

export default {
  pages: { main: FileSharePage },
};

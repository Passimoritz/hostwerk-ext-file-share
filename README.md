![File share (SFTP)](banner.svg)

# File share (SFTP)

Share a folder over SFTP – e.g. so friends can upload worlds, mods or photos. Every user with their own password and folder, read-only if you like; lock-out after wrong passwords and a log of sign-ins and uploads.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (SDK 2.7, native extension)

![Screenshot](docs/screenshot.png)

## What it does

- **“Share a folder” as a guided flow:** folder → for whom (access with password or SSH key, download link, team members) → rights (read only / read and write) → expiry and storage limit → done with address, QR code and “Copy”
- **Shares as one calm list:** who, which folder, rights, until when, last used – copy, QR code, edit and remove right there (also with right-click)
- **How others connect** – short steps for Windows, macOS, phone and FileZilla, details behind ⓘ; the SFTP state with start/stop on top
- **In Hostwerk’s file browser** (Hostwerk with SDK 3.2): right-click a folder → “Share …” opens the flow with that folder, shared folders get a small mark with “Shared with …”, and the open folder shows its shares on the right. Older Hostwerk: the page works on its own
- SFTP server built into Hostwerk – works with WinSCP, FileZilla, Cyberduck and every phone app
- Users with their own password (stored only as scrypt hash) and their own folder; nobody gets above it, links pointing outside are refused
- Read-only users for downloads
- **SSH keys** per user – sign in without a password
- **Time-limited users** (valid until a day) and a **storage limit** per user – handy for guests
- **Team members** (extension “Team & users”) sign in with their Hostwerk password and see one folder per service shared with them
- **Download links:** a folder read-only in the browser, without an SFTP program – from outside through Hostwerk’s remote access; 1, 7, 30 days or without limit
- **Forward port** with one click through the extension “Router & port forwarding” – shown there as coming from the file share, kept by the automatic mode and moved along when you change the port
- **Password vault:** new users go straight into the vault of “Passwords” if you like
- Address as **QR code** for SFTP apps on the phone
- Lock-out for 10 minutes after 5 wrong passwords per address; password checks never block Hostwerk (checked in the background, one at a time per address); activity log
- Own server key with fingerprint to compare; home network only or this PC only
- Other extensions may add tabs to its page (`allowExtensions`)

## Install

In Hostwerk: **Extensions → Discover** and click “Install”.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data

`data/file-share` – settings, users (password hashes and public keys only), download links, activity and the server key. Removing the extension keeps them; the shared folders are never touched.

## Develop

```bash
node --test tests/*.test.js          # tests
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
```

Interface source in `ui/src`, server part in `server/`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT

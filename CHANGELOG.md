## 1.3.0

- New interface: “Share a folder” as a guided flow (folder, for whom, rights, limits, done with address, QR code and “Copy”), the shares as one list with last use, short connection guides per device, the SFTP state on top. / Neue Oberfläche: „Ordner freigeben“ als geführter Ablauf, Freigaben als eine Liste mit „zuletzt benutzt“, kurze Verbindungs-Anleitungen je Gerät, Zustand des SFTP-Servers oben.
- In Hostwerk’s file browser (SDK 3.2): right-click “Share …” on folders, a mark on shared folders, the shares of the open folder as a section. / Im Datei-Browser: Rechtsklick „Freigeben …“, Zeichen an freigegebenen Ordnern, Freigaben des offenen Ordners als Abschnitt.

## 1.2.0

- “Forward port” registers the forwarding as belonging to the file share (`router.forwards`, Router & port forwarding 1.2): the router page shows where it comes from, the automatic mode keeps it, and a new port takes the forwarding along. With an older router extension it works as before. / „Port freigeben“ meldet die Freigabe mit Besitzer an (`router.forwards`): Herkunft sichtbar, Automatik behält sie, neuer Port nimmt sie mit; ältere Router-Erweiterung wie bisher.

## 1.1.0

- Password checks no longer block Hostwerk (async scrypt, one check at a time per address). / Passwortprüfungen blockieren Hostwerk nicht mehr (asynchrones scrypt, je Adresse eine Prüfung gleichzeitig).
- SSH keys per user. / SSH-Schlüssel je Zugang.
- Time-limited users and a storage limit per user. / Befristete Zugänge und Speichergrenze je Zugang.
- Team members sign in with their Hostwerk password and see the folders of their services. / Team-Mitglieder melden sich mit ihrem Hostwerk-Passwort an und sehen die Ordner ihrer Dienste.
- Download links: a folder read-only in the browser, also through remote access. / Download-Links: ein Ordner nur lesend im Browser, auch über den Fernzugriff.
- “Forward port” button through “Router & port forwarding”; store new passwords in the vault of “Passwords”; address as QR code. / Knopf „Port freigeben“ über „Router & Portfreigaben“; neue Passwörter im Tresor von „Passwörter“ ablegen; Adresse als QR-Code.
- Error state with “Try again”, date and time in Hostwerk's language, design scale instead of fixed pixels, right-click menu on users. / Fehlerzustand mit „Erneut versuchen“, Datum und Uhrzeit in Hostwerks Sprache, Design-Skala statt fester Pixel, Rechtsklick-Menü bei Zugängen.
- Sidebar group “Server” (`page.nav`), synergies, other extensions may add tabs (`allowExtensions`, shown by the page itself). / Seitenleisten-Gruppe „Server“ (`page.nav`), Synergien, andere Erweiterungen dürfen Reiter ergänzen (`allowExtensions`, die Seite zeigt sie selbst).
- Release package contains everything except the repository tooling. / Release-Paket enthält alles außer dem Repo-Werkzeug.

## 1.0.1

- Same symbol in the sidebar and in the page header (with Hostwerk 2.11 or newer). / Gleiches Symbol in der Seitenleiste und im Seitenkopf (ab Hostwerk 2.11).

## 1.0.0

- First release. / Erste Fassung.

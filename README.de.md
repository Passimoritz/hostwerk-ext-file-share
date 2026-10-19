![Dateifreigabe (SFTP)](banner.svg)

# Dateifreigabe (SFTP)

Einen Ordner per SFTP freigeben – z. B. damit Freunde Welten, Mods oder Fotos hochladen. Jeder Zugang mit eigenem Passwort und eigenem Ordner, auf Wunsch nur lesend; Sperre nach falschen Passwörtern und ein Protokoll aller Anmeldungen und Uploads.

[English](README.md) · Eine offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public) Erweiterung (SDK 2.7, native Erweiterung)

![Screenshot](docs/screenshot.de.png)

## Was sie kann

- SFTP-Server in Hostwerk – funktioniert mit WinSCP, FileZilla, Cyberduck und jeder Handy-App
- Zugänge mit eigenem Passwort (nur als scrypt-Hash gespeichert) und eigenem Ordner; niemand kommt darüber hinaus, Verknüpfungen nach draußen werden abgelehnt
- Nur-Lese-Zugänge zum Herunterladen
- Sperre für 10 Minuten nach 5 falschen Passwörtern je Adresse; Protokoll
- Eigener Server-Schlüssel mit Fingerabdruck zum Abgleichen; Heimnetz oder nur dieser PC

## Installieren

In Hostwerk: **Erweiterungen → Entdecken** und „Installieren“ klicken.

Native Erweiterungen laufen als Teil von Hostwerk (eigener Server- und Oberflächen-Teil). Deshalb installiert Hostwerk sie nur aus dem offiziellen Katalog (mit Prüfsumme) oder im Entwickler-Modus.

## Daten

`data/file-share` – Einstellungen, Zugänge (nur Passwort-Hashes), Protokoll und der Server-Schlüssel. Beim Entfernen der Erweiterung bleibt das erhalten; die freigegebenen Ordner werden nie angefasst.

## Entwickeln

```bash
node --test tests/*.test.js          # Tests
node build-native.js .               # Oberfläche bauen (sdk/build-native.js aus hostwerk-public)
node check.js . --strict             # dieselbe Prüfung wie der Katalog (sdk/check.js)
```

Oberfläche in `ui/src`, Server-Teil in `server/`. Texte im Code sind Englisch, Deutsch steht in `locales/de.json`.

## Lizenz

MIT

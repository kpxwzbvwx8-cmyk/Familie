# Familie

Gemeinsame Familien-App (PWA). Jedes Gerät gehört einem Nutzer, alle greifen auf denselben Server zu.

## Funktionen (Stand jetzt)

- **Konto einrichten** beim ersten Start: Vor- & Nachname, Geburtsdatum, Lieblingsfarbe. Die ID-Nummer wird zufällig vergeben.
- **Trainerpass** (Profil oben rechts) im Stil eines Trainerpasses in der Lieblingsfarbe:
  - ID Nr., Trainer, **Striche** (kommen später vom Board der Schande)
  - **Spielzeit** = Jahre / Monate / Wochen / Tage seit Geburt
  - **Abenteuer gestartet** = Geburtsdatum
  - **XP-Balken**: 1 XP pro Tag seit dem letzten Geburtstag, 365 bzw. 366 XP bis zum nächsten Level (= Alter)
- **Austausch**: Nachrichten mit Dringlichkeit (Info / Normal / Wichtig / Dringend → Farbe der Kachel), Titel, Beschreibung, automatisch ausgefülltem Urheber, Zeitpunkt und automatischem Löschen zu einem Datum/Uhrzeit.
  - Alle anderen bekommen eine **Push-Benachrichtigung** (bei offener App zusätzlich live).
  - **„In Kalender übernehmen“** lädt eine `.ics`-Datei → wird vom Smartphone-Kalender (iOS/Android) übernommen.
- **Team**: alle Konten der App, antippen zeigt deren Trainerpass.
- **Notizen**, **Kalender**, **Board der Schande**: Platzhalter für die nächsten Schritte.

## Starten

```bash
npm install
npm start          # http://localhost:3000
```

Umgebungsvariablen: `PORT` (Standard 3000), `DATA_DIR` (Standard `./data`), `VAPID_SUBJECT` (z. B. `mailto:du@example.org`).

Daten liegen in `data/db.json` (inkl. der beim ersten Start erzeugten Push-Schlüssel).

## Auf dem Smartphone nutzen

Push-Benachrichtigungen funktionieren nur über **HTTPS** (z. B. hinter einem Reverse-Proxy wie Caddy oder über einen Tunnel).

- **iPhone (ab iOS 16.4)**: Seite in Safari öffnen → Teilen → *Zum Home-Bildschirm*. Danach die App vom Home-Bildschirm starten und Benachrichtigungen aktivieren.
- **Android**: In Chrome öffnen → *App installieren* bzw. *Zum Startbildschirm hinzufügen*.

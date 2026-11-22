# Familie

Familien-App fürs iPhone (und jedes andere Smartphone), die im Browser läuft. Man braucht **keinen Mac und keinen App Store**:
Die App wird über Safari zum Home-Bildschirm hinzugefügt und verhält sich dann wie eine normale App, inklusive Benachrichtigungen.

- **Oberfläche:** statische Web-App in `public/`, kostenlos gehostet auf **GitHub Pages**
- **Daten, Anmeldung, Live-Updates, Benachrichtigungen:** **Supabase** (kostenloser Tarif)

## Funktionen

- **Konto einrichten** beim ersten Start: Familien-Code, Vor- & Nachname, Geburtsdatum, Geschlecht (bestimmt die Figur), Lieblingsfarbe.
  Ein neuer Code gründet ein eigenes Familien-Team. Wer denselben Code eingibt, tritt diesem Team bei. Jede Familie hat ihren eigenen Austausch, Kalender und Trainerbereich.
- **Trainerpass** (oben rechts) in der Lieblingsfarbe: ID Nr. (zufällig), Trainer, Striche, Spielzeit (J/M/W/T seit Geburt),
  Abenteuer gestartet (= Geburtsdatum), XP-Balken (1 XP pro Tag, 365/366 bis zum nächsten Geburtstag, Level = Alter).
- **Austausch:** Nachrichten mit Dringlichkeit (Farbe der Kachel), Titel, Beschreibung, Urheber, Zeitpunkt und automatischem Löschen.
  Alle anderen bekommen eine **Push-Benachrichtigung**. **„In Kalender übernehmen“** öffnet eine Kalenderdatei für den iPhone-Kalender.
- **Team:** alle Familienmitglieder mit ihrem Trainerpass, dazu Familien-Code und „Einladen“-Knopf.
- **Notizen, Kalender, Board der Schande:** folgen.

## Einrichtung (einmalig, geht komplett am iPhone im Browser)

### 1. Supabase-Projekt anlegen

1. Auf **supabase.com** kostenlos registrieren und **New project** anlegen.
   Name z. B. `familie`, Region **Frankfurt (eu-central-1)**. Das **Datenbank-Passwort notieren**.
2. **Authentication → Sign In / Providers**: **„Allow anonymous sign-ins“** einschalten und speichern.
3. Diese Werte notieren:
   - **Project ID / Reference:** steht in **Project Settings → General** (auch in der Adresse: `supabase.com/dashboard/project/<ID>`)
   - **Publishable key:** unter **Project Settings → API Keys** (alternativ der „anon public“-Schlüssel)
   - **Access Token:** unter **Account → Access Tokens** (supabase.com/dashboard/account/tokens) einen neuen Token erstellen

### 2. GitHub einstellen

Im Repository unter **Settings → Secrets and variables → Actions**:

| Art | Name | Wert |
|---|---|---|
| Variable | `SUPABASE_PROJECT_REF` | Project ID |
| Variable | `SUPABASE_KEY` | Publishable key |
| Secret | `SUPABASE_ACCESS_TOKEN` | Access Token |
| Secret | `SUPABASE_DB_PASSWORD` | Datenbank-Passwort |
| Secret | `TEAM_MASCOT_FAMILY_CODE` | Exakter Einladungscode der Familie mit den beiden Kaninchen und dem Ei, nur für die Datenbankmigration |
| Variable | `PRIVACY_CONTROLLER` | Öffentlich anzuzeigende verantwortliche Person oder Organisation einschließlich Anschrift |
| Variable | `PRIVACY_CONTACT` | Erreichbarer Kontakt für Datenschutzanfragen |
| Variable | `PRIVACY_RETENTION` | Tatsächliche Fristen für Nachweise, Sicherungen und technische Protokolle |
| Variable | `PRIVACY_TRANSFERS` | Tatsächliche Speicherregion, gegebenenfalls Drittlandtransfers und geltende Garantien |

Dann unter **Settings → Pages** bei **Source** die Option **GitHub Actions** wählen.
(GitHub Pages ist für **öffentliche** Repositories kostenlos. Für private Repositories braucht man GitHub Pro.)

### 3. Veröffentlichen

**Actions → Veröffentlichen → Run workflow** starten. Danach läuft das bei jeder Änderung am Standard-Branch automatisch.
Der Workflow richtet die Datenbank ein, veröffentlicht die Supabase-Funktionen und stellt die App auf GitHub Pages.
Die Adresse der App steht danach unter **Settings → Pages**, z. B. `https://<benutzer>.github.io/Familie/`.

### 4. Aufs iPhone holen (ab iOS 16.4)

1. Die Adresse in **Safari** öffnen.
2. **Teilen** → **„Zum Home-Bildschirm“** → **Hinzufügen**.
3. Die App über das neue Symbol öffnen, Konto einrichten und **Benachrichtigungen aktivieren**.

Weitere Familienmitglieder: Im Reiter **Team** auf **Einladen** tippen. Der Link enthält den Familien-Code.

> Hinweis: Kostenlose Supabase-Projekte werden nach 7 Tagen ganz ohne Nutzung pausiert und lassen sich im Dashboard wieder starten.

## Aufbau

```
public/                 Web-App (HTML/CSS/JS, Service Worker, Icons, Figuren)
supabase/migrations/    Datenbankschema inkl. Zugriffsregeln (RLS) und Auto-Löschen (pg_cron)
supabase/functions/     Edge Functions: push (Web-Push), ics (Kalender-Export)
.github/workflows/      Automatisches Veröffentlichen
```

## Lokal entwickeln

```bash
npm install
npx supabase start            # benötigt Docker
# public/config.js mit lokaler URL und Publishable key füllen (siehe `npx supabase status`)
npm start                     # http://localhost:8080
```

### Pikachu-Bildquellen

- Das Anime-Profil zeigt das überraschte Pikachu aus der Folge „Bisasam und das versteckte Idyll“. [Bildvorlage](https://github.com/Soviann/tarot/blob/fda3bd98e7a3776fd0a7a9f0dad1dc4f6831a461/frontend/public/memes/pikachu-surprised.webp)
- Das DS-Profil verwendet die Sprites aus Pokémon Platin. Auf Aufgabenkarten erscheint die Pose aus HeartGold und SoulSilver, bei Terminen die aus Schwarz und Weiß. [Generation IV](https://github.com/PokeAPI/sprites/tree/master/sprites/pokemon/versions/generation-iv) · [Generation V](https://github.com/PokeAPI/sprites/tree/master/sprites/pokemon/versions/generation-v/black-white)
- Das kleine Symbol neben Personennamen stammt aus dem Team-Menü von Pokémon Platin. [Pokémon-Platin-Sprite](https://github.com/pret/pokeplatinum/blob/main/res/pokemon/pikachu/icon.png)

# SpaceRocks Windows Relay Server

Das ist der externe Online-Relay-Server fuer SpaceRocks Windows Multiplayer.
Der Server laeuft auf Render oder einer anderen Webseite/Cloud, nicht auf deinem PC.

Empfohlen fuer einfache Tests: Render Web Service.
Render Free kann nach Inaktivitaet einschlafen. Wenn der Server wirklich immer online sein soll, nutze Oracle Cloud Always Free oder einen kleinen bezahlten VPS.

## Render Setup

1. GitHub Repository mit diesen Dateien hochladen.
2. Auf Render `New` -> `Web Service`.
3. Repo auswaehlen.
4. Root Directory leer lassen, wenn `package.json` direkt im Repo-Root liegt.
5. Build Command: `npm install`
6. Start Command: `npm start`
7. Plan: Free.
8. Nach Deploy die URL kopieren, z.B. `https://spacerocks-windows-relay.onrender.com`.

In GameMaker dann nur den Host eintragen:

```gml
global.mp_relay_host = "spacerocks-windows-relay.onrender.com";
global.mp_relay_port = 443;
global.mp_relay_secure = true;
```

Free Services koennen einschlafen. Beim ersten Join/Host kann es ein paar Sekunden dauern, bis Render wach ist.

## Funktionen

- Host/Join per Code
- Spieler suchen ohne Code ueber `Quick Match`
- Lobby-Liste im Spiel ueber `/lobbies`
- Server-Wakeup/Status ueber `/health`
- Update-Check ueber `/latest-version`
- Reconnect ueber gespeicherten Match-Token
- Einstimmige Revanche-Abstimmung; Bots stimmen automatisch zu
- Host-Wechsel und laufende Runden bei Spieler-Disconnects
- Servergepruefter Owner-Rang mit privaten Admin-Befehlen
- Google- und Apple-Anmeldung fuer den Onlinebereich
- Private Code-Lobbys, die niemals in Quick Match auftauchen
- Live-Zuschauen und die letzten zehn Match-Replays
- Match-History ueber `/history`
- Replay-Summaries ueber `/replays`
- Server-News ueber `/news`
- Freunde ueber `/friends` und `/friends/add`
- Invites ueber `/invites`
- einfacher Cloud-Save ueber `/cloud-save`

## Versionen

Der Server nutzt diese Variablen:

```bash
SPACEROCKS_LATEST_VERSION=1.0.8
SPACEROCKS_MIN_CLIENT_VERSION=1.0.8
SPACEROCKS_RELEASE_URL=https://github.com/nxn7gmcgmt-byte/SpaceRocks/releases/latest
SPACEROCKS_DOWNLOAD_URL=https://github.com/nxn7gmcgmt-byte/SpaceRocks/releases/latest
SPACEROCKS_GITHUB_TOKEN=DEIN_PRIVATE_REPO_READ_TOKEN
SPACEROCKS_USE_RELEASE_PROXY=true
SPACEROCKS_OWNER_SECRET=LANGER_ZUFAELLIGER_OWNER_KEY
SPACEROCKS_OWNER_ACCOUNT=deine-google-oder-apple-account-id
SPACEROCKS_AUTH_REQUIRED=true
SPACEROCKS_PUBLIC_BASE_URL=https://spacerocks-windows-relay.onrender.com
SPACEROCKS_GOOGLE_CLIENT_ID=GOOGLE_WEB_CLIENT_ID
SPACEROCKS_GOOGLE_CLIENT_SECRET=GOOGLE_WEB_CLIENT_SECRET
SPACEROCKS_APPLE_CLIENT_ID=APPLE_SERVICES_ID
SPACEROCKS_APPLE_TEAM_ID=APPLE_TEAM_ID
SPACEROCKS_APPLE_KEY_ID=APPLE_SIGN_IN_KEY_ID
SPACEROCKS_APPLE_PRIVATE_KEY=APPLE_P8_PRIVATE_KEY
SPACEROCKS_GITHUB_OAUTH_CLIENT_ID=GITHUB_OAUTH_CLIENT_ID
SPACEROCKS_GITHUB_OAUTH_CLIENT_SECRET=GITHUB_OAUTH_CLIENT_SECRET
SPACEROCKS_STEAM_LOGIN_ENABLED=false
SPACEROCKS_STEAM_WEB_API_KEY=OPTIONALER_STEAM_WEB_API_KEY
SPACEROCKS_ROBLOX_CLIENT_ID=ROBLOX_OAUTH_CLIENT_ID
SPACEROCKS_ROBLOX_CLIENT_SECRET=ROBLOX_OAUTH_CLIENT_SECRET
```

Wenn `MIN_CLIENT_VERSION` hoeher ist als die Spielversion, blockt der Server den alten Client.
Wenn das GitHub-Repo privat ist, braucht Render `SPACEROCKS_GITHUB_TOKEN`, damit `/launcher-release` und `/download/...` die privaten Release-ZIPs lesen koennen.

`SPACEROCKS_AUTH_REQUIRED` erst auf `true` setzen, nachdem mindestens ein Anbieter komplett konfiguriert wurde. Der Client zeigt nur Anbieter an, die der `/health`-Endpunkt als bereit meldet.

Google Redirect URI:

```text
https://spacerocks-windows-relay.onrender.com/auth/callback/google
```

Apple Return URL:

```text
https://spacerocks-windows-relay.onrender.com/auth/callback/apple
```

Steam Return URL:

```text
https://spacerocks-windows-relay.onrender.com/auth/callback/steam
```

Roblox Redirect URI:

```text
https://spacerocks-windows-relay.onrender.com/auth/callback/roblox
```

Epic Games, PlayStation und Nintendo sind im Server vorbereitet, bleiben aber unsichtbar, bis die genehmigten Anbieter-Zugangsdaten und alle drei OAuth-Endpunkte als Render-Variablen gesetzt sind. Die Variablennamen lauten jeweils `SPACEROCKS_<ANBIETER>_CLIENT_ID`, `..._CLIENT_SECRET`, `..._AUTH_URL`, `..._TOKEN_URL` und `..._USERINFO_URL`.

`SPACEROCKS_OWNER_SECRET` und alle OAuth-Secrets bleiben ausschliesslich als geheime Render-Variablen. Der Client speichert weder Secrets noch Login-Tokens in Saves, INI-Dateien oder Optionen. `SPACEROCKS_OWNER_ACCOUNT` bindet den Owner-Rang zusaetzlich an genau ein Google-/Apple-Konto. Im Match oeffnet F12 den Owner-Login. Nach erfolgreicher Serverpruefung stehen unter anderem `/players`, `/ban SLOT GRUND`, `/unban ID`, `/banlist`, `/unlockall SLOT`, `/heal`, `/teamwin 1`, `/kick 2` und `/announce TEXT` zur Verfuegung.

## Immer online

Wenn du nicht willst, dass der Server erst aufwachen muss:

- Oracle Cloud Always Free VM: kostenlos moeglich, aber Setup ist schwerer.
- Kleiner VPS: kostet meistens ca. 3-5 Euro pro Monat, ist am einfachsten stabil.

Auf einem Always-On Server startest du:

```bash
npm install
npm start
```

Dann im GameMaker eintragen:

```gml
global.mp_relay_host = "DEINE_SERVER_IP_ODER_DOMAIN";
global.mp_relay_port = 10000;
global.mp_relay_secure = false;
```

Bei HTTPS/WSS Hosting:

```gml
global.mp_relay_host = "deine-domain.onrender.com";
global.mp_relay_port = 443;
global.mp_relay_secure = true;
```

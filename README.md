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
- Match-History ueber `/history`
- Replay-Summaries ueber `/replays`
- Server-News ueber `/news`
- Freunde ueber `/friends` und `/friends/add`
- Invites ueber `/invites`
- einfacher Cloud-Save ueber `/cloud-save`

## Versionen

Der Server nutzt diese Variablen:

```bash
SPACEROCKS_LATEST_VERSION=1.0.7
SPACEROCKS_MIN_CLIENT_VERSION=1.0.6
SPACEROCKS_RELEASE_URL=https://github.com/nxn7gmcgmt-byte/SpaceRocks/releases/latest
SPACEROCKS_DOWNLOAD_URL=https://github.com/nxn7gmcgmt-byte/SpaceRocks/releases/latest
SPACEROCKS_GITHUB_TOKEN=DEIN_PRIVATE_REPO_READ_TOKEN
SPACEROCKS_USE_RELEASE_PROXY=true
SPACEROCKS_OWNER_SECRET=LANGER_ZUFAELLIGER_OWNER_KEY
```

Wenn `MIN_CLIENT_VERSION` hoeher ist als die Spielversion, blockt der Server den alten Client.
Wenn das GitHub-Repo privat ist, braucht Render `SPACEROCKS_GITHUB_TOKEN`, damit `/launcher-release` und `/download/...` die privaten Release-ZIPs lesen koennen.

`SPACEROCKS_OWNER_SECRET` bleibt ausschliesslich als geheime Render-Variable. Der Client speichert den Key weder in Saves noch in INI-Dateien oder Optionen. Im Match oeffnet F12 den Owner-Login. Nach erfolgreicher Serverpruefung stehen `/heal`, `/teamwin 1`, `/kick 2` und `/announce TEXT` zur Verfuegung.

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

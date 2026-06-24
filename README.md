# SpaceRocks Windows Relay Server

Das ist der Online-Relay-Server fuer Windows-1v1.

Empfohlen fuer einfache Tests: Render Web Service.
Render Free kann nach Inaktivitaet einschlafen. Wenn der Server wirklich immer online sein soll, nutze Oracle Cloud Always Free oder einen kleinen bezahlten VPS.

## Render Setup

1. GitHub Repository mit diesem Ordner hochladen.
2. Auf Render `New` -> `Web Service`.
3. Repo auswaehlen.
4. Root Directory auf `windows_relay_server` setzen.
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

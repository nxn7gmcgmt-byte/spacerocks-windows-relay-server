const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 1000 * 60 * 60;
const RECONNECT_TTL_MS = 1000 * 60 * 3;
const HISTORY_LIMIT = 50;
const MAX_TEAM_SIZE = 10;
const MAX_PLAYERS = 30;
const LATEST_VERSION = process.env.SPACEROCKS_LATEST_VERSION || "1.0.2";
const MIN_CLIENT_VERSION = process.env.SPACEROCKS_MIN_CLIENT_VERSION || "1.0.2";
const RELEASE_URL = process.env.SPACEROCKS_RELEASE_URL || "https://github.com/nxn7gmcgmt-byte/SpaceRocks/releases/latest";
const DOWNLOAD_URL = process.env.SPACEROCKS_DOWNLOAD_URL || "https://github.com/nxn7gmcgmt-byte/SpaceRocks/releases/latest";

const rooms = new Map();
const matchHistory = [];

function makeCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function makeUniqueCode() {
  for (let i = 0; i < 40; i += 1) {
    const code = makeCode();
    if (!rooms.has(code)) return code;
  }
  return makeCode();
}

function makeToken() {
  return `${makeCode()}-${makeCode()}-${Date.now().toString(36).toUpperCase()}`;
}

function compareVersion(a, b) {
  const left = String(a || "0").replace(/^v/i, "").split(".").map((part) => Number(part) || 0);
  const right = String(b || "0").replace(/^v/i, "").split(".").map((part) => Number(part) || 0);
  const len = Math.max(left.length, right.length, 3);

  for (let i = 0; i < len; i += 1) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }

  return 0;
}

function clientVersionOk(version) {
  return compareVersion(version || "0", MIN_CLIENT_VERSION) >= 0;
}

function rejectOldClient(ws) {
  send(ws, {
    cmd: "update_required",
    message: `Bitte update SpaceRocks auf ${LATEST_VERSION}.`,
    latest_version: LATEST_VERSION,
    min_version: MIN_CLIENT_VERSION,
    release_url: RELEASE_URL,
    download_url: DOWNLOAD_URL
  });
}

function normalizeMode(mode) {
  const text = String(mode || "1v1").toLowerCase();
  const parts = text.split("v");
  if (parts.length < 2 || parts.length > 3) return "1v1";

  const teamSize = Number(parts[0]);
  if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > MAX_TEAM_SIZE) return "1v1";
  if (!parts.every((part) => Number(part) === teamSize)) return "1v1";
  if (teamSize * parts.length > MAX_PLAYERS) return "1v1";

  return parts.map(() => String(teamSize)).join("v");
}

function requiredPlayersForMode(mode) {
  const parts = normalizeMode(mode).split("v");
  return Number(parts[0]) * parts.length;
}

function sanitizeSkin(skin) {
  const value = Number(skin || 0);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(8, Math.floor(value)));
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data) + "\0");
  }
}

function safeJson(text) {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function roomPlayers(room) {
  return room.players.filter((player) => player && player.readyState === WebSocket.OPEN);
}

function connectedCount(room) {
  return roomPlayers(room).length;
}

function clearClosedPlayers(room) {
  for (let i = 0; i < room.players.length; i += 1) {
    const player = room.players[i];
    if (player && player.readyState !== WebSocket.OPEN) {
      room.players[i] = null;
      if (room.disconnectedUntil) room.disconnectedUntil[i] = Math.max(room.disconnectedUntil[i] || 0, Date.now() + RECONNECT_TTL_MS);
    }
  }
}

function broadcastRoom(room, data, except = null) {
  for (const player of roomPlayers(room)) {
    if (player !== except) send(player, data);
  }
}

function sendRoomStatus(room, cmd = "lobby_update") {
  clearClosedPlayers(room);
  const count = connectedCount(room);

  for (const player of roomPlayers(room)) {
    send(player, {
      cmd,
      code: room.code,
      player: player.playerId,
      mode: room.mode,
      connected_players: count,
      required_players: room.maxPlayers,
      skins: room.skins,
      state: room.state,
      token: player.reconnectToken || ""
    });
  }
}

function startRoomIfReady(room) {
  clearClosedPlayers(room);
  if (connectedCount(room) < room.maxPlayers) return;
  room.state = "playing";

  for (const player of roomPlayers(room)) {
    send(player, {
      cmd: "start",
      code: room.code,
      player: player.playerId,
      mode: room.mode,
      connected_players: room.maxPlayers,
      required_players: room.maxPlayers,
      skins: room.skins,
      state: room.state,
      token: player.reconnectToken || ""
    });
  }
}

function findOpenSlot(room) {
  clearClosedPlayers(room);
  for (let i = 0; i < room.maxPlayers; i += 1) {
    if (!room.players[i]) return i;
  }
  return -1;
}

function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const players = connectedCount(room);
    const reconnectOpen = room.disconnectedUntil && room.disconnectedUntil.some((time) => time > now);

    if (room.expiresAt <= now || (players <= 0 && !reconnectOpen && now - room.createdAt > RECONNECT_TTL_MS)) {
      broadcastRoom(room, { cmd: "error", message: "Code expired." });
      rooms.delete(code);
    }
  }
}

function lobbySummary(room) {
  clearClosedPlayers(room);
  const count = connectedCount(room);

  return {
    code: room.code,
    mode: room.mode,
    state: room.state,
    connected_players: count,
    required_players: room.maxPlayers,
    open_slots: Math.max(0, room.maxPlayers - count),
    created_at: room.createdAt,
    expires_in_ms: Math.max(0, room.expiresAt - Date.now())
  };
}

function openLobbies(mode = "") {
  cleanupExpiredRooms();
  const wantedMode = mode ? normalizeMode(mode) : "";

  return Array.from(rooms.values())
    .filter((room) => room.state === "open")
    .filter((room) => !wantedMode || room.mode === wantedMode)
    .map(lobbySummary)
    .filter((room) => room.open_slots > 0 && room.expires_in_ms > 0)
    .sort((a, b) => a.created_at - b.created_at);
}

function createRoomForHost(ws, msg) {
  cleanupExpiredRooms();

  const mode = normalizeMode(msg.mode);
  const code = makeUniqueCode();
  const maxPlayers = requiredPlayersForMode(mode);
  const players = Array(maxPlayers).fill(null);
  const skins = Array(maxPlayers).fill(0);
  const tokens = Array(maxPlayers).fill("");
  const disconnectedUntil = Array(maxPlayers).fill(0);

  ws.playerId = 0;
  ws.roomCode = code;
  ws.skin = sanitizeSkin(msg.skin);
  ws.reconnectToken = makeToken();
  players[0] = ws;
  skins[0] = ws.skin;
  tokens[0] = ws.reconnectToken;

  const room = {
    code,
    mode,
    maxPlayers,
    players,
    skins,
    tokens,
    disconnectedUntil,
    state: "open",
    createdAt: Date.now(),
    expiresAt: Date.now() + CODE_TTL_MS
  };

  rooms.set(code, room);
  send(ws, {
    cmd: "hosted",
    code,
    player: 0,
    mode,
    connected_players: 1,
    required_players: maxPlayers,
    skins,
    state: room.state,
    token: ws.reconnectToken
  });

  return room;
}

function joinRoom(ws, room, msg, cmd = "lobby") {
  const slot = findOpenSlot(room);
  if (slot < 0) {
    send(ws, { cmd: "error", message: "Room is full." });
    return false;
  }

  ws.playerId = slot;
  ws.roomCode = room.code;
  ws.skin = sanitizeSkin(msg.skin);
  ws.reconnectToken = makeToken();
  room.players[slot] = ws;
  room.skins[slot] = ws.skin;
  room.tokens[slot] = ws.reconnectToken;
  room.disconnectedUntil[slot] = 0;

  send(ws, {
    cmd,
    code: room.code,
    player: slot,
    mode: room.mode,
    connected_players: connectedCount(room),
    required_players: room.maxPlayers,
    skins: room.skins,
    state: room.state,
    token: ws.reconnectToken
  });

  sendRoomStatus(room);
  startRoomIfReady(room);
  return true;
}

function saveMatchResult(room, msg) {
  const result = {
    code: room ? room.code : String(msg.code || ""),
    mode: room ? room.mode : normalizeMode(msg.mode),
    winner_team: Number.isFinite(Number(msg.winner_team)) ? Number(msg.winner_team) : -1,
    duration_seconds: Math.max(0, Math.floor(Number(msg.duration_seconds || 0))),
    team_wins: Array.isArray(msg.team_wins) ? msg.team_wins.slice(0, 3) : [],
    players: Array.isArray(msg.players) ? msg.players.slice(0, MAX_PLAYERS) : [],
    created_at: new Date().toISOString()
  };

  matchHistory.unshift(result);
  while (matchHistory.length > HISTORY_LIMIT) matchHistory.pop();
  return result;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      open_rooms: openLobbies().length,
      players: Array.from(rooms.values()).reduce((sum, room) => sum + connectedCount(room), 0),
      latest_version: LATEST_VERSION,
      min_client_version: MIN_CLIENT_VERSION,
      release_url: RELEASE_URL,
      download_url: DOWNLOAD_URL,
      uptime_seconds: Math.floor(process.uptime())
    }));
    return;
  }

  if (url.pathname === "/lobbies") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      lobbies: openLobbies(url.searchParams.get("mode") || "")
    }));
    return;
  }

  if (url.pathname === "/history") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      history: matchHistory.slice(0, 20)
    }));
    return;
  }

  if (url.pathname === "/latest-version") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      latest_version: LATEST_VERSION,
      min_client_version: MIN_CLIENT_VERSION,
      release_url: RELEASE_URL,
      download_url: DOWNLOAD_URL
    }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("SpaceRocks Windows Relay online");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.playerId = -1;
  ws.roomCode = "";
  ws.skin = 0;
  ws.reconnectToken = "";

  ws.on("message", (raw) => {
    const msg = safeJson(String(raw).replace(/\0/g, "").trim());
    if (!msg || typeof msg.cmd !== "string") {
      send(ws, { cmd: "error", message: "Bad packet." });
      return;
    }

    if (msg.cmd === "host") {
      if (!clientVersionOk(msg.version)) {
        rejectOldClient(ws);
        return;
      }

      createRoomForHost(ws, msg);
      return;
    }

    if (msg.cmd === "quickjoin") {
      if (!clientVersionOk(msg.version)) {
        rejectOldClient(ws);
        return;
      }

      const mode = normalizeMode(msg.mode);
      const lobby = openLobbies(mode)[0];

      if (lobby) {
        const room = rooms.get(lobby.code);
        if (room && joinRoom(ws, room, msg, "lobby")) return;
      }

      createRoomForHost(ws, { ...msg, mode });
      return;
    }

    if (msg.cmd === "join") {
      if (!clientVersionOk(msg.version)) {
        rejectOldClient(ws);
        return;
      }

      cleanupExpiredRooms();

      const code = String(msg.code || "").toUpperCase();
      const room = rooms.get(code);
      if (!room || room.expiresAt <= Date.now()) {
        send(ws, { cmd: room ? "expired" : "not_found", message: room ? "Code expired." : "Code not found." });
        if (room) rooms.delete(code);
        return;
      }

      const wantedMode = normalizeMode(msg.mode || room.mode);
      if (wantedMode !== room.mode) {
        send(ws, { cmd: "error", message: `This code is for ${room.mode}.` });
        return;
      }

      joinRoom(ws, room, msg, "lobby");
      return;
    }

    if (msg.cmd === "reconnect") {
      if (!clientVersionOk(msg.version)) {
        rejectOldClient(ws);
        return;
      }

      cleanupExpiredRooms();

      const code = String(msg.code || "").toUpperCase();
      const token = String(msg.token || "");
      const room = rooms.get(code);

      if (!room || room.expiresAt <= Date.now()) {
        send(ws, { cmd: room ? "expired" : "not_found", message: room ? "Code expired." : "Code not found." });
        return;
      }

      const slot = room.tokens ? room.tokens.indexOf(token) : -1;
      if (slot < 0 || (room.players[slot] && room.players[slot].readyState === WebSocket.OPEN)) {
        send(ws, { cmd: "error", message: "Reconnect failed." });
        return;
      }

      if (room.disconnectedUntil && room.disconnectedUntil[slot] > 0 && room.disconnectedUntil[slot] < Date.now()) {
        send(ws, { cmd: "expired", message: "Reconnect expired." });
        return;
      }

      ws.playerId = slot;
      ws.roomCode = room.code;
      ws.skin = sanitizeSkin(msg.skin);
      ws.reconnectToken = token;
      room.players[slot] = ws;
      room.skins[slot] = ws.skin;
      room.disconnectedUntil[slot] = 0;

      send(ws, {
        cmd: "reconnected",
        code: room.code,
        player: slot,
        mode: room.mode,
        connected_players: connectedCount(room),
        required_players: room.maxPlayers,
        skins: room.skins,
        state: room.state,
        token
      });

      sendRoomStatus(room, "lobby_update");
      if (room.state === "playing") {
        send(ws, {
          cmd: "start",
          code: room.code,
          player: slot,
          mode: room.mode,
          connected_players: connectedCount(room),
          required_players: room.maxPlayers,
          skins: room.skins,
          state: room.state,
          token
        });
      }
      return;
    }

    if (msg.cmd === "skin") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!room || ws.playerId < 0) return;
      room.skins[ws.playerId] = sanitizeSkin(msg.skin);
      sendRoomStatus(room);
      return;
    }

    if (msg.cmd === "input") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!room || ws.playerId < 0) return;
      broadcastRoom(room, { cmd: "input", player: ws.playerId, input: msg.input || {}, frame: msg.frame || 0 }, ws);
      return;
    }

    if (msg.cmd === "snapshot") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!room || ws.playerId !== 0) return;
      broadcastRoom(room, { cmd: "snapshot", snapshot: msg.snapshot || {} }, ws);
      return;
    }

    if (msg.cmd === "match_result") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!room || ws.playerId !== 0) return;
      const result = saveMatchResult(room, msg);
      room.state = "finished";
      broadcastRoom(room, { cmd: "match_result", result }, null);
    }
  });

  ws.on("close", () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    if (ws.playerId >= 0 && ws.playerId < room.players.length) {
      room.players[ws.playerId] = null;
      room.disconnectedUntil[ws.playerId] = Date.now() + RECONNECT_TTL_MS;
    }
    broadcastRoom(room, {
      cmd: "peer_left",
      player: ws.playerId,
      reconnect_seconds: Math.floor(RECONNECT_TTL_MS / 1000),
      message: "Player disconnected. Reconnect is possible for a short time."
    }, ws);
  });
});

setInterval(cleanupExpiredRooms, 30000);

server.listen(PORT, () => {
  console.log(`SpaceRocks Windows relay listening on ${PORT}`);
});

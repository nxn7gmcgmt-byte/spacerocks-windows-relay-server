const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 1000 * 60 * 60;
const MAX_TEAM_SIZE = 5;

const rooms = new Map();

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

function normalizeMode(mode) {
  const text = String(mode || "1v1").toLowerCase();
  const match = text.match(/^([1-5])v\1$/);
  if (!match) return "1v1";
  const teamSize = Math.max(1, Math.min(MAX_TEAM_SIZE, Number(match[1])));
  return `${teamSize}v${teamSize}`;
}

function requiredPlayersForMode(mode) {
  const normalized = normalizeMode(mode);
  return Number(normalized[0]) * 2;
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
      room.skins[i] = 0;
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
      skins: room.skins
    });
  }
}

function startRoomIfReady(room) {
  clearClosedPlayers(room);
  if (connectedCount(room) < room.maxPlayers) return;

  for (const player of roomPlayers(room)) {
    send(player, {
      cmd: "start",
      code: room.code,
      player: player.playerId,
      mode: room.mode,
      connected_players: room.maxPlayers,
      required_players: room.maxPlayers,
      skins: room.skins
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
    if (room.expiresAt <= now) {
      broadcastRoom(room, { cmd: "error", message: "Code expired." });
      rooms.delete(code);
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      players: Array.from(rooms.values()).reduce((sum, room) => sum + connectedCount(room), 0)
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

  ws.on("message", (raw) => {
    const msg = safeJson(String(raw).replace(/\0/g, "").trim());
    if (!msg || typeof msg.cmd !== "string") {
      send(ws, { cmd: "error", message: "Bad packet." });
      return;
    }

    if (msg.cmd === "host") {
      cleanupExpiredRooms();

      const mode = normalizeMode(msg.mode);
      const code = makeUniqueCode();
      const maxPlayers = requiredPlayersForMode(mode);
      const players = Array(maxPlayers).fill(null);
      const skins = Array(maxPlayers).fill(0);

      ws.playerId = 0;
      ws.roomCode = code;
      ws.skin = sanitizeSkin(msg.skin);
      players[0] = ws;
      skins[0] = ws.skin;

      const room = {
        code,
        mode,
        maxPlayers,
        players,
        skins,
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
        skins
      });
      return;
    }

    if (msg.cmd === "join") {
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

      const slot = findOpenSlot(room);
      if (slot < 0) {
        send(ws, { cmd: "error", message: "Room is full." });
        return;
      }

      ws.playerId = slot;
      ws.roomCode = code;
      ws.skin = sanitizeSkin(msg.skin);
      room.players[slot] = ws;
      room.skins[slot] = ws.skin;

      send(ws, {
        cmd: "lobby",
        code,
        player: slot,
        mode: room.mode,
        connected_players: connectedCount(room),
        required_players: room.maxPlayers,
        skins: room.skins
      });

      sendRoomStatus(room);
      startRoomIfReady(room);
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
    }
  });

  ws.on("close", () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    broadcastRoom(room, { cmd: "peer_left", message: "Player disconnected." }, ws);
    rooms.delete(ws.roomCode);
  });
});

setInterval(cleanupExpiredRooms, 30000);

server.listen(PORT, () => {
  console.log(`SpaceRocks Windows relay listening on ${PORT}`);
});

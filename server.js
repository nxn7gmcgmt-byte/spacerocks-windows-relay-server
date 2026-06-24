const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 1000 * 60 * 60;

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

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data) + "\0");
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getPeer(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return null;
  if (room.host === ws) return room.joiner;
  if (room.joiner === ws) return room.host;
  return null;
}

function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.expiresAt <= now) {
      send(room.host, { cmd: "error", message: "Code expired." });
      send(room.joiner, { cmd: "error", message: "Code expired." });
      rooms.delete(code);
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
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

      const code = makeUniqueCode();
      ws.playerId = 0;
      ws.roomCode = code;
      ws.skin = Number(msg.skin || 0);

      rooms.set(code, {
        code,
        host: ws,
        joiner: null,
        mode: String(msg.mode || "1v1"),
        hostSkin: ws.skin,
        joinerSkin: 0,
        expiresAt: Date.now() + CODE_TTL_MS
      });

      send(ws, { cmd: "hosted", code, player: 0 });
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

      if (room.joiner && room.joiner.readyState === WebSocket.OPEN) {
        send(ws, { cmd: "error", message: "Room is full." });
        return;
      }

      ws.playerId = 1;
      ws.roomCode = code;
      ws.skin = Number(msg.skin || 0);
      room.joiner = ws;
      room.joinerSkin = ws.skin;

      const startHost = { cmd: "start", code, player: 0, mode: room.mode, p1_skin: room.hostSkin, p2_skin: room.joinerSkin };
      const startJoiner = { cmd: "start", code, player: 1, mode: room.mode, p1_skin: room.hostSkin, p2_skin: room.joinerSkin };
      send(room.host, startHost);
      send(room.joiner, startJoiner);
      return;
    }

    if (msg.cmd === "input") {
      const peer = getPeer(ws);
      if (peer) send(peer, { cmd: "input", player: ws.playerId, input: msg.input || {}, frame: msg.frame || 0 });
      return;
    }

    if (msg.cmd === "snapshot") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (room && room.host === ws && room.joiner) {
        send(room.joiner, { cmd: "snapshot", snapshot: msg.snapshot || {} });
      }
    }
  });

  ws.on("close", () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    const peer = getPeer(ws);
    if (peer) send(peer, { cmd: "peer_left", message: "Opponent disconnected." });
    if (room && (room.host === ws || room.joiner === ws)) rooms.delete(ws.roomCode);
  });
});

setInterval(cleanupExpiredRooms, 30000);

server.listen(PORT, () => {
  console.log(`SpaceRocks Windows relay listening on ${PORT}`);
});

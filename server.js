const http = require("http");
const crypto = require("crypto");
const { Readable } = require("stream");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 1000 * 60 * 60;
const RECONNECT_TTL_MS = 1000 * 60 * 3;
const QUICK_MATCH_WAIT_MS = 2500;
const HISTORY_LIMIT = 50;
const MAX_TEAM_SIZE = 100;
const MAX_PLAYERS = 200;
const LATEST_VERSION = process.env.SPACEROCKS_LATEST_VERSION || "1.0.7";
const MIN_CLIENT_VERSION = process.env.SPACEROCKS_MIN_CLIENT_VERSION || "1.0.6";
const RELEASE_URL = process.env.SPACEROCKS_RELEASE_URL || "https://github.com/nxn7gmcgmt-byte/SpaceRocks/releases/latest";
const DOWNLOAD_URL = process.env.SPACEROCKS_DOWNLOAD_URL || "https://github.com/nxn7gmcgmt-byte/SpaceRocks/releases/latest";
const GITHUB_OWNER = process.env.SPACEROCKS_GITHUB_OWNER || "nxn7gmcgmt-byte";
const GITHUB_REPO = process.env.SPACEROCKS_GITHUB_REPO || "SpaceRocks";
const GITHUB_TOKEN = process.env.SPACEROCKS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
const RELEASE_TAG = process.env.SPACEROCKS_RELEASE_TAG || `v${LATEST_VERSION}`;
const DOWNLOAD_ASSET_NAME = process.env.SPACEROCKS_DOWNLOAD_ASSET_NAME || `SpaceRocks-v${LATEST_VERSION}-windows.zip`;
const USE_RELEASE_PROXY = process.env.SPACEROCKS_USE_RELEASE_PROXY !== "false";
const OWNER_SECRET = process.env.SPACEROCKS_OWNER_SECRET || "";

const rooms = new Map();
const matchHistory = [];
const cloudSaves = new Map();
const friendLists = new Map();
const invites = [];
const replaySummaries = [];
const serverNews = [
  {
    title: "SpaceRocks Online v1.0.7",
    text: "Revanche-Abstimmung, sichere Disconnects und Owner-Rang sind online.",
    created_at: new Date().toISOString()
  },
  {
    title: "Kein PC-Server noetig",
    text: "Der Relay-Server laeuft extern ueber Render. Dein PC muss nur das Spiel starten.",
    created_at: new Date().toISOString()
  }
];

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(body));
}

function serverOrigin(req) {
  if (process.env.SPACEROCKS_PUBLIC_BASE_URL) {
    return String(process.env.SPACEROCKS_PUBLIC_BASE_URL).replace(/\/+$/g, "");
  }

  const host = req && req.headers ? req.headers.host : "";
  let proto = req && req.headers && req.headers["x-forwarded-proto"]
    ? String(req.headers["x-forwarded-proto"]).split(",")[0].trim()
    : "https";
  if ((!req || !req.headers || !req.headers["x-forwarded-proto"]) && (String(host).startsWith("127.0.0.1") || String(host).startsWith("localhost"))) {
    proto = "http";
  }
  return `${proto}://${host || "localhost"}`;
}

function proxyDownloadUrl(req, tag = RELEASE_TAG, assetName = DOWNLOAD_ASSET_NAME) {
  return `${serverOrigin(req)}/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

function publicDownloadUrl(req) {
  if (USE_RELEASE_PROXY) return proxyDownloadUrl(req);
  return DOWNLOAD_URL;
}

function githubHeaders(accept) {
  const headers = {
    "Accept": accept || "application/vnd.github+json",
    "User-Agent": "SpaceRocksRelay"
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

async function fetchGithubJson(path) {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${path}`, {
    headers: githubHeaders("application/vnd.github+json")
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 160)}`);
  }

  return response.json();
}

async function githubReleaseForTag(tag) {
  const safeTag = String(tag || RELEASE_TAG);
  if (safeTag === "latest") return fetchGithubJson("/releases/latest");
  return fetchGithubJson(`/releases/tags/${encodeURIComponent(safeTag)}`);
}

function launcherReleaseFallback(req) {
  return {
    tag_name: RELEASE_TAG,
    name: `SpaceRocks ${RELEASE_TAG}`,
    body: "Private GitHub Release. Download laeuft ueber den Render-Server.",
    html_url: RELEASE_URL,
    private_release_proxy: true,
    github_private_access_configured: Boolean(GITHUB_TOKEN),
    assets: [
      {
        name: DOWNLOAD_ASSET_NAME,
        size: 0,
        browser_download_url: proxyDownloadUrl(req, RELEASE_TAG, DOWNLOAD_ASSET_NAME)
      }
    ]
  };
}

async function launcherReleasePayload(req) {
  try {
    const release = await githubReleaseForTag("latest");
    const tag = release.tag_name || RELEASE_TAG;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    return {
      tag_name: tag,
      name: release.name || `SpaceRocks ${tag}`,
      body: release.body || "",
      html_url: release.html_url || RELEASE_URL,
      private_release_proxy: USE_RELEASE_PROXY,
      github_private_access_configured: Boolean(GITHUB_TOKEN),
      assets: assets.map((asset) => ({
        name: asset.name,
        size: asset.size || 0,
        browser_download_url: USE_RELEASE_PROXY
          ? proxyDownloadUrl(req, tag, asset.name)
          : asset.browser_download_url
      }))
    };
  } catch (error) {
    const fallback = launcherReleaseFallback(req);
    fallback.body += `\n\nGitHub API Fehler: ${error.message}`;
    return fallback;
  }
}

async function streamGithubReleaseAsset(req, res, tag, assetName) {
  if (!GITHUB_TOKEN) {
    sendJson(res, 500, {
      ok: false,
      message: "Private GitHub downloads brauchen SPACEROCKS_GITHUB_TOKEN auf Render."
    });
    return;
  }

  try {
    const release = await githubReleaseForTag(tag || RELEASE_TAG);
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const wanted = String(assetName || DOWNLOAD_ASSET_NAME).toLowerCase();
    const asset = assets.find((item) => String(item.name || "").toLowerCase() === wanted)
      || assets.find((item) => String(item.name || "").toLowerCase().includes("windows") && String(item.name || "").toLowerCase().endsWith(".zip"))
      || assets.find((item) => String(item.name || "").toLowerCase().endsWith(".zip"));

    if (!asset || !asset.url) {
      sendJson(res, 404, { ok: false, message: "Release ZIP wurde nicht gefunden." });
      return;
    }

    const response = await fetch(asset.url, {
      redirect: "follow",
      headers: githubHeaders("application/octet-stream")
    });

    if (!response.ok || !response.body) {
      sendJson(res, response.status || 502, { ok: false, message: "GitHub Asset Download fehlgeschlagen." });
      return;
    }

    const headers = {
      "Content-Type": response.headers.get("content-type") || "application/zip",
      "Content-Disposition": `attachment; filename="${String(asset.name || DOWNLOAD_ASSET_NAME).replace(/"/g, "")}"`,
      "Access-Control-Allow-Origin": "*"
    };
    const length = response.headers.get("content-length") || asset.size;
    if (length) headers["Content-Length"] = String(length);

    res.writeHead(200, headers);
    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    sendJson(res, 500, { ok: false, message: error.message || "Download fehlgeschlagen." });
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sanitizeId(id) {
  return String(id || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 32);
}

function sanitizeName(name) {
  return String(name || "SPIELER").replace(/[^\w \-]/g, "").slice(0, 18) || "SPIELER";
}

function ownerSecretMatches(value) {
  if (!OWNER_SECRET) return false;
  const provided = Buffer.from(String(value || ""));
  const expected = Buffer.from(OWNER_SECRET);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function getFriendArray(playerId) {
  if (!friendLists.has(playerId)) friendLists.set(playerId, []);
  return friendLists.get(playerId);
}

function addFriend(playerId, friendId, friendName = "") {
  const friends = getFriendArray(playerId);
  if (!friendId || friendId === playerId) return friends;
  if (!friends.some((friend) => friend.id === friendId)) {
    friends.push({
      id: friendId,
      name: sanitizeName(friendName || friendId),
      added_at: new Date().toISOString()
    });
  }
  return friends;
}

function cleanupInvites() {
  const now = Date.now();
  for (let i = invites.length - 1; i >= 0; i -= 1) {
    if (invites[i].expires_at_ms <= now) invites.splice(i, 1);
  }
}

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
    download_url: ws && ws.downloadUrl ? ws.downloadUrl : DOWNLOAD_URL
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

function botCount(room) {
  if (!room || !Array.isArray(room.botSlots)) return 0;
  return room.botSlots.filter(Boolean).length;
}

function teamCountForMode(mode) {
  return normalizeMode(mode).split("v").length;
}

function teamForSlot(room, slot) {
  return Math.max(0, Number(slot) || 0) % teamCountForMode(room ? room.mode : "1v1");
}

function activeTeams(room) {
  const teams = new Set();
  if (!room) return teams;

  for (const player of roomPlayers(room)) {
    teams.add(teamForSlot(room, player.playerId));
  }

  if (Array.isArray(room.botSlots)) {
    for (let slot = 0; slot < room.botSlots.length; slot += 1) {
      if (room.botSlots[slot]) teams.add(teamForSlot(room, slot));
    }
  }

  return teams;
}

function occupiedCount(room) {
  return connectedCount(room) + botCount(room);
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

function privateBotSlotsFor(room, player) {
  if (!room || !Array.isArray(room.botSlots)) return Array(room ? room.maxPlayers : 0).fill(false);
  return player && player.playerId === room.hostPlayerId ? room.botSlots : Array(room.maxPlayers).fill(false);
}

function ensureRoomHost(room) {
  if (!room) return -1;
  const current = room.players[room.hostPlayerId];
  if (current && current.readyState === WebSocket.OPEN) return room.hostPlayerId;

  const nextHost = roomPlayers(room).sort((a, b) => a.playerId - b.playerId)[0] || null;
  room.hostPlayerId = nextHost ? nextHost.playerId : -1;

  for (const player of roomPlayers(room)) {
    send(player, {
      cmd: "host_migrated",
      host_player: room.hostPlayerId,
      bot_slots: privateBotSlotsFor(room, player),
      message: room.hostPlayerId >= 0 ? "Host migrated." : "No host available."
    });
  }

  return room.hostPlayerId;
}

function rematchStatus(room) {
  if (!room) return { ready: 0, required: 0 };
  if (!(room.rematchVotes instanceof Set)) room.rematchVotes = new Set();

  const connectedIds = new Set(roomPlayers(room).map((player) => player.playerId));
  for (const playerId of room.rematchVotes) {
    if (!connectedIds.has(playerId)) room.rematchVotes.delete(playerId);
  }

  return {
    ready: room.rematchVotes.size + botCount(room),
    required: connectedIds.size + botCount(room)
  };
}

function broadcastRematchStatus(room) {
  const status = rematchStatus(room);
  broadcastRoom(room, {
    cmd: "rematch_update",
    ready: status.ready,
    required: status.required
  });
  return status;
}

function startRematchIfReady(room) {
  const status = broadcastRematchStatus(room);
  if (status.required <= 0 || status.ready < status.required) return false;

  const resetSeries = Boolean(room.rematchResetSeries);
  room.rematchVotes.clear();
  room.rematchResetSeries = false;
  room.state = "playing";
  broadcastRoom(room, {
    cmd: "rematch_start",
    reset_series: resetSeries,
    ready: status.ready,
    required: status.required
  });
  return true;
}

function sendRoomStatus(room, cmd = "lobby_update") {
  clearClosedPlayers(room);
  const count = connectedCount(room);

  for (const player of roomPlayers(room)) {
    send(player, {
      cmd,
      code: room.code,
      player: player.playerId,
      host_player: room.hostPlayerId,
      mode: room.mode,
      connected_players: occupiedCount(room),
      required_players: room.maxPlayers,
      bot_slots: privateBotSlotsFor(room, player),
      skins: room.skins,
      state: room.state,
      token: player.reconnectToken || "",
      owner_player: Number.isInteger(room.ownerPlayerId) ? room.ownerPlayerId : -1
    });
  }
}

function startRoomIfReady(room) {
  clearClosedPlayers(room);
  if (occupiedCount(room) < room.maxPlayers) return;
  room.state = "playing";
  if (room.rematchVotes instanceof Set) room.rematchVotes.clear();
  room.rematchResetSeries = false;

  for (const player of roomPlayers(room)) {
    send(player, {
      cmd: "start",
      code: room.code,
      player: player.playerId,
      host_player: room.hostPlayerId,
      mode: room.mode,
      connected_players: occupiedCount(room),
      required_players: room.maxPlayers,
      bot_slots: privateBotSlotsFor(room, player),
      skins: room.skins,
      state: room.state,
      token: player.reconnectToken || "",
      owner_player: Number.isInteger(room.ownerPlayerId) ? room.ownerPlayerId : -1
    });
  }
}

function findOpenSlot(room) {
  clearClosedPlayers(room);
  for (let i = 0; i < room.maxPlayers; i += 1) {
    if (!room.players[i] && !(room.botSlots && room.botSlots[i])) return i;
  }
  return -1;
}

function fillRoomWithBots(room) {
  if (!room || room.state === "playing") return;
  clearClosedPlayers(room);
  if (!Array.isArray(room.botSlots)) room.botSlots = Array(room.maxPlayers).fill(false);

  for (let i = 0; i < room.maxPlayers; i += 1) {
    if (!room.players[i]) room.botSlots[i] = true;
  }

  startRoomIfReady(room);
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
    connected_players: occupiedCount(room),
    required_players: room.maxPlayers,
    open_slots: Math.max(0, room.maxPlayers - occupiedCount(room)),
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
  const botSlots = Array(maxPlayers).fill(false);

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
    botSlots,
    hostPlayerId: 0,
    rematchVotes: new Set(),
    rematchResetSeries: false,
    ownerPlayerId: -1,
    state: "open",
    createdAt: Date.now(),
    expiresAt: Date.now() + CODE_TTL_MS
  };

  rooms.set(code, room);
  send(ws, {
    cmd: "hosted",
    code,
    player: 0,
    host_player: 0,
    mode,
    connected_players: 1,
    required_players: maxPlayers,
    bot_slots: botSlots,
    skins,
    state: room.state,
    token: ws.reconnectToken,
    owner_player: -1
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
  if (room.botSlots) room.botSlots[slot] = false;
  room.skins[slot] = ws.skin;
  room.tokens[slot] = ws.reconnectToken;
  room.disconnectedUntil[slot] = 0;

  send(ws, {
    cmd,
    code: room.code,
    player: slot,
    host_player: room.hostPlayerId,
    mode: room.mode,
    connected_players: occupiedCount(room),
    required_players: room.maxPlayers,
    bot_slots: privateBotSlotsFor(room, ws),
    skins: room.skins,
    state: room.state,
    token: ws.reconnectToken,
    owner_player: Number.isInteger(room.ownerPlayerId) ? room.ownerPlayerId : -1
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

  replaySummaries.unshift({
    id: `${result.code}-${Date.now().toString(36)}`,
    code: result.code,
    mode: result.mode,
    winner_team: result.winner_team,
    duration_seconds: result.duration_seconds,
    team_wins: result.team_wins,
    players: result.players,
    created_at: result.created_at
  });
  while (replaySummaries.length > HISTORY_LIMIT) replaySummaries.pop();

  return result;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      rooms: rooms.size,
      open_rooms: openLobbies().length,
      players: Array.from(rooms.values()).reduce((sum, room) => sum + connectedCount(room), 0),
      latest_version: LATEST_VERSION,
      min_client_version: MIN_CLIENT_VERSION,
      release_url: RELEASE_URL,
      download_url: publicDownloadUrl(req),
      private_release_proxy: USE_RELEASE_PROXY,
      github_private_access_configured: Boolean(GITHUB_TOKEN),
      owner_auth_configured: Boolean(OWNER_SECRET),
      uptime_seconds: Math.floor(process.uptime())
    });
    return;
  }

  if (url.pathname === "/launcher-release") {
    sendJson(res, 200, await launcherReleasePayload(req));
    return;
  }

  if (url.pathname.startsWith("/download/")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const tag = decodeURIComponent(parts[1] || RELEASE_TAG);
    const assetName = decodeURIComponent(parts.slice(2).join("/") || DOWNLOAD_ASSET_NAME);
    await streamGithubReleaseAsset(req, res, tag, assetName);
    return;
  }

  if (url.pathname === "/lobbies") {
    sendJson(res, 200, {
      ok: true,
      lobbies: openLobbies(url.searchParams.get("mode") || "")
    });
    return;
  }

  if (url.pathname === "/history") {
    sendJson(res, 200, {
      ok: true,
      history: matchHistory.slice(0, 20)
    });
    return;
  }

  if (url.pathname === "/replays") {
    sendJson(res, 200, {
      ok: true,
      replays: replaySummaries.slice(0, 20)
    });
    return;
  }

  if (url.pathname === "/news") {
    sendJson(res, 200, {
      ok: true,
      news: serverNews.slice(0, 10)
    });
    return;
  }

  if (url.pathname === "/friends" && req.method === "GET") {
    const playerId = sanitizeId(url.searchParams.get("player_id"));
    sendJson(res, 200, {
      ok: true,
      player_id: playerId,
      friends: playerId ? getFriendArray(playerId) : []
    });
    return;
  }

  if (url.pathname === "/friends/add" && req.method === "POST") {
    const body = await readJson(req);
    const playerId = sanitizeId(body.player_id);
    const friendId = sanitizeId(body.friend_id);

    if (!playerId || !friendId || playerId === friendId) {
      sendJson(res, 400, { ok: false, message: "Invalid friend id." });
      return;
    }

    const friends = addFriend(playerId, friendId, body.friend_name || friendId);
    addFriend(friendId, playerId, body.player_name || playerId);
    sendJson(res, 200, { ok: true, friends });
    return;
  }

  if (url.pathname === "/invites" && req.method === "GET") {
    cleanupInvites();
    const playerId = sanitizeId(url.searchParams.get("player_id"));
    sendJson(res, 200, {
      ok: true,
      invites: invites.filter((invite) => invite.to_id === playerId).slice(0, 10)
    });
    return;
  }

  if (url.pathname === "/invites" && req.method === "POST") {
    cleanupInvites();
    const body = await readJson(req);
    const fromId = sanitizeId(body.from_id);
    const toId = sanitizeId(body.to_id);
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const mode = normalizeMode(body.mode || "1v1");

    if (!fromId || !toId || !code) {
      sendJson(res, 400, { ok: false, message: "Invite needs from_id, to_id and code." });
      return;
    }

    const invite = {
      from_id: fromId,
      from_name: sanitizeName(body.from_name || fromId),
      to_id: toId,
      code,
      mode,
      created_at: new Date().toISOString(),
      expires_at_ms: Date.now() + 1000 * 60 * 10
    };

    invites.unshift(invite);
    while (invites.length > 100) invites.pop();
    sendJson(res, 200, { ok: true, invite });
    return;
  }

  if (url.pathname === "/cloud-save" && req.method === "GET") {
    const playerId = sanitizeId(url.searchParams.get("player_id"));
    const save = playerId ? cloudSaves.get(playerId) : null;
    if (!save) {
      sendJson(res, 404, { ok: false, message: "Cloud save not found." });
      return;
    }

    sendJson(res, 200, { ok: true, save });
    return;
  }

  if (url.pathname === "/cloud-save" && req.method === "POST") {
    const body = await readJson(req);
    const playerId = sanitizeId(body.player_id);
    if (!playerId || !body.data || typeof body.data !== "object") {
      sendJson(res, 400, { ok: false, message: "Cloud save needs player_id and data." });
      return;
    }

    const save = {
      player_id: playerId,
      player_name: sanitizeName(body.player_name || playerId),
      data: body.data,
      updated_at: new Date().toISOString()
    };

    cloudSaves.set(playerId, save);
    sendJson(res, 200, { ok: true, save });
    return;
  }

  if (url.pathname === "/latest-version") {
    sendJson(res, 200, {
      ok: true,
      latest_version: LATEST_VERSION,
      min_client_version: MIN_CLIENT_VERSION,
      release_url: RELEASE_URL,
      download_url: publicDownloadUrl(req),
      private_release_proxy: USE_RELEASE_PROXY,
      github_private_access_configured: Boolean(GITHUB_TOKEN)
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("SpaceRocks Windows Relay online");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  ws.playerId = -1;
  ws.roomCode = "";
  ws.skin = 0;
  ws.reconnectToken = "";
  ws.downloadUrl = publicDownloadUrl(req);
  ws.isOwner = false;

  ws.on("message", (raw) => {
    const msg = safeJson(String(raw).replace(/\0/g, "").trim());
    if (!msg || typeof msg.cmd !== "string") {
      send(ws, { cmd: "error", message: "Bad packet." });
      return;
    }

    if (msg.cmd === "owner_auth") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      const authorized = ownerSecretMatches(msg.secret);
      ws.isOwner = authorized;

      if (authorized && room && ws.playerId >= 0) {
        room.ownerPlayerId = ws.playerId;
        broadcastRoom(room, { cmd: "owner_badge", player: ws.playerId });
      }

      send(ws, {
        cmd: "owner_status",
        authorized,
        player: authorized ? ws.playerId : -1,
        message: authorized ? "Owner access granted." : "Owner access denied."
      });
      return;
    }

    if (msg.cmd === "owner_command") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!room || !ws.isOwner || room.ownerPlayerId !== ws.playerId) {
        send(ws, { cmd: "owner_status", authorized: false, player: -1, message: "Owner command denied." });
        return;
      }

      const commandText = String(msg.text || "").trim().slice(0, 120);
      const parts = commandText.split(/\s+/);
      const command = String(parts.shift() || "").replace(/^\//, "").toLowerCase();

      if (command === "heal") {
        broadcastRoom(room, { cmd: "owner_command", command: "heal", player: ws.playerId });
        return;
      }

      if (command === "teamwin") {
        const winnerTeam = Math.max(0, Math.min(teamCountForMode(room.mode) - 1, (Number(parts[0]) || 1) - 1));
        broadcastRoom(room, { cmd: "owner_command", command: "teamwin", team: winnerTeam });
        return;
      }

      if (command === "kick") {
        const targetSlot = Math.max(0, Math.min(room.maxPlayers - 1, (Number(parts[0]) || 1) - 1));
        const target = room.players[targetSlot];
        if (target && target !== ws && target.readyState === WebSocket.OPEN) {
          send(target, { cmd: "owner_command", command: "kicked", message: "Removed by owner." });
          target.close(4001, "Removed by owner");
        }
        return;
      }

      if (command === "announce") {
        const announcement = parts.join(" ").replace(/[^\w \-!?.,:]/g, "").slice(0, 80);
        if (announcement) broadcastRoom(room, { cmd: "owner_command", command: "announce", message: announcement });
        return;
      }

      send(ws, {
        cmd: "owner_status",
        authorized: true,
        player: ws.playerId,
        message: "Commands: /heal, /teamwin 1, /kick 2, /announce text"
      });
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
        if (room && joinRoom(ws, room, msg, "lobby")) {
          fillRoomWithBots(room);
          return;
        }
      }

      const room = createRoomForHost(ws, { ...msg, mode });
      setTimeout(() => {
        if (rooms.get(room.code) === room && room.state === "open") fillRoomWithBots(room);
      }, QUICK_MATCH_WAIT_MS);
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

      if (room.state !== "open") {
        send(ws, { cmd: "error", message: "Match already started." });
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
      if (room.botSlots) room.botSlots[slot] = false;
      room.skins[slot] = ws.skin;
      room.disconnectedUntil[slot] = 0;
      if (room.hostPlayerId < 0) ensureRoomHost(room);

      send(ws, {
        cmd: "reconnected",
        code: room.code,
        player: slot,
        host_player: room.hostPlayerId,
        mode: room.mode,
        connected_players: occupiedCount(room),
        required_players: room.maxPlayers,
        bot_slots: privateBotSlotsFor(room, ws),
        skins: room.skins,
        state: room.state,
        token,
        owner_player: Number.isInteger(room.ownerPlayerId) ? room.ownerPlayerId : -1
      });

      sendRoomStatus(room, "lobby_update");
      if (room.state === "playing") {
        send(ws, {
          cmd: "start",
          code: room.code,
          player: slot,
          host_player: room.hostPlayerId,
          mode: room.mode,
          connected_players: occupiedCount(room),
          required_players: room.maxPlayers,
          bot_slots: privateBotSlotsFor(room, ws),
          skins: room.skins,
          state: room.state,
          token,
          owner_player: Number.isInteger(room.ownerPlayerId) ? room.ownerPlayerId : -1
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

    if (msg.cmd === "bot_input") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!room || ws.playerId !== room.hostPlayerId) return;
      const botPlayer = Math.max(0, Math.min(room.maxPlayers - 1, Math.floor(Number(msg.player || 0))));
      if (!room.botSlots || !room.botSlots[botPlayer]) return;
      broadcastRoom(room, { cmd: "input", player: botPlayer, input: msg.input || {}, frame: msg.frame || 0 }, ws);
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
      if (!room || ws.playerId !== room.hostPlayerId) return;
      broadcastRoom(room, { cmd: "snapshot", snapshot: msg.snapshot || {} }, ws);
      return;
    }

    if (msg.cmd === "match_result") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!room || ws.playerId !== room.hostPlayerId) return;
      const result = saveMatchResult(room, msg);
      room.state = "finished";
      broadcastRoom(room, { cmd: "match_result", result }, null);
      return;
    }

    if (msg.cmd === "rematch_vote") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!room || ws.playerId < 0) return;
      if (!(room.rematchVotes instanceof Set)) room.rematchVotes = new Set();
      room.rematchVotes.add(ws.playerId);
      room.rematchResetSeries = room.rematchResetSeries || Boolean(msg.reset_series);
      startRematchIfReady(room);
    }
  });

  ws.on("close", () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    if (ws.playerId >= 0 && ws.playerId < room.players.length) {
      room.players[ws.playerId] = null;
      room.disconnectedUntil[ws.playerId] = Date.now() + RECONNECT_TTL_MS;
      if (room.rematchVotes instanceof Set) room.rematchVotes.delete(ws.playerId);
    }

    const oldHost = room.hostPlayerId;
    if (ws.isOwner && room.ownerPlayerId === ws.playerId) {
      room.ownerPlayerId = -1;
      broadcastRoom(room, { cmd: "owner_badge", player: -1 }, ws);
    }
    const newHost = ensureRoomHost(room);
    broadcastRoom(room, {
      cmd: "player_disconnected",
      player: ws.playerId,
      host_player: newHost,
      reconnect_seconds: Math.floor(RECONNECT_TTL_MS / 1000),
      message: "Player disconnected. Match continues."
    }, ws);


    if (room.state === "open") {
      sendRoomStatus(room);
      return;
    }

    if (room.state === "playing") {
      const teams = activeTeams(room);
      if (teams.size === 1) {
        const winnerTeam = Array.from(teams)[0];
        room.state = "round_over";
        broadcastRoom(room, {
          cmd: "round_forfeit",
          winner_team: winnerTeam,
          disconnected_player: ws.playerId,
          message: `Team ${winnerTeam + 1} wins by disconnect.`
        });
      } else if (teams.size === 0 && oldHost >= 0) {
        room.state = "finished";
      }
    }

    if (room.state === "finished" || room.state === "round_over") {
      startRematchIfReady(room);
    }
  });
});

setInterval(cleanupExpiredRooms, 30000);

server.listen(PORT, () => {
  console.log(`SpaceRocks Windows relay listening on ${PORT}`);
});

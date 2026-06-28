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
const PLAYER_REPLAY_LIMIT = 10;
const REPLAY_STORE_LIMIT = 100;
const REPLAY_MAX_FRAMES = 1800;
const MAX_SPECTATORS_PER_MATCH = 32;
const MAX_TEAM_SIZE = 100;
const MAX_PLAYERS = 200;
const LATEST_VERSION = process.env.SPACEROCKS_LATEST_VERSION || "1.0.8";
const MIN_CLIENT_VERSION = process.env.SPACEROCKS_MIN_CLIENT_VERSION || "1.0.8";
const RELEASE_URL = process.env.SPACEROCKS_RELEASE_URL || "https://github.com/nxn7gmcgmt-byte/SpaceRocks/releases/latest";
const DOWNLOAD_URL = process.env.SPACEROCKS_DOWNLOAD_URL || "https://github.com/nxn7gmcgmt-byte/SpaceRocks/releases/latest";
const GITHUB_OWNER = process.env.SPACEROCKS_GITHUB_OWNER || "nxn7gmcgmt-byte";
const GITHUB_REPO = process.env.SPACEROCKS_GITHUB_REPO || "SpaceRocks";
const GITHUB_TOKEN = process.env.SPACEROCKS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
const RELEASE_TAG = process.env.SPACEROCKS_RELEASE_TAG || `v${LATEST_VERSION}`;
const DOWNLOAD_ASSET_NAME = process.env.SPACEROCKS_DOWNLOAD_ASSET_NAME || `SpaceRocks-v${LATEST_VERSION}-windows.zip`;
const USE_RELEASE_PROXY = process.env.SPACEROCKS_USE_RELEASE_PROXY !== "false";
const OWNER_SECRET = process.env.SPACEROCKS_OWNER_SECRET || "";
const OWNER_PLAYER_ID = String(process.env.SPACEROCKS_OWNER_PLAYER_ID || "").toUpperCase();
const OWNER_ACCOUNT = String(process.env.SPACEROCKS_OWNER_ACCOUNT || "").toLowerCase();
const SEEDED_BANS = process.env.SPACEROCKS_BANNED_PLAYERS || "";
const GOOGLE_CLIENT_ID = process.env.SPACEROCKS_GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.SPACEROCKS_GOOGLE_CLIENT_SECRET || "";
const GITHUB_OAUTH_CLIENT_ID = process.env.SPACEROCKS_GITHUB_OAUTH_CLIENT_ID || "";
const GITHUB_OAUTH_CLIENT_SECRET = process.env.SPACEROCKS_GITHUB_OAUTH_CLIENT_SECRET || "";
const APPLE_CLIENT_ID = process.env.SPACEROCKS_APPLE_CLIENT_ID || "";
const APPLE_TEAM_ID = process.env.SPACEROCKS_APPLE_TEAM_ID || "";
const APPLE_KEY_ID = process.env.SPACEROCKS_APPLE_KEY_ID || "";
const APPLE_PRIVATE_KEY = String(process.env.SPACEROCKS_APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const APPLE_CLIENT_SECRET = process.env.SPACEROCKS_APPLE_CLIENT_SECRET || "";
const AUTH_REQUIRED = process.env.SPACEROCKS_AUTH_REQUIRED === "true";
const AUTH_TOKEN_SECRET = process.env.SPACEROCKS_AUTH_TOKEN_SECRET || OWNER_SECRET;
const CLOUD_GITHUB_REPO = process.env.SPACEROCKS_CLOUD_GITHUB_REPO || "spacerocks-windows-relay-server";
const CLOUD_GITHUB_BRANCH = process.env.SPACEROCKS_CLOUD_GITHUB_BRANCH || "player-data";
const CLOUD_GITHUB_PATH = process.env.SPACEROCKS_CLOUD_GITHUB_PATH || "cloud-saves.json";
const AUTH_REQUEST_TTL_MS = 1000 * 60 * 10;
const AUTH_SESSION_TTL_MS = 1000 * 60 * 60 * 24;
const SCORE_SESSION_TTL_MS = 1000 * 60 * 60 * 6;
const SCORE_MAX_SUBMISSIONS = 260;

const rooms = new Map();
const scoreSessions = new Map();
const matchHistory = [];
const cloudSaves = new Map();
const friendLists = new Map();
const invites = [];
const replaySummaries = [];
const replayStore = new Map();
const replayByPlayer = new Map();
const bannedPlayers = new Map();
const authRequests = new Map();
const authSessions = new Map();
const serverNews = [
  {
    title: "Geschuetzte Online-Bestenlisten",
    text: "Online-Rekorde werden nur noch aus einer frischen, servergeprueften Spielrunde angenommen.",
    created_at: new Date().toISOString()
  },
  {
    title: "SpaceRocks Online v1.0.8",
    text: "Revanche-Abstimmung, sichere Disconnects und Owner-Rang sind online.",
    created_at: new Date().toISOString()
  },
  {
    title: "Kein PC-Server noetig",
    text: "Der Relay-Server laeuft extern ueber Render. Dein PC muss nur das Spiel starten.",
    created_at: new Date().toISOString()
  }
];

function scoreLeaderboardId(kind, wave) {
  if (kind === "score") return 34945;
  if (kind === "waves") return 34947;
  if (kind === "combo") return 34948;
  if (kind !== "wave_times") return 0;

  const safeWave = Math.floor(Number(wave || 0));
  if (safeWave < 1 || safeWave > 200) return 0;
  if (safeWave === 1) return 34957;
  if (safeWave >= 2 && safeWave <= 10) return 34956 + safeWave;
  if (safeWave >= 11 && safeWave <= 21) return 34957 + safeWave;
  if (safeWave >= 22 && safeWave <= 40) return 34958 + safeWave;
  if (safeWave <= 122) return 35108 + (safeWave - 41);
  return 35191 + (safeWave - 123);
}

function cleanScoreSessions() {
  const now = Date.now();
  for (const [token, session] of scoreSessions.entries()) {
    if (!session || now - session.createdAt > SCORE_SESSION_TTL_MS) scoreSessions.delete(token);
  }
}

function scoreSubmissionError(session, body) {
  const kind = String(body.kind || "").toLowerCase();
  const score = Math.floor(Number(body.score));
  const wave = Math.floor(Number(body.wave || 0));
  const runScore = Math.floor(Number(body.run_score || 0));
  const runWave = Math.floor(Number(body.run_wave || 0));
  const runCombo = Math.floor(Number(body.run_combo || 0));
  const waveTime = Math.floor(Number(body.run_wave_time || 0));
  const elapsedMs = Math.max(0, Date.now() - session.createdAt);
  const elapsedSeconds = elapsedMs / 1000;

  if (!Number.isSafeInteger(score) || score <= 0) return "Invalid score.";
  if (session.submissions >= SCORE_MAX_SUBMISSIONS) return "Too many submissions for this run.";
  if (runScore < 0 || runWave < 0 || runCombo < 0) return "Invalid run summary.";
  if (runWave > 200) return "Wave is outside the supported range.";
  if (runScore > 50000 + elapsedSeconds * 100000) return "Score is not plausible for this run time.";
  if (runCombo > 1000 + elapsedSeconds * 100) return "Combo is not plausible for this run time.";
  if (runWave > 1 + Math.floor(elapsedSeconds * 4)) return "Wave progress is too fast.";

  if (kind === "score" && score !== runScore) return "Score does not match the active run.";
  if (kind === "waves" && score !== runWave) return "Wave record does not match the active run.";
  if (kind === "combo" && score !== runCombo) return "Combo does not match the active run.";
  if (kind === "wave_times") {
    if (wave < 1 || wave > runWave) return "Wave time does not belong to the active run.";
    if (score !== waveTime) return "Wave time does not match the active run.";
    if (score < 250 || score > 60 * 60 * 1000) return "Wave time is outside the allowed range.";
    if (elapsedMs + 2000 < score) return "Wave time exceeds the active session time.";
  }

  if (!scoreLeaderboardId(kind, wave)) return "Leaderboard kind is not protected or configured.";
  return "";
}

async function submitProtectedLootLockerScore(session, body) {
  const kind = String(body.kind || "").toLowerCase();
  const wave = Math.floor(Number(body.wave || 0));
  const score = Math.floor(Number(body.score));
  const leaderboardId = scoreLeaderboardId(kind, wave);
  const lootLockerToken = String(body.lootlocker_session_token || "").trim();
  if (!lootLockerToken) throw new Error("LootLocker session is missing.");

  const fingerprint = `${kind}:${wave}:${score}`;
  if (session.uploads.has(fingerprint)) return { score, duplicate: true };

  const response = await fetch(`https://api.lootlocker.io/game/leaderboards/${leaderboardId}/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-token": lootLockerToken
    },
    body: JSON.stringify({ score })
  });
  const responseText = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`LootLocker ${response.status}: ${responseText.slice(0, 160)}`);

  session.uploads.add(fingerprint);
  session.submissions += 1;
  session.lastSeenAt = Date.now();
  let result = {};
  if (responseText.trim()) {
    try { result = JSON.parse(responseText); } catch { result = {}; }
  }
  return { ...result, score, leaderboard_id: leaderboardId, protected: true };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

function ownerAccountMatches(ws) {
  if (!ws) return false;
  if (OWNER_ACCOUNT) {
    const accountId = String(ws.accountId || "").toLowerCase();
    const accountEmail = String(ws.accountEmail || "").toLowerCase();
    return accountId === OWNER_ACCOUNT || accountEmail === OWNER_ACCOUNT;
  }
  const safeId = sanitizeId(ws.onlineId);
  return Boolean(OWNER_PLAYER_ID) && safeId === sanitizeId(OWNER_PLAYER_ID);
}

function cleanAuthState() {
  const now = Date.now();
  for (const [state, request] of authRequests.entries()) {
    if (!request || now - request.createdAt > AUTH_REQUEST_TTL_MS) authRequests.delete(state);
  }
  for (const [token, session] of authSessions.entries()) {
    if (!session || now - session.createdAt > AUTH_SESSION_TTL_MS) authSessions.delete(token);
  }
}

function authSessionForToken(token) {
  cleanAuthState();
  return authSessions.get(String(token || "")) || signedAuthSessionForToken(token);
}

function accountOnlineId(session) {
  if (!session) return "";
  const prefix = session.provider === "apple" ? "A" : session.provider === "github" ? "H" : "G";
  return sanitizeId(`${prefix}${session.provider_id || session.account_id}`);
}

function requestAuthContext(req, requestedPlayerId = "") {
  const authorization = String((req && req.headers && req.headers.authorization) || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const session = authSessionForToken(match ? match[1] : "");
  if (session) return { session, playerId: accountOnlineId(session) };
  if (!AUTH_REQUIRED) return { session: null, playerId: sanitizeId(requestedPlayerId) };
  return null;
}

function requireRequestAuth(req, res, requestedPlayerId = "") {
  const context = requestAuthContext(req, requestedPlayerId);
  if (context) return context;
  sendJson(res, 401, { ok: false, message: "Bitte zuerst mit Google, Apple oder GitHub anmelden." });
  return null;
}

function authenticateSocket(ws, msg) {
  applyConnectionIdentity(ws, msg);
  const session = authSessionForToken(msg && msg.auth_token);
  if (session) {
    ws.authToken = String(msg.auth_token);
    ws.accountId = String(session.account_id || "");
    ws.accountEmail = String(session.email || "");
    ws.playerName = sanitizeName(session.name || ws.playerName);
    ws.onlineId = accountOnlineId(session);
    return true;
  }
  if (!AUTH_REQUIRED) {
    ws.accountId = ws.onlineId || "guest";
    return true;
  }
  send(ws, { cmd: "auth_required", message: "Bitte zuerst mit Google, Apple oder GitHub anmelden." });
  return false;
}

function googleAuthConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

function appleAuthConfigured() {
  return Boolean(APPLE_CLIENT_ID && (APPLE_CLIENT_SECRET || (APPLE_TEAM_ID && APPLE_KEY_ID && APPLE_PRIVATE_KEY)));
}

function githubAuthConfigured() {
  return Boolean(GITHUB_OAUTH_CLIENT_ID && GITHUB_OAUTH_CLIENT_SECRET);
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function issueAuthSession(account) {
  const createdAt = Date.now();
  const session = { ...account, createdAt };
  const payload = base64Url(JSON.stringify({ ...account, iat: createdAt, exp: createdAt + AUTH_SESSION_TTL_MS }));
  if (!AUTH_TOKEN_SECRET) {
    const temporaryToken = makeToken() + makeToken();
    authSessions.set(temporaryToken, session);
    return temporaryToken;
  }
  const signature = crypto.createHmac("sha256", AUTH_TOKEN_SECRET).update(payload).digest("base64url");
  const token = `${payload}.${signature}`;
  authSessions.set(token, session);
  return token;
}

function signedAuthSessionForToken(token) {
  if (!AUTH_TOKEN_SECRET) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac("sha256", AUTH_TOKEN_SECRET).update(parts[0]).digest();
  let provided;
  try { provided = Buffer.from(parts[1], "base64url"); } catch { return null; }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { return null; }
  if (!payload || Number(payload.exp || 0) <= Date.now() || !payload.provider_id || !payload.provider) return null;
  return {
    provider: String(payload.provider),
    provider_id: String(payload.provider_id),
    account_id: String(payload.account_id || `${payload.provider}:${payload.provider_id}`),
    email: String(payload.email || "").toLowerCase(),
    name: sanitizeName(payload.name || payload.email || "SPIELER"),
    createdAt: Number(payload.iat || Date.now())
  };
}

function appleClientSecret() {
  if (APPLE_CLIENT_SECRET) return APPLE_CLIENT_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: APPLE_KEY_ID }));
  const payload = base64Url(JSON.stringify({
    iss: APPLE_TEAM_ID,
    iat: now,
    exp: now + 60 * 60 * 24 * 30,
    aud: "https://appleid.apple.com",
    sub: APPLE_CLIENT_ID
  }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: APPLE_PRIVATE_KEY,
    dsaEncoding: "ieee-p1363"
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function decodeJwtPart(value) {
  try { return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8")); } catch { return {}; }
}

async function verifyAppleIdToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("Apple identity token is invalid.");
  const header = decodeJwtPart(parts[0]);
  const claims = decodeJwtPart(parts[1]);
  const keysResponse = await fetch("https://appleid.apple.com/auth/keys");
  const keysData = await keysResponse.json().catch(() => ({}));
  const jwk = Array.isArray(keysData.keys) ? keysData.keys.find((key) => key.kid === header.kid) : null;
  if (!jwk) throw new Error("Apple signing key was not found.");
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const verified = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2], "base64url")
  );
  const now = Math.floor(Date.now() / 1000);
  if (!verified || claims.iss !== "https://appleid.apple.com" || claims.aud !== APPLE_CLIENT_ID || Number(claims.exp || 0) <= now) {
    throw new Error("Apple identity verification failed.");
  }
  return claims;
}

async function exchangeGoogleCode(code, redirectUri) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: String(code || ""),
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.id_token) throw new Error("Google token exchange failed.");

  const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenData.id_token)}`);
  const profile = await verifyResponse.json().catch(() => ({}));
  if (!verifyResponse.ok || String(profile.aud || "") !== GOOGLE_CLIENT_ID || !profile.sub) {
    throw new Error("Google identity verification failed.");
  }
  return {
    provider: "google",
    provider_id: String(profile.sub),
    account_id: `google:${profile.sub}`,
    email: String(profile.email || "").toLowerCase(),
    name: sanitizeName(profile.name || profile.email || "SPIELER")
  };
}

async function exchangeGithubCode(code, redirectUri) {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      client_secret: GITHUB_OAUTH_CLIENT_SECRET,
      code: String(code || ""),
      redirect_uri: redirectUri
    })
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.access_token) throw new Error("GitHub token exchange failed.");

  const githubHeaders = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${tokenData.access_token}`,
    "User-Agent": "SpaceRocks-Login",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const profileResponse = await fetch("https://api.github.com/user", { headers: githubHeaders });
  const profile = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok || !profile.id) throw new Error("GitHub identity verification failed.");

  let email = String(profile.email || "").toLowerCase();
  if (!email) {
    const emailResponse = await fetch("https://api.github.com/user/emails", { headers: githubHeaders });
    const emails = await emailResponse.json().catch(() => []);
    if (emailResponse.ok && Array.isArray(emails)) {
      const selected = emails.find((item) => item && item.primary && item.verified)
        || emails.find((item) => item && item.verified);
      if (selected) email = String(selected.email || "").toLowerCase();
    }
  }

  return {
    provider: "github",
    provider_id: String(profile.id),
    account_id: `github:${profile.id}`,
    email,
    name: sanitizeName(profile.name || profile.login || "SPIELER")
  };
}

async function exchangeAppleCode(code, redirectUri, suppliedUser = "") {
  const tokenResponse = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: String(code || ""),
      client_id: APPLE_CLIENT_ID,
      client_secret: appleClientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.id_token) throw new Error("Apple token exchange failed.");
  const claims = await verifyAppleIdToken(tokenData.id_token);
  let suppliedName = "";
  try {
    const user = JSON.parse(String(suppliedUser || "{}"));
    suppliedName = [user.name && user.name.firstName, user.name && user.name.lastName].filter(Boolean).join(" ");
  } catch {}
  return {
    provider: "apple",
    provider_id: String(claims.sub),
    account_id: `apple:${claims.sub}`,
    email: String(claims.email || "").toLowerCase(),
    name: sanitizeName(suppliedName || claims.email || "SPIELER")
  };
}

let cloudSavesLoaded = false;
let cloudSavePersistQueue = Promise.resolve();

function cloudGithubHeaders() {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${GITHUB_TOKEN}`,
    "User-Agent": "SpaceRocks-Cloud-Save",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function cloudGithubUrl() {
  const safePath = CLOUD_GITHUB_PATH.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(CLOUD_GITHUB_REPO)}/contents/${safePath}`;
}

async function ensureCloudSavesLoaded() {
  if (cloudSavesLoaded) return;
  if (!GITHUB_TOKEN) throw new Error("Cloud persistence token is missing.");
  const response = await fetch(`${cloudGithubUrl()}?ref=${encodeURIComponent(CLOUD_GITHUB_BRANCH)}`, {
    headers: cloudGithubHeaders()
  });
  if (response.status === 404) {
    cloudSavesLoaded = true;
    return;
  }
  const file = await response.json().catch(() => ({}));
  if (!response.ok || !file.content) throw new Error("Cloud save storage could not be loaded.");
  const parsed = JSON.parse(Buffer.from(String(file.content).replace(/\s/g, ""), "base64").toString("utf8"));
  const saves = parsed && parsed.saves && typeof parsed.saves === "object" ? parsed.saves : {};
  for (const [playerId, save] of Object.entries(saves)) {
    if (save && typeof save === "object") cloudSaves.set(sanitizeId(playerId), save);
  }
  cloudSavesLoaded = true;
}

async function persistCloudSavesNow() {
  if (!GITHUB_TOKEN) throw new Error("Cloud persistence token is missing.");
  const readResponse = await fetch(`${cloudGithubUrl()}?ref=${encodeURIComponent(CLOUD_GITHUB_BRANCH)}`, {
    headers: cloudGithubHeaders()
  });
  const current = await readResponse.json().catch(() => ({}));
  if (!readResponse.ok && readResponse.status !== 404) throw new Error("Cloud save storage metadata could not be loaded.");
  const saves = Object.fromEntries(cloudSaves.entries());
  const body = {
    message: "Update SpaceRocks account cloud saves",
    content: Buffer.from(JSON.stringify({ version: 1, updated_at: new Date().toISOString(), saves }, null, 2)).toString("base64"),
    branch: CLOUD_GITHUB_BRANCH
  };
  if (current.sha) body.sha = current.sha;
  const writeResponse = await fetch(cloudGithubUrl(), {
    method: "PUT",
    headers: { ...cloudGithubHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!writeResponse.ok) throw new Error("Cloud save storage could not be persisted.");
}

function persistCloudSaves() {
  cloudSavePersistQueue = cloudSavePersistQueue.catch(() => {}).then(() => persistCloudSavesNow());
  return cloudSavePersistQueue;
}

function connectionIpHash(ws) {
  const source = String((ws && ws.remoteAddress) || "");
  if (!source) return "";
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 24);
}

function applyConnectionIdentity(ws, msg) {
  if (!ws) return;
  const onlineId = sanitizeId(msg && msg.player_id);
  const playerName = sanitizeName(msg && msg.player_name);
  if (onlineId) ws.onlineId = onlineId;
  if (playerName) ws.playerName = playerName;
  if (!ws.ipHash) ws.ipHash = connectionIpHash(ws);
}

function banRecordFor(ws, msg = {}) {
  const onlineId = sanitizeId((msg && msg.player_id) || (ws && ws.onlineId));
  const ipHash = (ws && ws.ipHash) || connectionIpHash(ws);
  if (onlineId && bannedPlayers.has(`ID:${onlineId}`)) return bannedPlayers.get(`ID:${onlineId}`);
  if (ipHash && bannedPlayers.has(`IP:${ipHash}`)) return bannedPlayers.get(`IP:${ipHash}`);
  return null;
}

function rejectBannedConnection(ws, msg = {}) {
  applyConnectionIdentity(ws, msg);
  const record = banRecordFor(ws, msg);
  if (!record) return false;
  send(ws, {
    cmd: "banned",
    message: record.reason ? `Gebannt: ${record.reason}` : "Dieser Account wurde vom Owner gebannt."
  });
  setTimeout(() => {
    try { ws.close(4003, "Banned by owner"); } catch {}
  }, 20);
  return true;
}

function addPlayerBan(target, reason, ownerId) {
  if (!target) return null;
  const onlineId = sanitizeId(target.onlineId);
  const ipHash = target.ipHash || connectionIpHash(target);
  const record = {
    player_id: onlineId,
    player_name: sanitizeName(target.playerName || onlineId || "SPIELER"),
    reason: String(reason || "Vom Owner gebannt.").replace(/[^\w \-!?.,:]/g, "").slice(0, 80),
    owner_id: sanitizeId(ownerId),
    created_at: new Date().toISOString()
  };
  if (onlineId) bannedPlayers.set(`ID:${onlineId}`, record);
  if (ipHash) bannedPlayers.set(`IP:${ipHash}`, record);
  return record;
}

function removePlayerBan(playerId) {
  const safeId = sanitizeId(playerId);
  if (!safeId) return false;
  const record = bannedPlayers.get(`ID:${safeId}`);
  if (!record) return false;
  for (const [key, value] of bannedPlayers.entries()) {
    if (value === record || sanitizeId(value && value.player_id) === safeId) bannedPlayers.delete(key);
  }
  return true;
}

function publicBanList() {
  const unique = new Map();
  for (const record of bannedPlayers.values()) {
    if (record && record.player_id) unique.set(record.player_id, record);
  }
  return Array.from(unique.values()).slice(0, 50);
}

for (const seededId of String(SEEDED_BANS).split(",")) {
  const safeId = sanitizeId(seededId);
  if (safeId) {
    bannedPlayers.set(`ID:${safeId}`, {
      player_id: safeId,
      player_name: safeId,
      reason: "Server ban",
      owner_id: sanitizeId(OWNER_PLAYER_ID),
      created_at: new Date().toISOString()
    });
  }
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

function allowOnlineEntry(ws, msg) {
  if (!clientVersionOk(msg && msg.version)) {
    rejectOldClient(ws);
    return false;
  }
  if (!authenticateSocket(ws, msg)) return false;
  if (rejectBannedConnection(ws, msg)) return false;
  return true;
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

function roomSpectators(room) {
  if (!room || !(room.spectators instanceof Set)) return [];
  const active = [];
  for (const spectator of room.spectators) {
    if (spectator && spectator.readyState === WebSocket.OPEN) active.push(spectator);
    else room.spectators.delete(spectator);
  }
  return active;
}

function broadcastSpectators(room, data) {
  for (const spectator of roomSpectators(room)) send(spectator, data);
}

function resetRoomReplay(room) {
  if (!room) return;
  room.replayFrames = [];
  room.replayHighlights = [];
  room.replayStride = 1;
  room.replaySnapshotCount = 0;
  room.replayLastKills = [];
  room.replayLastRoundWinner = -1;
  room.latestSnapshot = null;
  room.matchStartedAt = Date.now();
}

function recordRoomSnapshot(room, snapshot) {
  if (!room || !snapshot || typeof snapshot !== "object") return;
  if (!Array.isArray(room.replayFrames)) resetRoomReplay(room);

  room.latestSnapshot = snapshot;
  room.replaySnapshotCount += 1;
  const elapsed = Math.max(0, Date.now() - (room.matchStartedAt || Date.now()));
  const snapshotPlayers = Array.isArray(snapshot.players) ? snapshot.players : [];

  for (let slot = 0; slot < snapshotPlayers.length; slot += 1) {
    const kills = Math.max(0, Math.floor(Number(snapshotPlayers[slot] && snapshotPlayers[slot].kills || 0)));
    const previous = Math.max(0, Math.floor(Number(room.replayLastKills[slot] || 0)));
    if (kills > previous) {
      room.replayHighlights.push({
        type: "kill",
        t_ms: elapsed,
        player: slot,
        team: teamForSlot(room, slot),
        label: `${room.slotNames[slot] || `P${slot + 1}`} erzielt einen Abschuss`
      });
    }
    room.replayLastKills[slot] = kills;
  }

  const roundWinner = Math.floor(Number(snapshot.round_winner_team || -1));
  if (roundWinner >= 0 && roundWinner !== room.replayLastRoundWinner) {
    room.replayHighlights.push({
      type: "round",
      t_ms: elapsed,
      team: roundWinner,
      label: `Team ${roundWinner + 1} gewinnt die Runde`
    });
  }
  room.replayLastRoundWinner = roundWinner;

  if (room.replaySnapshotCount % room.replayStride !== 0) return;
  if (room.replayFrames.length >= REPLAY_MAX_FRAMES) {
    room.replayFrames = room.replayFrames.filter((_, index) => index % 2 === 0);
    room.replayStride *= 2;
  }
  room.replayFrames.push({ t_ms: elapsed, snapshot });
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
  resetRoomReplay(room);
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
      visibility: room.visibility,
      connected_players: occupiedCount(room),
      required_players: room.maxPlayers,
      bot_slots: privateBotSlotsFor(room, player),
      skins: room.skins,
      state: room.state,
      token: player.reconnectToken || "",
      owner_player: Number.isInteger(room.ownerPlayerId) ? room.ownerPlayerId : -1,
      owner_eligible: ownerAccountMatches(player)
    });
  }
}

function startRoomIfReady(room) {
  clearClosedPlayers(room);
  if (occupiedCount(room) < room.maxPlayers) return;
  room.state = "playing";
  resetRoomReplay(room);
  if (room.rematchVotes instanceof Set) room.rematchVotes.clear();
  room.rematchResetSeries = false;

  for (const player of roomPlayers(room)) {
    send(player, {
      cmd: "start",
      code: room.code,
      player: player.playerId,
      host_player: room.hostPlayerId,
      mode: room.mode,
      visibility: room.visibility,
      connected_players: occupiedCount(room),
      required_players: room.maxPlayers,
      bot_slots: privateBotSlotsFor(room, player),
      skins: room.skins,
      state: room.state,
      token: player.reconnectToken || "",
      owner_player: Number.isInteger(room.ownerPlayerId) ? room.ownerPlayerId : -1,
      owner_eligible: ownerAccountMatches(player)
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
    visibility: room.visibility,
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
    .filter((room) => room.visibility === "public")
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
  const slotOnlineIds = Array(maxPlayers).fill("");
  const slotNames = Array(maxPlayers).fill("");
  const visibility = String(msg.visibility || "private").toLowerCase() === "public" ? "public" : "private";

  ws.playerId = 0;
  ws.roomCode = code;
  ws.skin = sanitizeSkin(msg.skin);
  ws.reconnectToken = makeToken();
  players[0] = ws;
  skins[0] = ws.skin;
  tokens[0] = ws.reconnectToken;
  slotOnlineIds[0] = sanitizeId(ws.onlineId);
  slotNames[0] = sanitizeName(ws.playerName || ws.onlineId || "SPIELER");

  const room = {
    code,
    mode,
    maxPlayers,
    players,
    skins,
    tokens,
    disconnectedUntil,
    botSlots,
    slotOnlineIds,
    slotNames,
    participantIds: new Set(slotOnlineIds[0] ? [slotOnlineIds[0]] : []),
    spectators: new Set(),
    visibility,
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
    visibility,
    connected_players: 1,
    required_players: maxPlayers,
    bot_slots: botSlots,
    skins,
    state: room.state,
    token: ws.reconnectToken,
    owner_player: -1,
    owner_eligible: ownerAccountMatches(ws)
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
  room.slotOnlineIds[slot] = sanitizeId(ws.onlineId);
  room.slotNames[slot] = sanitizeName(ws.playerName || ws.onlineId || `P${slot + 1}`);
  if (room.slotOnlineIds[slot]) room.participantIds.add(room.slotOnlineIds[slot]);

  send(ws, {
    cmd,
    code: room.code,
    player: slot,
    host_player: room.hostPlayerId,
    mode: room.mode,
    visibility: room.visibility,
    connected_players: occupiedCount(room),
    required_players: room.maxPlayers,
    bot_slots: privateBotSlotsFor(room, ws),
    skins: room.skins,
    state: room.state,
    token: ws.reconnectToken,
    owner_player: Number.isInteger(room.ownerPlayerId) ? room.ownerPlayerId : -1,
    owner_eligible: ownerAccountMatches(ws)
  });

  sendRoomStatus(room);
  startRoomIfReady(room);
  return true;
}

function saveMatchResult(room, msg) {
  const replayId = `${room ? room.code : String(msg.code || "MATCH")}-${Date.now().toString(36).toUpperCase()}`;
  const sourcePlayers = Array.isArray(msg.players) ? msg.players.slice(0, MAX_PLAYERS) : [];
  const resultPlayers = sourcePlayers.map((player, slot) => ({
    ...player,
    name: sanitizeName((room && room.slotNames && room.slotNames[slot]) || player.name || `P${slot + 1}`),
    online_id: sanitizeId((room && room.slotOnlineIds && room.slotOnlineIds[slot]) || player.online_id || ""),
    team: Number.isFinite(Number(player.team)) ? Math.floor(Number(player.team)) : teamForSlot(room, slot)
  }));
  const result = {
    id: replayId,
    code: room ? room.code : String(msg.code || ""),
    mode: room ? room.mode : normalizeMode(msg.mode),
    visibility: room ? room.visibility : "private",
    winner_team: Number.isFinite(Number(msg.winner_team)) ? Number(msg.winner_team) : -1,
    duration_seconds: Math.max(0, Math.floor(Number(msg.duration_seconds || 0))),
    team_wins: Array.isArray(msg.team_wins) ? msg.team_wins.slice(0, 3) : [],
    players: resultPlayers,
    created_at: new Date().toISOString()
  };

  matchHistory.unshift(result);
  while (matchHistory.length > HISTORY_LIMIT) matchHistory.pop();

  const summary = {
    id: replayId,
    code: result.code,
    mode: result.mode,
    visibility: result.visibility,
    winner_team: result.winner_team,
    duration_seconds: result.duration_seconds,
    team_wins: result.team_wins,
    players: result.players,
    highlight_count: room && Array.isArray(room.replayHighlights) ? room.replayHighlights.length : 0,
    frame_count: room && Array.isArray(room.replayFrames) ? room.replayFrames.length : 0,
    created_at: result.created_at
  };
  replaySummaries.unshift(summary);
  while (replaySummaries.length > REPLAY_STORE_LIMIT) replaySummaries.pop();

  replayStore.set(replayId, {
    ...summary,
    frames: room && Array.isArray(room.replayFrames) ? room.replayFrames : [],
    highlights: room && Array.isArray(room.replayHighlights) ? room.replayHighlights : []
  });

  const participantIds = new Set(result.players.map((player) => sanitizeId(player.online_id)).filter(Boolean));
  if (room && room.participantIds instanceof Set) {
    for (const playerId of room.participantIds) if (playerId) participantIds.add(sanitizeId(playerId));
  }
  for (const playerId of participantIds) {
    const list = replayByPlayer.get(playerId) || [];
    list.unshift(replayId);
    replayByPlayer.set(playerId, Array.from(new Set(list)).slice(0, PLAYER_REPLAY_LIMIT));
  }

  while (replayStore.size > REPLAY_STORE_LIMIT) {
    const oldestId = replaySummaries[replaySummaries.length - 1] && replaySummaries[replaySummaries.length - 1].id;
    if (!oldestId || oldestId === replayId) break;
    replayStore.delete(oldestId);
    replaySummaries.pop();
  }

  return result;
}

function replaySummariesForPlayer(playerId) {
  const safeId = sanitizeId(playerId);
  if (!safeId) return [];
  return (replayByPlayer.get(safeId) || [])
    .map((id) => replayStore.get(id))
    .filter(Boolean)
    .slice(0, PLAYER_REPLAY_LIMIT)
    .map(({ frames, highlights, ...summary }) => summary);
}

function liveMatchSummary(room) {
  return {
    id: room.code,
    mode: room.mode,
    state: room.state,
    duration_seconds: Math.max(0, Math.floor((Date.now() - (room.matchStartedAt || room.createdAt)) / 1000)),
    players: room.slotNames.map((name, slot) => ({
      name: sanitizeName(name || `P${slot + 1}`),
      team: teamForSlot(room, slot)
    })),
    connected_players: occupiedCount(room),
    spectators: roomSpectators(room).length
  };
}

function liveMatches(mode = "") {
  const wantedMode = mode ? normalizeMode(mode) : "";
  return Array.from(rooms.values())
    .filter((room) => room.visibility === "public" && room.state === "playing")
    .filter((room) => !wantedMode || room.mode === wantedMode)
    .map(liveMatchSummary)
    .sort((left, right) => right.connected_players - left.connected_players);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (url.pathname === "/auth/start") {
    cleanAuthState();
    const provider = String(url.searchParams.get("provider") || "google").toLowerCase();
    const providerConfigured = provider === "google"
      ? googleAuthConfigured()
      : provider === "apple"
        ? appleAuthConfigured()
        : provider === "github"
          ? githubAuthConfigured()
          : false;
    if (!providerConfigured) {
      sendJson(res, 503, { ok: false, message: `${provider} Login ist noch nicht konfiguriert.` });
      return;
    }
    const state = makeToken();
    const redirectUri = `${serverOrigin(req)}/auth/callback/${provider}`;
    authRequests.set(state, { provider, status: "pending", createdAt: Date.now(), redirectUri });
    const authEndpoint = provider === "apple"
      ? "https://appleid.apple.com/auth/authorize"
      : provider === "github"
        ? "https://github.com/login/oauth/authorize"
        : "https://accounts.google.com/o/oauth2/v2/auth";
    const authUrl = new URL(authEndpoint);
    const clientId = provider === "apple" ? APPLE_CLIENT_ID : provider === "github" ? GITHUB_OAUTH_CLIENT_ID : GOOGLE_CLIENT_ID;
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", provider === "apple" ? "name email" : provider === "github" ? "read:user user:email" : "openid email profile");
    authUrl.searchParams.set("state", state);
    if (provider === "apple") authUrl.searchParams.set("response_mode", "form_post");
    else if (provider === "google") authUrl.searchParams.set("prompt", "select_account");
    sendJson(res, 200, { ok: true, provider, state, auth_url: authUrl.toString(), expires_in_seconds: 600 });
    return;
  }

  if (url.pathname === "/auth/status") {
    cleanAuthState();
    const state = String(url.searchParams.get("state") || "");
    const request = authRequests.get(state);
    if (!request) {
      sendJson(res, 404, { ok: false, status: "expired", message: "Login-Anfrage abgelaufen." });
      return;
    }
    sendJson(res, 200, {
      ok: request.status === "complete",
      status: request.status,
      message: request.message || "",
      session_token: request.status === "complete" ? request.sessionToken : "",
      account: request.status === "complete" ? request.account : null
    });
    return;
  }

  if (url.pathname === "/auth/callback/google" || url.pathname === "/auth/callback/apple" || url.pathname === "/auth/callback/github") {
    cleanAuthState();
    let callbackParams = url.searchParams;
    if (req.method === "POST") callbackParams = new URLSearchParams(await readBody(req));
    const state = String(callbackParams.get("state") || "");
    const code = String(callbackParams.get("code") || "");
    const request = authRequests.get(state);
    let title = "SpaceRocks Login fehlgeschlagen";
    let message = "Die Anmeldung konnte nicht abgeschlossen werden.";

    if (request && code) {
      try {
        const account = request.provider === "apple"
          ? await exchangeAppleCode(code, request.redirectUri, callbackParams.get("user") || "")
          : request.provider === "github"
            ? await exchangeGithubCode(code, request.redirectUri)
            : await exchangeGoogleCode(code, request.redirectUri);
        const sessionToken = issueAuthSession(account);
        request.status = "complete";
        request.sessionToken = sessionToken;
        request.account = account;
        request.message = "Anmeldung erfolgreich.";
        title = "SpaceRocks Login erfolgreich";
        message = "Du kannst dieses Fenster schliessen und zu SpaceRocks zurueckkehren.";
      } catch (error) {
        request.status = "error";
        request.message = error.message || "Google Login fehlgeschlagen.";
      }
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;background:#06111c;color:#dff8ff;text-align:center;padding:80px"><h1>${title}</h1><p>${message}</p></body></html>`);
    return;
  }

  if (url.pathname === "/auth/me") {
    const auth = requireRequestAuth(req, res);
    if (!auth || !auth.session) return;
    const { provider, provider_id, account_id, email, name } = auth.session;
    sendJson(res, 200, { ok: true, account: { provider, provider_id, account_id, email, name } });
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
      owner_account_configured: Boolean(OWNER_ACCOUNT || OWNER_PLAYER_ID),
      auth_required: AUTH_REQUIRED,
      google_auth_configured: googleAuthConfigured(),
      apple_auth_configured: appleAuthConfigured(),
      github_auth_configured: githubAuthConfigured(),
      cloud_persistence_configured: Boolean(GITHUB_TOKEN && CLOUD_GITHUB_REPO && CLOUD_GITHUB_BRANCH),
      live_matches: liveMatches().length,
      active_spectators: Array.from(rooms.values()).reduce((sum, room) => sum + roomSpectators(room).length, 0),
      banned_players: publicBanList().length,
      protected_score_sessions: scoreSessions.size,
      uptime_seconds: Math.floor(process.uptime())
    });
    return;
  }

  if (url.pathname === "/score-session/start" && req.method === "POST") {
    cleanScoreSessions();
    const body = await readJson(req);
    const gameVersion = String(body.game_version || "0").trim();
    if (!clientVersionOk(gameVersion)) {
      sendJson(res, 426, {
        ok: false,
        message: `SpaceRocks ${MIN_CLIENT_VERSION} or newer is required.`,
        min_client_version: MIN_CLIENT_VERSION
      });
      return;
    }
    const token = makeToken();
    scoreSessions.set(token, {
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      gameVersion,
      playerId: sanitizeId(body.player_id || ""),
      submissions: 0,
      uploads: new Set()
    });
    sendJson(res, 201, {
      ok: true,
      run_token: token,
      expires_in_seconds: Math.floor(SCORE_SESSION_TTL_MS / 1000)
    });
    return;
  }

  if (url.pathname === "/score-session/submit" && req.method === "POST") {
    cleanScoreSessions();
    const body = await readJson(req);
    const token = String(body.run_token || "");
    const session = scoreSessions.get(token);
    if (!session) {
      sendJson(res, 401, { ok: false, message: "Secure run session is missing or expired." });
      return;
    }

    const error = scoreSubmissionError(session, body);
    if (error) {
      sendJson(res, 422, { ok: false, message: error });
      return;
    }

    try {
      const result = await submitProtectedLootLockerScore(session, body);
      sendJson(res, 200, { ok: true, ...result });
    } catch (submitError) {
      sendJson(res, 502, { ok: false, message: submitError.message || "LootLocker upload failed." });
    }
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
    if (!requireRequestAuth(req, res)) return;
    sendJson(res, 200, {
      ok: true,
      lobbies: openLobbies(url.searchParams.get("mode") || "")
    });
    return;
  }

  if (url.pathname === "/history") {
    const auth = requireRequestAuth(req, res, url.searchParams.get("player_id"));
    if (!auth) return;
    const playerId = auth.playerId;
    const history = playerId
      ? matchHistory.filter((match) => Array.isArray(match.players) && match.players.some((player) => sanitizeId(player.online_id) === playerId)).slice(0, 10)
      : matchHistory.slice(0, 20);
    sendJson(res, 200, {
      ok: true,
      history
    });
    return;
  }

  if (url.pathname === "/replays") {
    const auth = requireRequestAuth(req, res, url.searchParams.get("player_id"));
    if (!auth) return;
    const playerId = auth.playerId;
    sendJson(res, 200, {
      ok: true,
      replays: playerId ? replaySummariesForPlayer(playerId) : replaySummaries.slice(0, 10)
    });
    return;
  }

  if (url.pathname === "/live-matches") {
    if (!requireRequestAuth(req, res)) return;
    sendJson(res, 200, {
      ok: true,
      matches: liveMatches(url.searchParams.get("mode") || "")
    });
    return;
  }

  if (url.pathname.startsWith("/replay/")) {
    const auth = requireRequestAuth(req, res, url.searchParams.get("player_id"));
    if (!auth) return;
    const replayId = decodeURIComponent(url.pathname.slice("/replay/".length));
    const replay = replayStore.get(replayId);
    if (!replay) {
      sendJson(res, 404, { ok: false, message: "Replay nicht gefunden oder Server wurde neu gestartet." });
      return;
    }
    const playerId = auth.playerId;
    const isParticipant = !playerId || replay.players.some((player) => sanitizeId(player.online_id) === playerId);
    if (!isParticipant) {
      sendJson(res, 403, { ok: false, message: "Dieses Replay gehoert nicht zu deinem Account." });
      return;
    }
    sendJson(res, 200, { ok: true, replay });
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
    const auth = requireRequestAuth(req, res, url.searchParams.get("player_id"));
    if (!auth) return;
    const playerId = auth.playerId;
    sendJson(res, 200, {
      ok: true,
      player_id: playerId,
      friends: playerId ? getFriendArray(playerId) : []
    });
    return;
  }

  if (url.pathname === "/friends/add" && req.method === "POST") {
    const body = await readJson(req);
    const auth = requireRequestAuth(req, res, body.player_id);
    if (!auth) return;
    const playerId = auth.playerId;
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
    const auth = requireRequestAuth(req, res, url.searchParams.get("player_id"));
    if (!auth) return;
    const playerId = auth.playerId;
    sendJson(res, 200, {
      ok: true,
      invites: invites.filter((invite) => invite.to_id === playerId).slice(0, 10)
    });
    return;
  }

  if (url.pathname === "/invites" && req.method === "POST") {
    cleanupInvites();
    const body = await readJson(req);
    const auth = requireRequestAuth(req, res, body.from_id);
    if (!auth) return;
    const fromId = auth.playerId;
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
    const auth = requireRequestAuth(req, res, url.searchParams.get("player_id"));
    try { await ensureCloudSavesLoaded(); } catch (error) {
      sendJson(res, 503, { ok: false, message: error.message || "Cloud persistence unavailable." });
      return;
    }
    if (!auth) return;
    const playerId = auth.playerId;
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
    const auth = requireRequestAuth(req, res, body.player_id);
    try { await ensureCloudSavesLoaded(); } catch (error) {
      sendJson(res, 503, { ok: false, message: error.message || "Cloud persistence unavailable." });
      return;
    }
    if (!auth) return;
    const playerId = auth.playerId;
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
    try {
      await persistCloudSaves();
      sendJson(res, 200, { ok: true, save });
    } catch (error) {
      sendJson(res, 503, { ok: false, message: error.message || "Cloud save could not be persisted." });
    }
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
  ws.onlineId = "";
  ws.playerName = "SPIELER";
  ws.accountId = "";
  ws.accountEmail = "";
  ws.authToken = "";
  ws.isSpectator = false;
  ws.remoteAddress = String((req.socket && req.socket.remoteAddress) || req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  ws.ipHash = connectionIpHash(ws);

  ws.on("message", (raw) => {
    const msg = safeJson(String(raw).replace(/\0/g, "").trim());
    if (!msg || typeof msg.cmd !== "string") {
      send(ws, { cmd: "error", message: "Bad packet." });
      return;
    }

    if (msg.cmd === "owner_auth") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      const authorized = ownerSecretMatches(msg.secret) && ownerAccountMatches(ws);
      ws.isOwner = authorized;

      if (authorized && room && ws.playerId >= 0) {
        room.ownerPlayerId = ws.playerId;
        broadcastRoom(room, { cmd: "owner_badge", player: ws.playerId });
      }

      send(ws, {
        cmd: "owner_status",
        authorized,
        player: authorized ? ws.playerId : -1,
        message: authorized ? "Owner access granted." : "Owner access denied: falscher Account oder Key."
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

      if (command === "players") {
        const lines = room.players.map((player, slot) => {
          if (!player || player.readyState !== WebSocket.OPEN) return `P${slot + 1}: LEER`;
          return `P${slot + 1}: ${sanitizeName(player.playerName)} ${sanitizeId(player.onlineId)}`;
        });
        send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: lines.join(" | ").slice(0, 900) });
        return;
      }

      if (command === "ban") {
        const targetSlot = Math.max(0, Math.min(room.maxPlayers - 1, (Number(parts.shift()) || 1) - 1));
        const target = room.players[targetSlot];
        if (!target || target === ws || target.readyState !== WebSocket.OPEN) {
          send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: "Ban fehlgeschlagen. Nutze /players und dann /ban SLOT GRUND." });
          return;
        }
        const record = addPlayerBan(target, parts.join(" "), ws.accountId || ws.onlineId);
        send(target, { cmd: "banned", message: record.reason ? `Gebannt: ${record.reason}` : "Vom Owner gebannt." });
        send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: `${record.player_name} (${record.player_id}) wurde gebannt.` });
        setTimeout(() => {
          try { target.close(4003, "Banned by owner"); } catch {}
        }, 40);
        return;
      }

      if (command === "unban") {
        const playerId = sanitizeId(parts[0]);
        const removed = removePlayerBan(playerId);
        send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: removed ? `${playerId} wurde entbannt.` : "Ban-ID nicht gefunden." });
        return;
      }

      if (command === "banlist") {
        const list = publicBanList();
        const text = list.length > 0 ? list.map((record) => `${record.player_name}:${record.player_id}`).join(" | ") : "Banliste ist leer.";
        send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: text.slice(0, 900) });
        return;
      }

      if (command === "unlockall") {
        const targetSlot = parts.length > 0
          ? Math.max(0, Math.min(room.maxPlayers - 1, (Number(parts[0]) || 1) - 1))
          : ws.playerId;
        const target = room.players[targetSlot];
        if (!target || target.readyState !== WebSocket.OPEN) {
          send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: "Spieler fuer /unlockall SLOT nicht gefunden." });
          return;
        }
        send(target, { cmd: "owner_command", command: "unlockall", message: "Der Owner hat alle Skins freigeschaltet." });
        send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: `Alle Skins fuer P${targetSlot + 1} freigeschaltet.` });
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
        message: "Commands: /players, /ban SLOT GRUND, /unban ID, /banlist, /unlockall SLOT, /heal, /teamwin, /kick, /announce"
      });
      return;
    }

    if (msg.cmd === "host") {
      if (!allowOnlineEntry(ws, msg)) return;
      createRoomForHost(ws, { ...msg, visibility: "private" });
      return;
    }

    if (msg.cmd === "quickjoin") {
      if (!allowOnlineEntry(ws, msg)) return;

      const mode = normalizeMode(msg.mode);
      const lobby = openLobbies(mode)[0];

      if (lobby) {
        const room = rooms.get(lobby.code);
        if (room && joinRoom(ws, room, msg, "lobby")) {
          fillRoomWithBots(room);
          return;
        }
      }

      const room = createRoomForHost(ws, { ...msg, mode, visibility: "public" });
      setTimeout(() => {
        if (rooms.get(room.code) === room && room.state === "open") fillRoomWithBots(room);
      }, QUICK_MATCH_WAIT_MS);
      return;
    }

    if (msg.cmd === "join") {
      if (!allowOnlineEntry(ws, msg)) return;

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
      if (!allowOnlineEntry(ws, msg)) return;

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
      room.slotOnlineIds[slot] = sanitizeId(ws.onlineId);
      room.slotNames[slot] = sanitizeName(ws.playerName || ws.onlineId || `P${slot + 1}`);
      if (room.slotOnlineIds[slot]) room.participantIds.add(room.slotOnlineIds[slot]);
      if (room.hostPlayerId < 0) ensureRoomHost(room);

      send(ws, {
        cmd: "reconnected",
        code: room.code,
        player: slot,
        host_player: room.hostPlayerId,
        mode: room.mode,
        visibility: room.visibility,
        connected_players: occupiedCount(room),
        required_players: room.maxPlayers,
        bot_slots: privateBotSlotsFor(room, ws),
        skins: room.skins,
        state: room.state,
        token,
        owner_player: Number.isInteger(room.ownerPlayerId) ? room.ownerPlayerId : -1,
        owner_eligible: ownerAccountMatches(ws)
      });

      sendRoomStatus(room, "lobby_update");
      if (room.state === "playing") {
        send(ws, {
          cmd: "start",
          code: room.code,
          player: slot,
          host_player: room.hostPlayerId,
          mode: room.mode,
          visibility: room.visibility,
          connected_players: occupiedCount(room),
          required_players: room.maxPlayers,
          bot_slots: privateBotSlotsFor(room, ws),
          skins: room.skins,
          state: room.state,
          token,
          owner_player: Number.isInteger(room.ownerPlayerId) ? room.ownerPlayerId : -1,
          owner_eligible: ownerAccountMatches(ws)
        });
      }
      return;
    }

    if (msg.cmd === "spectate") {
      if (!allowOnlineEntry(ws, msg)) return;
      cleanupExpiredRooms();
      const matchId = String(msg.match_id || msg.code || "").toUpperCase();
      const room = rooms.get(matchId);
      if (!room || room.visibility !== "public" || room.state !== "playing") {
        send(ws, { cmd: "error", message: "Dieses Live-Match ist nicht mehr verfuegbar." });
        return;
      }
      if (roomSpectators(room).length >= MAX_SPECTATORS_PER_MATCH) {
        send(ws, { cmd: "error", message: "Zuschauerplaetze sind voll." });
        return;
      }
      ws.roomCode = room.code;
      ws.playerId = -1;
      ws.isSpectator = true;
      room.spectators.add(ws);
      send(ws, {
        cmd: "spectator_start",
        code: room.code,
        mode: room.mode,
        required_players: room.maxPlayers,
        skins: room.skins,
        player_names: room.slotNames,
        snapshot: room.latestSnapshot,
        spectators: roomSpectators(room).length
      });
      broadcastSpectators(room, { cmd: "spectator_count", spectators: roomSpectators(room).length });
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
      const snapshot = msg.snapshot || {};
      recordRoomSnapshot(room, snapshot);
      broadcastRoom(room, { cmd: "snapshot", snapshot }, ws);
      broadcastSpectators(room, { cmd: "snapshot", snapshot });
      return;
    }

    if (msg.cmd === "match_result") {
      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
      if (!room || ws.playerId !== room.hostPlayerId) return;
      const result = saveMatchResult(room, msg);
      room.state = "finished";
      broadcastRoom(room, { cmd: "match_result", result }, null);
      broadcastSpectators(room, { cmd: "match_result", result }, null);
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
    if (ws.isSpectator) {
      if (room.spectators instanceof Set) room.spectators.delete(ws);
      broadcastSpectators(room, { cmd: "spectator_count", spectators: roomSpectators(room).length });
      return;
    }
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
setInterval(cleanScoreSessions, 60000);

server.listen(PORT, () => {
  console.log(`SpaceRocks Windows relay listening on ${PORT}`);
});


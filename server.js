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
const OWNER_GOOGLE_SUB = String(process.env.SPACEROCKS_OWNER_GOOGLE_SUB || "").trim();
const OWNER_GITHUB_ID = String(process.env.SPACEROCKS_OWNER_GITHUB_ID || "").trim();
// Owner access is bound only to stable OAuth provider IDs stored on the backend.
// Enable MFA on Google and GitHub, never share tokens, and never place OAuth secrets in GameMaker.
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
const ADMIN_RECHECK_SECONDS = 300;
const SCORE_SESSION_TTL_MS = 1000 * 60 * 60 * 6;
const SCORE_MAX_SUBMISSIONS = 260;

const rooms = new Map();
const scoreSessions = new Map();
const securityProfiles = new Map();
const securityReports = [];
const leaderboardSoftBans = new Set();
const shadowBans = new Set();
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
const staffRoles = new Map();
const securityAuditLog = [];
const warningsByPlayer = new Map();
const mutesByPlayer = new Map();
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

function defaultSecurityProfile(playerId) {
  return {
    version: 1,
    player_id: sanitizeId(playerId),
    coins: 0,
    player_skin_owned_mask: 1,
    player_skin_active: 0,
    rainbow_skin_unlocked: false,
    rainbow_shots_unlocked: false,
    upgrades: {},
    inventory: {},
    daily: { current_day: 1, processed_epoch_day: Math.floor(Date.now() / 86400000), last_claim_epoch_day: -1 },
    updated_at: new Date().toISOString()
  };
}

function boundedInt(value, minimum, maximum, fallback = minimum) {
  const parsed = Math.floor(Number(value));
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function migrateSecurityProfile(playerId, save) {
  const profile = defaultSecurityProfile(playerId);
  const stored = save && save.server_security && typeof save.server_security === "object" ? save.server_security : null;
  const legacy = save && save.data && typeof save.data === "object" ? save.data : null;
  const source = stored || legacy;
  if (!source) return profile;
  profile.coins = boundedInt(source.coins, 0, 100000000, 0);
  profile.player_skin_owned_mask = boundedInt(source.player_skin_owned_mask, 1, 1023, 1) | 1;
  profile.player_skin_active = boundedInt(source.player_skin_active, 0, 8, 0);
  profile.rainbow_skin_unlocked = source.rainbow_skin_unlocked === true;
  profile.rainbow_shots_unlocked = source.rainbow_shots_unlocked === true;
  profile.upgrades = source.upgrades && typeof source.upgrades === "object" ? { ...source.upgrades } : {};
  const upgradeLimits = { hp_upgrades: 20, shop_drone_level: 3, upgrade_shield_level: 5, upgrade_magnet_level: 5, upgrade_speed_level: 5, upgrade_fire_rate_level: 5, upgrade_damage_level: 5, upgrade_coin_level: 5, upgrade_critical_level: 5, upgrade_dash_level: 3, upgrade_nuke_level: 5, upgrade_power_level: 5 };
  for (const [key, maximum] of Object.entries(upgradeLimits)) {
    if (Object.prototype.hasOwnProperty.call(source, key)) profile.upgrades[key] = boundedInt(source[key], 0, maximum, 0);
    else profile.upgrades[key] = boundedInt(profile.upgrades[key], 0, maximum, 0);
  }
  profile.inventory = source.inventory && typeof source.inventory === "object" ? { ...source.inventory } : {};
  profile.inventory.shop_spread = source.shop_spread === true || profile.inventory.shop_spread === true;
  profile.inventory.shop_big_bullets = source.shop_big_bullets === true || profile.inventory.shop_big_bullets === true;
  profile.inventory.shop_nuke = source.shop_nuke === true || profile.inventory.shop_nuke === true;
  profile.inventory.has_lightning = source.has_lightning === true || profile.inventory.has_lightning === true;
  if (source.daily && typeof source.daily === "object") {
    const today = Math.floor(Date.now() / 86400000);
    profile.daily.current_day = boundedInt(source.daily.current_day, 1, 30, 1);
    profile.daily.processed_epoch_day = boundedInt(source.daily.processed_epoch_day, 0, today, today);
    profile.daily.last_claim_epoch_day = boundedInt(source.daily.last_claim_epoch_day, -1, today, -1);
  } else {
    profile.daily.current_day = boundedInt(source.daily_reward_day, 1, 30, 1);
  }
  return profile;
}

function securityProfileFor(playerId) {
  const safeId = sanitizeId(playerId);
  if (!securityProfiles.has(safeId)) {
    securityProfiles.set(safeId, migrateSecurityProfile(safeId, cloudSaves.get(safeId)));
  }
  return securityProfiles.get(safeId);
}

function applySecurityProfile(data, profile) {
  const result = data && typeof data === "object" && !Array.isArray(data) ? { ...data } : {};
  result.coins = profile.coins;
  result.player_skin_owned_mask = profile.player_skin_owned_mask;
  result.player_skin_active = (profile.player_skin_owned_mask & (1 << profile.player_skin_active)) !== 0 ? profile.player_skin_active : 0;
  result.rainbow_skin_unlocked = profile.rainbow_skin_unlocked;
  result.rainbow_shots_unlocked = profile.rainbow_shots_unlocked;
  for (const [key, value] of Object.entries(profile.upgrades)) result[key] = value;
  for (const [key, value] of Object.entries(profile.inventory)) result[key] = value === true;
  result.shop_drone = boundedInt(profile.upgrades.shop_drone_level, 0, 3, 0) > 0;
  result.shop_ghost = boundedInt(profile.upgrades.upgrade_shield_level, 0, 5, 0) > 0;
  result.daily_reward_day = boundedInt(profile.daily.current_day, 1, 30, 1);
  return result;
}

function advanceDailyDay(day, steps) {
  return ((boundedInt(day, 1, 30, 1) - 1 + Math.max(0, Math.floor(steps))) % 30) + 1;
}

function applyValidatedDailyTransition(profile, incoming) {
  const today = Math.floor(Date.now() / 86400000);
  const daily = profile.daily || { current_day: 1, processed_epoch_day: today, last_claim_epoch_day: -1 };
  const elapsed = Math.max(0, today - boundedInt(daily.processed_epoch_day, 0, today, today));
  if (elapsed > 0) {
    const missed = Math.max(0, elapsed - (daily.last_claim_epoch_day === daily.processed_epoch_day ? 1 : 0));
    daily.current_day = advanceDailyDay(daily.current_day, missed);
    daily.processed_epoch_day = today;
  }

  const requestedDay = boundedInt(incoming.daily_reward_day, 1, 30, daily.current_day);
  const expectedNext = advanceDailyDay(daily.current_day, 1);
  if (requestedDay === expectedNext && daily.last_claim_epoch_day !== today) {
    const rewardDay = daily.current_day;
    const coinValues = [100,150,200,250,300,350,500,550,600,750,800,850,900,1000,1200,1300,1400,1500,1600,1800,2000,2200,2400,2600,3000,3250,3500,4000,5000];
    if (rewardDay === 5 && !profile.rainbow_shots_unlocked) {
      profile.rainbow_shots_unlocked = true;
      profile.player_skin_owned_mask |= (1 << 9);
    } else if (rewardDay === 30 && !profile.rainbow_skin_unlocked) {
      profile.rainbow_skin_unlocked = true;
      profile.player_skin_owned_mask |= (1 << 8);
    } else {
      profile.coins = boundedInt(profile.coins + (rewardDay === 30 ? 15000 : coinValues[Math.min(28, rewardDay - 1)]), 0, 100000000, profile.coins);
    }
    daily.current_day = expectedNext;
    daily.last_claim_epoch_day = today;
    daily.processed_epoch_day = today;
    profile.daily = daily;
    return { granted: true, reward_day: rewardDay };
  }

  profile.daily = daily;
  return { granted: false, reward_day: 0 };
}

function shopUpgradeCost(key, level) {
  let oldPrice = 0;
  if (key === "hp_upgrades") oldPrice = 180 + level * 90;
  else if (key === "upgrade_damage_level") oldPrice = 390 + level * 270;
  else if (key === "upgrade_coin_level") oldPrice = 450 + level * 300;
  else if (key === "upgrade_shield_level") oldPrice = 825 + level * 300;
  else if (key === "upgrade_magnet_level") oldPrice = 360 + level * 210;
  else if (key === "upgrade_speed_level") oldPrice = 420 + level * 240;
  else if (key === "upgrade_fire_rate_level") oldPrice = 480 + level * 270;
  else if (key === "upgrade_critical_level") oldPrice = 600 + level * 360;
  else if (key === "upgrade_dash_level") oldPrice = 750 + level * 450;
  else if (key === "upgrade_nuke_level") oldPrice = 540 + level * 330;
  else if (key === "upgrade_power_level") oldPrice = 510 + level * 315;
  else if (key === "shop_drone_level") oldPrice = level <= 0 ? 1230 : level === 1 ? 1890 : 2550;
  return Math.ceil(oldPrice * 3);
}

function validateAndApplyProtectedTransition(profile, incoming) {
  if (!incoming || typeof incoming !== "object") return { ok: false, reason: "Missing save data." };
  const upgradeLimits = { hp_upgrades: 20, shop_drone_level: 3, upgrade_shield_level: 5, upgrade_magnet_level: 5, upgrade_speed_level: 5, upgrade_fire_rate_level: 5, upgrade_damage_level: 5, upgrade_coin_level: 5, upgrade_critical_level: 5, upgrade_dash_level: 3, upgrade_nuke_level: 5, upgrade_power_level: 5 };
  const inventoryCosts = { shop_spread: 2025, shop_big_bullets: 2925, shop_nuke: 4050, has_lightning: 3150 };
  let expectedCost = 0;
  const nextUpgrades = { ...profile.upgrades };
  const nextInventory = { ...profile.inventory };
  const dailyResult = applyValidatedDailyTransition(profile, incoming);

  for (const [key, maximum] of Object.entries(upgradeLimits)) {
    const current = boundedInt(profile.upgrades[key], 0, maximum, 0);
    const desired = boundedInt(incoming[key], 0, maximum, current);
    if (desired < current) return { ok: false, reason: `${key} cannot decrease from the client.` };
    for (let level = current; level < desired; level += 1) expectedCost += shopUpgradeCost(key, level);
    nextUpgrades[key] = desired;
  }

  for (const [key, cost] of Object.entries(inventoryCosts)) {
    const current = profile.inventory[key] === true;
    const desired = incoming[key] === true;
    if (current && !desired) return { ok: false, reason: `${key} cannot be removed from the client.` };
    if (!current && desired) expectedCost += cost;
    nextInventory[key] = current || desired;
  }

  const currentMask = boundedInt(profile.player_skin_owned_mask, 1, 1023, 1) | 1;
  const desiredMask = boundedInt(incoming.player_skin_owned_mask, 1, 1023, currentMask) | 1;
  if ((desiredMask & currentMask) !== currentMask) return { ok: false, reason: "Owned skins cannot be removed from the client." };
  const newSkinBits = desiredMask & ~currentMask;
  if ((newSkinBits & ((1 << 8) | (1 << 9))) !== 0) return { ok: false, reason: "Reward-only Rainbow unlock was not granted by the server." };
  for (let skin = 1; skin <= 7; skin += 1) if ((newSkinBits & (1 << skin)) !== 0) expectedCost += 30000;

  if (incoming.rainbow_skin_unlocked === true && !profile.rainbow_skin_unlocked) return { ok: false, reason: "Rainbow skin unlock source is invalid." };
  if (incoming.rainbow_shots_unlocked === true && !profile.rainbow_shots_unlocked) return { ok: false, reason: "Rainbow shots unlock source is invalid." };

  const desiredCoins = boundedInt(incoming.coins, 0, 100000000, profile.coins);
  if (desiredCoins !== profile.coins - expectedCost) return { ok: false, reason: "Coin change does not match validated purchases." };

  profile.coins = desiredCoins;
  profile.upgrades = nextUpgrades;
  profile.inventory = nextInventory;
  profile.player_skin_owned_mask = desiredMask;
  const requestedActive = boundedInt(incoming.player_skin_active, 0, 8, profile.player_skin_active);
  if ((desiredMask & (1 << requestedActive)) !== 0) profile.player_skin_active = requestedActive;
  profile.updated_at = new Date().toISOString();
  return { ok: true, purchase_cost: expectedCost, daily_reward_granted: dailyResult.granted, daily_reward_day: dailyResult.reward_day };
}

function recordSecurityReport(type, auth, details = {}) {
  const report = {
    id: crypto.randomUUID(),
    type: String(type || "tamper").slice(0, 80),
    player_id: auth ? sanitizeId(auth.playerId) : "",
    account_id: auth && auth.session ? String(auth.session.account_id || "") : "",
    details: details && typeof details === "object" ? details : {},
    created_at: new Date().toISOString(),
    status: "open"
  };
  securityReports.unshift(report);
  if (securityReports.length > 1000) securityReports.length = 1000;
  auditSecurityEvent("suspicious_modified_client_behavior", auth && auth.session, { report_id: report.id, type: report.type });
  return report;
}

function activeBanForAuth(auth) {
  if (!auth) return null;
  return bannedPlayers.get(`ID:${sanitizeId(auth.playerId)}`) || null;
}

function runValidationError(session, summary, requireTelemetry = true) {
  if (!session) return "Run does not exist.";
  const elapsedMs = Math.max(0, Date.now() - session.createdAt);
  const elapsedSeconds = elapsedMs / 1000;
  const score = boundedInt(summary.run_score, 0, 2000000000, -1);
  const wave = boundedInt(summary.run_wave, 0, 200, -1);
  const combo = boundedInt(summary.run_combo, 0, 100000, -1);
  const coins = boundedInt(summary.run_coins, 0, 100000000, -1);
  if (score < 0 || wave < 0 || combo < 0 || coins < 0) return "Run summary contains invalid values.";
  if (elapsedSeconds < 1 && (score > 0 || wave > 1 || coins > 0)) return "Run ended too quickly.";
  if (score > 25000 + elapsedSeconds * 30000) return "Score rate is not plausible.";
  if (coins > 500 + elapsedSeconds * 250) return "Coin rate is not plausible.";
  if (wave > 1 + Math.floor(elapsedSeconds / 2)) return "Wave progression is not plausible.";
  if (combo > 100 + elapsedSeconds * 30) return "Combo is not plausible.";
  if (requireTelemetry && session.progressReports <= 0 && (score > 0 || coins > 0 || wave > 1)) return "Run has no server telemetry.";
  if (requireTelemetry && session.progressReports > 0) {
    if (score !== session.progress.score || wave !== session.progress.wave || combo !== session.progress.combo || coins !== session.progress.coins) {
      return "Run summary does not match server telemetry.";
    }
  }
  return "";
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

  if (session.state !== "ended" && session.state !== "submitted") return "Run must be ended before submission.";
  if (!session.summary) return "Validated run summary is missing.";

  if (!Number.isSafeInteger(score) || score <= 0) return "Invalid score.";
  if (session.submissions >= SCORE_MAX_SUBMISSIONS) return "Too many submissions for this run.";
  if (runScore < 0 || runWave < 0 || runCombo < 0) return "Invalid run summary.";
  if (runScore !== session.summary.run_score || runWave !== session.summary.run_wave || runCombo !== session.summary.run_combo) return "Submitted result does not match the ended run.";
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
  const fingerprint = `${kind}:${wave}:${score}`;
  if (session.uploads.has(fingerprint)) return "This run result was already submitted.";
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
  session.state = "submitted";
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

const ROLE_PERMISSIONS = Object.freeze({
  player: [],
  helper: ["can_view_players", "can_view_reports"],
  moderator: ["can_access_admin_room", "can_view_players", "can_view_reports", "can_warn", "can_kick", "can_mute"],
  admin: ["can_access_admin_room", "can_view_players", "can_view_reports", "can_warn", "can_kick", "can_mute", "can_ban", "can_unban", "can_shadow_ban", "can_manage_leaderboard", "can_manage_economy", "can_manage_skins", "can_send_announcements", "can_manage_events", "can_manage_maintenance", "can_manage_beta_access", "can_view_audit_log"],
  owner: ["can_access_admin_room", "can_view_players", "can_view_reports", "can_warn", "can_kick", "can_mute", "can_ban", "can_unban", "can_shadow_ban", "can_manage_leaderboard", "can_manage_economy", "can_manage_skins", "can_send_announcements", "can_manage_events", "can_manage_maintenance", "can_manage_beta_access", "can_view_audit_log", "can_manage_roles", "can_reset_progress", "can_use_dangerous_tools"]
});

function ownerIdentityConfigured() {
  return Boolean(OWNER_GOOGLE_SUB || OWNER_GITHUB_ID);
}

function ownerSessionMatches(session) {
  if (!session || !ownerIdentityConfigured()) return false;
  const provider = String(session.provider || "").toLowerCase();
  const providerId = String(session.provider_id || "").trim();
  if (provider === "google" && OWNER_GOOGLE_SUB) return providerId === OWNER_GOOGLE_SUB;
  if (provider === "github" && OWNER_GITHUB_ID) return providerId === OWNER_GITHUB_ID;
  return false;
}

function roleForSession(session) {
  if (!session) return "player";
  if (ownerSessionMatches(session)) return "owner";
  const stored = String(staffRoles.get(String(session.account_id || "")) || "player");
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, stored) && stored !== "owner" ? stored : "player";
}

function permissionsForRole(role) {
  return Array.from(ROLE_PERMISSIONS[String(role || "player")] || []);
}

function sessionHasPermission(session, permission) {
  return permissionsForRole(roleForSession(session)).includes(String(permission || ""));
}

function publicRoleResponse(session) {
  const role = roleForSession(session);
  return {
    account: {
      provider: String(session.provider || ""),
      provider_id: String(session.provider_id || ""),
      account_id: String(session.account_id || ""),
      email: String(session.email || ""),
      name: String(session.name || "SPIELER")
    },
    role,
    is_owner: role === "owner",
    permissions: permissionsForRole(role),
    session_expires_at: Number(session.expiresAt || (session.createdAt + AUTH_SESSION_TTL_MS)),
    recheck_after_seconds: ADMIN_RECHECK_SECONDS
  };
}

function ownerAccountMatches(ws) {
  if (!ws) return false;
  return ownerSessionMatches({
    provider: ws.authProvider,
    provider_id: ws.authProviderId,
    account_id: ws.accountId
  });
}

function auditSecurityEvent(type, session = null, details = {}) {
  const entry = {
    id: crypto.randomUUID(),
    type: String(type || "security_event").slice(0, 80),
    actor_account_id: session ? String(session.account_id || "") : "",
    actor_provider: session ? String(session.provider || "") : "",
    actor_role: roleForSession(session),
    timestamp: new Date().toISOString(),
    details: details && typeof details === "object" ? details : {}
  };
  securityAuditLog.unshift(entry);
  if (securityAuditLog.length > 1000) securityAuditLog.length = 1000;
  console.log(`[AUDIT] ${entry.type} actor=${entry.actor_account_id || "anonymous"} role=${entry.actor_role}`);
  return entry;
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

function requireRequestPermission(req, res, permission) {
  const auth = requireRequestAuth(req, res);
  if (!auth) return null;
  if (sessionHasPermission(auth.session, permission)) {
    auditSecurityEvent("admin_permission_check_success", auth.session, { permission: String(permission) });
    return auth;
  }
  auditSecurityEvent("admin_permission_check_failure", auth.session, { permission: String(permission) });
  sendJson(res, 403, { ok: false, message: "Permission denied." });
  return null;
}

function authenticateSocket(ws, msg) {
  applyConnectionIdentity(ws, msg);
  const session = authSessionForToken(msg && msg.auth_token);
  if (session) {
    ws.authToken = String(msg.auth_token);
    ws.accountId = String(session.account_id || "");
    ws.accountEmail = String(session.email || "");
    ws.authProvider = String(session.provider || "");
    ws.authProviderId = String(session.provider_id || "");
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
  const expiresAt = createdAt + AUTH_SESSION_TTL_MS;
  const session = { ...account, createdAt, expiresAt };
  const payload = base64Url(JSON.stringify({ ...account, iat: createdAt, exp: expiresAt }));
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
    createdAt: Number(payload.iat || Date.now()),
    expiresAt: Number(payload.exp || 0)
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
  const roles = parsed && parsed.roles && typeof parsed.roles === "object" ? parsed.roles : {};
  for (const [accountId, role] of Object.entries(roles)) {
    const safeRole = String(role || "player").toLowerCase();
    if (["helper", "moderator", "admin"].includes(safeRole)) staffRoles.set(String(accountId), safeRole);
  }
  const audit = parsed && Array.isArray(parsed.audit) ? parsed.audit.slice(0, 1000) : [];
  for (const entry of audit) if (entry && typeof entry === "object") securityAuditLog.push(entry);
  const moderation = parsed && parsed.moderation && typeof parsed.moderation === "object" ? parsed.moderation : {};
  for (const record of Array.isArray(moderation.bans) ? moderation.bans : []) {
    const playerId = sanitizeId(record && record.player_id);
    if (playerId) bannedPlayers.set(`ID:${playerId}`, { ...record, player_id: playerId });
  }
  for (const [playerId, entries] of Object.entries(moderation.warnings || {})) {
    const safeId = sanitizeId(playerId);
    if (safeId && Array.isArray(entries)) warningsByPlayer.set(safeId, entries.slice(0, 50));
  }
  for (const [playerId, record] of Object.entries(moderation.mutes || {})) {
    const safeId = sanitizeId(playerId);
    if (safeId && record && typeof record === "object") mutesByPlayer.set(safeId, record);
  }
  for (const playerId of Array.isArray(moderation.shadow_bans) ? moderation.shadow_bans : []) {
    const safeId = sanitizeId(playerId);
    if (safeId) shadowBans.add(safeId);
  }
  for (const playerId of Array.isArray(moderation.leaderboard_soft_bans) ? moderation.leaderboard_soft_bans : []) {
    const safeId = sanitizeId(playerId);
    if (safeId) leaderboardSoftBans.add(safeId);
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
  const roles = Object.fromEntries(staffRoles.entries());
  const moderation = {
    bans: publicBanList(),
    warnings: Object.fromEntries(warningsByPlayer.entries()),
    mutes: Object.fromEntries(mutesByPlayer.entries()),
    shadow_bans: Array.from(shadowBans),
    leaderboard_soft_bans: Array.from(leaderboardSoftBans)
  };
  const body = {
    message: "Update SpaceRocks account cloud saves",
    content: Buffer.from(JSON.stringify({ version: 3, updated_at: new Date().toISOString(), saves, roles, moderation, audit: securityAuditLog.slice(0, 1000) }, null, 2)).toString("base64"),
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

function requestIpHash(req) {
  const source = String((req && req.headers && req.headers["x-forwarded-for"]) || (req && req.socket && req.socket.remoteAddress) || "")
    .split(",")[0].trim();
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

function onlineSocketForPlayer(playerId) {
  const safeId = sanitizeId(playerId);
  if (!safeId || typeof wss === "undefined") return null;
  for (const socket of wss.clients) {
    if (sanitizeId(socket.onlineId) === safeId && socket.readyState === WebSocket.OPEN) return socket;
  }
  return null;
}

function knownPlayerRecords() {
  const records = new Map();
  const add = (playerId, name = "SPIELER", accountId = "") => {
    const safeId = sanitizeId(playerId);
    if (!safeId) return;
    const previous = records.get(safeId) || {};
    records.set(safeId, {
      player_id: safeId,
      player_name: sanitizeName(name || previous.player_name || safeId),
      account_id: String(accountId || previous.account_id || ""),
      online: Boolean(onlineSocketForPlayer(safeId)),
      banned: bannedPlayers.has(`ID:${safeId}`),
      muted: mutesByPlayer.has(safeId),
      shadow_banned: shadowBans.has(safeId),
      leaderboard_soft_banned: leaderboardSoftBans.has(safeId),
      warnings: (warningsByPlayer.get(safeId) || []).length
    });
  };
  for (const [playerId, save] of cloudSaves.entries()) add(playerId, save && save.player_name, save && save.account_id);
  for (const session of authSessions.values()) add(accountOnlineId(session), session.name, session.account_id);
  if (typeof wss !== "undefined") for (const socket of wss.clients) add(socket.onlineId, socket.playerName, socket.accountId);
  for (const record of publicBanList()) add(record.player_id, record.player_name, "");
  return Array.from(records.values());
}

function adminPlayerProfile(playerId) {
  const safeId = sanitizeId(playerId);
  if (!safeId) return null;
  const base = knownPlayerRecords().find((entry) => entry.player_id === safeId) || {
    player_id: safeId,
    player_name: safeId,
    account_id: "",
    online: false,
    banned: false,
    muted: false,
    shadow_banned: false,
    leaderboard_soft_banned: false,
    warnings: 0
  };
  const save = cloudSaves.get(safeId) || null;
  const security = securityProfiles.has(safeId) ? securityProfiles.get(safeId) : (save ? securityProfileFor(safeId) : null);
  const ban = bannedPlayers.get(`ID:${safeId}`) || null;
  return {
    ...base,
    ban,
    mute: mutesByPlayer.get(safeId) || null,
    warning_history: warningsByPlayer.get(safeId) || [],
    coins: security ? security.coins : 0,
    active_skin: security ? security.player_skin_active : 0,
    owned_skin_mask: security ? security.player_skin_owned_mask : 1,
    rainbow_skin_unlocked: security ? security.rainbow_skin_unlocked : false,
    trust_score: Math.max(0, 100 - (warningsByPlayer.get(safeId) || []).length * 8 - (shadowBans.has(safeId) ? 40 : 0)),
    client_version: onlineSocketForPlayer(safeId) ? String(onlineSocketForPlayer(safeId).gameVersion || "online") : "offline"
  };
}

function disconnectPlayer(playerId, message) {
  const socket = onlineSocketForPlayer(playerId);
  if (!socket) return false;
  send(socket, { cmd: "admin_disconnect", message: String(message || "Von einem Moderator getrennt.").slice(0, 160) });
  setTimeout(() => { try { socket.close(4004, "Admin action"); } catch {} }, 25);
  return true;
}

function invalidatePlayerSessions(playerId) {
  const safeId = sanitizeId(playerId);
  let removed = 0;
  for (const [token, session] of authSessions.entries()) {
    if (accountOnlineId(session) === safeId) {
      authSessions.delete(token);
      removed += 1;
    }
  }
  return removed;
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

  if (url.pathname === "/auth/start" || url.pathname === "/auth/login-google" || url.pathname === "/auth/login-github") {
    cleanAuthState();
    const provider = url.pathname === "/auth/login-google"
      ? "google"
      : url.pathname === "/auth/login-github"
        ? "github"
        : String(url.searchParams.get("provider") || "google").toLowerCase();
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
        auditSecurityEvent(ownerSessionMatches(account) ? "owner_login_success" : "account_login_success", account, {
          provider: request.provider
        });
        title = "SpaceRocks Login erfolgreich";
        message = "Du kannst dieses Fenster schliessen und zu SpaceRocks zurueckkehren.";
      } catch (error) {
        request.status = "error";
        request.message = error.message || "Google Login fehlgeschlagen.";
        auditSecurityEvent("owner_login_failure", null, { provider: request.provider, message: String(request.message).slice(0, 120) });
      }
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;background:#06111c;color:#dff8ff;text-align:center;padding:80px"><h1>${title}</h1><p>${message}</p></body></html>`);
    return;
  }

  if (url.pathname === "/auth/me" || url.pathname === "/auth/current-user") {
    const auth = requireRequestAuth(req, res);
    if (!auth || !auth.session) return;
    sendJson(res, 200, { ok: true, ...publicRoleResponse(auth.session) });
    return;
  }

  if (url.pathname === "/auth/check-role" || url.pathname === "/auth/check-owner") {
    const auth = requireRequestAuth(req, res);
    if (!auth || !auth.session) return;
    try { await ensureCloudSavesLoaded(); } catch (error) {
      auditSecurityEvent("backend_validation_failure", auth.session, { endpoint: url.pathname });
      sendJson(res, 503, { ok: false, message: "Role storage unavailable." });
      return;
    }
    const response = publicRoleResponse(auth.session);
    auditSecurityEvent(response.is_owner ? "owner_login_success" : "admin_permission_check_success", auth.session, {
      endpoint: url.pathname
    });
    sendJson(res, 200, { ok: true, ...response });
    return;
  }

  if (url.pathname === "/admin/roles/list") {
    const auth = requireRequestPermission(req, res, "can_manage_roles");
    if (!auth) return;
    const roles = Array.from(staffRoles.entries()).map(([account_id, role]) => ({ account_id, role }));
    sendJson(res, 200, { ok: true, roles });
    return;
  }

  if (url.pathname === "/admin/roles/grant" && req.method === "POST") {
    const auth = requireRequestPermission(req, res, "can_manage_roles");
    if (!auth) return;
    const body = await readJson(req);
    const accountId = String(body.account_id || "").trim().slice(0, 160);
    const role = String(body.role || "").toLowerCase();
    if (!accountId || !["helper", "moderator", "admin"].includes(role)) {
      auditSecurityEvent("attempted_unauthorized_role_change", auth.session, { account_id: accountId, requested_role: role });
      sendJson(res, 400, { ok: false, message: "Only helper, moderator or admin may be granted." });
      return;
    }
    if (accountId === String(auth.session.account_id || "")) {
      auditSecurityEvent("attempted_owner_self_promotion", auth.session, { requested_role: role });
      sendJson(res, 400, { ok: false, message: "Self role changes are not allowed." });
      return;
    }
    const previousRole = staffRoles.get(accountId);
    staffRoles.set(accountId, role);
    auditSecurityEvent("role_granted", auth.session, { account_id: accountId, role });
    try {
      await persistCloudSaves();
      sendJson(res, 200, { ok: true, account_id: accountId, role });
    } catch (error) {
      if (previousRole) staffRoles.set(accountId, previousRole); else staffRoles.delete(accountId);
      sendJson(res, 503, { ok: false, message: "Role storage unavailable." });
    }
    return;
  }

  if (url.pathname === "/admin/roles/revoke" && req.method === "POST") {
    const auth = requireRequestPermission(req, res, "can_manage_roles");
    if (!auth) return;
    const body = await readJson(req);
    const accountId = String(body.account_id || "").trim().slice(0, 160);
    if (!accountId || accountId === String(auth.session.account_id || "")) {
      auditSecurityEvent("attempted_unauthorized_role_change", auth.session, { account_id: accountId, action: "revoke" });
      sendJson(res, 400, { ok: false, message: "This role cannot be revoked here." });
      return;
    }
    const previousRole = staffRoles.get(accountId);
    const removed = staffRoles.delete(accountId);
    auditSecurityEvent("role_revoked", auth.session, { account_id: accountId, removed });
    try {
      await persistCloudSaves();
      sendJson(res, 200, { ok: true, account_id: accountId, removed });
    } catch (error) {
      if (previousRole) staffRoles.set(accountId, previousRole);
      sendJson(res, 503, { ok: false, message: "Role storage unavailable." });
    }
    return;
  }

  if (url.pathname === "/admin/audit/log") {
    const auth = requireRequestPermission(req, res, "can_view_audit_log");
    if (!auth) return;
    sendJson(res, 200, { ok: true, entries: securityAuditLog.slice(0, 200) });
    return;
  }

  if (url.pathname === "/admin/dashboard") {
    const auth = requireRequestPermission(req, res, "can_access_admin_room");
    if (!auth) return;
    try { await ensureCloudSavesLoaded(); } catch (error) {
      sendJson(res, 503, { ok: false, message: "Admin storage unavailable." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      stats: {
        online_players: knownPlayerRecords().filter((player) => player.online).length,
        known_players: knownPlayerRecords().length,
        active_reports: securityReports.filter((report) => report.status === "open").length,
        active_bans: publicBanList().length,
        suspicious_scores: securityReports.filter((report) => String(report.type || "").includes("score") || String(report.type || "").includes("run")).length,
        current_version: LATEST_VERSION,
        maintenance: false,
        system_health: "ONLINE"
      },
      recent_actions: securityAuditLog.slice(0, 12),
      recent_reports: securityReports.slice(0, 8)
    });
    return;
  }

  if (url.pathname === "/admin/players/search") {
    const auth = requireRequestPermission(req, res, "can_view_players");
    if (!auth) return;
    try { await ensureCloudSavesLoaded(); } catch (error) {
      sendJson(res, 503, { ok: false, message: "Player storage unavailable." });
      return;
    }
    const query = String(url.searchParams.get("q") || "").trim().toUpperCase().slice(0, 40);
    const players = knownPlayerRecords()
      .filter((player) => !query || player.player_id.includes(query) || String(player.player_name || "").toUpperCase().includes(query))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.player_name.localeCompare(b.player_name))
      .slice(0, 100);
    sendJson(res, 200, { ok: true, players });
    return;
  }

  if (url.pathname === "/player/profile") {
    const auth = requireRequestPermission(req, res, "can_view_players");
    if (!auth) return;
    try { await ensureCloudSavesLoaded(); } catch (error) {
      sendJson(res, 503, { ok: false, message: "Player storage unavailable." });
      return;
    }
    const profile = adminPlayerProfile(url.searchParams.get("player_id"));
    if (!profile) {
      sendJson(res, 400, { ok: false, message: "Invalid player ID." });
      return;
    }
    sendJson(res, 200, { ok: true, profile });
    return;
  }

  const adminActions = {
    "/admin/warn": { permission: "can_warn", action: "warn", dangerous: false },
    "/admin/kick": { permission: "can_kick", action: "kick", dangerous: false },
    "/admin/mute": { permission: "can_mute", action: "mute", dangerous: false },
    "/admin/ban": { permission: "can_ban", action: "ban", dangerous: true },
    "/admin/unban": { permission: "can_unban", action: "unban", dangerous: true },
    "/admin/force-logout": { permission: "can_kick", action: "force_logout", dangerous: true },
    "/admin/shadow-ban": { permission: "can_shadow_ban", action: "shadow_ban", dangerous: true },
    "/admin/leaderboard-soft-ban": { permission: "can_manage_leaderboard", action: "leaderboard_soft_ban", dangerous: true }
  };
  if (req.method === "POST" && Object.prototype.hasOwnProperty.call(adminActions, url.pathname)) {
    const config = adminActions[url.pathname];
    const auth = requireRequestPermission(req, res, config.permission);
    if (!auth) return;
    const body = await readJson(req);
    const playerId = sanitizeId(body.player_id);
    const reason = String(body.reason || "").replace(/[^\w \-!?.,:]/g, "").trim().slice(0, 160);
    if (!playerId || !reason) {
      sendJson(res, 400, { ok: false, message: "Player ID and reason are required." });
      return;
    }
    const protectedOwnerIds = [OWNER_GOOGLE_SUB ? sanitizeId(`G${OWNER_GOOGLE_SUB}`) : "", OWNER_GITHUB_ID ? sanitizeId(`H${OWNER_GITHUB_ID}`) : ""];
    if (protectedOwnerIds.includes(playerId)) {
      auditSecurityEvent("attempted_protected_owner_action", auth.session, { action: config.action, player_id: playerId });
      sendJson(res, 403, { ok: false, message: "The protected owner account cannot be moderated." });
      return;
    }
    if (config.dangerous && String(body.confirm || "") !== "CONFIRM") {
      sendJson(res, 400, { ok: false, message: "Dangerous action requires CONFIRM." });
      return;
    }

    const now = Date.now();
    const durationSeconds = boundedInt(body.duration_seconds, 0, 315360000, 0);
    let changed = true;
    if (config.action === "warn") {
      const warnings = warningsByPlayer.get(playerId) || [];
      warnings.unshift({ reason, created_at: new Date().toISOString(), admin_id: String(auth.session.account_id || "") });
      warningsByPlayer.set(playerId, warnings.slice(0, 50));
    } else if (config.action === "kick") {
      changed = disconnectPlayer(playerId, `Kick: ${reason}`);
    } else if (config.action === "mute") {
      mutesByPlayer.set(playerId, { reason, created_at: new Date().toISOString(), expires_at: durationSeconds > 0 ? new Date(now + durationSeconds * 1000).toISOString() : "" });
    } else if (config.action === "ban") {
      const record = { player_id: playerId, player_name: adminPlayerProfile(playerId)?.player_name || playerId, reason, owner_id: accountOnlineId(auth.session), created_at: new Date().toISOString(), expires_at: durationSeconds > 0 ? new Date(now + durationSeconds * 1000).toISOString() : "" };
      bannedPlayers.set(`ID:${playerId}`, record);
      disconnectPlayer(playerId, `Gebannt: ${reason}`);
      invalidatePlayerSessions(playerId);
    } else if (config.action === "unban") {
      changed = removePlayerBan(playerId);
    } else if (config.action === "force_logout") {
      changed = invalidatePlayerSessions(playerId) > 0;
      disconnectPlayer(playerId, `Abgemeldet: ${reason}`);
    } else if (config.action === "shadow_ban") {
      if (body.enabled === false) shadowBans.delete(playerId); else shadowBans.add(playerId);
    } else if (config.action === "leaderboard_soft_ban") {
      if (body.enabled === false) leaderboardSoftBans.delete(playerId); else leaderboardSoftBans.add(playerId);
    }
    auditSecurityEvent(`admin_${config.action}`, auth.session, { target_player_id: playerId, reason, duration_seconds: durationSeconds, changed });
    try {
      await persistCloudSaves();
      sendJson(res, 200, { ok: true, action: config.action, player_id: playerId, changed, profile: adminPlayerProfile(playerId) });
    } catch (error) {
      sendJson(res, 503, { ok: false, message: "Moderation storage unavailable." });
    }
    return;
  }

  if (url.pathname === "/version/check") {
    const gameVersion = String(url.searchParams.get("game_version") || "0").trim();
    const updateRequired = compareVersion(gameVersion, MIN_CLIENT_VERSION) < 0;
    const unpublished = compareVersion(gameVersion, LATEST_VERSION) > 0;
    sendJson(res, 200, {
      ok: true,
      access_allowed: !updateRequired && !unpublished,
      update_required: updateRequired,
      unpublished,
      current_version: gameVersion,
      latest_version: LATEST_VERSION,
      min_client_version: MIN_CLIENT_VERSION,
      release_url: RELEASE_URL,
      download_url: publicDownloadUrl(req)
    });
    return;
  }

  if (url.pathname === "/player/check-ban") {
    const auth = requireRequestAuth(req, res);
    if (!auth) return;
    const idRecord = bannedPlayers.get(`ID:${sanitizeId(auth.playerId)}`) || null;
    const ipHash = requestIpHash(req);
    const ipRecord = ipHash ? bannedPlayers.get(`IP:${ipHash}`) || null : null;
    const record = idRecord || ipRecord;
    sendJson(res, 200, {
      ok: true,
      banned: Boolean(record),
      reason: record ? String(record.reason || "Kontosperre") : "",
      created_at: record ? String(record.created_at || "") : "",
      expires_at: record ? String(record.expires_at || "") : "",
      permanent: record ? !record.expires_at : false
    });
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
      owner_auth_configured: ownerIdentityConfigured(),
      owner_account_configured: ownerIdentityConfigured(),
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

  if ((url.pathname === "/score-session/start" || url.pathname === "/run/start") && req.method === "POST") {
    cleanScoreSessions();
    const body = await readJson(req);
    const auth = requireRequestAuth(req, res, body.player_id);
    if (!auth) return;
    const gameVersion = String(body.game_version || "0").trim();
    if (!clientVersionOk(gameVersion)) {
      sendJson(res, 426, {
        ok: false,
        message: `SpaceRocks ${MIN_CLIENT_VERSION} or newer is required.`,
        min_client_version: MIN_CLIENT_VERSION
      });
      return;
    }
    if (activeBanForAuth(auth) || leaderboardSoftBans.has(auth.playerId)) {
      recordSecurityReport("blocked_run_start", auth, { banned: Boolean(activeBanForAuth(auth)), leaderboard_soft_ban: leaderboardSoftBans.has(auth.playerId) });
      sendJson(res, 403, { ok: false, message: "Online runs are disabled for this account." });
      return;
    }
    if (body.debug_build === true || body.bot_mode === true || body.test_mode === true) {
      recordSecurityReport("debug_or_bot_run", auth, { debug_build: body.debug_build === true, bot_mode: body.bot_mode === true, test_mode: body.test_mode === true });
      sendJson(res, 403, { ok: false, message: "Debug, bot and test runs cannot use public leaderboards." });
      return;
    }
    const token = makeToken();
    scoreSessions.set(token, {
      runId: crypto.randomUUID(),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      gameVersion,
      playerId: auth.playerId,
      accountId: String(auth.session && auth.session.account_id || ""),
      state: "running",
      progress: { score: 0, wave: 0, combo: 0, coins: 0, kills: 0, deaths: 0 },
      progressReports: 0,
      summary: null,
      submissions: 0,
      uploads: new Set()
    });
    const createdSession = scoreSessions.get(token);
    sendJson(res, 201, {
      ok: true,
      run_id: createdSession.runId,
      run_token: token,
      run_state: createdSession.state,
      expires_in_seconds: Math.floor(SCORE_SESSION_TTL_MS / 1000)
    });
    return;
  }

  if (url.pathname === "/run/progress" && req.method === "POST") {
    cleanScoreSessions();
    const body = await readJson(req);
    const auth = requireRequestAuth(req, res, body.player_id);
    if (!auth) return;
    const token = String(body.run_token || "");
    const session = scoreSessions.get(token);
    if (!session || session.accountId !== String(auth.session && auth.session.account_id || "")) {
      recordSecurityReport("invalid_run_progress", auth, { reason: "missing_or_wrong_owner" });
      sendJson(res, 401, { ok: false, message: "Secure run is missing or belongs to another account." });
      return;
    }
    if (session.state !== "running") {
      sendJson(res, 409, { ok: false, message: "Run is not running." });
      return;
    }
    const next = {
      run_score: body.run_score,
      run_wave: body.run_wave,
      run_combo: body.run_combo,
      run_coins: body.run_coins
    };
    const validationError = runValidationError(session, next, false);
    const score = boundedInt(body.run_score, 0, 2000000000, -1);
    const wave = boundedInt(body.run_wave, 0, 200, -1);
    const combo = boundedInt(body.run_combo, 0, 100000, -1);
    const coins = boundedInt(body.run_coins, 0, 100000000, -1);
    const kills = boundedInt(body.kills, 0, 1000000, session.progress.kills);
    const deaths = boundedInt(body.deaths, 0, 1000000, session.progress.deaths);
    const wentBackwards = score < session.progress.score || wave < session.progress.wave || coins < session.progress.coins || kills < session.progress.kills || deaths < session.progress.deaths;
    if (validationError || wentBackwards) {
      recordSecurityReport("invalid_run_progress", auth, { reason: validationError || "telemetry_went_backwards" });
      sendJson(res, 422, { ok: false, message: validationError || "Run telemetry went backwards." });
      return;
    }
    session.progress = { score, wave, combo, coins, kills, deaths };
    session.progressReports += 1;
    session.lastSeenAt = Date.now();
    sendJson(res, 200, { ok: true, run_id: session.runId, run_state: session.state });
    return;
  }

  if (url.pathname === "/run/end" && req.method === "POST") {
    cleanScoreSessions();
    const body = await readJson(req);
    const auth = requireRequestAuth(req, res, body.player_id);
    if (!auth) return;
    const token = String(body.run_token || "");
    const session = scoreSessions.get(token);
    if (!session || session.accountId !== String(auth.session && auth.session.account_id || "")) {
      recordSecurityReport("invalid_run_end", auth, { reason: "missing_or_wrong_owner" });
      sendJson(res, 401, { ok: false, message: "Secure run is missing or belongs to another account." });
      return;
    }
    if (session.state === "ended" || session.state === "submitted") {
      sendJson(res, 200, { ok: true, run_id: session.runId, run_state: session.state, duplicate: true, summary: session.summary });
      return;
    }
    if (session.state !== "running") {
      sendJson(res, 409, { ok: false, message: "Run cannot be ended from its current state." });
      return;
    }
    const validationError = runValidationError(session, body, true);
    if (validationError) {
      recordSecurityReport("invalid_run_end", auth, { reason: validationError });
      sendJson(res, 422, { ok: false, message: validationError });
      return;
    }
    session.summary = {
      run_score: boundedInt(body.run_score, 0, 2000000000, 0),
      run_wave: boundedInt(body.run_wave, 0, 200, 0),
      run_combo: boundedInt(body.run_combo, 0, 100000, 0),
      run_coins: boundedInt(body.run_coins, 0, 100000000, 0),
      kills: boundedInt(body.kills, 0, 1000000, 0),
      deaths: boundedInt(body.deaths, 0, 1000000, 0)
    };
    session.state = "ended";
    session.endedAt = Date.now();
    const profile = securityProfileFor(auth.playerId);
    profile.coins = boundedInt(profile.coins + session.summary.run_coins, 0, 100000000, profile.coins);
    profile.updated_at = new Date().toISOString();
    sendJson(res, 200, { ok: true, run_id: session.runId, run_state: session.state, summary: session.summary, economy: { coins: profile.coins } });
    return;
  }

  if (url.pathname === "/run/validate") {
    const auth = requireRequestAuth(req, res);
    if (!auth) return;
    const token = String(url.searchParams.get("run_token") || "");
    const session = scoreSessions.get(token);
    if (!session || session.accountId !== String(auth.session && auth.session.account_id || "")) {
      sendJson(res, 404, { ok: false, message: "Run not found." });
      return;
    }
    sendJson(res, 200, { ok: true, run_id: session.runId, run_state: session.state, summary: session.summary });
    return;
  }

  if ((url.pathname === "/score-session/submit" || url.pathname === "/leaderboard/submit") && req.method === "POST") {
    cleanScoreSessions();
    const body = await readJson(req);
    const auth = requireRequestAuth(req, res, body.player_id);
    if (!auth) return;
    const token = String(body.run_token || "");
    const session = scoreSessions.get(token);
    if (!session || session.accountId !== String(auth.session && auth.session.account_id || "")) {
      sendJson(res, 401, { ok: false, message: "Secure run session is missing or expired." });
      return;
    }

    if (activeBanForAuth(auth) || leaderboardSoftBans.has(auth.playerId)) {
      recordSecurityReport("blocked_leaderboard_upload", auth, { run_id: session.runId });
      sendJson(res, 403, { ok: false, message: "Leaderboard upload is disabled for this account." });
      return;
    }

    const error = scoreSubmissionError(session, body);
    if (error) {
      recordSecurityReport("invalid_leaderboard_upload", auth, { run_id: session.runId, reason: error });
      sendJson(res, 422, { ok: false, message: error });
      return;
    }

    if (shadowBans.has(auth.playerId)) {
      session.state = "submitted";
      session.uploads.add(`${String(body.kind || "").toLowerCase()}:${Math.floor(Number(body.wave || 0))}:${Math.floor(Number(body.score || 0))}`);
      sendJson(res, 200, { ok: true, protected: true, shadowed: true, score: Math.floor(Number(body.score || 0)) });
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

  if (url.pathname === "/leaderboard/validate-score" && req.method === "POST") {
    const body = await readJson(req);
    const auth = requireRequestAuth(req, res);
    if (!auth) return;
    const session = scoreSessions.get(String(body.run_token || ""));
    const error = !session || session.accountId !== String(auth.session && auth.session.account_id || "")
      ? "Run not found."
      : scoreSubmissionError(session, body);
    sendJson(res, error ? 422 : 200, { ok: !error, message: error, run_state: session ? session.state : "not_started" });
    return;
  }

  if (url.pathname === "/security/report-tamper" && req.method === "POST") {
    const body = await readJson(req);
    const auth = requireRequestAuth(req, res);
    if (!auth) return;
    const report = recordSecurityReport(String(body.type || "client_tamper_report"), auth, {
      message: String(body.message || "").slice(0, 240),
      client_version: String(body.client_version || "").slice(0, 32)
    });
    sendJson(res, 201, { ok: true, report_id: report.id });
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

    const profile = securityProfileFor(playerId);
    const protectedSave = { ...save, data: applySecurityProfile(save.data, profile), server_security: profile };
    cloudSaves.set(playerId, protectedSave);
    sendJson(res, 200, { ok: true, save: protectedSave });
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

    const profile = securityProfileFor(playerId);
    const transition = validateAndApplyProtectedTransition(profile, body.data);
    if (!transition.ok) recordSecurityReport("invalid_cloud_save_values", auth, { reason: transition.reason });

    const safeData = applySecurityProfile(body.data, profile);
    const save = {
      player_id: playerId,
      player_name: sanitizeName(body.player_name || playerId),
      data: safeData,
      server_security: profile,
      updated_at: new Date().toISOString()
    };

    cloudSaves.set(playerId, save);
    try {
      await persistCloudSaves();
      sendJson(res, 200, { ok: true, save, protected: true, tamper_blocked: !transition.ok, message: transition.ok ? "Protected values accepted." : transition.reason });
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
  ws.authProvider = "";
  ws.authProviderId = "";
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
      const session = authSessionForToken(ws.authToken);
      const authorized = ownerSessionMatches(session);
      ws.isOwner = authorized;

      auditSecurityEvent(authorized ? "owner_login_success" : "owner_login_failure", session, {
        source: "multiplayer_owner_console"
      });

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
      const session = authSessionForToken(ws.authToken);
      const stillOwner = ownerSessionMatches(session);
      if (!room || !ws.isOwner || !stillOwner || room.ownerPlayerId !== ws.playerId) {
        ws.isOwner = false;
        auditSecurityEvent("admin_permission_check_failure", session, { permission: "owner_command" });
        send(ws, { cmd: "owner_status", authorized: false, player: -1, message: "Owner command denied." });
        return;
      }

      auditSecurityEvent("admin_permission_check_success", session, { permission: "owner_command" });

      const commandText = String(msg.text || "").trim().slice(0, 120);
      const parts = commandText.split(/\s+/);
      const command = String(parts.shift() || "").replace(/^\//, "").toLowerCase();
      auditSecurityEvent("owner_command", session, { command });

      if (command === "heal") {
        broadcastRoom(room, { cmd: "owner_command", command: "heal", player: ws.playerId });
        return;
      }

      if (command === "teamwin") {
        if (String(parts[1] || "").toUpperCase() !== "CONFIRM") {
          send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: "Nutze /teamwin TEAM CONFIRM." });
          return;
        }
        const winnerTeam = Math.max(0, Math.min(teamCountForMode(room.mode) - 1, (Number(parts[0]) || 1) - 1));
        broadcastRoom(room, { cmd: "owner_command", command: "teamwin", team: winnerTeam });
        return;
      }

      if (command === "kick") {
        if (String(parts[1] || "").toUpperCase() !== "CONFIRM" || parts.slice(2).join(" ").trim().length < 3) {
          send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: "Nutze /kick SLOT CONFIRM GRUND." });
          return;
        }
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
        const confirmation = String(parts.shift() || "").toUpperCase();
        const reason = parts.join(" ").trim();
        if (confirmation !== "CONFIRM" || reason.length < 3) {
          send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: "Nutze /ban SLOT CONFIRM GRUND." });
          return;
        }
        const target = room.players[targetSlot];
        if (!target || target === ws || target.readyState !== WebSocket.OPEN) {
          send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: "Ban fehlgeschlagen. Nutze /players und dann /ban SLOT GRUND." });
          return;
        }
        const record = addPlayerBan(target, reason, ws.accountId || ws.onlineId);
        send(target, { cmd: "banned", message: record.reason ? `Gebannt: ${record.reason}` : "Vom Owner gebannt." });
        send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: `${record.player_name} (${record.player_id}) wurde gebannt.` });
        setTimeout(() => {
          try { target.close(4003, "Banned by owner"); } catch {}
        }, 40);
        return;
      }

      if (command === "unban") {
        const playerId = sanitizeId(parts[0]);
        if (String(parts[1] || "").toUpperCase() !== "CONFIRM") {
          send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: "Nutze /unban ID CONFIRM." });
          return;
        }
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
        if (String(parts[1] || "").toUpperCase() !== "CONFIRM" || parts.slice(2).join(" ").trim().length < 3) {
          send(ws, { cmd: "owner_status", authorized: true, player: ws.playerId, message: "Nutze /unlockall SLOT CONFIRM GRUND." });
          return;
        }
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
        message: "Commands: /players, /ban SLOT CONFIRM GRUND, /unban ID CONFIRM, /banlist, /unlockall SLOT CONFIRM GRUND, /heal, /teamwin TEAM CONFIRM, /kick SLOT CONFIRM GRUND, /announce"
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

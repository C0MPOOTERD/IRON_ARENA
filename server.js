'use strict';
// Iron Arena server: static page + accounts (HTTP) + matchmaking/relay (WebSocket)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { WebSocketServer } = require('ws');
const scrypt = promisify(crypto.scrypt);

// Read optional local .env file (never upload it)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch (_) {}
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');
const LOBBY_MS = 5000;
const MAX_PLAYERS = 25;
const MODES = ['br', 'tdm', 'ctf', 'jug']; // battle royale, teams, capture the flag, juggernaut

/* ---------------- storage ---------------- */
// Accounts save to data/users.json. Hosts that wipe files on restart (e.g. Render free) lose that file, so set
// UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to keep accounts in a free Upstash Redis database instead.
fs.mkdirSync(DATA_DIR, { recursive: true });
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
const REDIS_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const REDIS_KEY = 'iron-arena-users';
async function redis(cmd) {
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
let users = {};
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const tokenIndex = new Map();
const dirty = new Set();
let persistTimer = null;
function persist(key) {
  if (key) dirty.add(key); else Object.keys(users).forEach(k => dirty.add(k));
  clearTimeout(persistTimer);
  persistTimer = setTimeout(flush, 400);
}
async function flush() {
  const keys = [...dirty]; dirty.clear();
  if (REDIS_URL) {
    for (const k of keys) {
      try { await redis(['HSET', REDIS_KEY, k, JSON.stringify(users[k])]); }
      catch (e) { console.error('Could not save account', k, e.message); dirty.add(k); }
    }
    if (dirty.size) persistTimer = setTimeout(flush, 5000);
  } else {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(users), err => { if (!err) fs.rename(tmp, DB_FILE, () => {}); });
  }
}
const ready = (async () => {
  if (REDIS_URL) {
    const flat = (await redis(['HGETALL', REDIS_KEY])) || [];
    for (let i = 0; i < flat.length; i += 2) users[flat[i]] = JSON.parse(flat[i + 1]);
    console.log('Accounts loaded from Redis: ' + Object.keys(users).length);
  } else {
    try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) {}
  }
  for (const [key, u] of Object.entries(users)) (u.tokens || []).forEach(h => tokenIndex.set(h, key));
})().catch(e => { console.error('Could not load accounts:', e.message); process.exit(1); });

/* ---------------- username rules ---------------- */
// Extend these lists as needed. STRONG = blocked anywhere inside a name; EXACT = blocked only as a whole word.
const STRONG = ['fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'nigg', 'fag', 'whore', 'slut', 'rapist', 'nazi', 'hitler',
  'penis', 'vagina', 'porn', 'asshole', 'bastard', 'retard', 'blowjob', 'handjob', 'dildo', 'molest', 'pedo', 'kike', 'spic',
  'chink', 'tranny', 'twat', 'jizz', 'cumshot', 'boner', 'erotic', 'nigger'];
const EXACT = ['ass', 'cum', 'tit', 'tits', 'piss', 'damn', 'crap', 'anal', 'sex', 'rape', 'cock', 'wank', 'kkk', 'hell', 'admin', 'moderator', 'system', 'server'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', $: 's', '@': 'a', '!': 'i' };
const normalize = s => s.toLowerCase().replace(/[0134578$@!]/g, c => LEET[c]).replace(/[^a-z]/g, '');
const collapse = s => s.replace(/(.)\1+/g, '$1');
function isBotName(name) { const n = normalize(name); return n === 'bot' || collapse(n) === 'bot'; }
function inappropriate(name) {
  const n = normalize(name), c = collapse(n);
  if (STRONG.some(w => n.includes(w) || c.includes(collapse(w)))) return true;
  const parts = name.toLowerCase().split(/[_\d]+/).filter(Boolean).concat([name]).map(normalize);
  return parts.some(p => EXACT.includes(p) || EXACT.includes(collapse(p)));
}
function checkUsername(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(name)) return 'Username must be 3-16 characters: letters, numbers or underscores.';
  if (isBotName(name)) return 'That username is not allowed.';
  if (/^guest\d*$/i.test(name)) return 'That username is not allowed.';
  if (inappropriate(name)) return 'Please choose an appropriate username.';
  return null;
}

/* ---------------- save-data sanitising ---------------- */
const WEAPON_IDS = ['starter', 'twinbarrel', 'flamethrower', 'ricochet', 'kinetic', 'mortar', 'tesla', 'railgun'];
const SKIN_IDS = ['standard', 'tiger', 'zebra', 'desert', 'army', 'cyber', 'rust', 'obsidian', 'gold'];
const ARMOR_HP = [100, 140, 190, 250, 330, 440];
const num = (v, def, max) => Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : def;
function cleanSave(d) {
  d = d && typeof d === 'object' ? d : {};
  const list = (arr, valid, base) => [base, ...new Set((Array.isArray(arr) ? arr : []).filter(x => valid.includes(x) && x !== base))];
  const weapons = list(d.weapons, WEAPON_IDS, 'starter');
  const skins = list(d.unlockedSkins, SKIN_IDS, 'standard');
  return {
    credits: num(d.credits, 1500, 1e9), xp: num(d.xp, 0, 1e12), arena: Math.max(1, num(d.arena, 1, 9999)),
    armorLevel: Math.max(1, num(d.armorLevel, 1, 6)), trackLevel: Math.max(1, num(d.trackLevel, 1, 6)),
    weapons, activeWeapon: weapons.includes(d.activeWeapon) ? d.activeWeapon : 'starter',
    unlockedSkins: skins, activeSkin: skins.includes(d.activeSkin) ? d.activeSkin : 'standard'
  };
}

/* ---------------- owner account (infinite money + XP) ---------------- */
// The login is NOT stored in this code. Set OWNER_USER and OWNER_PASS as environment variables
// (on Render: Environment tab) or in a local file named .env (never upload that file).
const OWNER_USER = (process.env.OWNER_USER || '').trim();
const OWNER_PASS = process.env.OWNER_PASS || '';
const MAX_MONEY = 999999999;
if (OWNER_USER && OWNER_PASS.length >= 6 && /^[A-Za-z0-9_]{3,16}$/.test(OWNER_USER)) {
  ready.then(async () => {
    const key = OWNER_USER.toLowerCase();
    const salt = crypto.randomBytes(16);
    const hash = (await scrypt(OWNER_PASS, salt, 64)).toString('hex');
    const old = users[key];
    users[key] = { username: OWNER_USER, salt: salt.toString('hex'), hash, tokens: old ? old.tokens || [] : [], data: cleanSave(old ? old.data : {}), created: old ? old.created : Date.now(), infinite: true };
    users[key].data.credits = MAX_MONEY; users[key].data.xp = MAX_MONEY;
    for (const t of users[key].tokens) tokenIndex.set(t, key);
    persist(key);
  });
} else {
  console.log('No owner account set (OWNER_USER / OWNER_PASS). That is fine.');
}

/* ---------------- HTTP API ---------------- */
const attempts = new Map();
function limited(ip) {
  const now = Date.now(); let a = attempts.get(ip);
  if (!a || now > a.reset) a = { n: 0, reset: now + 10 * 60 * 1000 };
  a.n++; attempts.set(ip, a);
  return a.n > 30;
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function authUser(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const hash = sha(h.slice(7));
  const key = tokenIndex.get(hash);
  return key && users[key] ? { key, user: users[key], hash } : null;
}
function issueToken(key) {
  const token = crypto.randomBytes(24).toString('hex');
  const u = users[key];
  u.tokens = (u.tokens || []).slice(-7);
  u.tokens.push(sha(token));
  tokenIndex.set(sha(token), key);
  persist(key);
  return token;
}
async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || '?';
  if (url === '/api/me' && req.method === 'GET') {
    const a = authUser(req);
    return a ? json(res, 200, { ok: true, username: a.user.username, data: a.user.data, infinite: !!a.user.infinite }) : json(res, 401, { error: 'Not signed in.' });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Bad request.' });
  const body = await readBody(req);
  if (url === '/api/signup' || url === '/api/login') {
    if (limited(ip)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const { username, password } = body;
    if (url === '/api/signup') {
      const err = checkUsername(username);
      if (err) return json(res, 400, { error: err });
      if (typeof password !== 'string' || password.length < 6 || password.length > 64) return json(res, 400, { error: 'Password must be 6-64 characters.' });
      const key = username.toLowerCase();
      if (users[key]) return json(res, 400, { error: 'That username is already taken.' });
      const salt = crypto.randomBytes(16);
      const hash = (await scrypt(password, salt, 64)).toString('hex');
      if (users[key]) return json(res, 400, { error: 'That username is already taken.' });
      users[key] = { username, salt: salt.toString('hex'), hash, tokens: [], data: cleanSave({}), created: Date.now() };
      return json(res, 200, { ok: true, token: issueToken(key), username, data: users[key].data });
    }
    const key = typeof username === 'string' ? username.toLowerCase() : '';
    const u = users[key];
    if (!u || typeof password !== 'string') return json(res, 400, { error: 'Wrong username or password.' });
    const h = await scrypt(password, Buffer.from(u.salt, 'hex'), 64);
    if (!crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'))) return json(res, 400, { error: 'Wrong username or password.' });
    return json(res, 200, { ok: true, token: issueToken(key), username: u.username, data: u.data, infinite: !!u.infinite });
  }
  const a = authUser(req);
  if (!a) return json(res, 401, { error: 'Not signed in.' });
  if (url === '/api/save') { a.user.data = cleanSave(body); if (a.user.infinite) { a.user.data.credits = MAX_MONEY; a.user.data.xp = MAX_MONEY; } persist(a.key); return json(res, 200, { ok: true }); }
  if (url === '/api/logout') {
    a.user.tokens = (a.user.tokens || []).filter(t => t !== a.hash); tokenIndex.delete(a.hash); persist(a.key);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) return handleApi(req, res, url).catch(() => json(res, 500, { error: 'Server error.' }));
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('public/index.html is missing. Run: npm run patch'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf);
    });
  }
  res.writeHead(404); res.end('Not found');
});

/* ---------------- matchmaking + relay ---------------- */
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const inGame = new Set();
const lobbies = {}; // one open lobby per game mode
const send = (c, m) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); };
const release = c => { if (c.key) inGame.delete(c.key); };
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function broadcastLobby(l) {
  const msg = { t: 'lobby', count: l.players.length, msLeft: Math.max(0, l.startAt - Date.now()) };
  l.players.forEach(p => send(p, msg));
}
function joinLobby(c, arena, mode) {
  let l = lobbies[mode];
  if (!l) {
    l = lobbies[mode] = { mode, players: [], startAt: Date.now() + LOBBY_MS, arena, timer: null };
    l.timer = setTimeout(() => startMatch(l), LOBBY_MS); // fixed 5s window: joins never restart it
  }
  l.players.push(c); c.lobby = l;
  if (l.players.length >= MAX_PLAYERS) return startMatch(l);
  broadcastLobby(l);
}
function leaveLobby(c) {
  const l = c.lobby; if (!l) return;
  c.lobby = null; release(c);
  l.players = l.players.filter(p => p !== c);
  if (!l.players.length) { clearTimeout(l.timer); if (lobbies[l.mode] === l) delete lobbies[l.mode]; } else broadcastLobby(l);
}
function startMatch(l) {
  clearTimeout(l.timer);
  if (lobbies[l.mode] === l) delete lobbies[l.mode];
  if (!l.players.length) return;
  const roster = Array(MAX_PLAYERS).fill(null);
  const slotOf = new Map();
  const all = shuffle([...Array(MAX_PLAYERS).keys()]);
  if (l.mode === 'tdm' || l.mode === 'ctf') {
    // even slots = red, odd slots = blue; humans alternate so teams stay balanced
    const evens = all.filter(x => x % 2 === 0), odds = all.filter(x => x % 2 === 1);
    l.players.forEach((p, i) => slotOf.set(p, i % 2 ? odds.pop() : evens.pop()));
  } else l.players.forEach((p, i) => slotOf.set(p, all[i]));
  l.players.forEach(p => { roster[slotOf.get(p)] = { id: p.id, name: p.name, ...p.loadout }; });
  const jugId = l.mode === 'jug' ? l.players[Math.floor(Math.random() * l.players.length)].id : null;
  const match = { players: new Set(l.players), host: l.players[0].id, mode: l.mode };
  const seed = 1 + Math.floor(Math.random() * 2147483000);
  l.players.forEach(p => {
    p.lobby = null; p.match = match; p.dead = false;
    send(p, { t: 'start', seed, arena: l.arena, mode: l.mode, jugId, roster, slot: slotOf.get(p), hostId: match.host });
  });
}
function leaveMatch(c) {
  const mt = c.match; if (!mt) return;
  c.match = null; mt.players.delete(c); release(c);
  for (const p of mt.players) send(p, { t: 'left', id: c.id });
  if (mt.host === c.id && mt.players.size) {
    const list = [...mt.players];
    const next = list.find(p => !p.dead) || list[0];
    mt.host = next.id;
    for (const p of mt.players) send(p, { t: 'host', id: next.id });
  }
}
function relay(c, m) {
  m.from = c.id;
  const s = JSON.stringify(m);
  for (const p of c.match.players) if (p !== c && p.ws.readyState === 1) p.ws.send(s);
}
function cleanLoadout(l) {
  l = l && typeof l === 'object' ? l : {};
  return {
    weapon: WEAPON_IDS.includes(l.weapon) ? l.weapon : 'starter',
    skin: SKIN_IDS.includes(l.skin) ? l.skin : 'standard',
    trackLevel: Math.max(1, num(l.trackLevel, 1, 6)),
    maxHp: ARMOR_HP[Math.max(1, num(l.armorLevel, 1, 6)) - 1]
  };
}
function handle(c, m) {
  switch (m.t) {
    case 'hello': {
      if (c.name) return;
      const key = tokenIndex.get(sha(String(m.token || '')));
      if (key && users[key]) { c.key = key; c.name = users[key].username; }
      else c.name = /^Guest\d{4}$/.test(m.guest) ? m.guest : 'Guest' + (1000 + Math.floor(Math.random() * 9000));
      return send(c, { t: 'welcome', id: c.id, name: c.name });
    }
    case 'queue':
      if (!c.name || c.lobby || c.match) return;
      if (c.key && inGame.has(c.key)) return send(c, { t: 'busy' });
      if (c.key) inGame.add(c.key);
      c.loadout = cleanLoadout(m.loadout);
      return joinLobby(c, Math.max(1, Math.min(9999, m.arena | 0 || 1)), MODES.includes(m.mode) ? m.mode : 'br');
    case 'cancel': return leaveLobby(c);
    case 'leave': return leaveMatch(c);
    case 'shot': if (!Array.isArray(m.b) || m.b.length > 12) return;
    // falls through
    case 's': case 'barrel': case 'respawn': if (c.match) relay(c, m); return;
    case 'dead': if (c.match) { c.dead = true; relay(c, m); } return;
    case 'snap': if (!Array.isArray(m.bots) || m.bots.length > 32) return;
    // falls through
    case 'kill': case 'ev': case 'over': if (c.match && c.match.host === c.id) relay(c, m); return;
  }
}
wss.on('connection', ws => {
  const c = { ws, id: crypto.randomBytes(4).toString('hex'), name: null, key: null, lobby: null, match: null, loadout: null, dead: false };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    if (m && typeof m.t === 'string') handle(c, m);
  });
  ws.on('close', () => { leaveLobby(c); leaveMatch(c); });
  ws.on('error', () => {});
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 30000);

ready.then(() => server.listen(PORT, () => console.log('Iron Arena running on http://localhost:' + PORT)));

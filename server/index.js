'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./store');
const game = require('./game');
const push = require('./push');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

store.load();
push.init();

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '128kb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.use('/vendor/maplibre', express.static(path.join(__dirname, '..', 'node_modules', 'maplibre-gl', 'dist')));

/* ------------------------------------------------------------------- auth */

const loginAttempts = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 60000;
  }
  entry.count += 1;
  loginAttempts.set(ip, entry);
  return entry.count > 12;
}

function sessionFromToken(token) {
  if (!token) return null;
  const s = store.get();
  const device = s.devices[token];
  if (!device) return null;
  const entry = s.codes[device.code];
  if (!entry) return null;
  device.lastSeen = Date.now();
  return {
    token,
    code: device.code,
    role: entry.role,
    team: entry.team,
    label: entry.label
  };
}

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  const session = sessionFromToken(token);
  if (!session) return res.status(401).json({ error: 'Session expirée. Entrez votre code à nouveau.' });
  req.session = session;
  next();
}

function adminOnly(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Réservé au maître du jeu.' });
  next();
}

/* -------------------------------------------------------------------- api */

/**
 * Une clé vide, laissée à un placeholder ou copiée depuis une doc donne un
 * « API key required » et une carte muette : mieux vaut l'ignorer et retomber
 * sur OpenStreetMap, qui ne demande aucune clé.
 */
function cleanKey(name) {
  const key = (process.env[name] || '').trim();
  const placeholder =
    !key ||
    key.length < 16 ||
    /[<>\s]/.test(key) ||
    /^(votre|your|my|ta|ma)[_-]?(cle|clef|key)/i.test(key) ||
    /^(optionnel|optional|changeme|placeholder|xxx+)$/i.test(key);
  if (placeholder && key) {
    console.warn(`[carte] ${name} ignorée ("${key}") : fond OpenStreetMap utilisé.`);
  }
  return placeholder ? '' : key;
}

app.get('/api/config', (req, res) => {
  res.json({
    mapTilerKey: cleanKey('MAPTILER_KEY'),
    cartoKey: cleanKey('CARTO_KEY'),
    vapidPublicKey: push.publicKey(),
    appName: store.get().game.settings.appName
  });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Trop de tentatives. Attendez une minute.' });

  const code = String(req.body.code || '').trim();
  if (!/^\d{5}$/.test(code)) return res.status(400).json({ error: 'Le code fait 5 chiffres.' });

  const s = store.get();
  const entry = s.codes[code];
  if (!entry) return res.status(401).json({ error: 'Code inconnu.' });

  const token = crypto.randomBytes(24).toString('hex');
  s.devices[token] = { code, createdAt: Date.now(), lastSeen: Date.now() };
  store.save();

  game.addEvent('join', `${entry.label} a rejoint la partie`, {
    team: entry.team,
    scope: entry.role === 'player' ? 'team' : 'all'
  });
  broadcast();

  res.json({ token, role: entry.role, team: entry.team, label: entry.label });
});

app.post('/api/logout', auth, (req, res) => {
  const s = store.get();
  delete s.devices[req.session.token];
  store.save();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(req.session));

app.get('/api/state', auth, (req, res) => res.json(game.snapshotFor(req.session)));

app.post('/api/position', auth, (req, res) => {
  if (req.session.role !== 'player') return res.status(403).json({ error: 'Réservé aux joueurs.' });
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat/lng required.' });
  }
  game.setPosition(req.session.code, req.body);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/request', auth, async (req, res) => {
  try {
    const request = game.createRequest(req.session, req.body.type, req.body.payload || {});
    broadcast();
    await notifyRoles(['admin'], {
      title: 'Nouvelle demande',
      body: `${game.teamName(req.session.team)} : ${
        request.type === 'unlock' ? 'déblocage de joker' : 'localisation'
      }`,
      kind: 'request'
    });
    res.json({ ok: true, request });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Playing a joker is immediate: the rules gate it with an unlock, not with an approval.
app.post('/api/joker/play', auth, async (req, res) => {
  try {
    if (req.session.role !== 'player') throw new Error('Réservé aux joueurs.');
    const notify = game.playJoker(req.session.team, req.body.jokerId, { detail: req.body.detail });
    broadcast();
    for (const n of notify) await notifyTeam(n.team, n);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/decide', auth, adminOnly, async (req, res) => {
  try {
    const { request, notify } = game.decideRequest(req.body.id, !!req.body.approve, {
      minutes: req.body.minutes,
      mode: req.body.mode,
      note: req.body.note,
      by: req.session.label
    });
    broadcast();
    for (const n of notify) await notifyTeam(n.team, n);
    res.json({ ok: true, request });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/reveal', auth, adminOnly, async (req, res) => {
  try {
    const team = req.body.team;
    const minutes = Number(req.body.minutes || 3);
    if (req.body.revoke) {
      game.revokeReveal(team);
    } else if (req.body.mode === 'snapshot') {
      const notify = game.dropSnapshotPins(team, 30);
      for (const n of notify) await notifyTeam(n.team, n);
    } else {
      game.grantReveal(team, minutes);
      await notifyTeam(game.otherTeam(team), {
        title: 'You are exposed',
        body: `The ${game.teamName(team).toLowerCase()} can see you for ${minutes} min.`,
        kind: 'exposed'
      });
      await notifyTeam(team, {
        title: 'Access granted',
        body: `Live location unlocked for ${minutes} minutes.`,
        kind: 'granted'
      });
    }
    broadcast();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/freeze', auth, adminOnly, async (req, res) => {
  const team = req.body.team === 'spy' ? 'spy' : 'spied';
  const seconds = Math.min(600, Math.max(5, Number(req.body.seconds || 30)));
  game.freezeTeam(team, seconds, req.body.label || `Immobilisation ${seconds} s`);
  game.addEvent('joker', `${game.teamName(team)} figés ${seconds} s par le maître du jeu`, { scope: 'all' });
  broadcast();
  await notifyTeam(team, {
    title: 'Restez sur place',
    body: `Vous devez rester immobiles pendant ${seconds} secondes.`,
    kind: 'joker',
    loud: true
  });
  res.json({ ok: true });
});

app.post('/api/admin/clock', auth, adminOnly, async (req, res) => {
  if (req.body.action === 'stop') game.stopClock();
  else game.startClock(req.body.minutes);
  broadcast();
  const s = store.get();
  for (const team of ['spy', 'spied']) {
    await notifyTeam(team, {
      title: req.body.action === 'stop' ? 'Partie terminée' : 'La partie commence',
      body:
        req.body.action === 'stop'
          ? 'Le chrono est arrêté.'
          : `Vous avez ${Math.round(s.game.settings.durationMin / 60)} h.`,
      kind: 'announce'
    });
  }
  res.json({ ok: true });
});

app.post('/api/admin/announce', auth, adminOnly, async (req, res) => {
  const text = String(req.body.text || '').slice(0, 300);
  const target = req.body.team || 'all';
  if (!text) return res.status(400).json({ error: 'Message vide.' });
  game.addEvent('announce', text, { team: target === 'all' ? null : target, scope: target === 'all' ? 'all' : 'team' });
  const teams = target === 'all' ? ['spy', 'spied'] : [target];
  for (const t of teams) {
    await notifyTeam(t, { title: 'Message du maître du jeu', body: text, kind: 'announce', loud: true });
  }
  broadcast();
  res.json({ ok: true });
});

app.post('/api/admin/codes', auth, adminOnly, (req, res) => {
  const s = store.get();
  const action = req.body.action;

  if (action === 'add') {
    const taken = new Set(Object.keys(s.codes));
    const code = store.randomCode(taken);
    s.codes[code] = {
      role: req.body.role || 'player',
      team: req.body.role === 'player' ? req.body.team || 'spy' : null,
      label: String(req.body.label || 'Nouveau joueur').slice(0, 40)
    };
    store.save(true);
    return res.json({ ok: true, code });
  }

  if (action === 'remove') {
    const code = String(req.body.code || '');
    if (s.codes[code] && s.codes[code].role === 'admin') {
      const admins = Object.values(s.codes).filter((c) => c.role === 'admin').length;
      if (admins <= 1) return res.status(400).json({ error: 'Gardez au moins un code admin.' });
    }
    delete s.codes[code];
    game.positions.delete(code);
    for (const [token, device] of Object.entries(s.devices)) {
      if (device.code === code) delete s.devices[token];
    }
    store.save(true);
    broadcast();
    return res.json({ ok: true });
  }

  if (action === 'rotate') {
    const oldCode = String(req.body.code || '');
    const entry = s.codes[oldCode];
    if (!entry) return res.status(404).json({ error: 'Code inconnu.' });
    const taken = new Set(Object.keys(s.codes));
    const newCode = store.randomCode(taken);
    s.codes[newCode] = entry;
    delete s.codes[oldCode];
    const pos = game.positions.get(oldCode);
    if (pos) {
      game.positions.delete(oldCode);
      game.positions.set(newCode, Object.assign(pos, { code: newCode }));
    }
    for (const [token, device] of Object.entries(s.devices)) {
      if (device.code === oldCode) delete s.devices[token];
    }
    store.save(true);
    broadcast();
    return res.json({ ok: true, code: newCode });
  }

  res.status(400).json({ error: 'Action inconnue.' });
});

app.post('/api/admin/reset', auth, adminOnly, (req, res) => {
  store.resetGame();
  game.positions.clear();
  game.addEvent('reset', 'Le maître du jeu a réinitialisé la partie', { scope: 'all' });
  broadcast();
  res.json({ ok: true });
});

app.post('/api/push/subscribe', auth, (req, res) => {
  if (!req.body || !req.body.endpoint) return res.status(400).json({ error: 'Abonnement invalide.' });
  push.subscribe(req.session.code, req.body);
  res.json({ ok: true });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* -------------------------------------------------------------- websocket */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  socket.session = null;
  socket.isAlive = true;

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.t === 'auth') {
      const session = sessionFromToken(msg.token);
      if (!session) return socket.send(JSON.stringify({ t: 'unauthorized' }));
      socket.session = session;
      return socket.send(JSON.stringify({ t: 'state', data: game.snapshotFor(session) }));
    }

    if (!socket.session) return;

    if (msg.t === 'pos' && socket.session.role === 'player') {
      if (typeof msg.lat === 'number' && typeof msg.lng === 'number') {
        game.setPosition(socket.session.code, msg);
        broadcast();
      }
    }
  });
});

function sendState(socket) {
  if (socket.readyState !== 1 || !socket.session) return;
  const session = sessionFromToken(socket.session.token);
  if (!session) return socket.send(JSON.stringify({ t: 'unauthorized' }));
  socket.session = session;
  socket.send(JSON.stringify({ t: 'state', data: game.snapshotFor(session) }));
}

let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    wss.clients.forEach(sendState);
  }, 120);
}

/** Live alert over the socket + a real push notification on the phone. */
async function notifyTeam(team, payload) {
  const s = store.get();
  wss.clients.forEach((socket) => {
    if (socket.readyState !== 1 || !socket.session) return;
    const isObserver = socket.session.role === 'admin' || socket.session.role === 'viewer';
    if (socket.session.team !== team && !isObserver) return;
    // Players get the full-screen alert; the admin console and the viewer screen only get a toast.
    socket.send(JSON.stringify({ t: 'alert', data: Object.assign({ ts: Date.now(), team, observer: isObserver }, payload) }));
  });
  const codes = Object.entries(s.codes)
    .filter(([, c]) => c.role === 'player' && c.team === team)
    .map(([code]) => code);
  await push.sendToCodes(codes, payload);
}

async function notifyRoles(roles, payload) {
  const s = store.get();
  wss.clients.forEach((socket) => {
    if (socket.readyState !== 1 || !socket.session) return;
    if (!roles.includes(socket.session.role)) return;
    socket.send(JSON.stringify({ t: 'alert', data: Object.assign({ ts: Date.now(), observer: true }, payload) }));
  });
  const codes = Object.entries(s.codes)
    .filter(([, c]) => roles.includes(c.role))
    .map(([code]) => code);
  await push.sendToCodes(codes, payload);
}

setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  });
}, 30000);

// Keep timers (reveal windows, freezes) ticking down on every screen.
setInterval(broadcast, 1000);

server.listen(PORT, () => {
  const s = store.get();
  const rows = Object.entries(s.codes).map(
    ([code, c]) => `  ${code}  ${c.role.padEnd(6)}  ${(c.team || '-').padEnd(5)}  ${c.label}`
  );
  console.log(`\n  ${s.game.settings.appName} — http://localhost:${PORT}\n`);
  console.log(`  Traqueurs : ${game.teamName(s.game.settings.hunters)} · durée ${s.game.settings.durationMin} min\n`);
  console.log('  Codes d\'accès :');
  console.log(rows.join('\n'));
  console.log('\n  Le GPS des téléphones exige du HTTPS : tunnel (cloudflared / ngrok) ou déploiement.\n');
});

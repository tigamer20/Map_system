'use strict';

const crypto = require('crypto');
const store = require('./store');

const MAX_EVENTS = 300;
const POSITION_STALE_MS = 5 * 60 * 1000;

/** Live positions live in memory only, keyed by code (one code = one player slot). */
const positions = new Map();

const otherTeam = (team) => (team === 'spy' ? 'spied' : 'spy');
const teamName = (team) => (team === 'spy' ? 'Spies' : 'Spied');
const id = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

/* ------------------------------------------------------------------ events */

function addEvent(kind, text, opts = {}) {
  const s = store.get();
  const event = {
    id: id(),
    ts: now(),
    kind,
    text,
    team: opts.team || null,
    // 'all' -> admin, viewer and both teams; 'team' -> admin, viewer + opts.team
    scope: opts.scope || 'all'
  };
  s.events.unshift(event);
  if (s.events.length > MAX_EVENTS) s.events.length = MAX_EVENTS;
  store.save();
  return event;
}

/* --------------------------------------------------------------- positions */

function setPosition(code, pos) {
  const s = store.get();
  const entry = s.codes[code];
  if (!entry || entry.role !== 'player') return null;
  const record = {
    code,
    name: entry.label,
    team: entry.team,
    lat: pos.lat,
    lng: pos.lng,
    accuracy: pos.accuracy == null ? null : pos.accuracy,
    heading: pos.heading == null ? null : pos.heading,
    speed: pos.speed == null ? null : pos.speed,
    battery: pos.battery == null ? null : pos.battery,
    ts: now()
  };
  positions.set(code, record);
  return record;
}

function allPositions() {
  const list = [];
  const cutoff = now() - POSITION_STALE_MS;
  for (const p of positions.values()) {
    list.push(Object.assign({}, p, { stale: p.ts < cutoff }));
  }
  return list;
}

/* -------------------------------------------------------------- visibility */

function isBlocked(team) {
  return store.get().game.blocks[team].until > now();
}

function canSeeOpponents(team) {
  const g = store.get().game;
  return g.reveals[team].until > now() && !isBlocked(team);
}

/** What a given viewer is allowed to see on the map. */
function visibleFor(session) {
  const everything = session.role === 'admin' || session.role === 'viewer';
  const s = store.get();
  const list = allPositions();
  if (everything) return list;

  const team = session.team;
  const seeOthers = canSeeOpponents(team);
  return list
    .filter((p) => p.team === team || seeOthers)
    .map((p) => (p.team === team ? p : Object.assign({}, p, { revealed: true })));
}

function visiblePins(session) {
  const s = store.get();
  const fresh = s.game.pins.filter((p) => p.expiresAt > now());
  if (fresh.length !== s.game.pins.length) {
    s.game.pins = fresh;
    store.save();
  }
  if (session.role === 'admin' || session.role === 'viewer') return fresh;
  return fresh.filter((p) => p.forTeam === session.team);
}

function visibleEvents(session) {
  const s = store.get();
  if (session.role === 'admin' || session.role === 'viewer') return s.events.slice(0, 60);
  return s.events
    .filter((e) => e.scope === 'all' || (e.scope === 'team' && e.team === session.team))
    .slice(0, 40);
}

function visibleEffects(session) {
  const s = store.get();
  const live = s.game.effects.filter((e) => e.until > now());
  if (live.length !== s.game.effects.length) {
    s.game.effects = live;
    store.save();
  }
  if (session.role === 'admin' || session.role === 'viewer') return live;
  return live.filter((e) => e.team === session.team);
}

/* ---------------------------------------------------------------- requests */

function createRequest(session, type, payload = {}) {
  const s = store.get();
  if (session.role !== 'player') throw new Error('Only players can send requests.');

  if (type === 'location') {
    if (isBlocked(session.team)) {
      throw new Error('Your team is jammed right now. Location requests are blocked.');
    }
    const pending = s.requests.find(
      (r) => r.status === 'pending' && r.type === 'location' && r.team === session.team
    );
    if (pending) throw new Error('A location request from your team is already waiting for the admin.');
  }

  let joker = null;
  if (type === 'joker') {
    joker = (s.game.jokers[session.team] || []).find((j) => j.id === payload.jokerId);
    if (!joker) throw new Error('Unknown joker.');
    if (joker.usedAt) throw new Error('That joker has already been used.');
    const pending = s.requests.find(
      (r) => r.status === 'pending' && r.type === 'joker' && r.payload.jokerId === joker.id
    );
    if (pending) throw new Error('That joker is already waiting for admin approval.');
  }

  const request = {
    id: id(),
    type,
    team: session.team,
    code: session.code,
    from: session.label,
    payload,
    status: 'pending',
    createdAt: now(),
    decidedAt: null,
    decidedBy: null,
    note: null
  };
  s.requests.unshift(request);

  // A joker marked requiresApproval:false fires straight away, no admin in the loop.
  if (joker && joker.requiresApproval === false) {
    request.status = 'approved';
    request.decidedAt = now();
    request.decidedBy = 'auto';
    store.save();
    return { request, notify: playJoker(session.team, joker.id) };
  }

  store.save();
  addEvent(
    'request',
    type === 'joker'
      ? `${teamName(session.team)} asked to play "${joker.name}"`
      : `${teamName(session.team)} asked for a location reveal`,
    { team: session.team, scope: 'team' }
  );
  return { request, notify: [] };
}

/** Admin decision. Returns {request, notify:[{team, title, body, kind}]} */
function decideRequest(requestId, approve, options = {}) {
  const s = store.get();
  const request = s.requests.find((r) => r.id === requestId);
  if (!request) throw new Error('Request not found.');
  if (request.status !== 'pending') throw new Error('That request was already handled.');

  request.status = approve ? 'approved' : 'denied';
  request.decidedAt = now();
  request.decidedBy = options.by || 'admin';
  request.note = options.note || null;

  const notify = [];

  if (!approve) {
    addEvent('denied', `Admin denied a request from the ${teamName(request.team)}`, {
      team: request.team,
      scope: 'team'
    });
    notify.push({
      team: request.team,
      title: 'Request denied',
      body: options.note || 'The admin turned down your request.',
      kind: 'denied'
    });
    store.save();
    return { request, notify };
  }

  if (request.type === 'location') {
    const minutes = Number(options.minutes || request.payload.minutes || 3);
    const mode = options.mode || request.payload.mode || 'live';
    if (mode === 'snapshot') {
      notify.push(...dropSnapshotPins(request.team, minutes));
    } else {
      grantReveal(request.team, minutes);
      notify.push({
        team: otherTeam(request.team),
        title: 'You are exposed',
        body: `The ${teamName(request.team).toLowerCase()} can see your live location for ${minutes} min.`,
        kind: 'exposed'
      });
    }
    notify.push({
      team: request.team,
      title: 'Access granted',
      body:
        mode === 'snapshot'
          ? 'A snapshot pin of the other team just landed on your map.'
          : `Live location unlocked for ${minutes} minutes.`,
      kind: 'granted'
    });
  }

  if (request.type === 'joker') {
    notify.push(...playJoker(request.team, request.payload.jokerId, options));
  }

  store.save();
  return { request, notify };
}

/* ------------------------------------------------------------------ effects */

function grantReveal(team, minutes) {
  const s = store.get();
  if (isBlocked(team)) throw new Error('That team is jammed and cannot receive a reveal.');
  const until = Math.max(s.game.reveals[team].until, now() + minutes * 60 * 1000);
  s.game.reveals[team] = { until, grantedBy: 'admin' };
  addEvent('reveal', `${teamName(team)} unlocked live tracking for ${minutes} min`, { scope: 'all' });
  store.save();
  return until;
}

function revokeReveal(team) {
  const s = store.get();
  s.game.reveals[team] = { until: 0, grantedBy: null };
  addEvent('reveal', `${teamName(team)} lost live tracking`, { scope: 'all' });
  store.save();
}

function dropSnapshotPins(forTeam, minutesVisible = 30) {
  const s = store.get();
  const target = otherTeam(forTeam);
  const notify = [];
  let count = 0;
  for (const p of positions.values()) {
    if (p.team !== target) continue;
    s.game.pins.push({
      id: id(),
      forTeam,
      team: target,
      label: p.name,
      lat: p.lat,
      lng: p.lng,
      ts: p.ts,
      expiresAt: now() + Math.max(1, minutesVisible) * 60 * 1000
    });
    count += 1;
  }
  addEvent('pin', `${count} snapshot pin(s) dropped for the ${teamName(forTeam).toLowerCase()}`, {
    scope: 'all'
  });
  notify.push({
    team: target,
    title: 'Position leaked',
    body: 'Your exact position at this moment was just pinned on the enemy map.',
    kind: 'exposed'
  });
  store.save();
  return notify;
}

function playJoker(team, jokerId, options = {}) {
  const s = store.get();
  const joker = (s.game.jokers[team] || []).find((j) => j.id === jokerId);
  if (!joker) throw new Error('Unknown joker.');
  if (joker.usedAt) throw new Error('That joker has already been used.');

  joker.usedAt = now();
  const minutes = Number(options.minutes || joker.durationMin || 0);
  const target = otherTeam(team);
  const notify = [];

  switch (joker.effect) {
    case 'snapshot_pin':
      notify.push(...dropSnapshotPins(team, 30));
      break;
    case 'reveal_live':
      grantReveal(team, minutes || 3);
      break;
    case 'reveal_opponents':
      grantReveal(team, minutes || 3);
      break;
    case 'block_reveal': {
      const until = now() + (minutes || 10) * 60 * 1000;
      s.game.blocks[target] = { until, reason: joker.name };
      s.game.reveals[target] = { until: 0, grantedBy: null };
      break;
    }
    case 'freeze': {
      s.game.effects.push({
        id: id(),
        team: target,
        label: `Frozen by "${joker.name}" — stay where you are`,
        until: now() + (minutes || 5) * 60 * 1000
      });
      break;
    }
    default:
      break;
  }

  addEvent('joker', `${teamName(team)} played "${joker.name}"`, { scope: 'all' });

  notify.push({
    team: target,
    title: `Joker played: ${joker.name}`,
    body: `The ${teamName(team).toLowerCase()} played ${joker.name}. ${joker.effectLabel}`,
    kind: 'joker',
    loud: true
  });
  notify.push({
    team,
    title: `${joker.name} is live`,
    body: joker.effectLabel,
    kind: 'joker'
  });

  store.save();
  return notify;
}

/* -------------------------------------------------------------- snapshots */

function snapshotFor(session) {
  const s = store.get();
  const base = {
    now: now(),
    me: {
      code: session.code,
      role: session.role,
      team: session.team,
      label: session.label
    },
    game: {
      status: s.game.status,
      startedAt: s.game.startedAt,
      reveals: s.game.reveals,
      blocks: s.game.blocks
    },
    players: visibleFor(session),
    pins: visiblePins(session),
    effects: visibleEffects(session),
    events: visibleEvents(session),
    jokers: session.role === 'player' ? s.game.jokers[session.team] : s.game.jokers,
    canSeeOpponents: session.role === 'player' ? canSeeOpponents(session.team) : true,
    jammed: session.role === 'player' ? isBlocked(session.team) : false
  };

  if (session.role === 'player') {
    base.myRequests = s.requests.filter((r) => r.team === session.team).slice(0, 12);
  }
  if (session.role === 'admin' || session.role === 'viewer') {
    base.requests = s.requests.slice(0, 40);
    const roleOrder = { player: 0, admin: 1, viewer: 2 };
    const teamOrder = { spy: 0, spied: 1 };
    base.roster = Object.entries(s.codes)
      .map(([code, c]) => ({
        code,
        role: c.role,
        team: c.team,
        label: c.label,
        online: positions.has(code) ? now() - (positions.get(code) || {}).ts < POSITION_STALE_MS : false
      }))
      .sort(
        (a, b) =>
          (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9) ||
          (teamOrder[a.team] ?? 9) - (teamOrder[b.team] ?? 9) ||
          a.label.localeCompare(b.label)
      );
  }
  return base;
}

module.exports = {
  positions,
  setPosition,
  allPositions,
  visibleFor,
  snapshotFor,
  createRequest,
  decideRequest,
  grantReveal,
  revokeReveal,
  dropSnapshotPins,
  playJoker,
  canSeeOpponents,
  isBlocked,
  addEvent,
  otherTeam,
  teamName
};

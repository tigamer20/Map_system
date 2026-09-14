'use strict';

const crypto = require('crypto');
const store = require('./store');

const MAX_EVENTS = 300;
const POSITION_STALE_MS = 5 * 60 * 1000;

/** Live positions live in memory only, keyed by code (one code = one player slot). */
const positions = new Map();

const otherTeam = (team) => (team === 'spy' ? 'spied' : 'spy');
const teamName = (team) => (team === 'spy' ? 'Espions' : 'Espionnés');
const id = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

const settings = () => store.get().game.settings;
/** The hunters are the team allowed to ask for the other team's position. */
const isHunter = (team) => settings().hunters === team;

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
  positions.set(code, {
    code,
    name: entry.label,
    team: entry.team,
    lat: pos.lat,
    lng: pos.lng,
    accuracy: pos.accuracy == null ? null : pos.accuracy,
    heading: pos.heading == null ? null : pos.heading,
    speed: pos.speed == null ? null : pos.speed,
    ts: now()
  });
  return positions.get(code);
}

function allPositions() {
  const cutoff = now() - POSITION_STALE_MS;
  return Array.from(positions.values()).map((p) => Object.assign({}, p, { stale: p.ts < cutoff }));
}

/* -------------------------------------------------------------- visibility */

function isBlocked(team) {
  return store.get().game.blocks[team].until > now();
}

function canSeeOpponents(team) {
  const g = store.get().game;
  return g.reveals[team].until > now() && !isBlocked(team);
}

function visibleFor(session) {
  const list = allPositions();
  if (session.role === 'admin' || session.role === 'viewer') return list;

  const seeOthers = canSeeOpponents(session.team);
  return list
    .filter((p) => p.team === session.team || seeOthers)
    .map((p) => (p.team === session.team ? p : Object.assign({}, p, { revealed: true })));
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

function findJoker(team, jokerId) {
  return (store.get().game.jokers[team] || []).find((j) => j.id === jokerId);
}

/**
 * Two kinds of demand reach the admin:
 *  - 'location': the hunters ask to see the other team.
 *  - 'unlock'  : a team asks to unlock a joker after doing its challenge.
 */
function createRequest(session, type, payload = {}) {
  const s = store.get();
  if (session.role !== 'player') throw new Error('Seuls les joueurs peuvent envoyer une demande.');

  if (type === 'location') {
    if (!isHunter(session.team)) throw new Error("Votre équipe ne traque pas, elle est traquée.");
    if (isBlocked(session.team)) throw new Error('Vos demandes sont bloquées pour le moment.');
    if (s.requests.some((r) => r.status === 'pending' && r.type === 'location' && r.team === session.team)) {
      throw new Error('Une demande de votre équipe attend déjà le maître du jeu.');
    }
  }

  let joker = null;
  if (type === 'unlock') {
    joker = findJoker(session.team, payload.jokerId);
    if (!joker) throw new Error('Joker inconnu.');
    if (joker.unlocked) throw new Error('Ce joker est déjà débloqué.');
    if (joker.usedAt) throw new Error('Ce joker a déjà été utilisé.');
    if (s.requests.some((r) => r.status === 'pending' && r.type === 'unlock' && r.payload.jokerId === joker.id)) {
      throw new Error('Ce déblocage attend déjà une validation.');
    }
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
  store.save();

  addEvent(
    'request',
    type === 'unlock'
      ? `${teamName(session.team)} demandent à débloquer « ${joker.name} »`
      : `${teamName(session.team)} demandent une localisation`,
    { team: session.team, scope: 'team' }
  );
  return request;
}

/** Admin decision. Returns {request, notify:[{team, title, body, kind}]} */
function decideRequest(requestId, approve, options = {}) {
  const s = store.get();
  const request = s.requests.find((r) => r.id === requestId);
  if (!request) throw new Error('Demande introuvable.');
  if (request.status !== 'pending') throw new Error('Cette demande a déjà été traitée.');

  request.status = approve ? 'approved' : 'denied';
  request.decidedAt = now();
  request.decidedBy = options.by || 'admin';
  request.note = options.note || null;

  const notify = [];

  if (!approve) {
    addEvent('denied', `Demande des ${teamName(request.team).toLowerCase()} refusée`, {
      team: request.team,
      scope: 'team'
    });
    notify.push({
      team: request.team,
      title: 'Demande refusée',
      body: options.note || 'Le maître du jeu a refusé votre demande.',
      kind: 'denied'
    });
    store.save();
    return { request, notify };
  }

  if (request.type === 'location') {
    const minutes = Number(options.minutes || request.payload.minutes || 3);
    const mode = options.mode || request.payload.mode || 'live';
    if (mode === 'snapshot') {
      notify.push(...dropSnapshotPins(request.team, 30));
    } else {
      grantReveal(request.team, minutes);
      notify.push({
        team: otherTeam(request.team),
        title: 'Vous êtes repérés',
        body: `Les ${teamName(request.team).toLowerCase()} voient votre position en direct pendant ${minutes} min.`,
        kind: 'exposed'
      });
    }
    notify.push({
      team: request.team,
      title: 'Localisation accordée',
      body:
        mode === 'snapshot'
          ? 'Un point figé vient d’apparaître sur votre carte.'
          : `Suivi en direct pendant ${minutes} minutes.`,
      kind: 'granted'
    });
  }

  if (request.type === 'unlock') {
    const joker = findJoker(request.team, request.payload.jokerId);
    if (joker) {
      joker.unlocked = true;
      addEvent('joker', `« ${joker.name} » est débloqué pour les ${teamName(request.team).toLowerCase()}`, {
        scope: 'all'
      });
      notify.push({
        team: request.team,
        title: `${joker.name} débloqué`,
        body: 'Le défi est validé. Vous pouvez jouer ce joker quand vous voulez.',
        kind: 'granted'
      });
    }
  }

  store.save();
  return { request, notify };
}

/* ------------------------------------------------------------------ effects */

function grantReveal(team, minutes) {
  const s = store.get();
  if (isBlocked(team)) throw new Error('Cette équipe est bloquée, impossible de lui donner un accès.');
  const until = Math.max(s.game.reveals[team].until, now() + minutes * 60 * 1000);
  s.game.reveals[team] = { until, grantedBy: 'admin' };
  addEvent('reveal', `${teamName(team)} : suivi en direct pendant ${minutes} min`, { scope: 'all' });
  store.save();
  return until;
}

function revokeReveal(team) {
  const s = store.get();
  s.game.reveals[team] = { until: 0, grantedBy: null };
  addEvent('reveal', `${teamName(team)} : suivi coupé`, { scope: 'all' });
  store.save();
}

function dropSnapshotPins(forTeam, minutesVisible = 30) {
  const s = store.get();
  const target = otherTeam(forTeam);
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
  addEvent('pin', `${count} position(s) figée(s) envoyée(s) aux ${teamName(forTeam).toLowerCase()}`, {
    scope: 'all'
  });
  store.save();
  return [
    {
      team: target,
      title: 'Position envoyée',
      body: 'Votre position exacte vient d’être transmise à l’autre équipe.',
      kind: 'exposed'
    }
  ];
}

function freezeTeam(team, seconds, label) {
  const s = store.get();
  s.game.effects.push({
    id: id(),
    team,
    label: label || 'Restez sur place',
    until: now() + seconds * 1000
  });
  store.save();
}

/** Play a joker. `detail` is the free-text the rules ask the player for. */
function playJoker(team, jokerId, options = {}) {
  const s = store.get();
  const joker = findJoker(team, jokerId);
  if (!joker) throw new Error('Joker inconnu.');
  if (joker.usedAt) throw new Error('Ce joker a déjà été utilisé.');
  if (joker.requiresUnlock && !joker.unlocked) throw new Error('Ce joker doit d’abord être débloqué.');

  const detail = String(options.detail || '').slice(0, 160).trim();
  if (joker.prompt && !detail) throw new Error('Précisez votre joker avant de le jouer.');
  const grantsReveal = joker.effect === 'reveal_opponents' || joker.effect === 'reveal_live';
  if (grantsReveal && isBlocked(team)) {
    throw new Error('Votre équipe est bloquée : gardez ce joker pour plus tard.');
  }

  joker.usedAt = now();
  joker.detail = detail || null;

  const seconds = Number(joker.durationSec || (joker.durationMin || 0) * 60);
  const target = otherTeam(team);
  const notify = [];

  switch (joker.effect) {
    case 'snapshot_pin':
      notify.push(...dropSnapshotPins(team, 30));
      break;
    case 'reveal_live':
    case 'reveal_opponents':
      grantReveal(team, Math.max(1, Math.round(seconds / 60)));
      break;
    case 'block_reveal': {
      s.game.blocks[target] = { until: now() + seconds * 1000, reason: joker.name };
      s.game.reveals[target] = { until: 0, grantedBy: null };
      break;
    }
    case 'freeze':
      freezeTeam(target, seconds, `${joker.name} — ${detail || joker.description}`);
      if (joker.alsoBlock) {
        s.game.blocks[target] = { until: now() + seconds * 1000, reason: joker.name };
        s.game.reveals[target] = { until: 0, grantedBy: null };
      }
      break;
    case 'notify':
    default:
      break;
  }

  addEvent('joker', `${teamName(team)} jouent « ${joker.name} »${detail ? ` : ${detail}` : ''}`, {
    scope: 'all'
  });

  notify.push({
    team: target,
    title: `Joker : ${joker.name}`,
    body: detail ? `${joker.description} (${detail})` : joker.description,
    kind: 'joker',
    loud: true
  });
  notify.push({
    team,
    title: `${joker.name} est actif`,
    body: joker.description,
    kind: 'joker'
  });

  store.save();
  return notify;
}

/* ------------------------------------------------------------------- clock */

function startClock(minutes) {
  const s = store.get();
  const duration = Number(minutes) > 0 ? Number(minutes) : s.game.settings.durationMin;
  s.game.settings.durationMin = duration;
  s.game.status = 'running';
  s.game.startedAt = now();
  s.game.endsAt = now() + duration * 60 * 1000;
  addEvent('clock', `La partie démarre pour ${Math.round(duration / 60)} h`, { scope: 'all' });
  store.save();
}

function stopClock() {
  const s = store.get();
  s.game.status = 'ended';
  s.game.endsAt = now();
  addEvent('clock', 'La partie est terminée', { scope: 'all' });
  store.save();
}

/* -------------------------------------------------------------- snapshots */

function snapshotFor(session) {
  const s = store.get();
  const hunters = s.game.settings.hunters;
  const base = {
    now: now(),
    me: {
      code: session.code,
      role: session.role,
      team: session.team,
      label: session.label,
      isHunter: session.role === 'player' ? session.team === hunters : false
    },
    game: {
      status: s.game.status,
      startedAt: s.game.startedAt,
      endsAt: s.game.endsAt,
      settings: s.game.settings,
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
        online: positions.has(code) ? now() - positions.get(code).ts < POSITION_STALE_MS : false
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
  freezeTeam,
  playJoker,
  startClock,
  stopClock,
  canSeeOpponents,
  isBlocked,
  isHunter,
  addEvent,
  otherTeam,
  teamName
};

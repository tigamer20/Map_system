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

function metersBetween(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * iOS ne renseigne presque jamais `coords.speed` : on la recalcule à partir de
 * deux positions successives quand le téléphone ne la donne pas.
 */
function derivedSpeed(previous, pos, moment) {
  if (!previous) return null;
  const seconds = (moment - previous.ts) / 1000;
  if (seconds < 1 || seconds > 60) return null;
  const meters = metersBetween(previous, pos);
  // Sous 5 m, c'est du bruit GPS ; au-dessus de 60 m/s, c'est un saut de position.
  if (meters < 5) return 0;
  const speed = meters / seconds;
  return speed > 60 ? null : speed;
}

function setPosition(code, pos) {
  const s = store.get();
  const entry = s.codes[code];
  if (!entry || entry.role !== 'player' || !entry.admitted) return null;

  const moment = now();
  const previous = positions.get(code);
  const reported = pos.speed == null || pos.speed < 0 ? null : pos.speed;

  positions.set(code, {
    code,
    name: entry.label,
    team: entry.team,
    lat: pos.lat,
    lng: pos.lng,
    accuracy: pos.accuracy == null ? null : pos.accuracy,
    heading: pos.heading == null ? null : pos.heading,
    speed: reported != null ? reported : derivedSpeed(previous, pos, moment),
    ts: moment
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

/** Vision permanente : la proie voit ses poursuivants en continu. */
function hasPermanentReveal(team) {
  return settings().permanentReveal === team;
}

function canSeeOpponents(team) {
  if (isBlocked(team)) return false;
  if (hasPermanentReveal(team)) return true;
  return store.get().game.reveals[team].until > now();
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
  assertRunning();
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
    if (request.type === 'join') {
    const entry = s.codes[request.code];
    if (entry) {
      entry.admitted = true;
      addEvent('join', `${entry.label} entre dans la partie`, { scope: 'all' });
      notify.push({
        team: request.team,
        title: 'Vous êtes dans la partie',
        body: `${entry.label} a été admis par le maître du jeu.`,
        kind: 'granted'
      });
    }
  }

  if (request.type === 'challenge') {
      const challenge = findChallenge(request.payload.challengeId);
      if (challenge) {
        challenge.pending = false;
        challenge.photoFile = null;
        challenge.answerValue = null;
        challenge.submittedAt = null;
        challenge.submittedBy = null;
      }
    }
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

  if (request.type === 'join') {
    const entry = s.codes[request.code];
    if (entry) {
      entry.admitted = true;
      addEvent('join', `${entry.label} entre dans la partie`, { scope: 'all' });
      notify.push({
        team: request.team,
        title: 'Vous êtes dans la partie',
        body: `${entry.label} a été admis par le maître du jeu.`,
        kind: 'granted'
      });
    }
  }

  if (request.type === 'challenge') {
    const challenge = findChallenge(request.payload.challengeId);
    if (challenge) {
      challenge.pending = false;
      challenge.done = true;
      challenge.doneAt = now();
      challenge.doneBy = challenge.submittedBy;
      addEvent('challenge', `« ${challenge.title} » validé par le maître du jeu`, { scope: 'all' });
      notify.push({
        team: challenge.team,
        title: 'Défi validé',
        body: `« ${challenge.title} » est accepté.`,
        kind: 'granted'
      });
    }
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
  assertRunning();
  const joker = findJoker(team, jokerId);
  if (!joker) throw new Error('Joker inconnu.');
  if (joker.usedAt) throw new Error('Ce joker a déjà été utilisé.');
  if (joker.requiresUnlock && !joker.unlocked) throw new Error('Ce joker doit d’abord être débloqué.');

  let detail = String(options.detail || '').slice(0, 160).trim();
  let targetChallenge = null;
  if (joker.picksChallenge) {
    targetChallenge = findChallenge(options.challengeId);
    if (!targetChallenge) throw new Error('Choisissez un défi à annuler.');
    if (!targetChallenge.done) throw new Error("Ce défi n'est pas validé, il n'y a rien à annuler.");
    detail = targetChallenge.title;
  } else if (joker.prompt && !detail) {
    throw new Error('Précisez votre joker avant de le jouer.');
  }
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
      if (targetChallenge) resetChallenge(targetChallenge.id, `joker des ${teamName(team).toLowerCase()}`);
      break;
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

/* -------------------------------------------------------------- admission */

/** Un joueur n'entre pas dans la partie tant que le maître du jeu ne l'a pas admis. */
function isAdmitted(session) {
  if (session.role !== 'player') return true;
  return store.get().codes[session.code].admitted === true;
}

/** Appelé à chaque connexion : crée la demande d'admission si besoin. */
function requestAdmission(session) {
  const s = store.get();
  if (isAdmitted(session)) return null;
  const existing = s.requests.find(
    (r) => r.status === 'pending' && r.type === 'join' && r.code === session.code
  );
  if (existing) return existing;

  const request = {
    id: id(),
    type: 'join',
    team: session.team,
    code: session.code,
    from: session.label,
    payload: {},
    status: 'pending',
    createdAt: now(),
    decidedAt: null,
    decidedBy: null,
    note: null
  };
  s.requests.unshift(request);
  addEvent('join', `${session.label} demande à rejoindre la partie`, { scope: 'all' });
  store.save();
  return request;
}

function admittedPlayers() {
  const s = store.get();
  return Object.entries(s.codes)
    .filter(([, c]) => c.role === 'player' && c.admitted)
    .map(([code]) => code);
}

/* ------------------------------------------------------------------ pause */

function isPaused() {
  return store.get().game.status === 'paused';
}

/** Rien ne doit avancer pendant une pause : ni demande, ni joker, ni défi. */
function assertRunning() {
  const status = store.get().game.status;
  if (status === 'paused') throw new Error('La partie est en pause.');
  if (status === 'lobby' || status === 'countdown') throw new Error("La partie n'a pas encore commencé.");
}

function pauseGame(message) {
  const s = store.get();
  if (s.game.status === 'paused') throw new Error('La partie est déjà en pause.');
  s.game.status = 'paused';
  s.game.pausedAt = now();
  s.game.pauseMessage = String(message || '').slice(0, 300) || 'Pause décidée par le maître du jeu.';
  addEvent('clock', `Partie en pause : ${s.game.pauseMessage}`, { scope: 'all' });
  store.save();
  return s.game.pauseMessage;
}

function resumeGame() {
  const s = store.get();
  if (s.game.status !== 'paused') throw new Error("La partie n'est pas en pause.");
  // Le temps passé en pause est rendu aux joueurs.
  const elapsed = now() - (s.game.pausedAt || now());
  s.game.endsAt += elapsed;
  for (const effect of s.game.effects) effect.until += elapsed;
  for (const team of ['spy', 'spied']) {
    if (s.game.reveals[team].until > 0) s.game.reveals[team].until += elapsed;
    if (s.game.blocks[team].until > 0) s.game.blocks[team].until += elapsed;
  }
  s.game.status = 'running';
  s.game.pausedAt = null;
  s.game.pauseMessage = null;
  addEvent('clock', `Reprise de la partie (${Math.round(elapsed / 1000)} s de pause rendues)`, { scope: 'all' });
  store.save();
}

/* --------------------------------------------------------------- défis */

function findChallenge(id) {
  return store.get().game.challenges.find((c) => c.id === id);
}

/** Les coéquipiers d'une équipe, d'après les codes distribués. */
function teamMembers(team) {
  const s = store.get();
  return Object.entries(s.codes)
    .filter(([, c]) => c.role === 'player' && c.team === team)
    .map(([code, c]) => ({ code, label: c.label }));
}

function checkAnswer(challenge, answer) {
  if (!challenge.answer) return null;

  if (challenge.answer === 'ranking') {
    const names = Array.isArray(answer) ? answer.map((x) => String(x).trim()).filter(Boolean) : [];
    if (names.length < 2) throw new Error('Indiquez le classement complet.');
    if (new Set(names).size !== names.length) throw new Error('Un joueur apparaît deux fois dans le classement.');
    const roster = teamMembers(challenge.team).map((m) => m.label);
    for (const name of names) {
      if (!roster.includes(name)) throw new Error(`« ${name} » ne fait pas partie de votre équipe.`);
    }
    return names;
  }

  const text = String(answer || '').trim().slice(0, 300);
  if (!text) throw new Error('Ce défi demande une réponse.');
  return text;
}

function completeChallenge(session, challengeId, photoFile, answer) {
  assertRunning();
  const challenge = findChallenge(challengeId);
  if (!challenge) throw new Error('Défi inconnu.');
  if (session.role !== 'player' || session.team !== challenge.team) {
    throw new Error("Ce défi n'est pas le vôtre.");
  }
  if (challenge.done) throw new Error('Ce défi est déjà validé.');
  if (challenge.pending) throw new Error('Ce défi attend déjà la validation du maître du jeu.');
  if (challenge.photo === true && !photoFile) throw new Error('Ce défi demande une photo.');

  // Tout ce qui peut échouer se fait AVANT de toucher au défi : sinon une erreur
  // le laisse à moitié soumis, sans demande à valider.
  const answerValue = checkAnswer(challenge, answer);
  const request = challenge.approval
    ? {
        id: id(),
        type: 'challenge',
        team: challenge.team,
        code: session.code,
        from: session.label,
        payload: { challengeId: challenge.id },
        status: 'pending',
        createdAt: now(),
        decidedAt: null,
        decidedBy: null,
        note: null
      }
    : null;

  challenge.photoFile = photoFile || null;
  challenge.answerValue = answerValue;

  if (request) {
    // Défi soumis à validation : il n'est pas encore acquis, le maître du jeu tranche.
    challenge.pending = true;
    challenge.submittedAt = now();
    challenge.submittedBy = session.label;
    store.get().requests.unshift(request);
    addEvent('challenge', `${teamName(challenge.team)} soumettent « ${challenge.title} »`, {
      team: challenge.team,
      scope: 'team'
    });
    store.save();
    return challenge;
  }

  challenge.done = true;
  challenge.doneAt = now();
  challenge.doneBy = session.label;
  addEvent('challenge', `${teamName(challenge.team)} valident « ${challenge.title} »`, { scope: 'all' });
  store.save();
  return challenge;
}

/** Remet un défi en « non fait » : joker des espions, ou correction de l'admin. */
function resetChallenge(id, by) {
  const challenge = findChallenge(id);
  if (!challenge) throw new Error('Défi inconnu.');
  if (!challenge.done && !challenge.pending) throw new Error("Ce défi n'est ni validé ni en attente.");
  challenge.done = false;
  challenge.doneAt = null;
  challenge.doneBy = null;
  challenge.photoFile = null;
  challenge.answerValue = null;
  challenge.pending = false;
  challenge.submittedAt = null;
  challenge.submittedBy = null;
  addEvent('challenge', `« ${challenge.title} » repasse en non fait (${by})`, { scope: 'all' });
  store.save();
  return challenge;
}

function visibleChallenges(session) {
  const list = store.get().game.challenges;
  if (session.role === 'admin' || session.role === 'viewer') return list;
  if (session.role !== 'player') return [];
  // Son équipe : tout. L'équipe adverse : seulement les défis validés, sans photo,
  // ce qu'il faut pour choisir lequel annuler.
  return list.map((c) =>
    c.team === session.team
      ? c
      : { id: c.id, team: c.team, title: c.title, done: c.done, doneAt: c.doneAt, photo: c.photo }
  );
}

/** Le joueur a besoin des noms de son équipe pour remplir un classement. */
function teammatesFor(session) {
  return session.role === 'player' ? teamMembers(session.team) : [];
}

/* ------------------------------------------------------------------- clock */

/** Lance le décompte d'avant-partie ; la partie démarre à son terme. */
function startCountdown(seconds, minutes) {
  const s = store.get();
  if (s.game.status === 'countdown') throw new Error('Le décompte est déjà lancé.');
  const duration = Number(minutes) > 0 ? Number(minutes) : s.game.settings.durationMin;
  const delay = Math.min(60, Math.max(3, Number(seconds) || 10));
  s.game.settings.durationMin = duration;
  s.game.status = 'countdown';
  s.game.startsAt = now() + delay * 1000;
  s.game.startedAt = null;
  s.game.endsAt = null;
  addEvent('clock', `Départ dans ${delay} secondes`, { scope: 'all' });
  store.save();
  return delay;
}

/** Bascule réellement en partie : appelé au terme du décompte. */
function startClock(minutes) {
  const s = store.get();
  const duration = Number(minutes) > 0 ? Number(minutes) : s.game.settings.durationMin;
  s.game.settings.durationMin = duration;
  s.game.status = 'running';
  s.game.startsAt = null;
  s.game.startedAt = now();
  s.game.endsAt = now() + duration * 60 * 1000;
  addEvent('clock', `La partie commence — ${Math.round(duration / 60)} h`, { scope: 'all' });
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
      isHunter: session.role === 'player' ? session.team === hunters : false,
      admitted: isAdmitted(session),
      seesAlways: session.role === 'player' ? hasPermanentReveal(session.team) : false,
      seenAlways: session.role === 'player' ? hasPermanentReveal(otherTeam(session.team)) : false
    },
    game: {
      status: s.game.status,
      startedAt: s.game.startedAt,
      startsAt: s.game.startsAt,
      endsAt: s.game.endsAt,
      pausedAt: s.game.pausedAt,
      pauseMessage: s.game.pauseMessage,
      settings: s.game.settings,
      reveals: s.game.reveals,
      blocks: s.game.blocks
    },
    players: visibleFor(session),
    pins: visiblePins(session),
    effects: visibleEffects(session),
    events: visibleEvents(session),
    challenges: visibleChallenges(session),
    jokers: session.role === 'player' ? s.game.jokers[session.team] : s.game.jokers,
    canSeeOpponents: session.role === 'player' ? canSeeOpponents(session.team) : true,
    jammed: session.role === 'player' ? isBlocked(session.team) : false
  };

  if (session.role === 'player') {
    base.myRequests = s.requests.filter((r) => r.team === session.team).slice(0, 12);
    base.teammates = teammatesFor(session);
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
        admitted: c.role === 'player' ? c.admitted === true : true,
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
  completeChallenge,
  resetChallenge,
  teamMembers,
  findChallenge,
  pauseGame,
  resumeGame,
  isPaused,
  startClock,
  startCountdown,
  stopClock,
  isAdmitted,
  requestAdmission,
  admittedPlayers,
  canSeeOpponents,
  hasPermanentReveal,
  isBlocked,
  isHunter,
  addEvent,
  otherTeam,
  teamName
};

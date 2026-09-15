'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CONFIG_DIR = path.join(__dirname, '..', 'config');

const TEAMS = ['spy', 'spied'];

/** Optional hand-written overrides: config/codes.json and config/jokers.json. */
function readConfig(name) {
  const file = path.join(CONFIG_DIR, name);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[store] config/${name} is not valid JSON, ignoring it:`, err.message);
    return null;
  }
}


/**
 * Joker decks, straight from the printed rule sheets.
 *
 * Espions (the runners): 2 shared jokers, each usable once, and each has to be
 * UNLOCKED first by completing a challenge that the admin validates.
 * Espionnes (the hunters): 2 jokers, usable once each, no unlock needed.
 */
function defaultJokers() {
  const custom = readConfig('jokers.json');
  if (custom && custom.spy && custom.spied) {
    for (const team of TEAMS) {
      custom[team] = custom[team].map((joker, index) =>
        Object.assign(
          {
            id: `${team}_${index}`,
            team,
            icon: '★',
            effect: 'notify',
            durationSec: 60,
            requiresUnlock: false,
            unlocked: true,
            usedAt: null
          },
          joker,
          { team, usedAt: null, unlocked: !joker.requiresUnlock }
        )
      );
    }
    return custom;
  }

  return {
    spy: [
      {
        id: 'spy_blindfold',
        team: 'spy',
        name: 'Yeux fermés',
        icon: '🙈',
        description:
          'Les espionnés doivent se rendre à l’endroit que vous indiquez et fermer les yeux 30 secondes. Aucune poursuite pendant ces 30 secondes.',
        unlockRequirement: 'Prendre une photo de tous les membres des espionnés sur la même photo.',
        prompt: 'À quel endroit doivent-ils se rendre ?',
        effect: 'freeze',
        durationSec: 30,
        alsoBlock: true,
        requiresUnlock: true,
        unlocked: false,
        usedAt: null
      },
      {
        id: 'spy_reset',
        team: 'spy',
        name: 'Défi annulé',
        icon: '🔄',
        description: 'Un défi des espionnés est réinitialisé et repasse en « non fait ».',
        unlockRequirement: 'Réaliser vous-même le défi que vous voulez réinitialiser.',
        prompt: null,
        picksChallenge: true,
        effect: 'notify',
        durationSec: 0,
        requiresUnlock: true,
        unlocked: false,
        usedAt: null
      }
    ],
    spied: [
      {
        id: 'spied_freeze',
        team: 'spied',
        name: 'Gel',
        icon: '🧊',
        description: 'Les deux espions doivent rester figés sur place pendant 2 minutes.',
        unlockRequirement: null,
        prompt: null,
        effect: 'freeze',
        durationSec: 120,
        requiresUnlock: false,
        unlocked: true,
        usedAt: null
      },
      {
        id: 'spied_locate',
        team: 'spied',
        name: 'Localisation 5 minutes',
        icon: '📍',
        description: 'Vous obtenez la position des espions en direct pendant 5 minutes.',
        unlockRequirement: null,
        prompt: null,
        effect: 'reveal_opponents',
        durationSec: 300,
        requiresUnlock: false,
        unlocked: true,
        usedAt: null
      }
    ]
  };
}

/**
 * Défis : par défaut ceux de l'équipe espionnée. Remplaçables par config/defis.json.
 * `photo: true` oblige le joueur à envoyer une photo pour valider.
 */
function defaultChallenges() {
  const custom = readConfig('defis.json');
  const list = Array.isArray(custom) ? custom : null;
  const source = list || [
    { title: 'Photo devant une fontaine', photo: true },
    { title: 'Boire quelque chose dans un bar ou un café', photo: true },
    { title: 'Prendre un transport en commun sur au moins 3 arrêts', photo: true },
    { title: 'Trouver une plaque de rue qui porte un prénom', photo: true },
    { title: 'Monter au point le plus haut accessible du quartier', photo: true },
    { title: 'Acheter quelque chose à moins de 2 €', photo: true },
    { title: 'Faire un high-five à un inconnu', photo: false },
    { title: 'Chanter 30 secondes dans un lieu public', photo: false }
  ];
  return source.map((c, index) =>
    Object.assign(
      {
        id: `defi_${index + 1}`,
        team: 'spied',
        title: `Défi ${index + 1}`,
        description: '',
        // false = aucune photo, true = obligatoire, 'optional' = acceptée sans l'être.
        photo: false,
        photoLabel: null,
        // true = le maître du jeu doit valider avant que le défi compte.
        approval: false,
        // 'ranking' = classement des joueurs de l'équipe, 'text' = réponse libre.
        answer: null,
        answerValue: null,
        pending: false,
        submittedAt: null,
        submittedBy: null,
        done: false,
        doneAt: null,
        doneBy: null,
        photoFile: null
      },
      c,
      {
        id: c.id || `defi_${index + 1}`,
        done: false,
        doneAt: null,
        doneBy: null,
        photoFile: null,
        answerValue: null,
        pending: false,
        submittedAt: null,
        submittedBy: null
      }
    )
  );
}

/** Round settings: who hunts whom, how long the round lasts, what it is called. */
function defaultSettings() {
  const custom = readConfig('game.json') || {};
  const hunters = custom.hunters === 'spy' ? 'spy' : 'spied';
  return {
    hunters,
    // Équipe qui voit ses adversaires en permanence, sans rien demander.
    // Par défaut la proie : les espions voient les espionnés arriver.
    permanentReveal: ['spy', 'spied', 'none'].includes(custom.permanentReveal)
      ? custom.permanentReveal
      : hunters === 'spied'
      ? 'spy'
      : 'spied',
    durationMin: Number(custom.durationMin) > 0 ? Number(custom.durationMin) : 300,
    appName: process.env.APP_NAME || custom.appName || 'TRAQUE'
  };
}


function randomCode(taken) {
  let code;
  do {
    code = String(crypto.randomInt(10000, 100000));
  } while (taken.has(code));
  taken.add(code);
  return code;
}

function normalizeCodes(raw, source) {
  const valid = {};
  for (const [code, entry] of Object.entries(raw)) {
    if (!/^\d{5}$/.test(code)) {
      console.error(`[store] ${source}: "${code}" n'est pas un code à 5 chiffres, ignoré.`);
      continue;
    }
    const role = entry.role || 'player';
    valid[code] = {
      role,
      team: role === 'player' ? (entry.team === 'spied' ? 'spied' : 'spy') : null,
      label: entry.label || code
    };
  }
  return valid;
}

/**
 * ACCESS_CODES lets a host like Render hold the codes outside the repo and outside
 * the (ephemeral) data dir: "11111:spy:Espion 1,55555:admin:Admin".
 */
function codesFromEnv() {
  const raw = (process.env.ACCESS_CODES || '').trim();
  if (!raw) return null;
  const parsed = {};
  for (const chunk of raw.split(',')) {
    const [code, role, ...label] = chunk.split(':').map((x) => x.trim());
    if (!code) continue;
    const isTeam = role === 'spy' || role === 'spied';
    parsed[code] = {
      role: isTeam ? 'player' : role,
      team: isTeam ? role : null,
      label: label.join(':') || code
    };
  }
  const valid = normalizeCodes(parsed, 'ACCESS_CODES');
  return Object.keys(valid).length ? valid : null;
}

/**
 * D'où viennent les codes, dans l'ordre : le fichier config/codes.json s'il existe
 * (c'est un choix explicite), puis ACCESS_CODES, puis un tirage aléatoire.
 * La source est toujours annoncée au démarrage : rien ne doit se décider en silence.
 */
let avertiSurDoublon = false;

function resolveCodes() {
  const custom = readConfig('codes.json');
  if (custom && Object.keys(custom).length) {
    const valid = normalizeCodes(custom, 'config/codes.json');
    if (Object.keys(valid).length) {
      if (process.env.ACCESS_CODES && !avertiSurDoublon) {
        avertiSurDoublon = true;
        console.warn('[store] config/codes.json ET ACCESS_CODES sont présents : le fichier gagne.');
      }
      return { codes: valid, source: 'config/codes.json' };
    }
  }

  const fromEnv = codesFromEnv();
  if (fromEnv) return { codes: fromEnv, source: 'ACCESS_CODES' };

  return { codes: randomCodes(), source: 'tirage aléatoire' };
}

/** Signature d'un jeu de codes, pour repérer qu'un fichier a changé depuis. */
function signature(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

function defaultCodes() {
  return resolveCodes().codes;
}

function randomCodes() {
  const taken = new Set();
  const codes = {};
  const add = (role, team, label) => {
    codes[randomCode(taken)] = { role, team, label };
  };
  add('player', 'spy', 'Espion 1');
  add('player', 'spy', 'Espion 2');
  add('player', 'spied', 'Espionné 1');
  add('player', 'spied', 'Espionné 2');
  add('player', 'spied', 'Espionné 3');
  add('admin', null, 'Maître du jeu');
  add('viewer', null, 'Écran spectateur');
  return codes;
}

function defaultState() {
  const settings = defaultSettings();
  const resolved = resolveCodes();
  const jokers = defaultJokers();
  const challenges = defaultChallenges();
  return {
    version: 2,
    createdAt: Date.now(),
    codes: resolved.codes,
    codesSource: resolved.source,
    codesSignature: signature(resolved.codes),
    jokersSignature: signature(jokers),
    challengesSignature: signature(challenges),
    devices: {},
    game: {
      settings,
      // La partie attend le maître du jeu : 'lobby' → 'countdown' → 'running'.
      status: 'lobby',
      startedAt: null,
      startsAt: null,
      endsAt: null,
      // Per-team window during which that team can see the opposite team live.
      reveals: { spy: { until: 0, grantedBy: null }, spied: { until: 0, grantedBy: null } },
      // Per-team window during which that team CANNOT be granted any reveal.
      blocks: { spy: { until: 0, reason: null }, spied: { until: 0, reason: null } },
      // Frozen one-shot markers: [{id, team, forTeam, lat, lng, ts, label}]
      pins: [],
      // Timed constraints shown to a team: [{id, team, label, until}]
      effects: [],
      jokers,
      challenges,
      pausedAt: null,
      pauseMessage: null
    },
    requests: [],
    events: [],
    push: { vapid: null, subs: {} }
  };
}

function ensureShape(state) {
  const base = defaultState();
  const merged = Object.assign({}, base, state);
  merged.game = Object.assign({}, base.game, state.game || {});
  merged.game.reveals = Object.assign({}, base.game.reveals, (state.game || {}).reveals || {});
  merged.game.blocks = Object.assign({}, base.game.blocks, (state.game || {}).blocks || {});
  merged.game.jokers = (state.game || {}).jokers || base.game.jokers;
  merged.game.settings = Object.assign({}, base.game.settings, (state.game || {}).settings || {});
  merged.game.challenges = (state.game || {}).challenges || base.game.challenges;
  merged.game.pausedAt = (state.game || {}).pausedAt || null;
  merged.game.pauseMessage = (state.game || {}).pauseMessage || null;
  merged.game.endsAt = (state.game || {}).endsAt || base.game.endsAt;
  merged.game.startsAt = (state.game || {}).startsAt || null;
  merged.game.pins = (state.game || {}).pins || [];
  merged.game.effects = (state.game || {}).effects || [];
  merged.push = Object.assign({}, base.push, state.push || {});
  merged.codes = state.codes && Object.keys(state.codes).length ? state.codes : base.codes;
  merged.devices = state.devices || {};
  merged.requests = state.requests || [];
  merged.events = state.events || [];
  return merged;
}

let state = null;
let saveTimer = null;

/**
 * Un fichier de config modifié après la première partie n'était jamais relu :
 * on compare sa signature à celle enregistrée et on l'applique s'il a changé.
 */
function applyConfigChanges(state) {
  const resolved = resolveCodes();
  const applied = [];

  if (resolved.source !== 'tirage aléatoire') {
    const sig = signature(resolved.codes);
    if (state.codesSignature !== sig) {
      // Les joueurs déjà admis le restent si leur code existe toujours.
      for (const [code, entry] of Object.entries(resolved.codes)) {
        const ancien = state.codes[code];
        if (ancien && ancien.admitted) entry.admitted = true;
      }
      state.codes = resolved.codes;
      state.codesSignature = sig;
      applied.push(`codes (${Object.keys(resolved.codes).length}) depuis ${resolved.source}`);
    }
    state.codesSource = resolved.source;
  }

  const jokers = defaultJokers();
  const jokersSig = signature(jokers);
  if (state.jokersSignature && state.jokersSignature !== jokersSig) {
    state.game.jokers = jokers;
    state.jokersSignature = jokersSig;
    applied.push('jokers');
  } else if (!state.jokersSignature) {
    state.jokersSignature = jokersSig;
  }

  const challenges = defaultChallenges();
  const challengesSig = signature(challenges);
  if (state.challengesSignature && state.challengesSignature !== challengesSig) {
    state.game.challenges = challenges;
    state.challengesSignature = challengesSig;
    applied.push('défis');
  } else if (!state.challengesSignature) {
    state.challengesSignature = challengesSig;
  }

  if (applied.length) console.log(`[store] config modifiée, rechargée : ${applied.join(', ')}`);
  return state;
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = ensureShape(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    } catch (err) {
      console.error('[store] state.json unreadable, starting fresh:', err.message);
      state = defaultState();
    }
  } else {
    state = defaultState();
  }
  applyConfigChanges(state);
  save(true);
  return state;
}

function save(immediate) {
  if (immediate) {
    clearTimeout(saveTimer);
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[store] save failed:', err.message);
    }
  }, 500);
}

function get() {
  if (!state) load();
  return state;
}

/** Wipe the round, keep the codes and the signed-in devices. */
function resetGame() {
  const s = get();
  const fresh = defaultState();
  s.game = fresh.game;
  s.requests = [];
  s.events = [];
  save(true);
  return s;
}

module.exports = {
  get,
  load,
  resolveCodes,
  save,
  resetGame,
  defaultState,
  defaultJokers,
  defaultChallenges,
  randomCode,
  TEAMS,
  DATA_DIR
};

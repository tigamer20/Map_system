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


/** Default joker deck: 2 per team, each with a requirement the admin validates. */
function defaultJokers() {
  const custom = readConfig('jokers.json');
  if (custom && custom.spy && custom.spied) {
    for (const team of TEAMS) {
      custom[team] = custom[team].map((joker, index) =>
        Object.assign(
          { id: `${team}_${index}`, team, icon: '*', durationMin: 5, effect: 'freeze', requiresApproval: true, usedAt: null },
          joker,
          { team, usedAt: null }
        )
      );
    }
    return custom;
  }
  return {
    spy: [
      {
        id: 'spy_satellite',
        team: 'spy',
        name: 'Satellite Ping',
        icon: 'S',
        requirement: 'The whole spy team must be together at a bus stop or metro station.',
        effect: 'snapshot_pin',
        effectLabel: 'Drops a pin with the exact position of every spied player, right now.',
        durationMin: 0,
        requiresApproval: true,
        usedAt: null
      },
      {
        id: 'spy_roadblock',
        team: 'spy',
        name: 'Roadblock',
        icon: 'R',
        requirement: 'Name out loud the district you believe the spied team is hiding in.',
        effect: 'freeze',
        effectLabel: 'The spied team must stay where they are for 10 minutes.',
        durationMin: 10,
        requiresApproval: true,
        usedAt: null
      }
    ],
    spied: [
      {
        id: 'spied_smoke',
        team: 'spied',
        name: 'Smoke Screen',
        icon: 'X',
        requirement: 'Send the admin a photo of the street sign next to you.',
        effect: 'block_reveal',
        effectLabel: 'The spies cannot get any location access for 15 minutes.',
        durationMin: 15,
        requiresApproval: true,
        usedAt: null
      },
      {
        id: 'spied_counter',
        team: 'spied',
        name: 'Counter-Intel',
        icon: 'C',
        requirement: 'Answer correctly the trivia question asked by the admin.',
        effect: 'reveal_opponents',
        effectLabel: 'The spied team sees every spy on the map for 3 minutes.',
        durationMin: 3,
        requiresApproval: true,
        usedAt: null
      }
    ]
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

function defaultCodes() {
  const custom = readConfig('codes.json');
  if (custom && Object.keys(custom).length) {
    const valid = {};
    for (const [code, entry] of Object.entries(custom)) {
      if (!/^\d{5}$/.test(code)) {
        console.error(`[store] config/codes.json: "${code}" is not 5 digits, skipped.`);
        continue;
      }
      valid[code] = {
        role: entry.role || 'player',
        team: entry.role === 'player' || !entry.role ? entry.team || 'spy' : null,
        label: entry.label || code
      };
    }
    if (Object.keys(valid).length) return valid;
  }
  const taken = new Set();
  const codes = {};
  const add = (role, team, label) => {
    codes[randomCode(taken)] = { role, team, label };
  };
  add('player', 'spy', 'Spy 1');
  add('player', 'spy', 'Spy 2');
  add('player', 'spy', 'Spy 3');
  add('player', 'spied', 'Spied 1');
  add('player', 'spied', 'Spied 2');
  add('player', 'spied', 'Spied 3');
  add('admin', null, 'Game master');
  add('viewer', null, 'Viewer screen');
  return codes;
}

function defaultState() {
  return {
    version: 1,
    createdAt: Date.now(),
    codes: defaultCodes(),
    devices: {},
    game: {
      status: 'running',
      startedAt: Date.now(),
      // Per-team window during which that team can see the opposite team live.
      reveals: { spy: { until: 0, grantedBy: null }, spied: { until: 0, grantedBy: null } },
      // Per-team window during which that team CANNOT be granted any reveal.
      blocks: { spy: { until: 0, reason: null }, spied: { until: 0, reason: null } },
      // Frozen one-shot markers: [{id, team, forTeam, lat, lng, ts, label}]
      pins: [],
      // Timed constraints shown to a team: [{id, team, label, until}]
      effects: [],
      jokers: defaultJokers()
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

module.exports = { get, load, save, resetGame, defaultState, defaultJokers, randomCode, TEAMS, DATA_DIR };

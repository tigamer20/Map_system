/* Spy map client: live positions, role-aware panels, alerts. */
(function () {
  'use strict';

  const token = localStorage.getItem('spymap.token');
  if (!token) {
    location.replace('/');
    return;
  }

  const el = (id) => document.getElementById(id);
  const TEAM_LABEL = { spy: 'Spies', spied: 'Spied' };

  const ui = {
    app: el('app'),
    roleChip: el('roleChip'),
    roleText: el('roleText'),
    statusChip: el('statusChip'),
    statusText: el('statusText'),
    sheet: el('sheet'),
    sheetBody: el('sheetBody'),
    tabs: el('tabs'),
    toasts: el('toasts'),
    alertLayer: el('alertLayer'),
    alertTitle: el('alertTitle'),
    alertBody: el('alertBody'),
    alertIcon: el('alertIcon')
  };

  let config = {};
  let gameMap = null;
  let snapshot = null;
  let socket = null;
  let serverOffset = 0;
  let activeTab = null;
  let myPosition = null;
  let lastSent = 0;
  let reconnectDelay = 1000;
  let interactionUntil = 0;
  let lastFix = null;

  const now = () => Date.now() + serverOffset;

  /* --------------------------------------------------------------- helpers */

  async function api(path, options) {
    const res = await fetch(path, Object.assign({}, options, {
      headers: Object.assign({ 'content-type': 'application/json', authorization: `Bearer ${token}` }, (options || {}).headers)
    }));
    if (res.status === 401) {
      localStorage.removeItem('spymap.token');
      location.replace('/');
      throw new Error('Signed out');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function toast(message, kind) {
    const node = document.createElement('div');
    node.className = `toast${kind ? ' ' + kind : ''}`;
    node.textContent = message;
    ui.toasts.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  function fmtClock(ms) {
    if (ms <= 0) return '0:00';
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function fmtAgo(ts) {
    const secs = Math.max(0, Math.round((now() - ts) / 1000));
    if (secs < 10) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    return `${Math.round(secs / 3600)}h ago`;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function distance(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function fmtDistance(m) {
    if (m == null) return '—';
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ---------------------------------------------------------------- alerts */

  let audioCtx = null;
  function siren() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const start = audioCtx.currentTime;
      [0, 0.28, 0.56].forEach((offset) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, start + offset);
        osc.frequency.exponentialRampToValueAtTime(1500, start + offset + 0.18);
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.32, start + offset + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.24);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(start + offset);
        osc.stop(start + offset + 0.26);
      });
    } catch (err) {
      /* audio is a nice-to-have */
    }
  }

  function showAlert(data) {
    if (data.observer) {
      // Admin / viewer: never block the console with a modal.
      toast(`${data.title}${data.body ? ' — ' + data.body : ''}`);
      return;
    }
    ui.alertTitle.textContent = data.title || 'Alert';
    ui.alertBody.textContent = data.body || '';
    ui.alertIcon.textContent =
      { joker: '\u{1F0CF}', exposed: '\u{1F441}', granted: '\u{1F4CD}', denied: '\u{26D4}', announce: '\u{1F4E3}', request: '\u{1F514}' }[data.kind] || '\u{26A0}';
    ui.alertLayer.hidden = false;
    siren();
    if (navigator.vibrate) navigator.vibrate([220, 90, 220, 90, 420]);
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      try {
        new Notification(data.title || 'Spy map', { body: data.body || '', icon: '/icons/icon.svg', tag: 'spymap' });
      } catch (err) {
        /* some browsers only allow SW notifications */
      }
    }
  }

  el('alertDismiss').addEventListener('click', () => {
    ui.alertLayer.hidden = true;
  });

  /* ------------------------------------------------------------ websocket */

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws`);

    socket.addEventListener('open', () => {
      reconnectDelay = 1000;
      socket.send(JSON.stringify({ t: 'auth', token }));
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === 'state') {
        serverOffset = msg.data.now - Date.now();
        snapshot = msg.data;
        render();
      } else if (msg.t === 'alert') {
        showAlert(msg.data);
      } else if (msg.t === 'unauthorized') {
        localStorage.removeItem('spymap.token');
        location.replace('/');
      }
    });

    socket.addEventListener('close', () => {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 12000);
    });

    socket.addEventListener('error', () => socket.close());
  }

  function sendPosition(position) {
    const payload = {
      t: 'pos',
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      heading: position.coords.heading,
      speed: position.coords.speed
    };
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(payload));
    else api('/api/position', { method: 'POST', body: JSON.stringify(payload) }).catch(() => {});
  }

  /* ---------------------------------------------------------- geolocation */

  function startTracking() {
    if (!navigator.geolocation) {
      toast('This device has no GPS API.', 'error');
      return;
    }
    navigator.geolocation.watchPosition(
      (position) => {
        const coords = position.coords;
        const point = { lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy };
        const moved = !myPosition || distance(myPosition, point) > 3;
        myPosition = point;
        lastFix = position;

        gameMap.setAccuracy(point.lng, point.lat, coords.accuracy);
        gameMap.followTo(point.lng, point.lat);

        if (moved || Date.now() - lastSent > 4000) {
          lastSent = Date.now();
          sendPosition(position);
        }
        setStatus(`GPS ±${Math.round(coords.accuracy)} m`, 'live');
      },
      (err) => {
        const messages = {
          1: 'Location permission denied — the game needs it.',
          2: 'Position unavailable. Move outside and retry.',
          3: 'GPS timed out, still trying…'
        };
        setStatus(messages[err.code] || 'GPS error', 'warn');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );

    // A phone that is not moving can stay silent for minutes. Re-send the last fix
    // so the player never goes grey on the map, and comes back after an admin reset.
    setInterval(() => {
      if (lastFix) sendPosition(lastFix);
    }, 8000);

    keepAwake();
  }

  async function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    let lock = null;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch (err) {
        /* denied or unsupported */
      }
    };
    await acquire();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!lock || lock.released)) acquire();
    });
  }

  function setStatus(text, kind) {
    ui.statusChip.hidden = false;
    ui.statusChip.className = `chip ${kind || ''}`;
    ui.statusText.textContent = text;
  }

  /* ------------------------------------------------------- push (phones) */

  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !config.vapidPublicKey) return;
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey)
        }));
      await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
      toast('Phone notifications are on.', 'ok');
    } catch (err) {
      toast('Notifications unavailable on this device.', 'error');
    }
  }

  /* ---------------------------------------------------------------- tabs */

  const TABS = {
    player: [
      { id: 'players', label: 'Map' },
      { id: 'jokers', label: 'Jokers' },
      { id: 'requests', label: 'Requests' },
      { id: 'feed', label: 'Feed' }
    ],
    admin: [
      { id: 'requests', label: 'Approvals' },
      { id: 'control', label: 'Control' },
      { id: 'codes', label: 'Codes' },
      { id: 'feed', label: 'Feed' }
    ],
    viewer: [
      { id: 'players', label: 'Players' },
      { id: 'feed', label: 'Feed' },
      { id: 'control', label: 'Overview' }
    ]
  };

  function renderTabs() {
    const role = snapshot.me.role;
    const tabs = TABS[role] || TABS.player;
    if (!activeTab) activeTab = tabs[0].id;

    const pending = (snapshot.requests || []).filter((r) => r.status === 'pending').length;
    ui.tabs.innerHTML = tabs
      .map((tab) => {
        const badge = tab.id === 'requests' && pending ? `<span class="badge">${pending}</span>` : '';
        return `<button class="tab${tab.id === activeTab ? ' active' : ''}" data-tab="${tab.id}">${tab.label}${badge}</button>`;
      })
      .join('');

    ui.tabs.querySelectorAll('.tab').forEach((node) => {
      node.addEventListener('click', () => {
        activeTab = node.dataset.tab;
        ui.sheet.classList.remove('collapsed');
        render(true);
      });
    });
  }

  /* -------------------------------------------------------------- panels */

  function playerCard(player, me) {
    const dist = me && myPosition ? distance(myPosition, player) : null;
    const isMe = player.code === snapshot.me.code;
    return `
      <div class="card ${player.team}">
        <div class="card-head">
          <div class="avatar ${player.team}">${escapeHtml(window.mapUtils.initials(player.name))}</div>
          <div style="flex:1;min-width:0">
            <div class="card-title">${escapeHtml(player.name)}${isMe ? ' (you)' : ''}</div>
            <div class="card-sub">${TEAM_LABEL[player.team]} · ${player.stale ? 'signal lost' : 'live'} · ${fmtAgo(player.ts)}</div>
          </div>
          <button class="btn ghost small" data-goto="${player.code}">View</button>
        </div>
        <div class="meta">
          ${dist != null && !isMe ? `<span>Distance <b>${fmtDistance(dist)}</b></span>` : ''}
          ${player.accuracy != null ? `<span>Accuracy <b>±${Math.round(player.accuracy)} m</b></span>` : ''}
          ${player.speed ? `<span>Speed <b>${(player.speed * 3.6).toFixed(1)} km/h</b></span>` : ''}
        </div>
      </div>`;
  }

  function renderPlayersPanel() {
    const me = snapshot.me;
    const mine = snapshot.players.filter((p) => p.team === me.team);
    const others = snapshot.players.filter((p) => p.team !== me.team);
    const isPlayer = me.role === 'player';
    let html = '';

    if (isPlayer) {
      const reveal = snapshot.game.reveals[me.team];
      const remaining = reveal.until - now();
      if (snapshot.jammed) {
        html += `<div class="card"><div class="card-title">Signals jammed</div><div class="card-sub">The other team blocked your tracking for ${fmtClock(snapshot.game.blocks[me.team].until - now())}.</div></div>`;
      } else if (remaining > 0) {
        html += `<div class="card"><div class="card-title">Live tracking active — ${fmtClock(remaining)}</div><div class="card-sub">You can see every ${TEAM_LABEL[me.team === 'spy' ? 'spied' : 'spy'].toLowerCase()} on the map until the timer ends.</div></div>`;
      }
      (snapshot.effects || []).forEach((effect) => {
        html += `<div class="card spied"><div class="card-title">${escapeHtml(effect.label)}</div><div class="card-sub">${fmtClock(effect.until - now())} left</div></div>`;
      });
    }

    html += `<div class="section-label">${isPlayer ? 'Your team' : 'Spies'}</div>`;
    const first = isPlayer ? mine : snapshot.players.filter((p) => p.team === 'spy');
    html += first.length ? first.map((p) => playerCard(p, true)).join('') : '<div class="empty">Nobody is sharing a position yet.</div>';

    const second = isPlayer ? others : snapshot.players.filter((p) => p.team === 'spied');
    html += `<div class="section-label">${isPlayer ? 'Other team' : 'Spied'}</div>`;
    if (second.length) {
      html += second.map((p) => playerCard(p, true)).join('');
    } else if (isPlayer && me.team === 'spy') {
      html += `<div class="empty">No access to the spied team right now.<br />Ask the admin for a reveal from the Requests tab.</div>`;
    } else {
      html += '<div class="empty">Hidden.</div>';
    }

    if (snapshot.pins && snapshot.pins.length) {
      html += '<div class="section-label">Snapshot pins</div>';
      html += snapshot.pins
        .map(
          (pin) => `<div class="card ${pin.team}">
            <div class="card-title">${escapeHtml(pin.label)} — seen at ${fmtTime(pin.ts)}</div>
            <div class="card-sub">Frozen position. Expires in ${fmtClock(pin.expiresAt - now())}.</div>
            <div class="card-actions"><button class="btn ghost small" data-goto-pin="${pin.id}">Show on map</button></div>
          </div>`
        )
        .join('');
    }

    return html;
  }

  function renderJokersPanel() {
    const jokers = snapshot.jokers || [];
    const pending = (snapshot.myRequests || []).filter((r) => r.status === 'pending' && r.type === 'joker');
    let html = `<div class="section-label">Your two jokers</div>`;
    html += jokers
      .map((joker) => {
        const waiting = pending.find((r) => r.payload.jokerId === joker.id);
        const used = !!joker.usedAt;
        return `<div class="card joker ${joker.team}${used ? ' used' : ''}">
          <div class="card-head">
            <div class="avatar ${joker.team}">${escapeHtml(joker.icon || '*')}</div>
            <div style="flex:1;min-width:0">
              <div class="card-title">${escapeHtml(joker.name)}</div>
              <div class="card-sub">${escapeHtml(joker.effectLabel)}</div>
            </div>
          </div>
          <div class="req"><b>Requirement</b>${escapeHtml(joker.requirement)}</div>
          <div class="card-actions">
            ${
              used
                ? `<span class="card-sub">Used at ${fmtTime(joker.usedAt)}</span>`
                : waiting
                ? `<span class="card-sub">Waiting for the admin…</span>`
                : `<button class="btn small" data-joker="${joker.id}">Play this joker</button>`
            }
          </div>
        </div>`;
      })
      .join('');
    html += `<div class="empty">The admin checks the requirement before the joker fires. The other team gets a notification on their phone the moment it does.</div>`;
    return html;
  }

  function renderRequestsPanel() {
    const me = snapshot.me;

    if (me.role === 'player') {
      let html = '';
      if (me.team === 'spy') {
        html += `<div class="card spy">
          <div class="card-title">Ask for the spied location</div>
          <div class="card-sub">The admin decides. Live tracking runs for a few minutes, a snapshot drops a single pin.</div>
          <div class="card-actions">
            <button class="btn small" data-request="live">Request live tracking</button>
            <button class="btn ghost small" data-request="snapshot">Request a snapshot</button>
          </div>
        </div>`;
      } else {
        html += `<div class="card spied">
          <div class="card-title">You are the target</div>
          <div class="card-sub">The spies have to ask the admin before they can see you. You will be notified every time access is granted.</div>
        </div>`;
      }
      html += '<div class="section-label">Your team history</div>';
      const list = snapshot.myRequests || [];
      html += list.length
        ? list
            .map(
              (r) => `<div class="card">
                <div class="card-title">${r.type === 'joker' ? 'Joker' : 'Location access'} · ${r.status}</div>
                <div class="card-sub">${fmtTime(r.createdAt)} · asked by ${escapeHtml(r.from)}${r.note ? ` · “${escapeHtml(r.note)}”` : ''}</div>
              </div>`
            )
            .join('')
        : '<div class="empty">No requests yet.</div>';
      return html;
    }

    const requests = snapshot.requests || [];
    const pending = requests.filter((r) => r.status === 'pending');
    const done = requests.filter((r) => r.status !== 'pending').slice(0, 12);

    let html = '<div class="section-label">Waiting for you</div>';
    html += pending.length
      ? pending
          .map((r) => {
            const joker = r.type === 'joker' ? (snapshot.jokers[r.team] || []).find((j) => j.id === r.payload.jokerId) : null;
            return `<div class="card ${r.team}">
              <div class="card-title">${TEAM_LABEL[r.team]} · ${joker ? escapeHtml(joker.name) : 'Location access'}</div>
              <div class="card-sub">Asked by ${escapeHtml(r.from)} at ${fmtTime(r.createdAt)}</div>
              ${joker ? `<div class="req"><b>Check this first</b>${escapeHtml(joker.requirement)}</div>` : ''}
              ${!joker ? `<div class="req"><b>Mode asked</b>${r.payload.mode === 'snapshot' ? 'One-shot snapshot pin' : 'Live tracking'}</div>` : ''}
              <div class="card-actions">
                ${
                  joker
                    ? `<button class="btn small" data-decide="${r.id}" data-approve="1">Approve</button>`
                    : `<button class="btn small" data-decide="${r.id}" data-approve="1" data-mode="${r.payload.mode || 'live'}" data-minutes="3">Approve 3 min</button>
                       <button class="btn ghost small" data-decide="${r.id}" data-approve="1" data-mode="${r.payload.mode || 'live'}" data-minutes="10">Approve 10 min</button>`
                }
                <button class="btn danger small" data-decide="${r.id}" data-approve="0">Deny</button>
              </div>
            </div>`;
          })
          .join('')
      : '<div class="empty">Nothing pending. Relax.</div>';

    html += '<div class="section-label">Recent decisions</div>';
    html += done.length
      ? done
          .map(
            (r) => `<div class="event"><time>${fmtTime(r.decidedAt || r.createdAt)}</time><span class="kind ${r.status === 'denied' ? 'denied' : 'request'}"></span><span>${TEAM_LABEL[r.team]} · ${r.type} · <b>${r.status}</b></span></div>`
          )
          .join('')
      : '<div class="empty">No decisions yet.</div>';
    return html;
  }

  function renderControlPanel() {
    const isAdmin = snapshot.me.role === 'admin';
    const g = snapshot.game;
    let html = '<div class="section-label">Live tracking windows</div>';

    ['spy', 'spied'].forEach((team) => {
      const reveal = g.reveals[team];
      const block = g.blocks[team];
      const remaining = reveal.until - now();
      html += `<div class="card ${team}">
        <div class="card-title">${TEAM_LABEL[team]} can see ${TEAM_LABEL[team === 'spy' ? 'spied' : 'spy'].toLowerCase()}</div>
        <div class="card-sub">${
          block.until > now()
            ? `Jammed for ${fmtClock(block.until - now())} (${escapeHtml(block.reason || 'joker')})`
            : remaining > 0
            ? `Active — ${fmtClock(remaining)} left`
            : 'No access'
        }</div>
        ${
          isAdmin
            ? `<div class="card-actions">
                <button class="btn small" data-reveal="${team}" data-minutes="3">+3 min</button>
                <button class="btn ghost small" data-reveal="${team}" data-minutes="10">+10 min</button>
                <button class="btn ghost small" data-reveal="${team}" data-mode="snapshot">Snapshot</button>
                <button class="btn danger small" data-reveal="${team}" data-revoke="1">Cut</button>
              </div>`
            : ''
        }
      </div>`;
    });

    if (isAdmin) {
      html += '<div class="section-label">Message a team</div>';
      html += `<div class="card">
        <div class="field"><label for="announceText">Message (lands as a phone alert)</label><textarea id="announceText" rows="2" placeholder="Checkpoint reached, head to the station."></textarea></div>
        <div class="field"><label for="announceTeam">Send to</label>
          <select id="announceTeam"><option value="all">Both teams</option><option value="spy">Spies only</option><option value="spied">Spied only</option></select>
        </div>
        <button class="btn small" id="announceBtn">Send alert</button>
      </div>`;

      html += '<div class="section-label">Jokers on the board</div>';
      ['spy', 'spied'].forEach((team) => {
        (snapshot.jokers[team] || []).forEach((joker) => {
          html += `<div class="card ${team}">
            <div class="card-title">${escapeHtml(joker.name)} · ${TEAM_LABEL[team]}</div>
            <div class="card-sub">${joker.usedAt ? `Played at ${fmtTime(joker.usedAt)}` : 'Still available'} — ${escapeHtml(joker.effectLabel)}</div>
          </div>`;
        });
      });

      html += '<div class="section-label">Danger zone</div>';
      html += `<div class="card"><div class="card-sub">Resets jokers, timers, pins and the feed. Codes stay valid.</div>
        <div class="card-actions"><button class="btn danger small" id="resetBtn">Reset the game</button></div></div>`;
    } else {
      html += '<div class="section-label">Distances</div>';
      const spies = snapshot.players.filter((p) => p.team === 'spy');
      const spied = snapshot.players.filter((p) => p.team === 'spied');
      const rows = [];
      spies.forEach((s) => spied.forEach((t) => rows.push({ s, t, d: distance(s, t) })));
      rows.sort((a, b) => a.d - b.d);
      html += rows.length
        ? rows
            .slice(0, 12)
            .map(
              (row) => `<div class="event"><time>${fmtDistance(row.d)}</time><span class="kind reveal"></span><span>${escapeHtml(row.s.name)} → ${escapeHtml(row.t.name)}</span></div>`
            )
            .join('')
        : '<div class="empty">Waiting for both teams to appear.</div>';
    }

    html += `<div class="section-label">Device</div>
      <div class="card"><div class="card-title">${escapeHtml(snapshot.me.label)}</div>
      <div class="card-sub">Code ${escapeHtml(snapshot.me.code)} · ${snapshot.me.role}</div>
      <div class="card-actions">
        <button class="btn ghost small" id="pushBtn">Enable phone alerts</button>
        <button class="btn danger small" id="logoutBtn">Sign out</button>
      </div></div>`;
    return html;
  }

  function renderCodesPanel() {
    const roster = snapshot.roster || [];
    let html = '<div class="section-label">Access codes</div>';
    html += roster
      .map(
        (entry) => `<div class="card ${entry.team || ''}">
          <div class="card-head">
            <div style="flex:1;min-width:0">
              <div class="code-pill">${escapeHtml(entry.code)}</div>
              <div class="card-sub">${escapeHtml(entry.label)} · ${entry.role}${entry.team ? ' · ' + TEAM_LABEL[entry.team] : ''} · ${entry.online ? 'on the map' : 'idle'}</div>
            </div>
          </div>
          <div class="card-actions">
            <button class="btn ghost small" data-rotate="${entry.code}">New code</button>
            <button class="btn danger small" data-remove="${entry.code}">Delete</button>
          </div>
        </div>`
      )
      .join('');

    html += '<div class="section-label">Add a code</div>';
    html += `<div class="card">
      <div class="field"><label for="newLabel">Name on the map</label><input id="newLabel" placeholder="Spy 4" /></div>
      <div class="row">
        <div class="field"><label for="newRole">Role</label>
          <select id="newRole"><option value="player">Player</option><option value="admin">Admin</option><option value="viewer">Viewer</option></select>
        </div>
        <div class="field"><label for="newTeam">Team</label>
          <select id="newTeam"><option value="spy">Spies</option><option value="spied">Spied</option></select>
        </div>
      </div>
      <button class="btn small" id="addCodeBtn">Generate code</button>
    </div>`;
    return html;
  }

  function renderFeedPanel() {
    const events = snapshot.events || [];
    if (!events.length) return '<div class="empty">Nothing has happened yet.</div>';
    return events
      .map(
        (event) => `<div class="event"><time>${fmtTime(event.ts)}</time><span class="kind ${event.kind}"></span><span>${escapeHtml(event.text)}</span></div>`
      )
      .join('');
  }

  /* -------------------------------------------------------------- render */

  function render(force) {
    if (!snapshot) return;

    const me = snapshot.me;
    ui.roleChip.className = `chip ${me.team || ''}`;
    ui.roleText.textContent = me.role === 'player' ? `${me.label} · ${TEAM_LABEL[me.team]}` : me.label;
    if (me.role !== 'player') {
      const live = snapshot.players.filter((p) => !p.stale).length;
      setStatus(`${live} player${live === 1 ? '' : 's'} live`, live ? 'live' : '');
    }

    gameMap.render(snapshot.players, me.code);
    gameMap.renderPins(snapshot.pins || []);

    renderTabs();
    const panels = {
      players: renderPlayersPanel,
      jokers: renderJokersPanel,
      requests: renderRequestsPanel,
      control: renderControlPanel,
      codes: renderCodesPanel,
      feed: renderFeedPanel
    };
    // The panel redraws every second for the countdowns: never yank the DOM
    // out from under a finger that is already on a button.
    if (!force && Date.now() < interactionUntil) return;

    const scroll = ui.sheetBody.scrollTop;
    const focusId = document.activeElement ? document.activeElement.id : null;
    const values = {};
    ui.sheetBody.querySelectorAll('input[id], select[id], textarea[id]').forEach((node) => {
      values[node.id] = node.value;
    });

    ui.sheetBody.innerHTML = (panels[activeTab] || renderPlayersPanel)();

    Object.keys(values).forEach((id) => {
      const node = el(id);
      if (node) node.value = values[id];
    });
    ui.sheetBody.scrollTop = scroll;
    if (focusId && el(focusId)) el(focusId).focus();
    wirePanel();
  }

  /* ------------------------------------------------------------- actions */

  function wirePanel() {
    const body = ui.sheetBody;

    body.querySelectorAll('[data-goto]').forEach((node) =>
      node.addEventListener('click', () => {
        const player = snapshot.players.find((p) => p.code === node.dataset.goto);
        if (player) {
          gameMap.follow = false;
          gameMap.centerOn(player.lng, player.lat, 17);
          ui.sheet.classList.add('collapsed');
        }
      })
    );

    body.querySelectorAll('[data-goto-pin]').forEach((node) =>
      node.addEventListener('click', () => {
        const pin = (snapshot.pins || []).find((p) => p.id === node.dataset.gotoPin);
        if (pin) {
          gameMap.follow = false;
          gameMap.centerOn(pin.lng, pin.lat, 17);
          ui.sheet.classList.add('collapsed');
        }
      })
    );

    body.querySelectorAll('[data-request]').forEach((node) =>
      node.addEventListener('click', async () => {
        node.disabled = true;
        try {
          await api('/api/request', {
            method: 'POST',
            body: JSON.stringify({ type: 'location', payload: { mode: node.dataset.request } })
          });
          toast('Request sent to the admin.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
        node.disabled = false;
      })
    );

    body.querySelectorAll('[data-joker]').forEach((node) =>
      node.addEventListener('click', async () => {
        const joker = (snapshot.jokers || []).find((j) => j.id === node.dataset.joker);
        if (!confirm(`Play "${joker.name}"?\n\nRequirement: ${joker.requirement}\n\nThe admin has to validate it.`)) return;
        node.disabled = true;
        try {
          await api('/api/request', {
            method: 'POST',
            body: JSON.stringify({ type: 'joker', payload: { jokerId: joker.id } })
          });
          toast('Joker sent for approval.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
        node.disabled = false;
      })
    );

    body.querySelectorAll('[data-decide]').forEach((node) =>
      node.addEventListener('click', async () => {
        node.disabled = true;
        try {
          await api('/api/admin/decide', {
            method: 'POST',
            body: JSON.stringify({
              id: node.dataset.decide,
              approve: node.dataset.approve === '1',
              minutes: node.dataset.minutes ? Number(node.dataset.minutes) : undefined,
              mode: node.dataset.mode
            })
          });
        } catch (err) {
          toast(err.message, 'error');
          node.disabled = false;
        }
      })
    );

    body.querySelectorAll('[data-reveal]').forEach((node) =>
      node.addEventListener('click', async () => {
        try {
          await api('/api/admin/reveal', {
            method: 'POST',
            body: JSON.stringify({
              team: node.dataset.reveal,
              minutes: node.dataset.minutes ? Number(node.dataset.minutes) : undefined,
              mode: node.dataset.mode,
              revoke: node.dataset.revoke === '1'
            })
          });
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );

    const announceBtn = el('announceBtn');
    if (announceBtn) {
      announceBtn.addEventListener('click', async () => {
        const text = el('announceText').value.trim();
        if (!text) return;
        try {
          await api('/api/admin/announce', {
            method: 'POST',
            body: JSON.stringify({ text, team: el('announceTeam').value })
          });
          el('announceText').value = '';
          toast('Alert sent.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    const addCodeBtn = el('addCodeBtn');
    if (addCodeBtn) {
      addCodeBtn.addEventListener('click', async () => {
        try {
          const data = await api('/api/admin/codes', {
            method: 'POST',
            body: JSON.stringify({
              action: 'add',
              role: el('newRole').value,
              team: el('newTeam').value,
              label: el('newLabel').value || 'New player'
            })
          });
          toast(`Code ${data.code} created.`, 'ok');
          refreshState();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    body.querySelectorAll('[data-rotate]').forEach((node) =>
      node.addEventListener('click', async () => {
        if (!confirm('Generate a new code? The current device will be signed out.')) return;
        try {
          const data = await api('/api/admin/codes', {
            method: 'POST',
            body: JSON.stringify({ action: 'rotate', code: node.dataset.rotate })
          });
          toast(`New code: ${data.code}`, 'ok');
          refreshState();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );

    body.querySelectorAll('[data-remove]').forEach((node) =>
      node.addEventListener('click', async () => {
        if (!confirm('Delete this code for good?')) return;
        try {
          await api('/api/admin/codes', { method: 'POST', body: JSON.stringify({ action: 'remove', code: node.dataset.remove }) });
          refreshState();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );

    const resetBtn = el('resetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        if (!confirm('Reset the whole game? Jokers, timers and the feed are wiped.')) return;
        await api('/api/admin/reset', { method: 'POST' });
        toast('Game reset.', 'ok');
      });
    }

    const pushBtn = el('pushBtn');
    if (pushBtn) pushBtn.addEventListener('click', enablePush);

    const logoutBtn = el('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' }).catch(() => {});
        localStorage.removeItem('spymap.token');
        location.replace('/');
      });
    }
  }

  async function refreshState() {
    try {
      snapshot = await api('/api/state');
      serverOffset = snapshot.now - Date.now();
      render(true);
    } catch (err) {
      /* the socket will catch up */
    }
  }

  /* ----------------------------------------------------------------- boot */

  el('sheetHandle').addEventListener('click', () => ui.sheet.classList.toggle('collapsed'));

  ['pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach((evt) =>
    ui.sheetBody.addEventListener(evt, () => {
      interactionUntil = Date.now() + 700;
    }, { passive: true })
  );

  el('layersBtn').addEventListener('click', () => {
    const name = gameMap.toggleBasemap();
    el('layersBtn').classList.toggle('active', name === 'satellite');
    toast(name === 'satellite' ? 'Satellite view' : 'Street view');
  });

  el('locateBtn').addEventListener('click', () => {
    if (!myPosition) return toast('No GPS fix yet.', 'error');
    gameMap.follow = true;
    el('locateBtn').classList.add('active');
    gameMap.centerOn(myPosition.lng, myPosition.lat, 17);
  });

  el('fitBtn').addEventListener('click', () => {
    if (!snapshot || !snapshot.players.length) return toast('Nobody on the map yet.', 'error');
    gameMap.follow = false;
    gameMap.fitAll(snapshot.players);
  });

  async function boot() {
    config = await fetch('/api/config').then((r) => r.json());
    document.title = config.appName || 'Spy Map';

    gameMap = new GameMap('map', config, {
      onFollowChange: (follow) => el('locateBtn').classList.toggle('active', follow),
      onMarkerClick: (player) => {
        activeTab = 'players';
        ui.sheet.classList.remove('collapsed');
        render();
      }
    });
    if (gameMap.basemap === 'satellite') el('layersBtn').classList.add('active');

    const role = localStorage.getItem('spymap.role');
    if (role === 'player') {
      startTracking();
      ui.app.classList.add('player');
    }

    connect();
    await refreshState();

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    // Live countdowns stay honest even when no new state arrives.
    setInterval(() => {
      if (snapshot && !document.hidden) render();
    }, 1000);
  }

  boot();
})();

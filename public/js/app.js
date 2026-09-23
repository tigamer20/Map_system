/* Traque — client: positions en direct, panneaux par rôle, alertes. */
(function () {
  'use strict';

  let token = localStorage.getItem('spymap.token');

  /** Safari peut vider le localStorage : le cookie de session permet de revenir. */
  async function recoverSession() {
    if (token) return true;
    try {
      const res = await fetch('/api/me');
      if (!res.ok) return false;
      const me = await res.json();
      if (!me.token) return false;
      token = me.token;
      localStorage.setItem('spymap.token', me.token);
      localStorage.setItem('spymap.role', me.role);
      localStorage.setItem('spymap.team', me.team || '');
      localStorage.setItem('spymap.label', me.label);
      return true;
    } catch (err) {
      return false;
    }
  }

  const el = (id) => document.getElementById(id);
  const TEAM = { spy: 'Espions', spied: 'Espionnés' };
  const TEAM_ONE = { spy: 'espions', spied: 'espionnés' };

  const ui = {
    app: el('app'),
    roleChip: el('roleChip'),
    roleText: el('roleText'),
    statusChip: el('statusChip'),
    statusText: el('statusText'),
    clockChip: el('clockChip'),
    clockText: el('clockText'),
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
  let lastFix = null;
  let lastSent = 0;
  let reconnectDelay = 1000;
  let interactionUntil = 0;
  const pendingPhotos = {};
  let dernierTic = null;

  const now = () => Date.now() + serverOffset;

  /* --------------------------------------------------------------- helpers */

  async function api(path, options) {
    const res = await fetch(path, Object.assign({}, options, {
      headers: Object.assign(
        { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        (options || {}).headers
      )
    }));
    if (res.status === 401) {
      localStorage.removeItem('spymap.token');
      location.replace('/');
      throw new Error('Session expirée');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Une erreur est survenue.');
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
    if (total >= 3600) {
      return `${Math.floor(total / 3600)}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function fmtAgo(ts) {
    const secs = Math.max(0, Math.round((now() - ts) / 1000));
    if (secs < 10) return "à l'instant";
    if (secs < 60) return `il y a ${secs} s`;
    if (secs < 3600) return `il y a ${Math.round(secs / 60)} min`;
    return `il y a ${Math.round(secs / 3600)} h`;
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  function distance(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const fmtDistance = (m) =>
    m == null ? '—' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /** Une photo de téléphone fait 4 Mo : on la redimensionne avant l'envoi. */
  function compressImage(file, maxSide = 1400, quality = 0.72) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('lecture impossible'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('image illisible'));
        img.onload = () => {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---------------------------------------------------------------- alerts */

  let audioCtx = null;

  function audio() {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  /**
   * Une note sinusoïdale à attaque douce : sans arête, contrairement à l'onde
   * carrée qui perçait les oreilles.
   */
  function note(frequence, retard, duree, volume) {
    try {
      const ctx = audio();
      const t = ctx.currentTime + retard;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequence, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(volume, t + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duree);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + duree + 0.05);
    } catch (err) {
      /* le son reste un bonus */
    }
  }

  /** Tic feutré du décompte. */
  const ticDoux = () => note(587.33, 0, 0.35, 0.06);

  /** Accord majeur arpégé au top départ, chaleureux plutôt que strident. */
  const coupDEnvoi = () => [523.25, 659.25, 783.99].forEach((f, i) => note(f, i * 0.08, 1.2, 0.05));

  function chime() {
    try {
      const ctx = audio();
      const start = ctx.currentTime;
      [0, 0.22, 0.44].forEach((offset, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime([784, 988, 1319][i], start + offset);
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.28, start + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.3);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start + offset);
        osc.stop(start + offset + 0.32);
      });
    } catch (err) {
      /* le son reste un bonus */
    }
  }

  // Deux alertes peuvent arriver coup sur coup : on les empile au lieu d'écraser
  // la première, sinon un joueur peut ne jamais voir « Vous êtes repérés ».
  const alertQueue = [];

  function showAlert(data) {
    // inApp === false : l'information est déjà à l'écran (écran de pause), seule
    // la notification push a un intérêt.
    if (data.inApp === false) return;
    if (data.observer) {
      toast(`${data.title}${data.body ? ' — ' + data.body : ''}`);
      return;
    }
    if (!ui.alertLayer.hidden) {
      alertQueue.push(data);
      return;
    }
    paintAlert(data);
  }

  function paintAlert(data) {
    ui.alertTitle.textContent = data.title || 'Alerte';
    ui.alertBody.textContent = data.body || '';
    ui.alertIcon.textContent =
      { joker: '🃏', exposed: '📡', granted: '📍', denied: '⛔', announce: '📣', request: '🔔' }[data.kind] || '⚠️';
    ui.alertLayer.hidden = false;
    el('alertDismiss').textContent = alertQueue.length ? `Compris (${alertQueue.length} autre${alertQueue.length > 1 ? 's' : ''})` : 'Compris';
    chime();
    if (navigator.vibrate) navigator.vibrate([200, 80, 200, 80, 380]);
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      // iOS n'autorise que les notifications émises par le service worker.
      navigator.serviceWorker.ready
        .then((registration) =>
          registration.showNotification(data.title || 'Traque', {
            body: data.body || '',
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            tag: 'traque',
            renotify: true,
            vibrate: [200, 80, 200]
          })
        )
        .catch(() => {});
    }
  }

  el('countCancel').addEventListener('click', async () => {
    try {
      await api('/api/admin/clock', { method: 'POST', body: JSON.stringify({ action: 'cancel' }) });
      toast('Décompte annulé.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  el('alertDismiss').addEventListener('click', () => {
    ui.alertLayer.hidden = true;
    const next = alertQueue.shift();
    if (next) setTimeout(() => paintAlert(next), 260);
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
    lastSent = Date.now();
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

  /* ---------------------------------------------------------- géoloc */

  function startTracking() {
    if (!navigator.geolocation) {
      toast("Ce téléphone n'expose pas de GPS.", 'error');
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

        if (moved || Date.now() - lastSent > 4000) sendPosition(position);
        setStatus(`GPS ±${Math.round(coords.accuracy)} m`, 'live');
      },
      (err) => {
        const messages = {
          1: 'Autorisation de localisation refusée.',
          2: 'Position indisponible. Sortez et réessayez.',
          3: 'Le GPS met du temps, on réessaie…'
        };
        setStatus(messages[err.code] || 'Erreur GPS', 'warn');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );

    // Un téléphone immobile peut rester muet plusieurs minutes : on renvoie le
    // dernier point pour ne jamais disparaître de la carte.
    setInterval(() => {
      if (lastFix) sendPosition(lastFix);
    }, 8000);

    // iOS et Android gèlent le GPS d'un onglet en arrière-plan : au retour, on
    // redemande un point immédiatement plutôt que d'attendre le prochain battement.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      navigator.geolocation.getCurrentPosition(
        (position) => {
          myPosition = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy };
          lastFix = position;
          sendPosition(position);
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
      );
    });

    keepAwake();
  }

  async function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    let lock = null;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch (err) {
        /* refusé ou non supporté */
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

  /* ------------------------------------------------------- push (mobile) */

  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  const isIOS = () =>
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const isStandalone = () =>
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  async function enablePush() {
    // Sur iPhone, le push n'existe que dans une app ajoutée à l'écran d'accueil.
    if (isIOS() && !isStandalone()) {
      showAlert({
        title: 'À installer sur iPhone',
        body:
          "Safari n'autorise les notifications que depuis une app installée. Appuyez sur Partager, puis « Sur l'écran d'accueil », ouvrez Traque depuis l'icône et réactivez les notifications.",
        kind: 'announce'
      });
      return;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !config.vapidPublicKey) {
      toast('Notifications indisponibles sur cet appareil.', 'error');
      return;
    }
    try {
      await navigator.serviceWorker.register('/sw.js');
      const registration = await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('Notifications refusées dans les réglages du navigateur.', 'error');
        return;
      }
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey)
        }));
      await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
      toast('Notifications activées sur ce téléphone.', 'ok');
    } catch (err) {
      toast(`Notifications impossibles : ${err.message}`, 'error');
    }
  }

  /* ---------------------------------------------------------------- tabs */

  const TABS = {
    player: [
      { id: 'players', label: 'Carte' },
      { id: 'jokers', label: 'Jokers' },
      { id: 'requests', label: 'Demandes' },
      { id: 'feed', label: 'Journal' }
    ],
    admin: [
      { id: 'requests', label: 'Validations' },
      { id: 'control', label: 'Contrôle' },
      { id: 'codes', label: 'Codes' },
      { id: 'feed', label: 'Journal' }
    ],
    viewer: [
      { id: 'players', label: 'Joueurs' },
      { id: 'feed', label: 'Journal' },
      { id: 'control', label: 'Résumé' }
    ]
  };

  function renderTabs() {
    let tabs = TABS[snapshot.me.role] || TABS.player;
    const myChallenges = (snapshot.challenges || []).filter((c) => c.team === snapshot.me.team);
    if (snapshot.me.role === 'player' && myChallenges.length) {
      tabs = [tabs[0], { id: 'defis', label: 'Défis' }].concat(tabs.slice(1));
    }
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

  /* -------------------------------------------------------------- panneaux */

  function playerCard(player) {
    const dist = myPosition ? distance(myPosition, player) : null;
    const isMe = player.code === snapshot.me.code;
    return `
      <div class="card ${player.team}">
        <div class="card-head">
          <div class="avatar ${player.team}">${escapeHtml(window.mapUtils.initials(player.name))}</div>
          <div style="flex:1;min-width:0">
            <div class="card-title">${escapeHtml(player.name)}${isMe ? ' (vous)' : ''}</div>
            <div class="card-sub">${TEAM[player.team]} · ${player.stale ? 'signal perdu' : 'en direct'} · ${fmtAgo(player.ts)}</div>
          </div>
          <button class="btn ghost small" data-goto="${player.code}">Voir</button>
        </div>
        <div class="meta">
          ${dist != null && !isMe ? `<span>Distance <b>${fmtDistance(dist)}</b></span>` : ''}
          ${player.accuracy != null ? `<span>Précision <b>±${Math.round(player.accuracy)} m</b></span>` : ''}
          ${player.speed != null ? `<span>Vitesse <b>${(player.speed * 3.6).toFixed(1)} km/h</b></span>` : ''}
        </div>
      </div>`;
  }

  function renderPlayersPanel() {
    const me = snapshot.me;
    const isPlayer = me.role === 'player';
    let html = '';

    if (isPlayer) {
      const reveal = snapshot.game.reveals[me.team];
      const remaining = reveal.until - now();
      const other = me.team === 'spy' ? 'spied' : 'spy';
      const silence = Date.now() - lastSent;
      if (lastSent && silence > 45000) {
        html += `<div class="card alertish"><div class="card-title">Votre position ne part plus</div>
          <div class="card-sub">Dernier envoi ${fmtAgo(now() - silence)}. Gardez l'application ouverte à l'écran :
          iPhone comme Android coupent le GPS d'une application passée en arrière-plan ou écran verrouillé.</div></div>`;
      }
      if (me.seesAlways && !snapshot.jammed) {
        html += `<div class="card accent"><div class="card-title">Vision permanente</div>
          <div class="card-sub">Vous voyez les ${TEAM_ONE[other]} sur la carte en continu, sans rien demander.</div></div>`;
      }
      if (me.seenAlways) {
        html += `<div class="card alertish"><div class="card-title">Vous êtes visibles en permanence</div>
          <div class="card-sub">Les ${TEAM_ONE[other]} voient votre position en continu. À vous de leur échapper.</div></div>`;
      }
      if (snapshot.jammed) {
        html += `<div class="card alertish"><div class="card-title">Demandes bloquées</div>
          <div class="card-sub">Un joker adverse vous bloque encore ${fmtClock(snapshot.game.blocks[me.team].until - now())}.</div></div>`;
      } else if (remaining > 0 && !me.seesAlways) {
        html += `<div class="card accent"><div class="card-title">Suivi en direct — <span class="countdown">${fmtClock(remaining)}</span></div>
          <div class="card-sub">Vous voyez les ${TEAM_ONE[me.team === 'spy' ? 'spied' : 'spy']} sur la carte jusqu'à la fin du compte à rebours.</div></div>`;
      }
      (snapshot.effects || []).forEach((effect) => {
        html += `<div class="card alertish"><div class="card-title">${escapeHtml(effect.label)}</div>
          <div class="card-sub">Encore <span class="countdown">${fmtClock(effect.until - now())}</span></div></div>`;
      });
    }

    const mine = snapshot.players.filter((p) => p.team === me.team);
    const others = snapshot.players.filter((p) => p.team !== me.team);
    const first = isPlayer ? mine : snapshot.players.filter((p) => p.team === 'spy');
    const second = isPlayer ? others : snapshot.players.filter((p) => p.team === 'spied');

    html += `<div class="section-label">${isPlayer ? 'Votre équipe' : 'Espions'}</div>`;
    html += first.length ? first.map(playerCard).join('') : '<div class="empty">Personne ne partage encore sa position.</div>';

    html += `<div class="section-label">${isPlayer ? 'Équipe adverse' : 'Espionnés'}</div>`;
    if (second.length) {
      html += second.map(playerCard).join('');
    } else if (isPlayer && me.seesAlways) {
      html += `<div class="empty">Aucun ${TEAM_ONE[me.team === 'spy' ? 'spied' : 'spy'].replace(/s$/, '')} n'a encore partagé sa position.</div>`;
    } else if (isPlayer && me.isHunter) {
      html += `<div class="empty">Aucun accès à la position des ${TEAM_ONE[me.team === 'spy' ? 'spied' : 'spy']}.<br />Faites une demande depuis l'onglet Demandes.</div>`;
    } else {
      html += '<div class="empty">Position masquée.</div>';
    }

    if (snapshot.pins && snapshot.pins.length) {
      html += '<div class="section-label">Positions figées</div>';
      html += snapshot.pins
        .map(
          (pin) => `<div class="card ${pin.team}">
            <div class="card-title">${escapeHtml(pin.label)} — vu à ${fmtTime(pin.ts)}</div>
            <div class="card-sub">Point figé, disparaît dans ${fmtClock(pin.expiresAt - now())}.</div>
            <div class="card-actions"><button class="btn ghost small" data-goto-pin="${pin.id}">Voir sur la carte</button></div>
          </div>`
        )
        .join('');
    }

    if (isPlayer) html += deviceCard();

    return html;
  }

  function renderJokersPanel() {
    const jokers = snapshot.jokers || [];
    const pending = (snapshot.myRequests || []).filter((r) => r.status === 'pending' && r.type === 'unlock');

    let html = `<div class="section-label">Vos 2 jokers</div>`;
    html += jokers
      .map((joker) => {
        const waiting = pending.find((r) => r.payload.jokerId === joker.id);
        const used = !!joker.usedAt;
        const locked = joker.requiresUnlock && !joker.unlocked;

        let state = '<span class="pill ok">Prêt</span>';
        if (used) state = '<span class="pill used">Utilisé</span>';
        else if (locked) state = '<span class="pill locked">À débloquer</span>';

        let actions = '';
        if (used) {
          actions = `<span class="card-sub">Joué à ${fmtTime(joker.usedAt)}${joker.detail ? ` · ${escapeHtml(joker.detail)}` : ''}</span>`;
        } else if (locked) {
          actions = waiting
            ? '<span class="card-sub">Le maître du jeu vérifie votre défi…</span>'
            : `<button class="btn small" data-unlock="${joker.id}">Défi fait, débloquer</button>`;
        } else {
          actions = `<button class="btn small" data-play="${joker.id}">Jouer ce joker</button>`;
        }

        return `<div class="card joker ${joker.team}${used ? ' used' : ''}">
          <div class="card-head">
            <div class="avatar ${joker.team}">${escapeHtml(joker.icon || '★')}</div>
            <div style="flex:1;min-width:0">
              <div class="card-title">${escapeHtml(joker.name)}</div>
            </div>
            ${state}
          </div>
          <div class="card-sub" style="margin-top:8px">${escapeHtml(joker.description)}</div>
          ${
            locked && joker.unlockRequirement
              ? `<div class="req"><b>Défi à réaliser</b>${escapeHtml(joker.unlockRequirement)}</div>`
              : ''
          }
          ${
            !used && !locked && joker.picksChallenge
              ? (() => {
                  const targets = (snapshot.challenges || []).filter((c) => c.team !== joker.team && c.done);
                  return targets.length
                    ? `<div class="field" style="margin-top:12px"><label for="target_${joker.id}">Quel défi annuler ?</label>
                       <select id="target_${joker.id}">${targets
                         .map((c) => `<option value="${c.id}">${escapeHtml(c.title)}</option>`)
                         .join('')}</select></div>`
                    : `<div class="req">L'équipe adverse n'a encore validé aucun défi : rien à annuler pour l'instant.</div>`;
                })()
              : !used && !locked && joker.prompt
              ? `<div class="field" style="margin-top:12px"><label for="detail_${joker.id}">${escapeHtml(joker.prompt)}</label>
                 <input id="detail_${joker.id}" maxlength="160" placeholder="Votre réponse" /></div>`
              : ''
          }
          <div class="card-actions">${actions}</div>
        </div>`;
      })
      .join('');

    html += `<div class="empty">Chaque joker ne sert qu'une seule fois. L'équipe adverse reçoit une notification dès qu'il est joué.</div>`;
    return html;
  }

  /** Un menu déroulant par position, rempli avec les noms de l'équipe. */
  function rankingFields(challenge) {
    const team = snapshot.teammates || [];
    if (!team.length) return '<div class="req">Aucun coéquipier connu pour établir le classement.</div>';
    const rank = (i) =>
      i === 0 ? '1 — le plus cave' : i === team.length - 1 ? `${i + 1} — le plus intelligent` : String(i + 1);
    return `<div class="req"><b>Classement donné par l'inconnu</b>
      ${team
        .map(
          (_, i) => `<div class="field" style="margin-top:8px"><label for="rank_${challenge.id}_${i}">${rank(i)}</label>
            <select id="rank_${challenge.id}_${i}" data-rank="${challenge.id}">
              <option value="">—</option>
              ${team.map((m) => `<option value="${escapeHtml(m.label)}">${escapeHtml(m.label)}</option>`).join('')}
            </select></div>`
        )
        .join('')}
    </div>`;
  }

  function readRanking(challenge) {
    const team = snapshot.teammates || [];
    const values = team.map((_, i) => {
      const node = el(`rank_${challenge.id}_${i}`);
      return node ? node.value : '';
    });
    if (values.some((v) => !v)) throw new Error('Complétez tout le classement.');
    if (new Set(values).size !== values.length) throw new Error('Un joueur apparaît deux fois.');
    return values;
  }

  /**
   * Trois sources : appareil photo, galerie, fichiers. iOS regroupe galerie et
   * fichiers dans une même feuille système ; Android ouvre bien deux sélecteurs.
   */
  function photoPicker(challenge, photo) {
    const required = challenge.photo === true;
    const title = challenge.photoLabel || (required ? 'Photo obligatoire' : 'Photo facultative');
    return `<div class="req"><b>${escapeHtml(title)}</b>
      ${
        photo
          ? `<img src="${photo}" alt="Aperçu" style="width:100%;border-radius:10px;margin-top:8px" />`
          : required
          ? 'Elle part avec la validation.'
          : 'Ajoutez-la si vous voulez, elle n’est pas obligatoire.'
      }
      <div class="card-actions">
        <label class="btn ghost small" for="cam_${challenge.id}">${photo ? 'Reprendre' : 'Prendre une photo'}</label>
        <label class="btn ghost small" for="gal_${challenge.id}">Galerie</label>
        <label class="btn ghost small" for="fil_${challenge.id}">Fichiers</label>
      </div>
      <input id="cam_${challenge.id}" type="file" accept="image/*" capture="environment" data-photo="${challenge.id}" hidden />
      <input id="gal_${challenge.id}" type="file" accept="image/*" data-photo="${challenge.id}" hidden />
      <input id="fil_${challenge.id}" type="file" data-photo="${challenge.id}" hidden />
    </div>`;
  }

  function renderChallengesPanel() {
    const me = snapshot.me;
    const mine = (snapshot.challenges || []).filter((c) => c.team === me.team);
    const done = mine.filter((c) => c.done).length;
    const waiting = mine.filter((c) => c.pending).length;

    let html = `<div class="card accent">
      <div class="card-title">${done} / ${mine.length} défis validés${
        waiting ? ` · ${waiting} en attente` : ''
      }</div>
      <div class="card-sub">Un défi annulé par l'équipe adverse repasse en non fait : il faudra le refaire.</div>
    </div>`;

    const pending = mine.filter((c) => c.pending);
    if (pending.length) {
      html += '<div class="section-label">En attente du maître du jeu</div>';
      html += pending
        .map(
          (challenge) => `<div class="card ${challenge.team}">
            <div class="card-head">
              <div style="flex:1;min-width:0"><div class="card-title">${escapeHtml(challenge.title)}</div>
              <div class="card-sub">Envoyé à ${fmtTime(challenge.submittedAt)} par ${escapeHtml(challenge.submittedBy || '—')}</div></div>
              <span class="pill locked">En attente</span>
            </div>
          </div>`
        )
        .join('');
    }

    html += '<div class="section-label">À faire</div>';
    const todo = mine.filter((c) => !c.done && !c.pending);
    html += todo.length
      ? todo
          .map((challenge) => {
            const photo = pendingPhotos[challenge.id];
            return `<div class="card ${challenge.team}">
              <div class="card-title">${escapeHtml(challenge.title)}</div>
              ${challenge.description ? `<div class="card-sub">${escapeHtml(challenge.description)}</div>` : ''}
              ${challenge.answer === 'ranking' ? rankingFields(challenge) : ''}
              ${challenge.photo ? photoPicker(challenge, photo) : ''}
              <div class="card-actions">
                <button class="btn small" data-complete="${challenge.id}"${
                  challenge.photo === true && !photo ? ' disabled' : ''
                }>${challenge.approval ? 'Envoyer au maître du jeu' : 'Valider le défi'}</button>
              </div>
            </div>`;
          })
          .join('')
      : '<div class="empty">Tous vos défis sont validés.</div>';

    const finished = mine.filter((c) => c.done);
    if (finished.length) {
      html += '<div class="section-label">Validés</div>';
      html += finished
        .map(
          (challenge) => `<div class="card">
            <div class="card-head">
              <div style="flex:1;min-width:0">
                <div class="card-title">${escapeHtml(challenge.title)}</div>
                <div class="card-sub">Validé à ${fmtTime(challenge.doneAt)} par ${escapeHtml(challenge.doneBy || '—')}</div>
              </div>
              <span class="pill ok">Fait</span>
            </div>
            ${answerLine(challenge)}
            ${
              challenge.photoFile
                ? `<img src="/api/challenge/photo/${challenge.id}?token=${encodeURIComponent(token)}" alt="Photo du défi" style="width:100%;border-radius:10px;margin-top:10px" />`
                : ''
            }
          </div>`
        )
        .join('');
    }
    return html;
  }

  /** Restitution lisible d'une réponse de défi (classement ou texte). */
  function answerLine(challenge) {
    if (!challenge.answerValue) return '';
    const value = Array.isArray(challenge.answerValue)
      ? challenge.answerValue.map((name, i) => `${i + 1}. ${escapeHtml(name)}`).join(' · ')
      : escapeHtml(challenge.answerValue);
    return `<div class="req"><b>Réponse</b>${value}</div>`;
  }

  function renderRequestsPanel() {
    const me = snapshot.me;

    if (me.role === 'player') {
      let html = '';
      if (me.isHunter) {
        html += `<div class="card accent">
          <div class="card-title">Demander la position des ${TEAM_ONE[me.team === 'spy' ? 'spied' : 'spy']}</div>
          <div class="card-sub">Le maître du jeu décide. Le suivi en direct dure quelques minutes, l'envoi ponctuel pose un seul point figé.</div>
          <div class="card-actions">
            <button class="btn small" data-request="live">Suivi en direct</button>
            <button class="btn ghost small" data-request="snapshot">Envoi ponctuel</button>
          </div>
        </div>`;
      } else {
        const other = me.team === 'spy' ? 'spied' : 'spy';
        html += `<div class="card alertish">
          <div class="card-title">Vous êtes traqués</div>
          <div class="card-sub">Les ${TEAM_ONE[other]} doivent passer par le maître du jeu pour obtenir votre position. Vous êtes prévenus à chaque fois.</div>
        </div>`;
        if (me.seesAlways) {
          html += `<div class="card accent">
            <div class="card-title">Rien à demander de votre côté</div>
            <div class="card-sub">Vous voyez les ${TEAM_ONE[other]} en permanence sur l'onglet Carte. Vos jokers se débloquent dans l'onglet Jokers.</div>
          </div>`;
        }
      }

      html += '<div class="section-label">Historique de votre équipe</div>';
      const list = snapshot.myRequests || [];
      const label = { pending: 'en attente', approved: 'acceptée', denied: 'refusée' };
      html += list.length
        ? list
            .map(
              (r) => `<div class="card">
                <div class="card-title">${r.type === 'unlock' ? 'Déblocage de joker' : 'Localisation'} · ${label[r.status] || r.status}</div>
                <div class="card-sub">${fmtTime(r.createdAt)} · demandé par ${escapeHtml(r.from)}${r.note ? ` · « ${escapeHtml(r.note)} »` : ''}</div>
              </div>`
            )
            .join('')
        : '<div class="empty">Aucune demande pour le moment.</div>';
      return html;
    }

    const requests = snapshot.requests || [];
    const pending = requests.filter((r) => r.status === 'pending');
    const done = requests.filter((r) => r.status !== 'pending').slice(0, 12);

    let html = '<div class="section-label">En attente de votre validation</div>';
    html += pending.length
      ? pending
          .map((r) => {
            const joker =
              r.type === 'unlock' ? (snapshot.jokers[r.team] || []).find((j) => j.id === r.payload.jokerId) : null;
            const challenge =
              r.type === 'challenge'
                ? (snapshot.challenges || []).find((c) => c.id === r.payload.challengeId)
                : null;
            const entree = r.type === 'join';
            const titre = entree
              ? `${r.from} veut entrer dans la partie`
              : challenge
              ? challenge.title
              : joker
              ? joker.name
              : 'Localisation';

            let corps = '';
            if (entree) {
              corps = `<div class="req"><b>Code utilisé</b>${escapeHtml(r.code)} · ${TEAM[r.team]}</div>`;
            } else if (challenge) {
              corps = `${challenge.description ? `<div class="req"><b>Le défi</b>${escapeHtml(challenge.description)}</div>` : ''}
                ${answerLine(challenge)}
                ${
                  challenge.photoFile
                    ? `<img src="/api/challenge/photo/${challenge.id}?token=${encodeURIComponent(token)}" alt="Photo envoyée" style="width:100%;border-radius:10px;margin-top:10px" />`
                    : '<div class="req">Aucune photo : validez sur ce que vous avez vu.</div>'
                }`;
            } else if (joker) {
              corps = `<div class="req"><b>Défi à vérifier</b>${escapeHtml(joker.unlockRequirement || '—')}</div>`;
            } else {
              corps = `<div class="req"><b>Mode demandé</b>${r.payload.mode === 'snapshot' ? 'Envoi ponctuel (point figé)' : 'Suivi en direct'}</div>`;
            }

            let boutons = '';
            if (entree) {
              boutons = `<button class="btn small" data-decide="${r.id}" data-approve="1">Admettre</button>`;
            } else if (challenge) {
              boutons = `<button class="btn small" data-decide="${r.id}" data-approve="1">Accepter le défi</button>`;
            } else if (joker) {
              boutons = `<button class="btn small" data-decide="${r.id}" data-approve="1">Valider le défi</button>`;
            } else {
              boutons = `<button class="btn small" data-decide="${r.id}" data-approve="1" data-mode="${r.payload.mode || 'live'}" data-minutes="3">Accorder 3 min</button>
                <button class="btn ghost small" data-decide="${r.id}" data-approve="1" data-mode="${r.payload.mode || 'live'}" data-minutes="10">10 min</button>`;
            }

            return `<div class="card ${r.team}">
              <div class="card-title">${entree ? escapeHtml(titre) : `${TEAM[r.team]} · ${escapeHtml(titre)}`}</div>
              <div class="card-sub">${entree ? 'Connecté' : 'Envoyé par ' + escapeHtml(r.from)} à ${fmtTime(r.createdAt)}</div>
              ${corps}
              <div class="card-actions">
                ${boutons}
                <button class="btn danger small" data-decide="${r.id}" data-approve="0">Refuser</button>
              </div>
            </div>`;
          })
          .join('')
      : '<div class="empty">Rien à valider pour le moment.</div>';

    html += '<div class="section-label">Décisions récentes</div>';
    const label = { approved: 'acceptée', denied: 'refusée' };
    html += done.length
      ? done
          .map(
            (r) => `<div class="event"><time>${fmtTime(r.decidedAt || r.createdAt)}</time>
              <span class="kind ${r.status === 'denied' ? 'denied' : 'request'}"></span>
              <span>${TEAM[r.team]} · ${{ unlock: 'joker', challenge: 'défi', location: 'localisation', join: 'entrée' }[r.type] || r.type} · <b>${label[r.status] || r.status}</b></span></div>`
          )
          .join('')
      : '<div class="empty">Aucune décision pour le moment.</div>';
    return html;
  }

  function renderControlPanel() {
    const isAdmin = snapshot.me.role === 'admin';
    const g = snapshot.game;
    const hunters = g.settings.hunters;
    let html = '';

    if (isAdmin) {
      const timerEnabled = g.timerEnabled !== false;
      const left = !timerEnabled ? null : g.endsAt ? g.endsAt - now() : g.settings.durationMin * 60 * 1000;
      const etat =
        g.status === 'lobby'
          ? 'Pas encore commencée'
          : g.status === 'countdown'
          ? `Départ dans ${Math.max(0, Math.ceil((g.startsAt - now()) / 1000))} s`
          : g.status === 'running' && !timerEnabled
          ? 'Sans timer'
          : g.status === 'ended' || (timerEnabled && left <= 0)
          ? 'Terminée'
          : fmtClock(left);

      html += `<div class="card accent">
        <div class="card-title">Partie — <span class="countdown">${etat}</span></div>
        <div class="card-sub">Durée prévue : ${Math.round(g.settings.durationMin / 60)} h. Traqueurs : ${TEAM[hunters]}.</div>
        ${
          g.status === 'lobby' || g.status === 'ended'
            ? `<div class="field" style="margin-top:10px"><label for="clockMode">Mode de démarrage</label>
                 <select id="clockMode"><option value="countdown">Avec décompte</option><option value="no-timer">Sans timer</option></select>
               </div>
               <div class="field"><label for="countSeconds">Décompte avant le départ</label>
                 <select id="countSeconds"><option value="5">5 secondes</option><option value="10" selected>10 secondes</option><option value="30">30 secondes</option><option value="60">1 minute</option></select>
               </div>
               <div class="card-actions"><button class="btn small" data-clock="start" data-minutes="${g.settings.durationMin}">Démarrer la partie</button></div>`
            : `<div class="card-actions">
                 <button class="btn ghost small" data-clock="start" data-minutes="${g.settings.durationMin}">Relancer</button>
                 <button class="btn danger small" data-clock="stop">Arrêter</button>
               </div>`
        }
      </div>`;
    }

    html += '<div class="section-label">Accès aux positions</div>';
    ['spy', 'spied'].forEach((team) => {
      const reveal = g.reveals[team];
      const block = g.blocks[team];
      const remaining = reveal.until - now();
      const permanent = g.settings.permanentReveal === team;
      html += `<div class="card ${team}">
        <div class="card-title">${TEAM[team]} voient les ${TEAM_ONE[team === 'spy' ? 'spied' : 'spy']}</div>
        <div class="card-sub">${
          block.until > now()
            ? `Bloqué ${fmtClock(block.until - now())} (${escapeHtml(block.reason || 'joker')})`
            : permanent
            ? 'Permanent — règle du jeu, rien à accorder'
            : remaining > 0
            ? `Actif — <span class="countdown">${fmtClock(remaining)}</span>`
            : 'Aucun accès'
        }</div>
        ${
          isAdmin && !permanent
            ? `<div class="card-actions">
                <button class="btn small" data-reveal="${team}" data-minutes="3">+3 min</button>
                <button class="btn ghost small" data-reveal="${team}" data-minutes="10">+10 min</button>
                <button class="btn ghost small" data-reveal="${team}" data-mode="snapshot">Point figé</button>
                <button class="btn danger small" data-reveal="${team}" data-revoke="1">Couper</button>
              </div>`
            : ''
        }
      </div>`;
    });

    if (isAdmin) {
      html += '<div class="section-label">Immobiliser une équipe</div>';
      html += `<div class="card">
        <div class="card-sub">Pour la règle « rester figé 30 secondes après avoir envoyé sa position », ou toute pause décidée en jeu.</div>
        <div class="card-actions">
          <button class="btn ghost small" data-freeze="spy" data-seconds="30">Espions 30 s</button>
          <button class="btn ghost small" data-freeze="spy" data-seconds="120">Espions 2 min</button>
          <button class="btn ghost small" data-freeze="spied" data-seconds="30">Espionnés 30 s</button>
          <button class="btn ghost small" data-freeze="spied" data-seconds="120">Espionnés 2 min</button>
        </div>
      </div>`;

      html += '<div class="section-label">Mettre la partie en pause</div>';
      html += `<div class="card">
        <div class="card-sub">Pendant la pause, plus personne ne peut jouer de joker, demander une position ou valider un défi. Le temps perdu est rendu à la reprise.</div>
        <div class="field" style="margin-top:10px"><label for="pauseText">Message affiché sur tous les écrans</label>
          <textarea id="pauseText" rows="2" placeholder="Pause repas, on se retrouve dans 20 minutes."></textarea></div>
        <div class="card-actions">
          ${
            g.status === 'paused'
              ? '<button class="btn small" data-pause="resume">Reprendre la partie</button>'
              : '<button class="btn danger small" data-pause="pause">Mettre en pause</button>'
          }
        </div>
      </div>`;

      html += '<div class="section-label">Message aux équipes</div>';
      html += `<div class="card">
        <div class="field"><label for="announceText">Message (arrive en alerte sur les téléphones)</label>
          <textarea id="announceText" rows="2" placeholder="Rendez-vous à la fontaine dans 10 minutes."></textarea></div>
        <div class="field"><label for="announceTeam">Destinataires</label>
          <select id="announceTeam"><option value="all">Les deux équipes</option><option value="spy">Espions</option><option value="spied">Espionnés</option></select>
        </div>
        <button class="btn small" id="announceBtn">Envoyer</button>
      </div>`;

      html += '<div class="section-label">État des jokers</div>';
      ['spy', 'spied'].forEach((team) => {
        (snapshot.jokers[team] || []).forEach((joker) => {
          const state = joker.usedAt
            ? `Joué à ${fmtTime(joker.usedAt)}${joker.detail ? ` · ${escapeHtml(joker.detail)}` : ''}`
            : joker.requiresUnlock && !joker.unlocked
            ? 'À débloquer par un défi'
            : 'Disponible';
          html += `<div class="card ${team}">
            <div class="card-title">${escapeHtml(joker.icon || '')} ${escapeHtml(joker.name)} · ${TEAM[team]}</div>
            <div class="card-sub">${state} — ${escapeHtml(joker.description)}</div>
          </div>`;
        });
      });

      const challenges = snapshot.challenges || [];
      if (challenges.length) {
        const done = challenges.filter((c) => c.done);
        html += `<div class="section-label">Défis — ${done.length} / ${challenges.length} validés</div>`;
        html += challenges
          .map(
            (challenge) => `<div class="card ${challenge.team}">
              <div class="card-head">
                <div style="flex:1;min-width:0">
                  <div class="card-title">${escapeHtml(challenge.title)}</div>
                  <div class="card-sub">${
                    challenge.done
                      ? `Validé à ${fmtTime(challenge.doneAt)} par ${escapeHtml(challenge.doneBy || '—')}`
                      : challenge.pending
                      ? `Envoyé à ${fmtTime(challenge.submittedAt)} — à traiter dans Validations`
                      : challenge.photo === true
                      ? 'À faire · photo obligatoire'
                      : challenge.approval
                      ? 'À faire · votre validation requise'
                      : 'À faire'
                  }</div>
                </div>
                <span class="pill ${challenge.done ? 'ok' : challenge.pending ? 'locked' : 'used'}">${
                  challenge.done ? 'Fait' : challenge.pending ? 'En attente' : 'À faire'
                }</span>
              </div>
              ${answerLine(challenge)}
              ${
                challenge.photoFile
                  ? `<img src="/api/challenge/photo/${challenge.id}?token=${encodeURIComponent(token)}" alt="Photo du défi" style="width:100%;border-radius:10px;margin-top:10px" />`
                  : ''
              }
              ${
                challenge.done || challenge.pending
                  ? `<div class="card-actions"><button class="btn danger small" data-reset-challenge="${challenge.id}">${
                      challenge.pending ? 'Remettre à faire' : 'Annuler ce défi'
                    }</button></div>`
                  : ''
              }
            </div>`
          )
          .join('');
      }

      html += '<div class="section-label">Zone sensible</div>';
      html += `<div class="card"><div class="card-sub">Remet à zéro les jokers, les compteurs, les points figés et le journal. Les codes restent valides.</div>
        <div class="card-actions"><button class="btn danger small" id="resetBtn">Réinitialiser la partie</button></div></div>`;
    } else {
      html += '<div class="section-label">Distances</div>';
      const spies = snapshot.players.filter((p) => p.team === 'spy');
      const spied = snapshot.players.filter((p) => p.team === 'spied');
      const rows = [];
      spied.forEach((h) => spies.forEach((t) => rows.push({ h, t, d: distance(h, t) })));
      rows.sort((a, b) => a.d - b.d);
      html += rows.length
        ? rows
            .slice(0, 12)
            .map(
              (row) => `<div class="event"><time>${fmtDistance(row.d)}</time><span class="kind reveal"></span>
                <span>${escapeHtml(row.h.name)} → ${escapeHtml(row.t.name)}</span></div>`
            )
            .join('')
        : '<div class="empty">En attente des deux équipes.</div>';
    }

    html += deviceCard();
    return html;
  }

  /** Notifications + déconnexion : visible pour tous les rôles, joueurs compris. */
  function deviceCard() {
    const roleLabel = { player: 'joueur', admin: 'maître du jeu', viewer: 'spectateur' };
    const pushOn = 'Notification' in window && Notification.permission === 'granted';
    const needsInstall = isIOS() && !isStandalone();
    return `<div class="section-label">Cet appareil</div>
      <div class="card"><div class="card-title">${escapeHtml(snapshot.me.label)}</div>
      <div class="card-sub">Code ${escapeHtml(snapshot.me.code)} · ${roleLabel[snapshot.me.role] || snapshot.me.role}</div>
      <div class="card-actions">
        <button class="btn ghost small" id="pushBtn">${
          pushOn ? 'Notifications activées' : needsInstall ? "Notifications : installer l'app" : 'Activer les notifications'
        }</button>
        <button class="btn danger small" id="logoutBtn">Se déconnecter</button>
      </div></div>`;
  }

  function renderCodesPanel() {
    const roster = snapshot.roster || [];
    const roleLabel = { player: 'joueur', admin: 'maître du jeu', viewer: 'spectateur' };
    let html = '<div class="section-label">Codes d\'accès</div>';
    html += roster
      .map(
        (entry) => `<div class="card ${entry.team || ''}">
          <div class="code-pill">${escapeHtml(entry.code)}</div>
          <div class="card-sub">${escapeHtml(entry.label)} · ${roleLabel[entry.role] || entry.role}${entry.team ? ' · ' + TEAM[entry.team] : ''} · ${
            entry.role === 'player' && !entry.admitted ? 'pas encore admis' : entry.online ? 'sur la carte' : 'inactif'
          }</div>
          <div class="card-actions">
            <button class="btn ghost small" data-rotate="${entry.code}">Nouveau code</button>
            <button class="btn danger small" data-remove="${entry.code}">Supprimer</button>
          </div>
        </div>`
      )
      .join('');

    html += '<div class="section-label">Ajouter un code</div>';
    html += `<div class="card">
      <div class="field"><label for="newLabel">Nom sur la carte</label><input id="newLabel" placeholder="Espion 3" /></div>
      <div class="row">
        <div class="field"><label for="newRole">Rôle</label>
          <select id="newRole"><option value="player">Joueur</option><option value="admin">Maître du jeu</option><option value="viewer">Spectateur</option></select>
        </div>
        <div class="field"><label for="newTeam">Équipe</label>
          <select id="newTeam"><option value="spy">Espions</option><option value="spied">Espionnés</option></select>
        </div>
      </div>
      <button class="btn small" id="addCodeBtn">Générer le code</button>
    </div>`;
    return html;
  }

  function renderFeedPanel() {
    const events = snapshot.events || [];
    if (!events.length) return '<div class="empty">Rien ne s\'est encore passé.</div>';
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
    ui.roleText.textContent = me.role === 'player' ? `${me.label} · ${TEAM[me.team]}` : me.label;

    if (me.role !== 'player') {
      const live = snapshot.players.filter((p) => !p.stale).length;
      setStatus(`${live} joueur${live === 1 ? '' : 's'} en direct`, live ? 'live' : '');
    }

    // Décompte d'avant-partie : un tic feutré par seconde, un accord au départ.
    const countLayer = el('countLayer');
    if (snapshot.game.status === 'countdown' && snapshot.game.startsAt) {
      const reste = Math.max(0, Math.ceil((snapshot.game.startsAt - now()) / 1000));
      el('countNumber').textContent = reste || 'GO';
      el('countTitle').textContent = reste ? 'La partie commence' : 'C\'est parti !';
      el('countBody').textContent = reste ? 'Tenez-vous prêts.' : 'Bonne chasse.';
      countLayer.hidden = false;
      const annuler = el('countCancel');
      annuler.hidden = me.role !== 'admin';
      if (reste !== dernierTic) {
        dernierTic = reste;
        if (reste > 0) ticDoux();
        else coupDEnvoi();
      }
    } else {
      countLayer.hidden = true;
      dernierTic = null;
    }

    const paused = snapshot.game.status === 'paused';
    const pauseLayer = el('pauseLayer');
    if (paused && me.role !== 'admin') {
      el('pauseMessage').textContent = snapshot.game.pauseMessage || 'Pause décidée par le maître du jeu.';
      pauseLayer.hidden = false;
    } else {
      pauseLayer.hidden = true;
    }

    // Pendant la pause, le chrono est gelé à l'instant où elle a commencé.
    const timerEnabled = snapshot.game.timerEnabled !== false;
    const left = !timerEnabled
      ? null
      : !snapshot.game.endsAt
      ? snapshot.game.settings.durationMin * 60 * 1000
      : paused && snapshot.game.pausedAt
      ? snapshot.game.endsAt - snapshot.game.pausedAt
      : snapshot.game.endsAt - now();
    const timerExpired = timerEnabled && left <= 0;
    ui.clockChip.hidden = false;
    ui.clockChip.className = `chip clock${timerExpired || snapshot.game.status === 'ended' ? ' warn' : timerEnabled && left < 15 * 60 * 1000 ? ' warn' : ''}`;
    const etat = snapshot.game.status;
    ui.clockText.textContent =
      etat === 'lobby'
        ? 'En attente'
        : etat === 'countdown'
        ? `Départ dans ${Math.max(0, Math.ceil((snapshot.game.startsAt - now()) / 1000))} s`
        : etat === 'running' && !timerEnabled
        ? 'Sans timer'
        : etat === 'ended' || timerExpired
        ? 'Partie terminée'
        : paused
        ? `⏸ ${timerEnabled ? fmtClock(left) : 'Sans timer'}`
        : fmtClock(left);

    gameMap.render(snapshot.players, me.code);
    gameMap.renderPins(snapshot.pins || []);

    renderTabs();

    // Le panneau se redessine chaque seconde pour les compte à rebours : on ne
    // retire jamais le DOM sous un doigt déjà posé sur un bouton.
    if (!force && Date.now() < interactionUntil) return;

    const panels = {
      players: renderPlayersPanel,
      defis: renderChallengesPanel,
      jokers: renderJokersPanel,
      requests: renderRequestsPanel,
      control: renderControlPanel,
      codes: renderCodesPanel,
      feed: renderFeedPanel
    };

    const scroll = ui.sheetBody.scrollTop;
    const focusId = document.activeElement ? document.activeElement.id : null;
    const values = {};
    // Un input[type=file] refuse qu'on lui réassigne sa valeur : on l'exclut.
    ui.sheetBody.querySelectorAll('input[id]:not([type="file"]), select[id], textarea[id]').forEach((node) => {
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
          toast('Demande envoyée au maître du jeu.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
        node.disabled = false;
      })
    );

    body.querySelectorAll('[data-unlock]').forEach((node) =>
      node.addEventListener('click', async () => {
        const joker = (snapshot.jokers || []).find((j) => j.id === node.dataset.unlock);
        if (!confirm(`Défi à valider :\n\n${joker.unlockRequirement}\n\nLe maître du jeu doit confirmer.`)) return;
        node.disabled = true;
        try {
          await api('/api/request', {
            method: 'POST',
            body: JSON.stringify({ type: 'unlock', payload: { jokerId: joker.id } })
          });
          toast('Déblocage envoyé au maître du jeu.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
        node.disabled = false;
      })
    );

    body.querySelectorAll('[data-play]').forEach((node) =>
      node.addEventListener('click', async () => {
        const joker = (snapshot.jokers || []).find((j) => j.id === node.dataset.play);
        const input = el(`detail_${joker.id}`);
        const picker = el(`target_${joker.id}`);
        const detail = input ? input.value.trim() : '';
        const challengeId = picker ? picker.value : undefined;
        if (joker.picksChallenge && !challengeId) {
          toast("Aucun défi validé à annuler pour l'instant.", 'error');
          return;
        }
        if (joker.prompt && !detail) {
          toast(joker.prompt, 'error');
          if (input) input.focus();
          return;
        }
        const summary = picker ? picker.options[picker.selectedIndex].text : detail;
        if (!confirm(`Jouer « ${joker.name} » ?\n\n${joker.description}${summary ? `\n\n${summary}` : ''}`)) return;
        node.disabled = true;
        try {
          await api('/api/joker/play', {
            method: 'POST',
            body: JSON.stringify({ jokerId: joker.id, detail, challengeId })
          });
          toast('Joker joué.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
          node.disabled = false;
        }
      })
    );

    body.querySelectorAll('[data-photo]').forEach((node) =>
      node.addEventListener('change', async () => {
        const file = node.files && node.files[0];
        if (!file) return;
        try {
          pendingPhotos[node.dataset.photo] = await compressImage(file);
        } catch (err) {
          toast("Ce fichier n'est pas une image lisible.", 'error');
          return;
        }
        render(true);
      })
    );

    body.querySelectorAll('[data-complete]').forEach((node) =>
      node.addEventListener('click', async () => {
        const id = node.dataset.complete;
        const challenge = (snapshot.challenges || []).find((c) => c.id === id);
        let answer;
        try {
          if (challenge && challenge.answer === 'ranking') answer = readRanking(challenge);
        } catch (err) {
          return toast(err.message, 'error');
        }
        node.disabled = true;
        try {
          await api('/api/challenge/complete', {
            method: 'POST',
            body: JSON.stringify({ id, photo: pendingPhotos[id], answer })
          });
          delete pendingPhotos[id];
          toast('Défi validé.', 'ok');
          refreshState();
        } catch (err) {
          toast(err.message, 'error');
          node.disabled = false;
        }
      })
    );

    body.querySelectorAll('[data-reset-challenge]').forEach((node) =>
      node.addEventListener('click', async () => {
        if (!confirm('Repasser ce défi en non fait ?')) return;
        try {
          await api('/api/admin/challenge/reset', {
            method: 'POST',
            body: JSON.stringify({ id: node.dataset.resetChallenge })
          });
          refreshState();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );

    body.querySelectorAll('[data-pause]').forEach((node) =>
      node.addEventListener('click', async () => {
        try {
          const input = el('pauseText');
          await api('/api/admin/pause', {
            method: 'POST',
            body: JSON.stringify({ action: node.dataset.pause, message: input ? input.value.trim() : '' })
          });
          if (input) input.value = '';
        } catch (err) {
          toast(err.message, 'error');
        }
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

    body.querySelectorAll('[data-freeze]').forEach((node) =>
      node.addEventListener('click', async () => {
        try {
          await api('/api/admin/freeze', {
            method: 'POST',
            body: JSON.stringify({ team: node.dataset.freeze, seconds: Number(node.dataset.seconds) })
          });
          toast('Équipe immobilisée.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );

    body.querySelectorAll('[data-clock]').forEach((node) =>
      node.addEventListener('click', async () => {
        const secondes = el('countSeconds') ? Number(el('countSeconds').value) : 10;
        const sansTimer = node.dataset.clock === 'start' && el('clockMode') && el('clockMode').value === 'no-timer';
        if (node.dataset.clock === 'start') {
          const confirmation = sansTimer
            ? 'Démarrer la partie maintenant sans timer ?'
            : `Lancer le décompte de ${secondes} secondes ?`;
          if (!confirm(confirmation)) return;
        }
        if (node.dataset.clock === 'stop') {
          // Arrêter coupe le chrono pour tout le monde : on demande confirmation, en rappelant le temps restant.
          const reste = snapshot && snapshot.game.endsAt ? snapshot.game.endsAt - now() : 0;
          const detail = reste > 0 ? `Il reste ${fmtClock(reste)} au chrono.\n\n` : '';
          const message = `Arrêter la partie maintenant ?\n\n${detail}Le chrono s'arrête et tout le monde reçoit « Partie terminée ».`;
          if (!confirm(message)) return;
        }
        try {
          await api('/api/admin/clock', {
            method: 'POST',
            body: JSON.stringify({
              action: node.dataset.clock,
              minutes: Number(node.dataset.minutes) || undefined,
              seconds: secondes,
              timerEnabled: !sansTimer
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
          toast('Message envoyé.', 'ok');
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
              label: el('newLabel').value || 'Nouveau joueur'
            })
          });
          toast(`Code ${data.code} créé.`, 'ok');
          refreshState();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    body.querySelectorAll('[data-rotate]').forEach((node) =>
      node.addEventListener('click', async () => {
        if (!confirm('Générer un nouveau code ? L\'appareil actuel sera déconnecté.')) return;
        try {
          const data = await api('/api/admin/codes', {
            method: 'POST',
            body: JSON.stringify({ action: 'rotate', code: node.dataset.rotate })
          });
          toast(`Nouveau code : ${data.code}`, 'ok');
          refreshState();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );

    body.querySelectorAll('[data-remove]').forEach((node) =>
      node.addEventListener('click', async () => {
        if (!confirm('Supprimer ce code définitivement ?')) return;
        try {
          await api('/api/admin/codes', {
            method: 'POST',
            body: JSON.stringify({ action: 'remove', code: node.dataset.remove })
          });
          refreshState();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );

    const resetBtn = el('resetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        if (!confirm('Réinitialiser la partie ? Jokers, compteurs et journal sont effacés.')) return;
        await api('/api/admin/reset', { method: 'POST' });
        toast('Partie réinitialisée.', 'ok');
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
      /* le websocket rattrapera */
    }
  }

  /* ----------------------------------------------------------------- boot */

  // iOS n'autorise le son qu'après une interaction : on prépare le contexte audio
  // au premier contact, pour que le décompte ne soit pas muet.
  ['pointerdown', 'touchstart'].forEach((evt) =>
    document.addEventListener(evt, () => audio(), { once: true, passive: true })
  );

  el('sheetHandle').addEventListener('click', () => ui.sheet.classList.toggle('collapsed'));

  ['pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach((evt) =>
    ui.sheetBody.addEventListener(
      evt,
      () => {
        interactionUntil = Date.now() + 700;
      },
      { passive: true }
    )
  );

  el('layersBtn').addEventListener('click', () => {
    const basemap = gameMap.toggleBasemap();
    el('layersBtn').classList.toggle('active', basemap.name !== 'streets');
    toast(basemap.name === 'streets' ? 'Plan OpenStreetMap — commerces visibles' : basemap.label);
  });

  el('locateBtn').addEventListener('click', () => {
    if (!myPosition) return toast('Pas encore de position GPS.', 'error');
    gameMap.follow = true;
    el('locateBtn').classList.add('active');
    gameMap.centerOn(myPosition.lng, myPosition.lat, 17);
  });

  el('fitBtn').addEventListener('click', () => {
    if (!snapshot || !snapshot.players.length) return toast('Personne sur la carte.', 'error');
    gameMap.follow = false;
    gameMap.fitAll(snapshot.players);
  });

  async function boot() {
    if (!(await recoverSession())) {
      location.replace('/');
      return;
    }
    config = await fetch('/api/config').then((r) => r.json());
    document.title = config.appName || 'Traque';

    gameMap = new GameMap('map', config, {
      onFollowChange: (follow) => el('locateBtn').classList.toggle('active', follow),
      onBasemapFallback: (provider) => toast(`Clé ${provider} refusée — fond OpenStreetMap utilisé.`, 'error'),
      onBasemapError: (label) => toast(`${label} ne répond pas — touchez le bouton calques pour changer de fond.`, 'error'),
      onMarkerClick: () => {
        activeTab = 'players';
        ui.sheet.classList.remove('collapsed');
        render(true);
      }
    });
    if (gameMap.basemap !== 'streets') el('layersBtn').classList.add('active');

    if (localStorage.getItem('spymap.role') === 'player') startTracking();

    connect();
    await refreshState();

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    setInterval(() => {
      if (snapshot && !document.hidden) render();
    }, 1000);
  }

  boot();
})();

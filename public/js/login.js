(function () {
  'use strict';

  const inputs = Array.from(document.querySelectorAll('#codeInput input'));
  const form = document.getElementById('codeForm');
  const submitBtn = document.getElementById('submitBtn');
  const errorBox = document.getElementById('error');

  if (localStorage.getItem('spymap.token')) {
    location.replace('/app');
    return;
  }

  // Session encore valable côté serveur (cookie) mais localStorage vidé par Safari.
  fetch('/api/me')
    .then((r) => (r.ok ? r.json() : null))
    .then((me) => {
      if (me && me.token) location.replace('/app');
    })
    .catch(() => {});

  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      if (cfg.appName) document.getElementById('appName').textContent = cfg.appName;
    })
    .catch(() => {});

  const value = () => inputs.map((i) => i.value).join('');

  function refresh() {
    inputs.forEach((i) => i.classList.toggle('filled', !!i.value));
    submitBtn.disabled = value().length !== 5;
  }

  inputs.forEach((input, index) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      if (input.value && index < inputs.length - 1) inputs[index + 1].focus();
      refresh();
      if (value().length === 5) form.requestSubmit();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && index > 0) {
        inputs[index - 1].focus();
        inputs[index - 1].value = '';
        refresh();
      }
      if (e.key === 'ArrowLeft' && index > 0) inputs[index - 1].focus();
      if (e.key === 'ArrowRight' && index < inputs.length - 1) inputs[index + 1].focus();
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 5).split('');
      digits.forEach((d, i) => {
        if (inputs[i]) inputs[i].value = d;
      });
      refresh();
      if (value().length === 5) form.requestSubmit();
      else inputs[Math.min(digits.length, 4)].focus();
    });
  });

  inputs[0].focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = value();
    if (code.length !== 5) return;

    errorBox.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Vérification…';

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Connexion impossible.');

      localStorage.setItem('spymap.token', data.token);
      localStorage.setItem('spymap.role', data.role);
      localStorage.setItem('spymap.team', data.team || '');
      localStorage.setItem('spymap.label', data.label);
      localStorage.setItem('spymap.lastCode', code);
      location.replace('/app');
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      inputs.forEach((i) => (i.value = ''));
      refresh();
      inputs[0].focus();
      submitBtn.textContent = 'Rejoindre la partie';
    }
  });
  // Lien personnel : /?c=12345 connecte directement, pratique pour distribuer un code
  // par joueur. À défaut, on repropose le dernier code utilisé sur cet appareil.
  // Ce bloc vient après l'écouteur de soumission, sinon requestSubmit() ne déclenche rien.
  const depuisLien = (new URLSearchParams(location.search).get('c') || '').replace(/\D/g, '');
  const dernier = localStorage.getItem('spymap.lastCode') || '';
  const prerempli = depuisLien.length === 5 ? depuisLien : dernier.length === 5 ? dernier : '';
  if (prerempli) {
    prerempli.split('').forEach((d, i) => {
      if (inputs[i]) inputs[i].value = d;
    });
    refresh();
    if (depuisLien.length === 5) form.requestSubmit();
  }
})();

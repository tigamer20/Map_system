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
    submitBtn.textContent = 'Checking…';

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed.');

      localStorage.setItem('spymap.token', data.token);
      localStorage.setItem('spymap.role', data.role);
      localStorage.setItem('spymap.team', data.team || '');
      localStorage.setItem('spymap.label', data.label);
      location.replace('/app');
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      inputs.forEach((i) => (i.value = ''));
      refresh();
      inputs[0].focus();
      submitBtn.textContent = 'Join the game';
    }
  });
})();

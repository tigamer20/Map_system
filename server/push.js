'use strict';

const webpush = require('web-push');
const store = require('./store');

let ready = false;

function init() {
  const s = store.get();
  if (!s.push.vapid) {
    s.push.vapid = webpush.generateVAPIDKeys();
    store.save(true);
  }
  const subject = process.env.PUSH_SUBJECT || 'mailto:admin@example.com';
  webpush.setVapidDetails(subject, s.push.vapid.publicKey, s.push.vapid.privateKey);
  ready = true;
}

function publicKey() {
  const s = store.get();
  return s.push.vapid ? s.push.vapid.publicKey : null;
}

function subscribe(code, subscription) {
  const s = store.get();
  if (!s.push.subs[code]) s.push.subs[code] = [];
  const exists = s.push.subs[code].some((x) => x.endpoint === subscription.endpoint);
  if (!exists) s.push.subs[code].push(subscription);
  store.save();
}

function unsubscribe(code, endpoint) {
  const s = store.get();
  if (!s.push.subs[code]) return;
  s.push.subs[code] = s.push.subs[code].filter((x) => x.endpoint !== endpoint);
  store.save();
}

/** Send a push to every device holding one of the given codes. */
async function sendToCodes(codes, payload) {
  if (!ready) return;
  const s = store.get();
  const body = JSON.stringify(payload);
  const jobs = [];
  for (const code of codes) {
    for (const sub of s.push.subs[code] || []) {
      jobs.push(
        webpush.sendNotification(sub, body).catch((err) => {
          if (err.statusCode === 404 || err.statusCode === 410) unsubscribe(code, sub.endpoint);
          else console.warn('[push] failed:', err.statusCode || err.message);
        })
      );
    }
  }
  await Promise.all(jobs);
}

module.exports = { init, publicKey, subscribe, unsubscribe, sendToCodes };

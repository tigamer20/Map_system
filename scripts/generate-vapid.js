#!/usr/bin/env node
/* Prints a VAPID key pair to paste into the host's environment variables. */
const keys = require('web-push').generateVAPIDKeys();
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);

#!/usr/bin/env node
'use strict';
// Usage: node engine/check_client.js <username> [--port 25567] [--seconds N]
// A headless protocol client that joins the replay server and reports whether it stayed connected and
// whether minecraft-protocol could parse everything it was sent. It is a smoke test for the server, not
// proof a vanilla client accepts the traffic.

const path = require('path');
const { mc } = require(path.join(__dirname, '..', 'reader', 'deps'));

const arg = (n, d) => (process.argv.indexOf(n) > 0 ? process.argv[process.argv.indexOf(n) + 1] : d);
const username = process.argv[2];
const PORT = +arg('--port', 25567);
const SECONDS = +arg('--seconds', 120);

const client = mc.createClient({ host: '127.0.0.1', port: PORT, username, auth: 'offline', version: '1.21.1', hideErrors: false });
const got = new Map();
const errors = [];
let start = null;
client.on('state', (s) => {
    if (s === 'play' && !start) start = Date.now();
});
client.on('packet', (d, meta) => got.set(meta.name, (got.get(meta.name) || 0) + 1));
client.on('error', (e) => errors.push(e.message.slice(0, 120)));
client.on('end', (r) => finish(`connection ended: ${r}`));
setTimeout(() => finish('time limit'), SECONDS * 1000);

let done = false;
function finish(why) {
    if (done) return;
    done = true;
    const secs = start ? ((Date.now() - start) / 1000).toFixed(1) : 'never reached play';
    console.log(`[check] ${why}; in play for ${secs} s; ${[...got.values()].reduce((a, b) => a + b, 0)} packets parsed`);
    console.log('[check] errors:', errors.length ? JSON.stringify([...new Set(errors)].slice(0, 8)) : 'none');
    console.log('[check] top packets:', JSON.stringify([...got].sort((a, b) => b[1] - a[1]).slice(0, 10)));
    process.exit(errors.length ? 1 : 0);
}

// Offline-mode bot that walks a slow circle through the recording proxy on 127.0.0.1:25566.
// Usage: node bots/wander.js [durationSeconds=90]
const path = require('path');
const mc = require(path.join(__dirname, '..', 'proxy', 'node_modules', 'minecraft-protocol'));

const DURATION_S = Number(process.argv[2] || 90);
const RADIUS = 3;               // blocks
const SPEED = 0.2;              // blocks per tick
const OMEGA = SPEED / RADIUS;   // radians per tick
const TICK_MS = 50;
const ARM_EVERY = 40;           // ticks

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const client = mc.createClient({
  host: '127.0.0.1',
  port: 25566,
  username: 'ReaderBot1',
  auth: 'offline',
  version: '1.21.1',
});

let spawn = null;      // {x,y,z}
let loopTimer = null;
let endTimer = null;
let tick = 0;
let finished = false;

function finish(reason) {
  if (finished) return;
  finished = true;
  if (loopTimer) clearInterval(loopTimer);
  if (endTimer) clearTimeout(endTimer);
  log('finishing:', reason, `ticks sent=${tick}`);
  try { client.end(reason); } catch (e) { log('end() error:', e.message); }
  setTimeout(() => process.exit(0), 500).unref();
}

client.on('connect', () => log('TCP connected to proxy'));
client.on('state', (newState) => log('protocol state ->', newState));
client.on('login', (p) => log('logged in: entityId', p.entityId, 'gameMode', p.gameMode, 'dimension', p.worldName || p.dimension));
client.on('spawn', () => log('spawned (client spawn event)'));
client.on('kick_disconnect', (p) => log('KICKED:', JSON.stringify(p.reason)));
client.on('disconnect', (p) => log('DISCONNECT:', JSON.stringify(p.reason)));
client.on('end', (reason) => { log('connection ended:', reason); if (!finished) { finished = true; if (loopTimer) clearInterval(loopTimer); if (endTimer) clearTimeout(endTimer); process.exit(0); } });
client.on('error', (err) => log('ERROR:', err && (err.stack || err.message || err)));

// Server-side teleports must be confirmed or the server will not accept movement.
client.on('position', (p) => {
  client.write('teleport_confirm', { teleportId: p.teleportId });
  const rel = p.flags || {};
  const cur = spawn || { x: 0, y: 0, z: 0 };
  const newPos = {
    x: rel.x ? cur.x + p.x : p.x,
    y: rel.y ? cur.y + p.y : p.y,
    z: rel.z ? cur.z + p.z : p.z,
  };
  if (!spawn) {
    spawn = newPos;
    log('spawn position', spawn.x.toFixed(2), spawn.y.toFixed(2), spawn.z.toFixed(2), 'teleportId', p.teleportId);
    loopTimer = setInterval(stepBot, TICK_MS);
    endTimer = setTimeout(() => finish('done'), DURATION_S * 1000);
    log(`walking circle for ${DURATION_S}s`);
  } else {
    spawn = newPos; // server corrected us; re-center on the new position
    log('server position correction', JSON.stringify(newPos), 'teleportId', p.teleportId);
  }
});

function stepBot() {
  if (!spawn || finished) return;
  tick++;
  const theta = tick * OMEGA;
  const x = spawn.x + RADIUS * Math.cos(theta);
  const z = spawn.z + RADIUS * Math.sin(theta);
  // Direction of travel (-sin, cos) corresponds to Minecraft yaw = theta (in degrees).
  let yaw = (theta * 180 / Math.PI) % 360;
  if (yaw < 0) yaw += 360;
  client.write('position_look', {
    x, y: spawn.y, z,
    yaw, pitch: 0,
    onGround: true,
  });
  if (tick % ARM_EVERY === 0) {
    client.write('arm_animation', { hand: 0 });
  }
  if (tick === 1 || tick % 200 === 0) {
    log(`tick ${tick} pos ${x.toFixed(2)} ${spawn.y.toFixed(2)} ${z.toFixed(2)} yaw ${yaw.toFixed(1)}`);
  }
}

process.on('SIGINT', () => finish('interrupted'));

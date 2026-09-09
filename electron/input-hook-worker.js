'use strict';

const STOP_KEYCODE = 31;
const MOVE_INTERVAL_MS = 1000 / 30;

function runInputHookWorker({ hook, transport = process, exit = code => process.exit(code), now = Date.now }) {
  let stopping = false;
  let activitySent = false;
  let lastMoveWall = -Infinity;
  let lastMoveX = null;
  let lastMoveY = null;
  const send = message => {
    try { if (transport.connected !== false && typeof transport.send === 'function') transport.send(message); } catch {}
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    try { hook.stop(); } catch {}
    send({ type: 'stopped' });
    setImmediate(() => exit(0));
  };
  const reportActivity = () => {
    if (activitySent) return;
    activitySent = true;
    send({ type: 'activity' });
  };

  hook.on('mousedown', event => {
    reportActivity();
    send({ type: 'mousedown', x: Number(event.x), y: Number(event.y), wall: Date.now() });
  });
  hook.on('mousemove', event => {
    reportActivity();
    // uiohook can emit hundreds of move events per second. Keep the worker
    // cheap and predictable: clicks remain immediate, pointer samples are a
    // bounded 30Hz stream for the recorder's cursor timeline.
    const wall = Number.isFinite(Number(event?.wall)) ? Number(event.wall) : now();
    const x = Number(event?.x);
    const y = Number(event?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (wall - lastMoveWall < MOVE_INTERVAL_MS && x === lastMoveX && y === lastMoveY) return;
    if (wall - lastMoveWall < MOVE_INTERVAL_MS) return;
    lastMoveWall = wall;
    lastMoveX = x;
    lastMoveY = y;
    send({ type: 'mousemove', x, y, wall });
  });
  hook.on('keydown', event => {
    reportActivity();
    if (event.keycode === STOP_KEYCODE && event.ctrlKey && event.metaKey) send({ type: 'stop-request' });
  });
  transport.on('message', message => { if (message?.type === 'stop') stop(); });
  transport.on('disconnect', stop);

  try {
    hook.start();
    send({ type: 'ready' });
  }
  catch (error) {
    send({ type: 'error', error: String(error.message || error) });
    setImmediate(() => exit(1));
  }
  return { stop };
}

module.exports = { runInputHookWorker, STOP_KEYCODE, MOVE_INTERVAL_MS };

if (require.main === module) {
  try {
    const { uIOhook } = require('uiohook-napi');
    runInputHookWorker({ hook: uIOhook });
  } catch (error) {
    try { process.send?.({ type: 'error', error: String(error.message || error) }); } catch {}
    process.exitCode = 1;
  }
}

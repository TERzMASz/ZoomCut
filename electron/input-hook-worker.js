'use strict';

const STOP_KEYCODE = 31;

function runInputHookWorker({ hook, transport = process, exit = code => process.exit(code) }) {
  let stopping = false;
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

  hook.on('mousedown', event => {
    send({ type: 'mousedown', x: Number(event.x), y: Number(event.y), wall: Date.now() });
  });
  hook.on('keydown', event => {
    if (event.keycode === STOP_KEYCODE && event.ctrlKey && event.metaKey) send({ type: 'stop-request' });
  });
  transport.on('message', message => { if (message?.type === 'stop') stop(); });
  transport.on('disconnect', stop);

  send({ type: 'ready' });
  try { hook.start(); }
  catch (error) {
    send({ type: 'error', error: String(error.message || error) });
    setImmediate(() => exit(1));
  }
  return { stop };
}

module.exports = { runInputHookWorker, STOP_KEYCODE };

if (require.main === module) {
  try {
    const { uIOhook } = require('uiohook-napi');
    runInputHookWorker({ hook: uIOhook });
  } catch (error) {
    try { process.send?.({ type: 'error', error: String(error.message || error) }); } catch {}
    process.exitCode = 1;
  }
}

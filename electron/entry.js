'use strict';

const INPUT_HOOK_MODE = '--zoomcut-input-hook-worker';

if (process.argv.includes(INPUT_HOOK_MODE)) {
  const { app } = require('electron');
  app.whenReady().then(() => {
    app.dock?.hide();
    const { uIOhook } = require('uiohook-napi');
    const { runInputHookWorker } = require('./input-hook-worker');
    runInputHookWorker({ hook: uIOhook });
  }).catch(error => {
    try { process.send?.({ type: 'error', error: String(error.message || error) }); } catch {}
    app.exit(1);
  });
} else {
  require('./main');
}

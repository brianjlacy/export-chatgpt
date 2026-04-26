#!/usr/bin/env node
'use strict';

// Prefix console output with ISO timestamps so log files can be correlated to
// wall-clock without relying on the caller to pipe through `ts` / `awk`.
// Only wraps when stdout is NOT a TTY — interactive runs keep clean output
// (the throttle ticker on \r, prompts, progress all depend on a clean TTY).
if (!process.stdout.isTTY) {
  const ts = () => '[' + new Date().toISOString().replace('T', ' ').replace(/\..+/, '') + ']';
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.log = (...args) => origLog(ts(), ...args);
  console.warn = (...args) => origWarn(ts(), ...args);
  console.error = (...args) => origError(ts(), ...args);
}

require('./lib/cli').main();

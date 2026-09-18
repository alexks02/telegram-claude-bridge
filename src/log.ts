/**
 * Mirror the console to a log file.
 *
 * Console output only exists in the terminal that started the bridge, and it is
 * gone the moment the process restarts — which is exactly when you want to know
 * what the last request did.
 */

import { appendFileSync } from 'fs';
import { inspect } from 'util';
import { logFile } from './config.js';

for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    const line = args
      .map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 3 })))
      .join(' ')
      .replace(/\n+$/, '');
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${line}\n`);
    } catch {
      // A broken log file must never take the bridge down
    }
  };
}

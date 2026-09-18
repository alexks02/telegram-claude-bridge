#!/usr/bin/env node
// Run the bridge detached from any terminal, tracked by a PID file — on macOS,
// Linux and Windows alike. The logic lives here, in Node, rather than in a shell
// script, so there is one implementation instead of a bridge.sh / bridge.cmd
// pair that drift apart. bridge.sh and bridge.cmd are one-line shims onto this.
//
// Usage: node bridge.mjs {start|stop|restart|status|log}

import {
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  watchFile,
  createReadStream,
} from 'fs';
import { spawn, spawnSync, execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
process.chdir(root);

const PID_FILE = join(root, 'bridge.pid');
const OUT_FILE = join(root, 'bridge.out');
const LOG_FILE = join(root, 'bridge.log');
const isWindows = process.platform === 'win32';

function pid() {
  try {
    return Number(readFileSync(PID_FILE, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

function running() {
  const p = pid();
  if (!p) return false;
  try {
    process.kill(p, 0); // signal 0 only tests for existence
    return true;
  } catch {
    return false;
  }
}

function build() {
  // npm is npm.cmd on Windows; name it directly rather than via a shell, which
  // both resolves it and avoids passing args through a shell.
  const npm = isWindows ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', '--silent', 'build'], { stdio: 'inherit' });
  return r.status === 0;
}

function start() {
  if (running()) {
    console.log(`already running (pid ${pid()})`);
    return;
  }
  if (!build()) {
    console.log('build failed');
    process.exit(1);
  }

  // Compiled output means one process with a PID we can trust — tsx wraps the
  // real process in a parent, so killing it can leave the child behind.
  const out = openSync(OUT_FILE, 'a');
  const child = spawn(process.execPath, [join(root, 'dist', 'index.js')], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
  });
  writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  setTimeout(() => {
    if (running()) {
      console.log(`started (pid ${pid()})`);
    } else {
      console.log(`failed to start — last lines of ${OUT_FILE}:`);
      try {
        console.log(readFileSync(OUT_FILE, 'utf8').trimEnd().split('\n').slice(-5).join('\n'));
      } catch {
        /* nothing to show */
      }
      try {
        rmSync(PID_FILE);
      } catch {
        /* already gone */
      }
      process.exit(1);
    }
  }, 1000);
}

async function stop() {
  if (!running()) {
    console.log('not running');
    try {
      rmSync(PID_FILE);
    } catch {
      /* already gone */
    }
    return;
  }

  const p = pid();
  // SIGTERM lets Telegraf close its long poll; on Windows Node maps it to a
  // terminate. Only insist with SIGKILL if it hangs.
  try {
    process.kill(p, 'SIGTERM');
  } catch {
    /* already dead */
  }

  for (let i = 0; i < 5 && running(); i++) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (running()) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* already dead */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  try {
    rmSync(PID_FILE);
  } catch {
    /* already gone */
  }
  console.log(`stopped (pid ${p})`);
}

function humanUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function status() {
  if (!running()) {
    console.log('stopped');
    return;
  }
  const p = pid();
  let up = '';
  try {
    up = `, up ${humanUptime(Date.now() - statSync(PID_FILE).mtimeMs)}`;
  } catch {
    /* no pid file mtime */
  }
  console.log(`running (pid ${p}${up})`);

  // A Claude run in flight is the reason not to restart right now. pgrep is
  // Unix-only; on Windows this check is skipped rather than faked.
  if (!isWindows) {
    try {
      const busy = execSync(`pgrep -P ${p} -f 'claude --resume' | wc -l`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      if (Number(busy) > 0) {
        console.log(`⚠️  ${busy} Claude run(s) in flight — restarting would kill them`);
      }
    } catch {
      /* pgrep missing or nothing matched */
    }
  }
}

function log() {
  // A cross-platform `tail -f`: print the tail, then stream appends.
  let size = 0;
  try {
    size = statSync(LOG_FILE).size;
    const tail = readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-25).join('\n');
    if (tail) console.log(tail);
  } catch {
    console.log(`(no ${LOG_FILE} yet)`);
  }
  watchFile(LOG_FILE, { interval: 500 }, (curr) => {
    if (curr.size < size) size = 0; // rotated/truncated
    if (curr.size > size) {
      createReadStream(LOG_FILE, { start: size, end: curr.size }).pipe(process.stdout);
      size = curr.size;
    }
  });
}

const cmd = process.argv[2];
if (cmd === 'start') start();
else if (cmd === 'stop') await stop();
else if (cmd === 'restart') await stop().then(start);
else if (cmd === 'status') status();
else if (cmd === 'log') log();
else {
  console.log('usage: node bridge.mjs {start|stop|restart|status|log}');
  process.exit(1);
}

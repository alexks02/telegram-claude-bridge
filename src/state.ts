/**
 * The bridge's one state file, holding both of the things it remembers.
 *
 * There used to be two — `sessions.json` (which conversation each tab is on) and
 * `tabs.json` (which project each tab is on) — with different key shapes and
 * different lifetimes, which was two files to lose instead of one. They are now
 * two sections of a single `state.json`:
 *
 *   { "tabs": { "<chat>:<topic>": "<project path>" },
 *     "sessions": { "<chat>:<topic>|<path>": <id | entry> },
 *     "modes": { "<chat>:<topic>": "plan" | "acceptEdits" | … },
 *     "models": { "<chat>:<topic>": "opus" | "haiku" | … } }
 *
 * Each section is written on its own (a tab switch never rewrites session data
 * and vice versa) by reading the file, replacing one key, and writing it back —
 * so the file stays the shared authority the handoff/idle logic relies on.
 */

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { scriptDir, stateFile } from './config.js';

export interface BridgeState {
  tabs: Record<string, string>;
  sessions: Record<string, unknown>;
  /** Per-tab Claude permission mode; absent means the CLI default. */
  modes: Record<string, string>;
  /** Per-tab Claude model; absent means the CLI default. */
  models: Record<string, string>;
}

const legacySessions = resolve(scriptDir, '..', 'sessions.json');
const legacyTabs = resolve(scriptDir, '..', 'tabs.json');

/** Fold a pre-merge pair of files into the single one, once. */
function migrate(): void {
  if (existsSync(stateFile)) return;
  if (!existsSync(legacySessions) && !existsSync(legacyTabs)) return;

  const state: BridgeState = { tabs: {}, sessions: {}, modes: {}, models: {} };
  try {
    state.sessions = JSON.parse(readFileSync(legacySessions, 'utf8'));
  } catch {
    // No sessions file, or unreadable — start that section empty
  }
  try {
    state.tabs = JSON.parse(readFileSync(legacyTabs, 'utf8'));
  } catch {
    // Same for tabs
  }

  try {
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    for (const file of [legacySessions, legacyTabs]) {
      try {
        rmSync(file);
      } catch {
        // Leaving a stale legacy file behind is harmless; it is ignored from now on
      }
    }
    console.log(`🗃️  Merged sessions.json + tabs.json into ${stateFile}`);
  } catch (error) {
    console.warn('⚠️  Could not write the merged state file:', error);
  }
}

export function readState(): BridgeState {
  migrate();
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<BridgeState>;
    return {
      tabs: raw.tabs ?? {},
      sessions: raw.sessions ?? {},
      modes: raw.modes ?? {},
      models: raw.models ?? {},
    };
  } catch {
    return { tabs: {}, sessions: {}, modes: {}, models: {} }; // No file yet, or corrupted
  }
}

function writeState(state: BridgeState): void {
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/** Replace the tabs section, leaving sessions untouched. */
export function patchTabs(tabs: Record<string, string>): void {
  const state = readState();
  state.tabs = tabs;
  writeState(state);
}

/** Replace the sessions section, leaving tabs untouched. */
export function patchSessions(sessions: Record<string, unknown>): void {
  const state = readState();
  state.sessions = sessions;
  writeState(state);
}

/** Replace the modes section, leaving tabs and sessions untouched. */
export function patchModes(modes: Record<string, string>): void {
  const state = readState();
  state.modes = modes;
  writeState(state);
}

/** Replace the models section, leaving the rest untouched. */
export function patchModels(models: Record<string, string>): void {
  const state = readState();
  state.models = models;
  writeState(state);
}

/** mtime:size, so a caller can tell when the file changed under it. */
export function stateStamp(): string {
  try {
    const stats = statSync(stateFile);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'none';
  }
}

export { stateFile };

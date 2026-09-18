/**
 * Which conversation each tab is on, and when it lets go of it.
 *
 * The map is a cache of `sessions.json`; the file is the authority, so editing
 * it from outside the process works.
 */

import { HANDOFF_IDLE_MS, ownerChatId } from './config.js';
import { isBusy } from './queue.js';
import { readSession } from './sessions.js';
import { patchSessions, readState, stateFile, stateStamp } from './state.js';
import { tabFromKey } from './tabs.js';
import type { Project, SessionEntry, Tab } from './types.js';

export const sessionIds = new Map<string, SessionEntry>(loadSessions());

/**
 * Conversations are per tab *and* per project: switching either one starts a
 * different conversation, which is what keeps workstreams from bleeding together.
 */
export function sessionKeyFor(tab: Tab, project: Project): string {
  return `${tab.key}|${project.path}`;
}

/** What the tab is on, parked sessions included — for showing, not for resuming. */
export function entryFor(tab: Tab, project: Project): SessionEntry | undefined {
  syncSessions();

  const own = sessionIds.get(sessionKeyFor(tab, project));
  if (own) return own;

  const legacy = sessionIds.get(project.path);
  if (legacy && tab.key === `${ownerChatId}:0`) {
    console.log(`↪️  Adopting the pre-tabs conversation for ${project.name}`);
    return legacy;
  }
  return undefined;
}

/** What to actually resume: a parked session is deliberately not it. */
export function resumeFor(tab: Tab, project: Project): SessionEntry | undefined {
  const entry = entryFor(tab, project);
  return entry?.parked ? undefined : entry;
}

/**
 * Let go of a conversation nobody is having any more, and take it back when
 * they are.
 *
 * The bridge never holds a session open — it resumes per message — so a tab
 * that has been quiet for a minute is not using its session for anything, it is
 * only claiming it. That claim is what makes walking to the desk unsafe.
 * Dropping it on a timer means this needs no command at all: the bridge answers,
 * a minute of quiet later the session is free, you open it at the desk, and if you come
 * back to the phone your next message simply continues it.
 *
 * Taking it back is a plain resume of the same session — not a fork. Copying a
 * transcript on every return would cost tens of megabytes to protect against
 * two windows being used in the same minute, which is not how anyone works.
 *
 * A minute by default, which is aggressive on purpose: the claim is only worth
 * holding while a back-and-forth is actually happening, and the cost of letting
 * go early is nothing — the next message takes it straight back.
 */

export const idleTimers = new Map<string, NodeJS.Timeout>();
/** When each tab's timer is due, so `/status` can say how long is left. */
export const idleDeadlines = new Map<string, number>();

export function transcriptStamp(project: Project, id: string): string {
  const session = readSession(project.path, id);
  return session ? `${Math.round(session.modifiedAt)}:${session.bytes}` : 'none';
}

export function scheduleIdlePark(tab: Tab, delay = HANDOFF_IDLE_MS): void {
  if (!HANDOFF_IDLE_MS) return;

  const existing = idleTimers.get(tab.key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => parkIfIdle(tab), delay);
  timer.unref();
  idleTimers.set(tab.key, timer);
  idleDeadlines.set(tab.key, Date.now() + delay);
}

export function forgetIdleTimer(tabKey: string): void {
  const timer = idleTimers.get(tabKey);
  if (timer) clearTimeout(timer);
  idleTimers.delete(tabKey);
  idleDeadlines.delete(tabKey);
}

export function parkIfIdle(tab: Tab): void {
  const entry = entryFor(tab, tab.project);
  if (!entry || entry.parked) {
    forgetIdleTimer(tab.key);
    return;
  }

  // A run still working is not idle, whatever the timer thinks
  if (isBusy(tab.project.path)) {
    scheduleIdlePark(tab, 60000);
    return;
  }

  sessionIds.set(sessionKeyFor(tab, tab.project), {
    id: entry.id,
    parked: 'auto',
    stamp: transcriptStamp(tab.project, entry.id),
  });
  persistSessions();
  forgetIdleTimer(tab.key);
  console.log(
    `✋ ${tab.label} let go of ${entry.id.slice(0, 8)}… in ${tab.project.name} ` +
      `after ${Math.round(HANDOFF_IDLE_MS / 1000)}s of quiet`
  );
}

/**
 * What this run should resume, taking a parked session back if there is one.
 */
export function planResume(
  tab: Tab,
  project: Project,
  onNotice: (line: string) => void
): SessionEntry | undefined {
  const entry = entryFor(tab, project);
  if (!entry?.parked) return entry;

  const movedOn = entry.stamp !== undefined && entry.stamp !== transcriptStamp(project, entry.id);
  sessionIds.set(sessionKeyFor(tab, project), { id: entry.id });
  persistSessions();
  console.log(
    `↩️  ${tab.label} took ${entry.id.slice(0, 8)}… back` +
      (movedOn ? ' (it was worked on elsewhere while parked)' : '')
  );

  // Worth saying out loud: it means the desk is in this conversation too, and
  // from here both windows are writing into one transcript.
  if (movedOn) onNotice('↩️ Taking the conversation back — it was worked on elsewhere meanwhile');

  return { id: entry.id };
}

/** Ids were stored as bare strings before adoption existed; both forms load. */
export function loadSessions(): [string, SessionEntry][] {
  const stored = readState().sessions as Record<string, string | SessionEntry>;
  return Object.entries(stored).map(([key, value]) => {
    if (typeof value === 'string') return [key, { id: value }];
    // Anything parked is parked the one way there is now
    return [key, value.parked ? { ...value, parked: 'auto' } : value];
  });
}

/** A plain id is enough unless something is pending on the entry. */
export function persistSessions(): void {
  const plain = Object.fromEntries(
    [...sessionIds].map(([key, entry]) => [key, entry.fork || entry.parked ? entry : entry.id])
  );
  try {
    patchSessions(plain);
    lastStateStamp = stateStamp();
  } catch (error) {
    console.warn('⚠️  Could not persist session ids:', error);
  }
}

/**
 * The file on disk wins over what is in memory.
 *
 * Something else may have edited it — by hand, or by a script parking a session
 * so it can be opened elsewhere safely. Keeping the map as a cache of a file
 * that is read back whenever it changes means an outside edit is honoured
 * rather than overwritten by the next run.
 */
let lastStateStamp = stateStamp();

export function syncSessions(): void {
  const stamp = stateStamp();
  if (stamp === lastStateStamp) return;

  sessionIds.clear();
  for (const [key, entry] of loadSessions()) sessionIds.set(key, entry);
  lastStateStamp = stamp;
  console.log(`🔄 Reloaded ${stateFile} (changed on disk)`);
}

export function rememberSession(key: string, sessionId: string): void {
  syncSessions();
  const current = sessionIds.get(key);
  if (current && current.id === sessionId && !current.fork && !current.parked) return;

  // Whatever the CLI answered with is now the bridge's own session, forked or
  // not — but a parking that landed while the run was in flight still stands.
  sessionIds.set(
    key,
    current?.parked ? { id: sessionId, parked: current.parked } : { id: sessionId }
  );
  persistSessions();
}

/**
 * Point a tab at a conversation started elsewhere; the first run forks it.
 *
 * The fork inherits the original's `ai-title`, so without a name of its own the
 * two are indistinguishable in the CLI's own `/resume` picker — two entries
 * called "Юнит-тесты", one of which quietly has three hours of Telegram work in
 * it. `-n` on the forking run settles that at the moment it is created.
 *
 * Forking is the exception, not the rule. Picking a conversation out of the
 * list continues it — one session, no copy — because that is what picking it
 * means. The fork is for the one case where continuing it in place would hurt:
 * a session another window is writing to right now, taken anyway on purpose.
 */
export function adoptSession(
  key: string,
  sessionId: string,
  title: string,
  fork: boolean
): void {
  if (!fork) {
    sessionIds.set(key, { id: sessionId });
    persistSessions();
    return;
  }

  const clipped = title.length > 48 ? `${title.slice(0, 47)}…` : title;
  sessionIds.set(key, { id: sessionId, fork: true, name: `📱 ${clipped}` });
  persistSessions();
}

export function forgetSession(key: string): void {
  sessionIds.delete(key);
  persistSessions();
}

/**
 * A restart wipes the idle timers, so quiet sessions are caught up on at start:
 * anything whose transcript has not been touched for the idle window is let go
 * of straight away. Otherwise a bridge that restarted overnight would come up
 * still claiming every conversation it had.
 */
export function parkStaleSessions(): void {
  if (!HANDOFF_IDLE_MS) return;
  let parked = 0;
  let armed = 0;

  for (const [key, entry] of sessionIds) {
    if (entry.parked) continue;

    const tabKey = key.includes('|') ? key.slice(0, key.indexOf('|')) : key;
    const projectPath = key.includes('|') ? key.slice(key.indexOf('|') + 1) : key;
    const session = readSession(projectPath, entry.id);
    if (!session) continue;

    const quietFor = Date.now() - session.modifiedAt;
    if (quietFor < HANDOFF_IDLE_MS) {
      // Still warm: give it the rest of its window rather than leaving it
      // claimed with no timer until someone happens to write.
      scheduleIdlePark(tabFromKey(tabKey, projectPath), HANDOFF_IDLE_MS - quietFor);
      armed += 1;
      continue;
    }

    sessionIds.set(key, {
      id: entry.id,
      parked: 'auto',
      stamp: `${Math.round(session.modifiedAt)}:${session.bytes}`,
    });
    parked += 1;
  }

  if (parked) {
    persistSessions();
    console.log(`✋ Let go of ${parked} conversation(s) that were already quiet`);
  }
  if (armed) console.log(`⏳ ${armed} conversation(s) still warm — timers re-armed`);
}


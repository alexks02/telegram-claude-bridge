/**
 * One conversation per tab means one run at a time, so requests from that same
 * tab queue. Two tabs — even on the same project — run in parallel; that's a
 * deliberate choice to let two forum topics work independently, at the cost of
 * two agents being able to edit the same working copy at once if the user
 * points both tabs at it.
 *
 * Its own module because the session store asks "is this tab busy?" before
 * letting go of a session, and the turn pipeline that fills the queue asks the
 * store what to resume. Keeping the queue between them is what stops those two
 * from importing each other.
 */

import type { ChildProcess } from 'child_process';

export const runQueues = new Map<string, Promise<unknown>>();

export function isBusy(tabKey: string): boolean {
  return runQueues.has(tabKey);
}

/**
 * The Claude child process in flight for a tab, so /cancel can kill it.
 *
 * Only real turns register here (the preview summariser does not), so /cancel
 * never reaches for a background summary. `cancelled` is a one-shot flag the
 * turn reads after the child dies, to tell "the user stopped it" apart from
 * "it failed".
 */

const activeChild = new Map<string, ChildProcess>();
const cancelledTabs = new Set<string>();

export function setActiveChild(tabKey: string, child: ChildProcess): void {
  activeChild.set(tabKey, child);
  cancelledTabs.delete(tabKey);
}

export function clearActiveChild(tabKey: string): void {
  activeChild.delete(tabKey);
}

/** Kill the in-flight run for a tab. Returns false if nothing was running. */
export function cancelRun(tabKey: string): boolean {
  const child = activeChild.get(tabKey);
  if (!child) return false;
  cancelledTabs.add(tabKey);
  child.kill('SIGTERM');
  return true;
}

/** Read-and-clear the cancelled flag for a tab. */
export function consumeCancelled(tabKey: string): boolean {
  const was = cancelledTabs.has(tabKey);
  cancelledTabs.delete(tabKey);
  return was;
}

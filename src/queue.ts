/**
 * One conversation per project means one run at a time, so requests queue.
 *
 * Its own module because the session store asks "is this project busy?" before
 * letting go of a session, and the turn pipeline that fills the queue asks the
 * store what to resume. Keeping the queue between them is what stops those two
 * from importing each other.
 */

import type { ChildProcess } from 'child_process';

export const runQueues = new Map<string, Promise<unknown>>();

export function isBusy(projectPath: string): boolean {
  return runQueues.has(projectPath);
}

/**
 * The Claude child process in flight for a project, so /cancel can kill it.
 *
 * Only real turns register here (the preview summariser does not), so /cancel
 * never reaches for a background summary. `cancelled` is a one-shot flag the
 * turn reads after the child dies, to tell "the user stopped it" apart from
 * "it failed".
 */

const activeChild = new Map<string, ChildProcess>();
const cancelledProjects = new Set<string>();

export function setActiveChild(projectPath: string, child: ChildProcess): void {
  activeChild.set(projectPath, child);
  cancelledProjects.delete(projectPath);
}

export function clearActiveChild(projectPath: string): void {
  activeChild.delete(projectPath);
}

/** Kill the in-flight run for a project. Returns false if nothing was running. */
export function cancelRun(projectPath: string): boolean {
  const child = activeChild.get(projectPath);
  if (!child) return false;
  cancelledProjects.add(projectPath);
  child.kill('SIGTERM');
  return true;
}

/** Read-and-clear the cancelled flag for a project. */
export function consumeCancelled(projectPath: string): boolean {
  const was = cancelledProjects.has(projectPath);
  cancelledProjects.delete(projectPath);
  return was;
}

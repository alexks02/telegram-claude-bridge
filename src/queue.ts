/**
 * One conversation per project means one run at a time, so requests queue.
 *
 * Its own module because the session store asks "is this project busy?" before
 * letting go of a session, and the turn pipeline that fills the queue asks the
 * store what to resume. Keeping the queue between them is what stops those two
 * from importing each other.
 */

export const runQueues = new Map<string, Promise<unknown>>();

export function isBusy(projectPath: string): boolean {
  return runQueues.has(projectPath);
}

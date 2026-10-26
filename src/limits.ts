/**
 * How much of the 5-hour and weekly subscription limit is left.
 *
 * `/usage` is the CLI's own built-in command — it answers from local account
 * state without calling the model (0 tokens, 0 cost, `"model":"<synthetic>"`
 * in its own output), so running it once per reply costs nothing but the
 * ~400ms of a subprocess. Cached briefly so a burst of messages doesn't spawn
 * one per reply.
 */

import { runClaudeCli } from './runner.js';

const CACHE_MS = 30000;
let cached: { at: number; text: string } | undefined;

export async function rateLimitFooter(cwd: string): Promise<string | undefined> {
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS) {
    try {
      const run = await runClaudeCli(
        ['-p', '/usage', '--output-format', 'stream-json', '--verbose'],
        cwd,
        () => {},
        20000
      );
      cached = { at: now, text: run.result };
    } catch (error) {
      console.warn(
        '⚠️  Could not read /usage limits:',
        error instanceof Error ? error.message : error
      );
      return undefined;
    }
  }

  const session = cached.text.match(/^Current session:.*/m)?.[0];
  const week = cached.text.match(/^Current week.*/m)?.[0];
  if (!session && !week) return undefined;

  return [session && `⏳ ${session}`, week && `📅 ${week}`].filter(Boolean).join('\n');
}

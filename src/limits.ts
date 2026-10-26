/**
 * How much of the 5-hour and weekly subscription limit is left, and how much
 * of it the last turn used.
 *
 * `/usage` is the CLI's own built-in command — it answers from local account
 * state without calling the model (0 tokens, 0 cost, `"model":"<synthetic>"`
 * in its own output), so reading it once per reply costs nothing but the
 * ~400ms of a subprocess.
 *
 * The limits are account-wide, not per tab or project, so the previous
 * reading is kept in one place and compared against whatever reads it next —
 * a reply's own footer or a `/status` check, whichever comes first. That also
 * means a delta can include usage from another tab in between, and a bridge
 * restart starts over with nothing to compare against.
 */

import { runClaudeCli } from './runner.js';

interface Reading {
  sessionPct?: number;
  sessionLine?: string;
  weekPct?: number;
  weekLine?: string;
}

let previous: Reading | undefined;

function parse(raw: string): Reading {
  const sessionMatch = raw.match(/^Current session: (\d+)% used · resets .*$/m);
  const weekMatch = raw.match(/^Current week.*?: (\d+)% used · resets .*$/m);
  return {
    sessionPct: sessionMatch ? Number(sessionMatch[1]) : undefined,
    sessionLine: sessionMatch?.[0],
    weekPct: weekMatch ? Number(weekMatch[1]) : undefined,
    weekLine: weekMatch?.[0],
  };
}

/** `/usage` only reports whole percent, so a light turn can round down to +0. */
function withDelta(
  line: string | undefined,
  pct: number | undefined,
  prevPct: number | undefined
): string | undefined {
  if (!line) return undefined;
  if (prevPct === undefined || pct === undefined) return line;

  const delta = pct - prevPct;
  // A negative delta means the window rolled over between the two readings,
  // not that usage went backwards — say so instead of printing "-40%".
  const note = delta < 0 ? ' (window reset)' : ` (+${delta} this turn)`;
  return line.replace('% used', `% used${note}`);
}

export async function rateLimitFooter(cwd: string): Promise<string | undefined> {
  let raw: string;
  try {
    const run = await runClaudeCli(
      ['-p', '/usage', '--output-format', 'stream-json', '--verbose'],
      cwd,
      () => {},
      20000
    );
    raw = run.result;
  } catch (error) {
    console.warn(
      '⚠️  Could not read /usage limits:',
      error instanceof Error ? error.message : error
    );
    return undefined;
  }

  const current = parse(raw);
  const sessionLine = withDelta(current.sessionLine, current.sessionPct, previous?.sessionPct);
  const weekLine = withDelta(current.weekLine, current.weekPct, previous?.weekPct);
  previous = current;

  if (!sessionLine && !weekLine) return undefined;
  return [sessionLine && `⏳ ${sessionLine}`, weekLine && `📅 ${weekLine}`].filter(Boolean).join('\n');
}

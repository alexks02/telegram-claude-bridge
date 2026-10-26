/**
 * How much of the 5-hour and weekly subscription limit is left, how much of
 * it the last turn used, and how long until each window resets.
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
  sessionResetMs?: number;
  weekPct?: number;
  weekResetMs?: number;
}

let previous: Reading | undefined;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "resets Oct 26 at 8:39pm (Europe/Warsaw)" has no year, and the zone name is
 * cosmetic — the clock it is printed against is this same machine's, so it is
 * read as local time and compared against `now` on that same machine.
 */
function parseResetDate(
  month: string,
  day: string,
  hour: string,
  minute: string | undefined,
  ampm: string,
  now: Date
): Date {
  const monthIndex = MONTHS.indexOf(month);
  let hour24 = Number(hour) % 12;
  if (ampm.toLowerCase() === 'pm') hour24 += 12;

  const year = now.getFullYear();
  const candidate = new Date(year, monthIndex, Number(day), hour24, Number(minute ?? 0), 0, 0);
  // A reset date "in the past" by more than a day means it is actually next
  // year (reading in December about a January reset).
  if (candidate.getTime() < now.getTime() - 24 * 3600 * 1000) {
    candidate.setFullYear(year + 1);
  }
  return candidate;
}

function formatRelative(resetMs: number, now: Date): string {
  const diffMs = resetMs - now.getTime();
  if (diffMs <= 0) return 'any moment now';

  let totalMinutes = Math.round(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  totalMinutes -= days * 1440;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return `in ${parts.join(' ')}`;
}

// The minute is only printed when it is not :00 — "8am", but "7:59am".
const RESET_RE = /(\d+)% used · resets (\w+) (\d+) at (\d+)(?::(\d+))?(am|pm)/;

function parse(raw: string, now: Date): Reading {
  const sessionMatch = raw.match(new RegExp(`^Current session: ${RESET_RE.source}`, 'm'));
  const weekMatch = raw.match(new RegExp(`^Current week.*?: ${RESET_RE.source}`, 'm'));

  return {
    sessionPct: sessionMatch ? Number(sessionMatch[1]) : undefined,
    sessionResetMs: sessionMatch
      ? parseResetDate(sessionMatch[2], sessionMatch[3], sessionMatch[4], sessionMatch[5], sessionMatch[6], now).getTime()
      : undefined,
    weekPct: weekMatch ? Number(weekMatch[1]) : undefined,
    weekResetMs: weekMatch
      ? parseResetDate(weekMatch[2], weekMatch[3], weekMatch[4], weekMatch[5], weekMatch[6], now).getTime()
      : undefined,
  };
}

/** `/usage` only reports whole percent, so a light turn can round down to +0. */
function describe(
  label: string,
  pct: number | undefined,
  resetMs: number | undefined,
  prevPct: number | undefined,
  now: Date
): string | undefined {
  if (pct === undefined || resetMs === undefined) return undefined;

  // The baseline is account-wide, not this tab's — with several tabs running
  // at once the gap since it was last read can hold another one's usage too,
  // so this is never claimed as "this turn" alone.
  //
  // A negative delta means the window rolled over between the two readings,
  // not that usage went backwards — say so instead of printing "-40%".
  const delta =
    prevPct === undefined
      ? ''
      : prevPct > pct
        ? ' (window reset)'
        : ` (+${pct - prevPct} since last check)`;

  return `${label}: ${pct}% used${delta} · resets ${formatRelative(resetMs, now)}`;
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

  const now = new Date();
  const current = parse(raw, now);
  const sessionLine = describe('Session', current.sessionPct, current.sessionResetMs, previous?.sessionPct, now);
  const weekLine = describe('Week', current.weekPct, current.weekResetMs, previous?.weekPct, now);
  previous = current;

  if (!sessionLine && !weekLine) return undefined;
  return [sessionLine && `⏳ ${sessionLine}`, weekLine && `📅 ${weekLine}`].filter(Boolean).join('\n');
}

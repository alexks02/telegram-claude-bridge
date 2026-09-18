/** Turning a stored session into something readable in a chat message. */

import {
  MAX_MESSAGE_CHARS,
  PREVIEW_ASSISTANT_FACTOR,
  PREVIEW_USER_CHARS,
  workspaceRoot,
} from './config.js';
import { describeToolCall, plainLine } from './format.js';
import { idleDeadlines } from './sessionStore.js';
import { formatAge, formatSize, readSession } from './sessions.js';
import type { PreviewEntry, SessionSummary } from './sessions.js';
import { HANDOFF_IDLE_MS } from './config.js';
import type { SessionEntry, Tab } from './types.js';

/** "43s", "2m 10s" — a countdown reads better than a timestamp. */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(Math.ceil(ms / 1000), 0);
  if (seconds < 90) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Name the conversation a tab is on, rather than showing eight hex characters.
 *
 * The title comes from the transcript itself, so it stays right as the CLI
 * renames a conversation — and a stored id whose file is gone says so, which is
 * the one case where the short id is the useful thing to print.
 */
export function describeCurrent(tab: Tab, entry: SessionEntry): string {
  const session = readSession(tab.project.path, entry.id);
  const short = `${entry.id.slice(0, 8)}…`;
  if (!session) return `${short} (no longer in the history)`;

  const due = idleDeadlines.get(tab.key);
  const pending =
    entry.parked
      ? ', let go of for now — your next message takes it back'
      : entry.fork
          ? ', forks on the next message'
          : due
            ? `, let go of in ${formatCountdown(due - Date.now())}`
            : HANDOFF_IDLE_MS
              ? ', held until the next message restarts the clock'
              : '';
  return `${session.title} (${short}${pending})`;
}

/**
 * Hand the current conversation to another window and stop resuming it.
 *
 * Without this the only safe way to continue a session at the desk was to not
 * touch Telegram again and hope — because both windows resuming one transcript
 * grow separate branches and one side's work quietly stops counting. The id is
 * kept, so taking it back is one press, and taking it back forks: by then the
 * IDE has moved the conversation on, and branching is the point.

 * No origin marker: the transcripts do not reliably say which window wrote them
 * (every session on this machine records `entrypoint: claude-vscode`, the
 * bridge's own included), and a guessed icon would read as fact. What can be
 * stated is what the bridge actually knows — which one this tab is on, and which
 * ones were written to a moment ago.
 */
export function sessionLine(
  session: SessionSummary,
  index: number,
  current: SessionEntry | undefined
): string {
  const marks = [current?.id === session.id ? '▸' : ' ', session.live ? '🔴' : ''].filter(
    Boolean
  );

  const meta = [
    formatAge(session.modifiedAt),
    formatSize(session.bytes),
    session.gitBranch,
    session.id.slice(0, 8),
  ].filter(Boolean);

  return `${marks.join('')} ${index}. ${session.title}\n     ${meta.join(' · ')}`;
}

/**
 * The list is a keyboard, not a menu you have to transcribe a number from.
 *
 * `callback_data` is capped at 64 bytes, which a full session id fits into with
 * room to spare — so a press carries the session itself rather than a position
 * in a list that may have been redrawn since. `rf:` is the same press confirmed
 * for a session that looks like it is still open somewhere.
 */
export function sessionKeyboard(sessions: SessionSummary[], current: SessionEntry | undefined) {
  // A fresh start is the first thing offered, above the history: the common
  // reason to open this list is "put this tab on a clean conversation", and
  // that need not mean picking an old one.
  const newRow = [{ text: '➕ New conversation', callback_data: 'rn' }];
  return {
    inline_keyboard: [
      newRow,
      ...sessions.map((session, i) => {
      // Both marks can apply at once — the tab's own session is often the one
      // being written to right now.
      const mark =
        (current?.id === session.id ? '▸' : '') + (session.live ? '🔴' : '') || '';
      const title =
        session.title.length > 38 ? `${session.title.slice(0, 37)}…` : session.title;
      return [
        {
          text: `${mark ? `${mark} ` : ''}${i + 1}. ${title} · ${formatAge(session.modifiedAt)}`,
          callback_data: `r:${session.id}`,
        },
        // Titles say what a conversation was about, not where it got to — and
        // picking one up is a commitment, so it can be read first.
        { text: '👁', callback_data: `p:${session.id}` },
      ];
      }),
    ],
  };
}

/**
 * The same list of conversations, but each button arms a deletion.
 *
 * No "new conversation" row — this list only removes — and the callback carries
 * `d:` rather than `r:`, so a press opens a confirmation instead of resuming or
 * wiping on the first tap. 👁 stays, because reading a conversation is exactly
 * how you decide it is the one to throw away.
 */
export function deleteKeyboard(sessions: SessionSummary[], current: SessionEntry | undefined) {
  return {
    inline_keyboard: sessions.map((session, i) => {
      const mark =
        (current?.id === session.id ? '▸' : '') + (session.live ? '🔴' : '') || '';
      const title =
        session.title.length > 38 ? `${session.title.slice(0, 37)}…` : session.title;
      return [
        {
          text: `🗑️ ${mark ? `${mark} ` : ''}${i + 1}. ${title} · ${formatAge(session.modifiedAt)}`,
          callback_data: `d:${session.id}`,
        },
        { text: '👁', callback_data: `p:${session.id}` },
      ];
    }),
  };
}


/**
 * Show where a conversation got to, in the shape of the live progress feed.
 *
 * The same renderers as a running task (`describeToolCall`, `plainLine`), so a
 * preview of yesterday's session and today's run read alike — and the oldest
 * lines are dropped rather than the newest, because what a conversation ended
 * on is what decides whether it is the one you want.
 */
export function renderPreview(entries: PreviewEntry[], count: number, chars: number): string[] {
  return entries
    .slice(-count)
    .map((entry) => {
      if (entry.kind === 'tool') {
        return `🔧 ${describeToolCall(entry.tool ?? '', entry.input ?? {}, chars, workspaceRoot)}`;
      }
      if (entry.kind === 'user') {
        return `📨 ${plainLine(entry.text ?? '', PREVIEW_USER_CHARS)}`;
      }
      return `💬 ${plainLine(entry.text ?? '', chars * PREVIEW_ASSISTANT_FACTOR)}`;
    });
}

/** The whole excerpt, for the summariser rather than for the screen. */
export function renderExcerpt(entries: PreviewEntry[]): string {
  return renderPreview(entries, entries.length, 300).join('\n');
}

/**
 * Assemble a preview that Telegram will accept.
 *
 * Five turns with a whole prompt in each can exceed the 4096-character limit on
 * their own, and an over-long edit is simply refused — leaving "summarising…"
 * on screen for good. So the oldest lines go first, the newest being the ones
 * that say where the conversation stopped, and the summary is never the part
 * that gets dropped.
 */
export function fitPreview(header: string, summary: string | undefined, lines: string[]): string {
  // A blank line between turns, not a newline: every line here has had its own
  // line breaks flattened out (`plainLine` was written for the one-line progress
  // feed), so single newlines leave five turns reading as one paragraph.
  const compose = (shown: string[]) =>
    [
      header,
      summary ? `📝 ${summary}` : '',
      shown.length ? `Last turns:\n\n${shown.join('\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

  const shown = [...lines];
  while (shown.length > 1 && compose(shown).length > MAX_MESSAGE_CHARS) shown.shift();

  const text = compose(shown);
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}

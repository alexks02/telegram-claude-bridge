/**
 * Every setting the bridge reads, in one place.
 *
 * These used to be scattered down the file, each next to whatever used it,
 * which made "what can I configure?" a question you answered by grepping.
 * The README's table is this file, in order.
 */

import 'dotenv/config';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const scriptDir = dirname(fileURLToPath(import.meta.url));

// This file lives at <workspace>/<project>/.claude/bridge/{src,dist}/config.ts, so
// when the bridge is nested in a project the workspace is three levels up. It is
// only a suggestion for the .env, though — WORKSPACE_ROOT is required, so the bridge
// scans exactly the folder you name and never guesses its way into unrelated dirs.
export const hostProject = resolve(scriptDir, '../../..');

if (!process.env.WORKSPACE_ROOT) {
  console.error(
    '❌ WORKSPACE_ROOT is not set.\n' +
      '   Set it in .env to the absolute path of the folder that holds your repositories,\n' +
      `   e.g. WORKSPACE_ROOT=${resolve(scriptDir, '../../../..')}\n` +
      '   (see .env.example), then start the bridge again.'
  );
  process.exit(1);
}
export const workspaceRoot = resolve(process.env.WORKSPACE_ROOT);

/**
 * Authorisation is by *user*, not by chat.
 *
 * With forum topics the bridge lives in a group, where the chat id belongs to
 * the group and every member could write. Only the owner's messages are ever
 * acted on; everyone else is ignored.
 */
export const ownerId = Number(process.env.TELEGRAM_OWNER_ID || process.env.TELEGRAM_CHAT_ID!);

/** Where unsolicited messages go (restart confirmations) — the owner's own chat. */
export const ownerChatId = Number(process.env.TELEGRAM_CHAT_ID!);

export const botToken = process.env.TELEGRAM_BOT_TOKEN!;

/**
 * Short names for projects, `alias:directory` pairs — e.g. "api:my-backend,web:my-frontend".
 * There are no built-in aliases: each person names their own repositories here.
 */
export const aliasSpec = process.env.ALIASES || '';

/**
 * The Claude CLI to run — a full path, no PATH lookup.
 *
 * PATH-based resolution is unreliable exactly where the bridge usually runs: a
 * detached/background process often has a stripped PATH that omits ~/.local/bin.
 * So this is an absolute path. The default is the native-installer location on
 * macOS and Linux (~/.local/bin/claude); set CLAUDE_CLI for any other install
 * or on Windows (see .env.example).
 */
export const claudeCli = process.env.CLAUDE_CLI || join(homedir(), '.local', 'bin', 'claude');
export const claudeTimeoutMs = Number(process.env.CLAUDE_TIMEOUT_MS || 600000);

export const logFile = process.env.LOG_FILE || resolve(scriptDir, '..', 'bridge.log');
/** Left behind by /restart so the process that comes up can confirm it worked. */
export const restartMarker = resolve(scriptDir, '..', '.restart-requested');

/** Both the tab→project map and the tab→conversation map, in one file. */
export const stateFile = process.env.STATE_FILE || resolve(scriptDir, '..', 'state.json');

/** Where files you send the bot are kept so Claude can read them from disk. */
export const inboxDir = process.env.INBOX_DIR || resolve(scriptDir, '..', 'inbox');
export const INBOX_KEEP_DAYS = Number(process.env.INBOX_KEEP_DAYS || 7);
/** getFile caps downloads at 20 MB, so anything larger can't be fetched at all. */
export const MAX_INCOMING_BYTES = 20 * 1024 * 1024;

/** Bots may upload up to 50 MB per file through the Bot API. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS = Number(process.env.MAX_ATTACHMENTS || 5);
export const FILE_SEND_TIMEOUT_MS = 120000;
export const ffmpegCli = process.env.FFMPEG_CLI || 'ffmpeg';

/** Telegram's own cap is 4096; the rest is headroom for what we add around a chunk. */
export const MAX_MESSAGE_CHARS = 3800;

export const PROGRESS_INTERVAL_MS = Number(process.env.PROGRESS_INTERVAL_MS || 4000);
// Line and message budgets work together: a line is only clipped when it alone
// is unreasonably long, and how many lines fit is decided when the message is
// rendered.
export const PROGRESS_MAX_LINES = Number(process.env.PROGRESS_MAX_LINES || 20);
export const PROGRESS_LINE_CHARS = Number(process.env.PROGRESS_LINE_CHARS || 600);

export const SESSION_LIST_DEFAULT = 10;
export const SESSION_LIST_MAX = 25;
/** How deep a search goes when the list itself is not deep enough. */
export const SESSION_SEARCH_DEPTH = 200;
export const SESSION_LIVE_WINDOW_MS = Number(process.env.SESSION_LIVE_WINDOW_MS || 300000);

/**
 * A preview is the summary. The raw lines are a footnote under it.
 *
 * Twelve turns are read because that is what the summariser needs to say
 * anything useful — but printing all twelve buries the summary under a wall of
 * half-sentences, which is the thing the summary exists to replace.
 */
export const PREVIEW_ENTRIES = 12;
/**
 * How far back the tail is read before the shown turns are picked out of it.
 *
 * The screen shows messages only — five of them, assistant and person taking
 * turns. Tool calls are what a run *did*, not what was said, and a working
 * stretch is mostly tool calls, so counting them as turns fills all five slots
 * with `Bash:` lines and tells you nothing about the conversation. They stay in
 * the excerpt the summariser reads, where they are the evidence of what
 * happened; scanning wider is what makes five actual messages findable.
 */
export const PREVIEW_SCAN_ENTRIES = 60;
export const PREVIEW_SHOWN_LINES = 5;
export const PREVIEW_SHOWN_CHARS = 130;
export const PREVIEW_FALLBACK_LINES = 8;
export const PREVIEW_FALLBACK_CHARS = 200;
/**
 * What the person asked is printed whole — with a cap only because a prompt is
 * sometimes a pasted stack trace. The reply gets twice a tool call's budget: it
 * needs room to get past its opening sentence.
 */
export const PREVIEW_USER_CHARS = 1200;
export const PREVIEW_ASSISTANT_FACTOR = 2;

/** Haiku by default: two seconds and a cent, against a preview nobody waits for. */
export const summaryModel = process.env.SUMMARY_MODEL || 'claude-haiku-4-5-20251001';
export const SUMMARY_TIMEOUT_MS = Number(process.env.SUMMARY_TIMEOUT_MS || 60000);
export const SUMMARY_EXCERPT_CHARS = 6000;

/** Quiet time after which a tab lets go of its session; 0 disables. */
export const HANDOFF_IDLE_MS = Number(process.env.HANDOFF_IDLE_MS ?? 60000);

/**
 * Drop incoming messages older than this many seconds; 0 disables.
 *
 * Telegram redelivers unacknowledged updates and holds a backlog while the bot
 * is down (up to 24h), so a crash, a redeploy or a laptop waking from sleep can
 * replay old requests. Anything older than this window is ignored so the bridge
 * does not act on stale work.
 */
export const STALE_MESSAGE_SECONDS = Number(process.env.STALE_MESSAGE_SECONDS ?? 300);

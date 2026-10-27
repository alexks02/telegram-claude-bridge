/** Getting text back into Telegram: chunking, fallbacks, and the live feed. */

import { Context, TelegramError } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import {
  MAX_MESSAGE_CHARS,
  PROGRESS_INTERVAL_MS,
  PROGRESS_MAX_LINES,
  SEND_RETRY_ATTEMPTS,
  SEND_RETRY_BASE_MS,
} from './config.js';
import { toTelegramHtml } from './format.js';
import type { Project } from './types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry a Telegram API call through the API's own two transient failure modes:
 * flood control (429, with Telegram naming the wait itself) and an outage on
 * its end (502/503/504, where only a guess is possible). Anything else —
 * a bad token, "can't parse entities", chat not found — is permanent and
 * must surface immediately rather than burn through the retry budget.
 *
 * This exists for the one call whose failure is otherwise invisible: the
 * final answer a whole run produced. A progress-feed edit skips this on
 * purpose — losing one of twenty cosmetic updates is nothing, but losing the
 * only reply a person is waiting on is everything.
 */
export async function withTelegramRetry<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      const retryable =
        error instanceof TelegramError && (error.code === 429 || error.code >= 500);
      if (!retryable || attempt >= SEND_RETRY_ATTEMPTS) throw error;

      const waitMs =
        error.code === 429 && error.parameters?.retry_after
          ? error.parameters.retry_after * 1000 + 250
          : SEND_RETRY_BASE_MS * attempt;
      console.warn(
        `⚠️  Telegram ${error.code} on send, retrying in ${Math.round(waitMs / 1000)}s ` +
          `(attempt ${attempt}/${SEND_RETRY_ATTEMPTS}):`,
        error.description
      );
      await sleep(waitMs);
    }
  }
}

/**
 * Split a reply into Telegram-sized pieces without breaking it mid-structure.
 *
 * Cutting every 4000 characters splits code fences in half, and half a fence is
 * invalid Markdown that Telegram rejects outright — so split on line boundaries
 * and close and reopen any fence that spans the cut.
 */
export function chunkReply(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let fence = ''; // The opening fence line, when a chunk ends inside a code block

  const flush = () => {
    if (!current.trim()) return;
    const openInside = countFences(current) % 2 === 1;
    chunks.push(openInside ? `${current}\n\`\`\`` : current);
    fence = openInside ? lastFenceLine(current) : '';
    current = fence ? `${fence}\n` : '';
  };

  for (const line of text.split('\n')) {
    // A single line longer than the limit is rare; hard-split it as a last resort
    if (line.length > MAX_MESSAGE_CHARS) {
      flush();
      for (const piece of line.match(new RegExp(`[\\s\\S]{1,${MAX_MESSAGE_CHARS}}`, 'g')) || []) {
        chunks.push(piece);
      }
      continue;
    }

    if (current.length + line.length + 1 > MAX_MESSAGE_CHARS) flush();
    current += `${line}\n`;
  }

  if (current.trim()) {
    const openInside = countFences(current) % 2 === 1;
    chunks.push(openInside ? `${current}\n\`\`\`` : current);
  }

  return chunks.length ? chunks.map((c) => c.trimEnd()) : [text];
}

export function countFences(text: string): number {
  return (text.match(/^```/gm) || []).length;
}

export function lastFenceLine(text: string): string {
  const opens = text.split('\n').filter((line) => line.startsWith('```'));
  return opens[opens.length - 1] || '```';
}

/**
 * Send a reply, falling back to plain text when Telegram rejects the Markdown.
 *
 * Claude writes for humans, not for Telegram's dialect of Markdown: a lone
 * asterisk, an underscore in a file name or an unclosed backtick makes Telegram
 * answer "can't parse entities" and drop the message. The answer matters more
 * than its formatting, so send it unformatted rather than lose it.
 */
export async function sendReply(
  ctx: Context,
  text: string,
  // Attached to the last chunk only — a keyboard on every chunk of a long
  // answer would repeat it, and the last one is where a reply to it lands.
  replyMarkup?: InlineKeyboardMarkup
): Promise<void> {
  // Chunk the markdown (fence-aware), then convert each piece on its own — the
  // chunker guarantees balanced fences, so every chunk converts to valid HTML.
  const chunks = chunkReply(text);
  for (const [i, chunk] of chunks.entries()) {
    const extra = i === chunks.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {};
    try {
      await withTelegramRetry(() => ctx.reply(toTelegramHtml(chunk), { parse_mode: 'HTML', ...extra }));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!errorMsg.includes("can't parse entities")) throw error;

      console.warn('⚠️  HTML rejected, sending as plain text:', errorMsg);
      await withTelegramRetry(() => ctx.reply(chunk, extra));
    }
  }
}

// Line and message budgets work together: a line is only clipped when it alone
// is unreasonably long, and how many lines fit is decided when the message is
// rendered. A small per-line cap used to throw away detail while most of the
// 4096-character message went unused.

/**
 * A live progress feed in the chat, as one message that keeps being edited.
 *
 * Posting every step as its own message reads well for two steps and becomes
 * unusable at thirty — and Telegram throttles bots at roughly one message per
 * second per chat, so a busy run would hit 429 and lose steps. Editing a single
 * message shows the same information as it happens, costs one message per run,
 * and leaves the chat readable afterwards.
 *
 * Edits are throttled: steps that arrive inside the interval are collected and
 * shown by the next edit, so nothing is dropped, it just lands a moment later.
 */
export function createProgressFeed(ctx: Context, messageId: number, project: Project) {
  const steps: string[] = [];
  let sent = '';
  let lastEditAt = 0;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  /**
   * Fill the message rather than a per-line quota.
   *
   * A fixed budget per line clipped useful text while most of the 4096-character
   * message went unused, so pack the newest steps in until the message is full
   * and let the older ones fall off the top.
   */
  const render = (): string => {
    const header = `⏳ ${project.name} — ${steps.length} step(s)`;
    const budget = MAX_MESSAGE_CHARS - header.length - 40; // room for the "… earlier" line
    const shown: string[] = [];
    let used = 0;

    for (let i = steps.length - 1; i >= 0 && shown.length < PROGRESS_MAX_LINES; i--) {
      const line = steps[i];
      if (used + line.length + 1 > budget) break;
      shown.unshift(line);
      used += line.length + 1;
    }

    const hidden = steps.length - shown.length;
    return [header, hidden > 0 ? `… ${hidden} earlier step(s)` : '', ...shown]
      .filter(Boolean)
      .join('\n');
  };

  const push = async () => {
    timer = undefined;
    if (closed) return;

    const text = render();
    if (text === sent) return;
    sent = text;
    lastEditAt = Date.now();

    try {
      await ctx.telegram.editMessageText(ctx.chat!.id, messageId, undefined, text);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // "message is not modified" is benign; anything else is worth a log line
      // but never worth failing the request over.
      if (!errorMsg.includes('message is not modified')) {
        console.warn('⚠️  Could not update progress:', errorMsg);
      }
    }
  };

  return {
    add(line: string) {
      console.log(`   ${line}`);
      steps.push(line);
      if (timer || closed) return;
      const wait = Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - lastEditAt));
      timer = setTimeout(push, wait);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    steps: () => steps.length,
  };
}


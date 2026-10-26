/** One request, end to end: the run, its live feed, its answer and its files. */

import { Context } from 'telegraf';
import { MAX_ATTACHMENTS } from './config.js';
import { extractAttachments } from './format.js';
import { sendAttachment } from './files.js';
import { createProgressFeed, sendReply } from './reply.js';
import { rateLimitFooter } from './limits.js';
import { CancelledError, callClaudeWithContext } from './runner.js';
import { scheduleIdlePark, sessionKeyFor, takePendingSeed } from './sessionStore.js';
import { runQueues } from './queue.js';
import type { Tab } from './types.js';

/** The "🧹 Compact session" button under every answer — see commands.ts's `clr` action. */
const clearSessionKeyboard = {
  inline_keyboard: [[{ text: '🧹 Compact session', callback_data: 'clr' }]],
};

/** Run one request against a project: Claude call, then the reply in chunks. */
export async function runTurn(ctx: Context, userMessage: string, tab: Tab): Promise<void> {
  const project = tab.project;
  const statusMsg = await ctx.reply(`⏳ ${project.name} — starting…`);
  const progress = createProgressFeed(ctx, statusMsg.message_id, project);

  try {
    console.log(`\n📨 User (${tab.label} · ${project.name}): ${userMessage}`);

    // Set by "🧹 Compact session": carries a short recap of the parted conversation
    // into the fresh one it started, so the next message isn't the first thing
    // the new session has ever heard about the task.
    const seed = takePendingSeed(sessionKeyFor(tab, project));
    const prompt = seed ? `${seed}\n\n---\n\n${userMessage}` : userMessage;

    const response = await callClaudeWithContext(prompt, tab, project, progress.add);
    progress.close();

    console.log(`\n🤖 Claude: ${response.substring(0, 100)}...`);

    // The finished run's steps are already in the log, so the feed can go and
    // leave the chat with just the question and the answer.
    try {
      await ctx.deleteMessage(statusMsg.message_id);
    } catch {
      // Ignore if can't delete
    }

    const { text: reply, attachments } = extractAttachments(response);
    const limits = await rateLimitFooter(project.path);
    const footer = limits ? `\n\n${limits}` : '';
    await sendReply(ctx, (reply || '(no text)') + footer, clearSessionKeyboard);

    // Files come after the text, and a failed upload never fails the turn —
    // the answer is already delivered by this point.
    for (const attachment of attachments.slice(0, MAX_ATTACHMENTS)) {
      try {
        await sendAttachment(ctx, attachment, project);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(`⚠️  Could not send ${attachment.path}:`, errorMsg);
        await ctx.reply(`⚠️ Could not send ${attachment.path}: ${errorMsg}`).catch(() => {});
      }
    }
    if (attachments.length > MAX_ATTACHMENTS) {
      const skipped = attachments.length - MAX_ATTACHMENTS;
      await ctx.reply(`⚠️ ${skipped} more file(s) were not sent (limit ${MAX_ATTACHMENTS} per reply)`);
    }
  } catch (error) {
    progress.close();
    try {
      await ctx.deleteMessage(statusMsg.message_id);
    } catch {
      // Ignore if can't delete
    }

    if (error instanceof CancelledError) {
      console.log(`🛑 ${tab.label} cancelled the run on ${project.name}`);
      await ctx.reply('🛑 Cancelled.').catch(() => {});
      return;
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ Error:', errorMsg);
    await ctx.reply(`❌ Error: ${errorMsg}`).catch(() => {});
  }
}

/**
 * One conversation per project means one run at a time, so requests queue.
 *
 * The handler must not await the run: Telegraf stops fetching updates until the
 * current handler settles, so awaiting a ten-minute task makes the bot ignore
 * everything — including `/status` and `/log`, exactly when you want them.
 */

export function enqueueTurn(ctx: Context, userMessage: string, tab: Tab): boolean {
  // Keyed by project, not by tab: two tabs on different projects run in
  // parallel, but two tabs on the *same* repository take turns — parallel
  // agents editing one working copy is how you get conflicts.
  const project = tab.project;
  const previous = runQueues.get(project.path);
  const next = (previous ?? Promise.resolve())
    // A failed run must not poison the queue behind it
    .catch(() => {})
    .then(() => runTurn(ctx, userMessage, tab))
    .catch((error) => console.error('❌ Queued run failed:', error));

  runQueues.set(project.path, next);
  next.finally(() => {
    if (runQueues.get(project.path) === next) runQueues.delete(project.path);
    // The clock starts from the bot's reply, not the user's message: the quiet
    // window is time since the conversation last said anything, and while a run
    // is in flight there is no timer at all. A run answered, so start it now.
    scheduleIdlePark(tab);
  });

  return previous !== undefined;
}


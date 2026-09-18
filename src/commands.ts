/**
 * Everything the bot answers to.
 *
 * Handlers only: the work each one triggers lives in the module that owns it,
 * so this file reads as the bot's surface rather than as its implementation.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { join, resolve } from 'path';
import { Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { bot, isOwner } from './bot.js';
import {
  PREVIEW_ENTRIES,
  PREVIEW_FALLBACK_CHARS,
  PREVIEW_SCAN_ENTRIES,
  PREVIEW_FALLBACK_LINES,
  PREVIEW_SHOWN_CHARS,
  PREVIEW_SHOWN_LINES,
  SESSION_LIST_DEFAULT,
  SESSION_LIST_MAX,
  SESSION_LIVE_WINDOW_MS,
  SESSION_SEARCH_DEPTH,
  logFile,
  ownerChatId,
  restartMarker,
  scriptDir,
  workspaceRoot,
} from './config.js';
import { handleIncomingFile } from './files.js';
import {
  describeCurrent,
  deleteKeyboard,
  fitPreview,
  renderExcerpt,
  renderPreview,
  sessionKeyboard,
  sessionLine,
} from './preview.js';
import { availableProjects, projectList, resolveProject } from './projects.js';
import { cancelRun, isBusy } from './queue.js';
import { summarisePreview } from './runner.js';
import {
  adoptSession,
  entryFor,
  forgetSession,
  resumeFor,
  sessionKeyFor,
} from './sessionStore.js';
import {
  deleteSession,
  formatAge,
  formatSize,
  historyDirFor,
  listSessions,
  previewSession,
  readSession,
} from './sessions.js';
import { PERMISSION_MODES, modeFor, setMode, setTabProject, tabFor } from './tabs.js';
import { enqueueTurn } from './turns.js';
import type { SessionSummary } from './sessions.js';
import type { Tab } from './types.js';

// Shown in Telegram's autocomplete menu when typing "/"
export const BOT_COMMANDS = [
  { command: 'projects', description: 'List available projects' },
  { command: 'project', description: 'Switch project: /project web | manager | nurse' },
  { command: 'status', description: 'Bridge status and current project' },
  { command: 'mode', description: 'Show or set the Claude permission mode' },
  { command: 'sessions', description: 'Pick up a conversation, VS Code ones included' },
  { command: 'delete', description: 'Delete a conversation (asks to confirm)' },
  { command: 'cancel', description: 'Stop the run in flight for this tab' },
  { command: 'clear', description: 'Start a fresh conversation for this project' },
  { command: 'log', description: 'Show the last lines of the bridge log' },
  { command: 'restart', description: 'Restart the bridge (detached mode only)' },
  { command: 'help', description: 'What this bot can do' },
];

bot.start((ctx) => {
  if (!isOwner(ctx)) {
    if (ctx.chat?.type === 'private') ctx.reply('❌ You do not have access to this bot.');
    return;
  }

  const tab = tabFor(ctx);
  ctx.reply(
    '👋 Claude Code Bridge is active!\n\n' +
      'It uses the Claude Code CLI to work with your projects.\n\n' +
      `This tab (${tab.label}) works on: ${tab.project.name}\n\n` +
      'Example commands:\n' +
      '• "add logging to lib/services/auth.dart"\n' +
      '• "which files are in lib/view?"\n' +
      '• "run the tests"\n\n' +
      'Switch projects with /projects and /project <name>\n' +
      'In a group with Topics on, every topic is its own tab: own project,\n' +
      'own conversation, running in parallel with the others.\n\n' +
      '⚡ Works without API keys — uses local authentication'
  );
});

bot.command('help', (ctx) => {
  if (!isOwner(ctx)) return;
  ctx.reply(
    `ℹ️ Send any request as text — this tab (${tabFor(ctx).label}) runs it against ` +
      `${tabFor(ctx).project.name}.\n` +
      'Each forum topic is a separate tab with its own project and conversation.\n\n' +
      'Commands:\n' +
      BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`).join('\n') +
      `\n\nThis tab: ${tabFor(ctx).project.name}`
  );
});

// List discovered projects
bot.command('projects', (ctx) => {
  if (!isOwner(ctx)) return;
  ctx.reply(`📁 Projects in ${workspaceRoot}:\n${projectList(tabFor(ctx).project)}`);
});

// Switch the target project
bot.command('project', (ctx) => {
  if (!isOwner(ctx)) return;

  const query = ctx.message.text.split(/\s+/).slice(1).join(' ');
  if (!query) {
    ctx.reply(
      `📁 This tab (${tabFor(ctx).label}) works on: ${tabFor(ctx).project.name}\n` +
        `${tabFor(ctx).project.path}\n\n` +
        `Usage: /project <name>\n\nAvailable:\n${projectList(tabFor(ctx).project)}`
    );
    return;
  }

  const resolved = resolveProject(query, availableProjects);
  if (!resolved.ok) {
    if (resolved.reason === 'ambiguous') {
      const names = resolved.matches.map((p) => `• ${p.name}`).join('\n');
      ctx.reply(`❓ "${query}" matches several projects:\n${names}`);
    } else if (resolved.reason === 'bad-alias') {
      ctx.reply(`❌ ${resolved.detail}\n\nAvailable:\n${projectList(tabFor(ctx).project)}`);
    } else {
      ctx.reply(
        `❌ No project matches "${query}".\n\nAvailable:\n${projectList(tabFor(ctx).project)}`
      );
    }
    return;
  }

  const tab = tabFor(ctx);
  setTabProject(tab, resolved.project);
  console.log(`\n📁 ${tab.label} switched to ${tab.project.name} (${tab.project.path})`);
  ctx.reply(`✅ This tab now works on ${tab.project.name}\n${tab.project.path}`);
});

// Health check
bot.command('status', (ctx) => {
  if (!isOwner(ctx)) return;
  const tab = tabFor(ctx);
  // entryFor, not resumeFor: a session let go of must show as let go of,
  // rather than as no session at all.
  const entry = entryFor(tab, tab.project);
  const busy = isBusy(tab.project.path) ? ' (a run is in flight)' : '';
  const conversation = entry ? describeCurrent(tab, entry) : 'none yet';
  const mode = modeFor(tab);
  ctx.reply(
    '✅ Bridge is running\n' +
      `🗂 Tab: ${tab.label}${busy}\n` +
      `📁 Project: ${tab.project.name}${tab.implicit ? ' (default — this tab was never set)' : ''}\n` +
      `💬 Conversation: ${conversation}` +
      (mode !== 'default' ? `\n⚙️ Mode: ${mode}` : '')
  );
});

// Last lines of the log, for when the bot goes quiet and the terminal is elsewhere
bot.command('log', async (ctx) => {
  if (!isOwner(ctx)) return;

  const requested = Number(ctx.message.text.split(/\s+/)[1]);
  const lines = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), 100)
    : 25;

  try {
    const content = await readFile(logFile, 'utf8');
    const tail = content.trimEnd().split('\n').slice(-lines).join('\n');
    // Telegram caps a message at 4096 chars; keep the newest end of the tail
    const clipped = tail.length > 3900 ? tail.slice(-3900) : tail;
    await ctx.reply(clipped ? `\`\`\`\n${clipped}\n\`\`\`` : 'Log is empty.', {
      parse_mode: 'Markdown',
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ Could not read ${logFile}: ${errorMsg}`);
  }
});

/**
 * Restart the bridge from the chat, for when the laptop is somewhere else.
 *
 * The restart is handed to a detached Node running `bridge.mjs restart`, which
 * kills this very process, so the command cannot outlive it. The new process
 * reports back by finding the marker file this one leaves behind.
 */
bot.command('restart', async (ctx) => {
  if (!isOwner(ctx)) return;

  const bridgeRoot = resolve(scriptDir, '..');
  const manager = join(bridgeRoot, 'bridge.mjs');
  const pidFile = join(bridgeRoot, 'bridge.pid');

  // Only meaningful in detached mode: under `npm run dev` there is no PID file,
  // so the manager would start a *second* instance and both would fight for the
  // same bot token (Telegram allows one long poll per bot).
  const detachedPid = existsSync(pidFile)
    ? Number(readFileSync(pidFile, 'utf8').trim())
    : undefined;

  if (!existsSync(manager) || detachedPid !== process.pid) {
    await ctx.reply(
      '❌ /restart only works when the bridge runs detached (`npm run bg`).\n' +
        'Right now it is attached to a terminal, so restart it there.'
    );
    return;
  }

  await ctx.reply('♻️ Restarting…');

  try {
    writeFileSync(restartMarker, new Date().toISOString());
  } catch (error) {
    console.warn('⚠️  Could not write the restart marker:', error);
  }

  // A detached Node runs the manager's restart — cross-platform, and it outlives
  // this process (the restart kills it). The short delay lets the reply flush
  // before the kill. `bridge.mjs restart` stops this pid, then starts a new one.
  const child = spawn(
    process.execPath,
    ['-e', `setTimeout(() => require('child_process').spawn(process.execPath, [${JSON.stringify(manager)}, 'restart'], { detached: true, stdio: 'ignore' }).unref(), 800)`],
    { cwd: bridgeRoot, detached: true, stdio: 'ignore' }
  );
  child.unref();
});

/**
 * Picking up a conversation that was started somewhere else.
 *
 * The CLI keeps every session of a project in one directory, keyed by working
 * directory and nothing else, so a conversation from the VS Code extension or a
 * terminal is visible here and can be resumed exactly like the bridge's own.
 *
 * A session touched in the last few minutes is very likely still open in that
 * other window. Taking it is allowed, but only when confirmed — and only then
 * is it branched, so that window keeps what it is in the middle of.
 *
 * One command, not two: the list is a keyboard, so a separate command to adopt
 * by number only duplicated the same state machine behind a second syntax. What
 * it alone could reach — a conversation older than the list — is now `/sessions
 * <text>`, a search over the same titles the buttons carry.
 */

/** Recent conversations of this project, as a list you can tap. */
bot.command('sessions', (ctx) => {
  if (!isOwner(ctx)) return;

  const tab = tabFor(ctx);

  // The argument is a count or a search: "/sessions 20" reaches further back,
  // "/sessions payroll" reaches a conversation by name however old it is. A
  // search is what replaced typing an id, back when adopting one was a command.
  const argument = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  // Number('') is 0, not NaN, so an absent argument has to be ruled out before
  // the count is read — otherwise a bare /sessions asks for a list of one.
  const requested = argument ? Number(argument) : NaN;
  const counting = Number.isFinite(requested);
  const searching = argument.length > 0 && !counting;
  const limit = counting
    ? Math.min(Math.max(requested, 1), SESSION_LIST_MAX)
    : SESSION_LIST_DEFAULT;

  const needle = argument.toLowerCase();
  const sessions = searching
    ? listSessions(tab.project.path, SESSION_SEARCH_DEPTH, SESSION_LIVE_WINDOW_MS)
        .filter(
          (session) =>
            session.title.toLowerCase().includes(needle) || session.id.startsWith(needle)
        )
        .slice(0, SESSION_LIST_MAX)
    : listSessions(tab.project.path, limit, SESSION_LIVE_WINDOW_MS);

  if (sessions.length === 0) {
    ctx.reply(
      searching
        ? `📭 No conversation in ${tab.project.name} matches "${argument}".`
        : `📭 No recorded conversations for ${tab.project.name}.\n` +
            `Looked in ${historyDirFor(tab.project.path)}`
    );
    return;
  }

  const current = entryFor(tab, tab.project);

  // The tab's own conversation can be older than anything the list shows, and
  // then a ▸ in the list marks nothing at all — so it is named in the header,
  // where it is true regardless of how far back the list reaches.
  const now = current ? describeCurrent(tab, current) : 'nothing yet';

  ctx.reply(
    (searching
      ? `💬 Conversations in ${tab.project.name} matching "${argument}"\n`
      : `💬 Recent conversations in ${tab.project.name} — from any window\n`) +
      // The history belongs to the project, not to the tab, so two tabs on one
      // project always list the same conversations. Saying the project was
      // never chosen here is what distinguishes that from a bug.
      (tab.implicit
        ? `⚠️ This tab was never pointed at a project — it is on ${tab.project.name} by default. Use /project <name> to change it.\n`
        : '') +
      `▸ this tab is on: ${now}\n` +
      '🔴 written to just now, so probably still open elsewhere\n\n' +
      sessions.map((session, i) => sessionLine(session, i + 1, current)).join('\n') +
      '\n\nTap one to continue it here — the same conversation, no copy. 👁 reads it first.',
    { reply_markup: sessionKeyboard(sessions, current) }
  );
});

/**
 * The same list as /sessions, but a tap removes a conversation instead of
 * resuming it. It takes the same argument — a count or a search — so a
 * conversation too old for the default list can still be found and deleted.
 */
bot.command('delete', (ctx) => {
  if (!isOwner(ctx)) return;

  const tab = tabFor(ctx);

  const argument = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  const requested = argument ? Number(argument) : NaN;
  const counting = Number.isFinite(requested);
  const searching = argument.length > 0 && !counting;
  const limit = counting
    ? Math.min(Math.max(requested, 1), SESSION_LIST_MAX)
    : SESSION_LIST_DEFAULT;

  const needle = argument.toLowerCase();
  const sessions = searching
    ? listSessions(tab.project.path, SESSION_SEARCH_DEPTH, SESSION_LIVE_WINDOW_MS)
        .filter(
          (session) =>
            session.title.toLowerCase().includes(needle) || session.id.startsWith(needle)
        )
        .slice(0, SESSION_LIST_MAX)
    : listSessions(tab.project.path, limit, SESSION_LIVE_WINDOW_MS);

  if (sessions.length === 0) {
    ctx.reply(
      searching
        ? `📭 No conversation in ${tab.project.name} matches "${argument}".`
        : `📭 No recorded conversations for ${tab.project.name}.\n` +
            `Looked in ${historyDirFor(tab.project.path)}`
    );
    return;
  }

  const current = entryFor(tab, tab.project);
  const now = current ? describeCurrent(tab, current) : 'nothing yet';

  ctx.reply(
    (searching
      ? `🗑️ Delete a conversation in ${tab.project.name} matching "${argument}"\n`
      : `🗑️ Delete a conversation in ${tab.project.name} — from any window\n`) +
      (tab.implicit
        ? `⚠️ This tab was never pointed at a project — it is on ${tab.project.name} by default. Use /project <name> to change it.\n`
        : '') +
      `▸ this tab is on: ${now}\n` +
      '🔴 written to just now, so probably still open elsewhere\n\n' +
      sessions.map((session, i) => sessionLine(session, i + 1, current)).join('\n') +
      '\n\nTap one to delete it — you will be asked to confirm. 👁 reads it first.',
    { reply_markup: deleteKeyboard(sessions, current) }
  );
});

/** Adopt the session behind a pressed button, and say what that means. */
export function adoptAndReport(
  ctx: Context,
  tab: Tab,
  session: SessionSummary,
  fork: boolean
): void {
  adoptSession(sessionKeyFor(tab, tab.project), session.id, session.title, fork);
  console.log(`↪️  ${tab.label} adopted ${session.id}${fork ? ' (as a fork)' : ''}`);

  // No slash-command names in bot text: Telegram turns them into tappable
  // commands, and a tap on one this bot does not have goes nowhere.
  const note = fork
    ? `It branches first, because that conversation is open elsewhere: this tab gets a copy ` +
      `named "📱 ${session.title}" and the original is left as it is.`
    : 'This is the same conversation, continued — no copy is made.';

  ctx.reply(
    `✅ Now continuing: ${session.title}\n` +
      `${session.id.slice(0, 8)}… · ${formatAge(session.modifiedAt)} · ${formatSize(session.bytes)}\n\n` +
      'Just write — the next message picks up where it left off.\n' +
      `${note} Loading ${formatSize(session.bytes)} makes that first reply slower than usual.`
  );
}

bot.action(/^r(f?):([0-9a-fA-F-]{36})$/, async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Not your bot');
    return;
  }

  const forced = ctx.match[1] === 'f';
  const id = ctx.match[2];
  const tab = tabFor(ctx);

  // Re-read rather than trust the listing: the button may be minutes old, and
  // whether the session is live now is exactly what decides the next step.
  const session = readSession(tab.project.path, id, SESSION_LIVE_WINDOW_MS);
  if (!session) {
    await ctx.answerCbQuery('That conversation is no longer in the history', {
      show_alert: true,
    });
    return;
  }

  if (session.live && !forced) {
    await ctx.answerCbQuery();
    await ctx.reply(
      `⚠️ ${session.title}\nwas written to ${formatAge(session.modifiedAt)} — it is probably ` +
        'open in another window right now. Taking it anyway branches it, so that window ' +
        'keeps the conversation it is in the middle of and this tab gets its own copy.',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🍴 Continue it anyway', callback_data: `rf:${session.id}` },
              { text: '✖️ Cancel', callback_data: 'rx' },
            ],
          ],
        },
      }
    );
    return;
  }

  // Only the confirmed "take it anyway" path forks: a session being written to
  // right now is the one case where continuing it in place costs the other
  // window its work. Everything else is a plain continuation.
  await ctx.answerCbQuery('✅ Adopted');
  adoptAndReport(ctx, tab, session, forced && session.live);
});

/**
 * Reading a conversation before picking it up.
 *
 * The summary is the preview and the raw turns are a footnote under it: the
 * lines say what was happening, the summary says what it was for and where it
 * stopped, and that is what decides whether this is the conversation you want.
 */
bot.action(/^p:([0-9a-fA-F-]{36})$/, async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Not your bot');
    return;
  }

  const id = ctx.match[1];
  const tab = tabFor(ctx);
  const session = readSession(tab.project.path, id, SESSION_LIVE_WINDOW_MS);
  if (!session) {
    await ctx.answerCbQuery('That conversation is no longer in the history', {
      show_alert: true,
    });
    return;
  }

  // Read wide, then split: the summariser gets the working detail, the screen
  // gets the conversation. Tool calls are what a run did, not what was said.
  const scanned = previewSession(tab.project.path, id, PREVIEW_SCAN_ENTRIES) ?? [];
  const entries = scanned.slice(-PREVIEW_ENTRIES);
  const spoken = scanned.filter((entry) => entry.kind !== 'tool');
  await ctx.answerCbQuery();

  const header =
    `👁 ${session.title}\n` +
    `${formatAge(session.modifiedAt)} · ${formatSize(session.bytes)}` +
    `${session.gitBranch ? ` · ${session.gitBranch}` : ''}${session.live ? ' · 🔴 open elsewhere' : ''}`;

  const tail = renderPreview(spoken, PREVIEW_SHOWN_LINES, PREVIEW_SHOWN_CHARS);
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🍴 Continue it here', callback_data: `r:${session.id}` },
        { text: '✖️ Close', callback_data: 'rx' },
      ],
    ],
  };

  // Plain text, deliberately: a transcript is full of asterisks, underscores and
  // half-finished code fences, and Telegram rejects the whole message over one
  // of them. The preview is worth more unformatted than not at all.
  const sent = await ctx.reply(
    entries.length
      ? fitPreview(header, 'summarising…', tail)
      : `${header}\n\n(nothing recorded yet)`,
    { reply_markup: keyboard }
  );

  if (!entries.length) return;

  // The tail is already on screen; the summary lands in the same message a few
  // seconds later rather than holding the preview back. Without one, the
  // messages are all there is to go on, so more of them come back — still
  // messages, since a page of `Bash:` lines is not what was being discussed.
  const withoutSummary = () =>
    fitPreview(
      header,
      undefined,
      renderPreview(spoken, PREVIEW_FALLBACK_LINES, PREVIEW_FALLBACK_CHARS)
    );

  let text: string;
  try {
    const summary = await summarisePreview(renderExcerpt(entries), tab.project);
    text = summary ? fitPreview(header, summary, tail) : withoutSummary();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️  Could not summarise ${id.slice(0, 8)}…:`, errorMsg);
    text = withoutSummary();
  }

  await ctx.telegram
    .editMessageText(ctx.chat!.id, sent.message_id, undefined, text, {
      reply_markup: keyboard,
    })
    .catch((error) => console.warn('⚠️  Could not update the preview:', error.message));
});

// "Cancel" on the still-open warning, "Close" on a preview: off the screen
// The ➕ button on a /sessions list: put this tab on a clean conversation, so
// the next message starts one instead of resuming anything.
bot.action('rn', async (ctx) => {
  if (!isOwner(ctx)) return;
  const tab = tabFor(ctx);
  forgetSession(sessionKeyFor(tab, tab.project));
  await ctx.answerCbQuery('✅ New conversation');
  await ctx.reply(
    `🗑️ This tab is on a new conversation for ${tab.project.name} — just write to start it.`
  );
});

bot.action('rx', async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.answerCbQuery('Cancelled');
  await ctx.deleteMessage().catch(() => {});
});

/**
 * A tap on a /delete row: confirm before anything is removed.
 *
 * The session is re-read rather than trusted from the button, because whether it
 * is live now — and whether this tab is the one on it — is what the confirmation
 * needs to warn about, and the button may be minutes old.
 */
bot.action(/^d:([0-9a-fA-F-]{36})$/, async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Not your bot');
    return;
  }

  const id = ctx.match[1];
  const tab = tabFor(ctx);

  const session = readSession(tab.project.path, id, SESSION_LIVE_WINDOW_MS);
  if (!session) {
    await ctx.answerCbQuery('That conversation is no longer in the history', {
      show_alert: true,
    });
    return;
  }

  const current = entryFor(tab, tab.project);
  const wasCurrent = current?.id === id;
  await ctx.answerCbQuery();

  await ctx.reply(
    `🗑️ Delete this conversation?\n${session.title}\n` +
      `${id.slice(0, 8)}… · ${formatAge(session.modifiedAt)} · ${formatSize(session.bytes)}\n\n` +
      (session.live
        ? '🔴 It was written to just now — it may be open in another window right now.\n'
        : '') +
      (wasCurrent ? '▸ This tab is on it; deleting starts a new conversation here.\n' : '') +
      'The transcript file is removed for good — this cannot be undone.',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🗑️ Delete permanently', callback_data: `dc:${id}` },
            { text: '✖️ Cancel', callback_data: 'rx' },
          ],
        ],
      },
    }
  );
});

/** The confirmed delete: remove the transcript, and let go of it if this tab was on it. */
bot.action(/^dc:([0-9a-fA-F-]{36})$/, async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Not your bot');
    return;
  }

  const id = ctx.match[1];
  const tab = tabFor(ctx);

  const session = readSession(tab.project.path, id, SESSION_LIVE_WINDOW_MS);
  if (!session) {
    await ctx.answerCbQuery('That conversation is already gone', { show_alert: true });
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  const current = entryFor(tab, tab.project);
  const wasCurrent = current?.id === id;

  if (!deleteSession(tab.project.path, id)) {
    await ctx.answerCbQuery('Could not delete it', { show_alert: true });
    return;
  }

  // A tab still resuming a deleted transcript would fail on its next message, so
  // it is let go of here — the same clean-slate state a fresh conversation has.
  if (wasCurrent) forgetSession(sessionKeyFor(tab, tab.project));
  console.log(`🗑️  ${tab.label} deleted ${id}`);

  await ctx.answerCbQuery('🗑️ Deleted');
  await ctx
    .editMessageText(
      `🗑️ Deleted: ${session.title}\n${id.slice(0, 8)}… · ${formatSize(session.bytes)}` +
        (wasCurrent
          ? '\n\nThis tab was on it — it is now on a new conversation.'
          : '')
    )
    .catch(() => {});
});

// Start a fresh conversation for the current project — the old session stays on
// disk in the CLI's own history, it just stops being resumed here.
bot.command('mode', (ctx) => {
  if (!isOwner(ctx)) return;
  const tab = tabFor(ctx);
  const wanted = ctx.message.text.split(/\s+/)[1]?.trim();

  if (!wanted) {
    ctx.reply(
      `⚙️ Permission mode for ${tab.project.name} (this tab): ${modeFor(tab)}\n\n` +
        `Set it with /mode <${PERMISSION_MODES.join(' | ')}>.\n` +
        '• default — ask as usual\n' +
        '• plan — think through a plan without making changes\n' +
        '• acceptEdits — apply edits without asking\n' +
        '• bypassPermissions — run everything unprompted (use with care)'
    );
    return;
  }

  const match = PERMISSION_MODES.find((m) => m.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    ctx.reply(`❌ Unknown mode "${wanted}". Pick one of: ${PERMISSION_MODES.join(', ')}.`);
    return;
  }

  setMode(tab, match);
  console.log(`⚙️  ${tab.label} set permission mode ${match}`);
  ctx.reply(`⚙️ This tab now runs in ${match} mode. It applies from your next message.`);
});

bot.command('cancel', (ctx) => {
  if (!isOwner(ctx)) return;
  const tab = tabFor(ctx);
  if (cancelRun(tab.project.path)) {
    console.log(`🛑 ${tab.label} requested cancel on ${tab.project.name}`);
    ctx.reply(`🛑 Stopping the run on ${tab.project.name}…`);
  } else {
    ctx.reply(`Nothing is running on ${tab.project.name} right now.`);
  }
});

bot.command('clear', (ctx) => {
  if (!isOwner(ctx)) return;
  const tab = tabFor(ctx);
  const had = resumeFor(tab, tab.project) !== undefined;
  forgetSession(sessionKeyFor(tab, tab.project));
  ctx.reply(
    had
      ? `🗑️ Started a new conversation for ${tab.project.name} in this tab`
      : `🗑️ This tab had no conversation for ${tab.project.name} to clear`
  );
});

bot.on(message('photo'), async (ctx) => {
  if (!isOwner(ctx)) return;

  // Telegram sends several sizes; the last one is the largest
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  await handleIncomingFile(
    ctx,
    photo.file_id,
    'screenshot.jpg',
    photo.file_size,
    ctx.message.caption,
    'image'
  );
});

bot.on(message('document'), async (ctx) => {
  if (!isOwner(ctx)) return;

  const document = ctx.message.document;
  const isImage = document.mime_type?.startsWith('image/') ?? false;
  await handleIncomingFile(
    ctx,
    document.file_id,
    document.file_name || 'attachment',
    document.file_size,
    ctx.message.caption,
    isImage ? 'image' : 'file'
  );
});

bot.on(message('text'), async (ctx) => {
  if (!isOwner(ctx)) {
    if (ctx.chat?.type === 'private') ctx.reply('❌ Access denied.');
    return;
  }

  // Commands are handled by their own handlers above
  if (ctx.message.text.startsWith('/')) return;

  const tab = tabFor(ctx);
  const queued = enqueueTurn(ctx, ctx.message.text, tab);

  if (queued) {
    await ctx.reply(
      `⏳ ${tab.project.name} is still working on an earlier request — this one is queued.`
    );
  }
});

// Last resort: an error escaping a handler must not take the bridge down with it.

/**
 * Register the command menu so Telegram autocompletes them after "/".
 *
 * Narrower scopes win, and another tool may own the bot's `all_private_chats` list, so the
 * chat scope is what actually makes the menu visible here; `default` is a harmless fallback.
 */
export async function registerCommandMenu(): Promise<void> {
  await bot.telegram.setMyCommands(BOT_COMMANDS, {
    scope: { type: 'chat', chat_id: ownerChatId },
  });
  await bot.telegram.setMyCommands(BOT_COMMANDS);
}


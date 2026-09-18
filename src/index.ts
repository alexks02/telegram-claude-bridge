/**
 * Starting the bridge.
 *
 * The whole of it used to live in this file — 2200 lines of settings, state,
 * rendering and handlers in one scroll. What is left here is the startup
 * sequence, in the order it happens; everything else is a module named after
 * the one thing it owns.
 */

import './log.js';
import { existsSync, rmSync } from 'fs';
import { bot } from './bot.js';
import { BOT_COMMANDS, registerCommandMenu } from './commands.js';
import {
  claudeCli,
  ownerChatId,
  ownerId,
  restartMarker,
  stateFile,
  workspaceRoot,
} from './config.js';
import { pruneInbox } from './files.js';
import { defaultProject, projectList } from './projects.js';
import { parkStaleSessions, sessionIds } from './sessionStore.js';
import { tabProjects } from './tabs.js';

// Last resort: an error escaping a handler must not take the bridge down with it.
bot.catch((error, ctx) => {
  const errorMsg = error instanceof Error ? error.message : String(error);
  console.error(`❌ Unhandled error on ${ctx.updateType}:`, errorMsg);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled rejection:', reason);
});

registerCommandMenu().catch((error) =>
  console.warn('⚠️  Could not register command menu:', error.message)
);

pruneInbox();
parkStaleSessions();
bot.launch();

// A restart asked for from the chat gets an answer from the process that came up
if (existsSync(restartMarker)) {
  try {
    rmSync(restartMarker);
  } catch {
    // Losing the marker is harmless; worst case the next start reports again
  }
  bot.telegram
    .sendMessage(ownerChatId, '✅ Bridge restarted and back online')
    .then(() => console.log('♻️  Restart confirmed in the chat'))
    .catch((error) => console.warn('⚠️  Could not confirm the restart:', error.message));
}

console.log('🚀 Claude Code Telegram Bridge started');
console.log(`📱 Owner: ${ownerId} (chat ${ownerChatId})`);
console.log(`🗂️  Workspace: ${workspaceRoot}`);
console.log(`📁 Default project: ${defaultProject.name} (${defaultProject.path})`);
console.log(`🗂 Tabs remembered: ${tabProjects.size}`);
console.log(`🔧 Claude CLI: ${claudeCli}`);
console.log(`💬 State: ${stateFile} (${sessionIds.size} session(s))`);
console.log(`\nDiscovered projects:\n${projectList(defaultProject)}`);
console.log('\nCommands:');
for (const { command, description } of BOT_COMMANDS) {
  console.log(`  /${command} - ${description}`);
}
console.log('');

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

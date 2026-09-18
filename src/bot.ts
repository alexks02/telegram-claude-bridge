/** The Telegraf instance and the one question every handler asks first. */

import { Context, Telegraf } from 'telegraf';
import { botToken, ownerId } from './config.js';

// Telegraf times handlers out after 90s by default and throws, which kills the
// process. A Claude run can legitimately take minutes, so we drop that watchdog
// and enforce our own timeout on the CLI instead.
export const bot = new Telegraf(botToken, { handlerTimeout: Infinity });

/** Everything the bot does is gated on this: the message came from the owner. */
export function isOwner(ctx: Context): boolean {
  return ctx.from?.id === ownerId;
}

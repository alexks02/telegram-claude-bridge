/**
 * What the last Claude run in each tab cost — diagnostic only, not persisted.
 *
 * Resuming a session resends its whole history every time, so cost per turn
 * grows with how long a conversation has run. There was no way to see that
 * from the bridge; this is just enough to show in /status so a pricey tab is
 * visible before it burns through the rate limit, rather than after.
 */

import type { RunUsage } from './types.js';

const lastUsage = new Map<string, RunUsage>();

export function recordUsage(tabKey: string, usage: RunUsage): void {
  lastUsage.set(tabKey, usage);
}

export function usageFor(tabKey: string): RunUsage | undefined {
  return lastUsage.get(tabKey);
}

export function formatUsage(usage: RunUsage): string {
  const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const seconds = (usage.durationMs / 1000).toFixed(1);
  return (
    `💰 Last turn: $${usage.costUsd.toFixed(4)} · ${seconds}s\n` +
    `   in ${totalInput} (${usage.cacheReadTokens} cached) / out ${usage.outputTokens} tokens`
  );
}

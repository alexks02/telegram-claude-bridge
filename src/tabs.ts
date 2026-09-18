/**
 * A "tab" is one Telegram forum topic — or the private chat, which is one tab.
 *
 * Each tab keeps its own selected project and its own conversation, so two
 * topics are two independent workstreams the way two Claude Code tabs are.
 */

import { existsSync } from 'fs';
import { Context } from 'telegraf';
import { ownerChatId } from './config.js';
import { availableProjects, defaultProject } from './projects.js';
import { patchModels, patchModes, patchTabs, readState } from './state.js';
import type { Project, Tab } from './types.js';

export const tabs = new Map<string, Tab>();

export const tabProjects = new Map<string, string>(loadTabs());

export function loadTabs(): [string, string][] {
  return Object.entries(readState().tabs);
}

export function persistTabs(): void {
  try {
    patchTabs(Object.fromEntries(tabProjects));
  } catch (error) {
    console.warn('⚠️  Could not persist tab state:', error);
  }
}

export function tabFor(ctx: Context): Tab {
  const chat = ctx.chat?.id ?? ownerChatId;
  // A button press carries no message of its own — the topic it belongs to is
  // the one the message holding the button was posted in.
  const source = ctx.message ?? ctx.callbackQuery?.message;
  const thread =
    source && 'message_thread_id' in source
      ? (source.message_thread_id as number | undefined)
      : undefined;

  const key = `${chat}:${thread ?? 0}`;
  const existing = tabs.get(key);
  if (existing) return existing;

  const storedPath = tabProjects.get(key);
  const project =
    (storedPath && availableProjects.find((p) => p.path === storedPath)) ||
    (storedPath && existsSync(storedPath)
      ? { name: storedPath.split('/').pop()!, path: storedPath }
      : undefined) ||
    defaultProject;

  // A remembered project that no longer exists — renamed, moved, unmounted —
  // falls back to the default, which otherwise happens silently and looks like
  // the tab forgetting its setting. The entry is kept: if the directory comes
  // back, so does the tab, without anyone having to set it again.
  if (storedPath && project === defaultProject && storedPath !== defaultProject.path) {
    console.warn(
      `⚠️  ${key} is remembered as ${storedPath}, which is not there — ` +
        `falling back to ${defaultProject.name}`
    );
  }

  const tab: Tab = {
    key,
    label: thread ? `topic ${thread}` : 'main',
    project,
    implicit: !storedPath,
  };
  tabs.set(key, tab);
  return tab;
}

export function setTabProject(tab: Tab, project: Project): void {
  tab.project = project;
  tab.implicit = false;
  tabProjects.set(tab.key, project.path);
  persistTabs();
}

/** Rebuild the tab a stored session belongs to, for timers set before any message. */
export function tabFromKey(tabKey: string, projectPath: string): Tab {
  const existing = tabs.get(tabKey);
  if (existing) return existing;

  const project =
    availableProjects.find((p) => p.path === projectPath) ||
    ({ name: projectPath.split('/').pop()!, path: projectPath } as Project);
  const thread = Number(tabKey.split(':')[1] || 0);
  const tab: Tab = {
    key: tabKey,
    label: thread ? `topic ${thread}` : 'main',
    project,
    implicit: false,
  };
  tabs.set(tabKey, tab);
  return tab;
}

/**
 * A tab's Claude permission mode, and where it is stored.
 *
 * Per tab, not per project — a permission style is how you want to work in that
 * workstream, not a property of the repository. An empty string means the CLI's
 * own default. Valid values are the CLI's: default | plan | acceptEdits |
 * bypassPermissions.
 */
export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const;

export function modeFor(tab: Tab): string {
  return readState().modes[tab.key] || 'default';
}

export function setMode(tab: Tab, mode: string): void {
  const modes = readState().modes;
  if (mode === 'default') delete modes[tab.key];
  else modes[tab.key] = mode;
  patchModes(modes);
}

/**
 * A tab's Claude model, and where it is stored.
 *
 * Per tab, like the permission mode — a working choice, not a repo property.
 * "default" (empty) leaves the CLI to pick; the others are the CLI's own model
 * aliases, passed through with --model.
 */
export const MODELS = ['default', 'sonnet', 'opus', 'haiku'] as const;

export function modelFor(tab: Tab): string {
  return readState().models[tab.key] || 'default';
}

export function setModel(tab: Tab, model: string): void {
  const models = readState().models;
  if (model === 'default') delete models[tab.key];
  else models[tab.key] = model;
  patchModels(models);
}

/** Which repositories the bridge can work in, and how a typed name finds one. */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { aliasSpec, hostProject, workspaceRoot } from './config.js';
import type { Project } from './types.js';

/** Every direct subdirectory of the workspace root that is a git repository. */
export function discoverProjects(): Project[] {
  return readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(workspaceRoot, entry.name) }))
    .filter((project) => existsSync(join(project.path, '.git')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Short names that win over directory-name matching — e.g. "web" can select a
 * repo whose directory name it is only a substring of. They come entirely from
 * the ALIASES setting; there are no built-in ones, so the bridge carries no
 * assumptions about which repositories it sits next to.
 */
export function parseAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const pair of aliasSpec.split(',')) {
    const [alias, target] = pair.split(':').map((part) => part?.trim());
    if (alias && target) aliases[alias.toLowerCase()] = target;
  }
  return aliases;
}

export const aliases = parseAliases();

export type Resolution =
  | { ok: true; project: Project }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'bad-alias'; matches: Project[]; detail?: string };

/**
 * Match a user-typed name against discovered projects: aliases first, then the exact
 * directory name, then a case-insensitive substring.
 */
export function resolveProject(query: string, projects: Project[]): Resolution {
  const needle = query.trim().toLowerCase();
  if (!needle) return { ok: false, reason: 'not-found', matches: [] };

  const aliasTarget = aliases[needle];
  if (aliasTarget) {
    const target = projects.find((p) => p.name.toLowerCase() === aliasTarget.toLowerCase());
    if (target) return { ok: true, project: target };
    return {
      ok: false,
      reason: 'bad-alias',
      matches: [],
      detail: `alias "${needle}" points at "${aliasTarget}", which is not in the workspace`,
    };
  }

  const exact = projects.find((p) => p.name.toLowerCase() === needle);
  if (exact) return { ok: true, project: exact };

  const partial = projects.filter((p) => p.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, project: partial[0] };
  if (partial.length > 1) return { ok: false, reason: 'ambiguous', matches: partial };
  return { ok: false, reason: 'not-found', matches: [] };
}

/** Aliases pointing at a project, for display next to its name. */
export function aliasesFor(project: Project): string[] {
  return Object.entries(aliases)
    .filter(([, target]) => target.toLowerCase() === project.name.toLowerCase())
    .map(([alias]) => alias);
}

/** Startup default: the DEFAULT_PROJECT alias, else the project hosting this bridge. */
export function pickDefaultProject(projects: Project[]): Project {
  const alias = process.env.DEFAULT_PROJECT;
  if (alias) {
    const resolved = resolveProject(alias, projects);
    if (resolved.ok) return resolved.project;
    console.warn(
      `⚠️  DEFAULT_PROJECT="${alias}" did not match a project (${resolved.reason}), ignoring it`
    );
  }

  // Nested install: default to the project the bridge lives in, when it is one of them.
  const host = projects.find((p) => p.path === hostProject);
  if (host) return host;

  // Standalone: no natural home, so start on the first discovered project.
  return projects[0];
}

export const availableProjects = discoverProjects();
if (availableProjects.length === 0) {
  console.error(
    `❌ No git repositories found under WORKSPACE_ROOT=${workspaceRoot}\n` +
      '   Every direct subdirectory with a .git is a project; there are none here.\n' +
      '   Point WORKSPACE_ROOT at the folder that holds your repositories and restart.'
  );
  process.exit(1);
}
export const defaultProject = pickDefaultProject(availableProjects);

export function projectList(current?: Project): string {
  if (availableProjects.length === 0) return `  (none found under ${workspaceRoot})`;
  return availableProjects
    .map((p) => {
      const marker = current && p.path === current.path ? '▸' : ' ';
      const shortNames = aliasesFor(p);
      const suffix = shortNames.length ? `  (${shortNames.join(', ')})` : '';
      return `${marker} ${p.name}${suffix}`;
    })
    .join('\n');
}

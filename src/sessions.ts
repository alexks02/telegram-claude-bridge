/**
 * Reading the Claude CLI's own session history.
 *
 * Every conversation the CLI has ever had — from a terminal, from the VS Code
 * extension, or from this bridge — is a JSONL transcript under
 * `~/.claude/projects/<slug>/<session-id>.jsonl`, where the slug is derived from
 * the working directory alone. Nothing records *who* started a session, which is
 * exactly why the bridge can pick one up: a session id from the IDE resumes the
 * same way its own do.
 *
 * Transcripts get large (tens of megabytes), so only the head of each file is
 * read — the metadata and the first human prompt live in the first few lines.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Enough for the leading metadata and the first prompt, never the whole file. */
const HEAD_BYTES = 256 * 1024;

/** Enough for the last few turns, however long the conversation was. */
const TAIL_BYTES = 256 * 1024;

const projectsDir =
  process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');

export interface SessionSummary {
  id: string;
  file: string;
  /** The CLI's own title for the conversation, or the first human prompt. */
  title: string;
  /** "claude-vscode", "cli", … — whatever wrote the first line. */
  entrypoint: string;
  gitBranch?: string;
  modifiedAt: number;
  bytes: number;
  /** Touched so recently that something is probably still writing to it. */
  live: boolean;
}

/**
 * The CLI's directory name for a project: every character that is not a letter,
 * a digit or an underscore becomes a dash, so `/Users/you/code/my-app`
 * becomes `-Users-you-code-my-app`.
 */
export function historyDirFor(projectPath: string): string {
  return join(projectsDir, projectPath.replace(/[^a-zA-Z0-9_]/g, '-'));
}

/** Sessions for one project, newest first. */
export function listSessions(
  projectPath: string,
  limit: number,
  liveWindowMs: number
): SessionSummary[] {
  const dir = historyDirFor(projectPath);

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return []; // No history for this project yet
  }

  const now = Date.now();
  return entries
    .map((name) => {
      const file = join(dir, name);
      const stats = statSync(file);
      return { file, id: name.slice(0, -'.jsonl'.length), stats };
    })
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
    .slice(0, limit)
    .map(({ file, id, stats }) => ({
      id,
      file,
      ...describe(file),
      modifiedAt: stats.mtimeMs,
      bytes: stats.size,
      live: now - stats.mtimeMs < liveWindowMs,
    }));
}

/** One known session, read straight from its own file. */
export function readSession(
  projectPath: string,
  id: string,
  liveWindowMs = 0
): SessionSummary | undefined {
  const file = join(historyDirFor(projectPath), `${id}.jsonl`);

  let stats;
  try {
    stats = statSync(file);
  } catch {
    return undefined; // Cleared history, or a session from another machine
  }

  return {
    id,
    file,
    ...describe(file),
    modifiedAt: stats.mtimeMs,
    bytes: stats.size,
    live: Date.now() - stats.mtimeMs < liveWindowMs,
  };
}


/**
 * Remove a conversation's transcript from the CLI's history for good.
 *
 * There is nothing else to clean up: a session is just its `.jsonl` file, keyed
 * by working directory, so unlinking it is the whole deletion. Returns whether
 * the file was actually there to remove.
 */
export function deleteSession(projectPath: string, id: string): boolean {
  const file = join(historyDirFor(projectPath), `${id}.jsonl`);
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}


/**
 * The CLI names a conversation itself and writes the name into the transcript as
 * an `ai-title` row, within the first couple of dozen lines — the same name its
 * own `/resume` picker shows. A name given with `-n` lands as `custom-title` and
 * wins, which is how the bridge's forks stay distinguishable from the
 * conversations they were forked from.
 */
function describe(file: string): Pick<SessionSummary, 'title' | 'entrypoint' | 'gitBranch'> {
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let summary: string | undefined;
  let prompt: string | undefined;
  let entrypoint = 'cli';
  let gitBranch: string | undefined;

  for (const line of readHead(file).split('\n')) {
    if (!line.trim()) continue;

    let row: Record<string, any>;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // The head can end mid-line, and a torn line is not worth a failure
    }

    // Last one wins: a retitled conversation writes another row
    if (row.type === 'custom-title' && typeof row.customTitle === 'string') {
      customTitle = row.customTitle;
    }
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string') aiTitle = row.aiTitle;
    if (row.type === 'summary' && typeof row.summary === 'string') summary ??= row.summary;
    if (typeof row.entrypoint === 'string') entrypoint = row.entrypoint;
    if (typeof row.gitBranch === 'string') gitBranch ??= row.gitBranch;

    if (!prompt && row.type === 'user' && !row.isSidechain) prompt = promptText(row.message);
  }

  return {
    title: clip(customTitle || aiTitle || summary || prompt || '(no prompt recorded)'),
    entrypoint,
    gitBranch,
  };
}

/**
 * The human's own words, skipping what the harness injected around them.
 *
 * A user row carries tool results and machine-generated context — IDE file
 * notices, system reminders, slash-command wrappers — all of which are text
 * blocks opening with a tag, so the first untagged block is the actual question.
 */
function promptText(message: Record<string, any> | undefined): string | undefined {
  const content = message?.content;
  const blocks =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content
        : [];

  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const text = block.text.trim();
    if (!text || text.startsWith('<') || text.startsWith('[Request interrupted')) continue;
    return text;
  }
  return undefined;
}

/**
 * What a conversation was last doing, for deciding whether to pick it up.
 *
 * Read from the *end* of the transcript: the head answers what a session is
 * called, but where it got to is the last thing in a file that can be fifty
 * megabytes long, so only the tail is touched. The first line of that tail is
 * almost certainly torn in half and is dropped.
 *
 * Rows are returned as data, not as text — the caller already has the tool-call
 * formatting the live progress feed uses, and a preview that reads like that
 * feed is one less thing to learn.
 */
export interface PreviewEntry {
  kind: 'user' | 'assistant' | 'tool';
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
}

export function previewSession(
  projectPath: string,
  id: string,
  limit: number
): PreviewEntry[] | undefined {
  const file = join(historyDirFor(projectPath), `${id}.jsonl`);
  if (!existsSync(file)) return undefined;

  const entries: PreviewEntry[] = [];

  for (const line of readTail(file, TAIL_BYTES).split('\n').slice(1)) {
    if (!line.trim()) continue;

    let row: Record<string, any>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    // A subagent's own conversation is noise in a preview of the main one
    if (row.isSidechain) continue;

    if (row.type === 'user') {
      const text = promptText(row.message);
      if (text) entries.push({ kind: 'user', text });
      continue;
    }

    if (row.type !== 'assistant') continue;

    for (const block of row.message?.content ?? []) {
      if (block?.type === 'text' && block.text?.trim()) {
        entries.push({ kind: 'assistant', text: block.text.trim() });
      } else if (block?.type === 'tool_use') {
        entries.push({ kind: 'tool', tool: block.name, input: block.input });
      }
    }
  }

  return entries.slice(-limit);
}

function readTail(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

export function formatAge(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(Math.round(bytes / 1024), 1)} KB`;
}

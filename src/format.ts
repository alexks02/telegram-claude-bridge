/**
 * Formatting for the live progress feed.
 *
 * Every line competes for one Telegram message, so each has a character budget —
 * but a naive cut is worse than useless: the informative half of a file path is
 * its tail, and the informative half of a shell command hides behind a `cd`.
 */

/** Cut at a word boundary when there is one nearby, so lines end readably. */
export function clip(text: string, budget: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= budget) return flat;

  const hard = flat.slice(0, budget - 1);
  const lastSpace = hard.lastIndexOf(' ');
  const cut = lastSpace > budget * 0.6 ? hard.slice(0, lastSpace) : hard;
  return `${cut.trimEnd()}…`;
}

/**
 * Shorten a path from the middle, keeping the file name intact.
 *
 * `/Users/you/code/repo/tests/admin/timecards/common/filter-by-activity.spec.ts`
 * becomes `repo/…/common/filter-by-activity.spec.ts` — the repository and the
 * file survive, the middle is what you can afford to lose.
 */
export function shortenPath(path: string, budget: number, workspaceRoot?: string): string {
  let rel = path;
  if (workspaceRoot && rel.startsWith(`${workspaceRoot}/`)) {
    rel = rel.slice(workspaceRoot.length + 1);
  }
  if (rel.length <= budget) return rel;

  const parts = rel.split('/').filter(Boolean);
  const file = parts.pop() ?? rel;

  // Drop middle segments one by one, keeping the first (repo) and the last dir
  for (let keepTail = 2; keepTail >= 1; keepTail--) {
    if (parts.length <= keepTail) break;
    const head = parts[0];
    const tail = parts.slice(-keepTail);
    const candidate = [head, '…', ...tail, file].join('/');
    if (candidate.length <= budget) return candidate;
  }

  const bare = `…/${file}`;
  if (bare.length <= budget) return bare;

  // Even the file name alone is too long: keep its end, extension included
  return `…${file.slice(-(budget - 1))}`;
}

/**
 * Strip the noise a shell command carries into a one-line summary: the leading
 * `cd <somewhere> &&` that every command repeats, and collapsed whitespace.
 */
export function shortenCommand(command: string, budget: number): string {
  const stripped = command
    .replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(stripped || command, budget);
}

/** Assistant text for the feed: no markdown markers, no line breaks. */
export function plainLine(text: string, budget: number): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\s+/g, ' ');
  return clip(flat, budget);
}

/** The only three characters Telegram's HTML mode cares about. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert Claude's markdown to the HTML subset Telegram accepts.
 *
 * Telegram's legacy Markdown parses the *model's* text, so a single stray `*` or
 * the underscores in `filter_timecards_by_activity.spec.ts` make it reject the
 * whole message — and the reply then arrives as plain text, losing the syntax
 * highlighting exactly where code matters most. Here the text is escaped first
 * and every tag is one we emit ourselves, so there is nothing left to misparse.
 *
 * Only unambiguous markup is translated. Single `*` and `_` emphasis is left as
 * literal text on purpose: in this codebase they appear inside globs, snake_case
 * identifiers and shell flags far more often than as italics.
 */
export function toTelegramHtml(markdown: string): string {
  const fence = /```([\w+-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let html = '';
  let last = 0;

  for (const match of markdown.matchAll(fence)) {
    html += inlineHtml(markdown.slice(last, match.index));

    const language = match[1]?.trim();
    const body = escapeHtml(match[2].replace(/\s+$/, ''));
    html += language
      ? `<pre><code class="language-${language}">${body}</code></pre>`
      : `<pre>${body}</pre>`;

    last = (match.index ?? 0) + match[0].length;
  }

  return html + inlineHtml(markdown.slice(last));
}

/** Prose between code fences: escape, then translate the safe markers. */
function inlineHtml(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_, bold) => `<b>${bold}</b>`)
    .replace(/^#{1,6}[ \t]+(.+)$/gm, (_, heading) => `<b>${heading}</b>`)
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, label, href) => `<a href="${href}">${label}</a>`
    );
}

/** One readable line describing a tool call. */
export function describeToolCall(
  name: string,
  input: unknown,
  budget: number,
  workspaceRoot?: string
): string {
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const command = typeof fields.command === 'string' ? fields.command : undefined;
  if (command) return `${name}: ${shortenCommand(command, budget)}`;

  const path =
    typeof fields.file_path === 'string'
      ? fields.file_path
      : typeof fields.path === 'string'
        ? fields.path
        : typeof fields.notebook_path === 'string'
          ? fields.notebook_path
          : undefined;
  if (path) return `${name}: ${shortenPath(path, budget, workspaceRoot)}`;

  const query =
    typeof fields.pattern === 'string'
      ? fields.pattern
      : typeof fields.query === 'string'
        ? fields.query
        : typeof fields.url === 'string'
          ? fields.url
          : typeof fields.prompt === 'string'
            ? fields.prompt
            : undefined;
  if (query) return `${name}: ${clip(query, budget)}`;

  const keys = Object.keys(fields);
  return keys.length ? `${name}: ${clip(JSON.stringify(fields), budget)}` : name;
}

export interface Attachment {
  path: string;
  caption?: string;
}

/**
 * Pull `SEND:` lines out of a reply.
 *
 * Claude can only return text, so a file is delivered by naming it: the bridge
 * uploads whatever these lines point at and the lines themselves never reach the
 * chat. `SEND: path | caption` — the caption is optional.
 */
export function extractAttachments(reply: string): { text: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const kept: string[] = [];

  for (const line of reply.split('\n')) {
    const match = /^\s*SEND:\s*(.+?)\s*$/i.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }

    const [rawPath, ...captionParts] = match[1].split('|');
    const path = rawPath.trim().replace(/^["'`]|["'`]$/g, '');
    const caption = captionParts.join('|').trim();
    if (path) attachments.push(caption ? { path, caption } : { path });
  }

  return { text: kept.join('\n').trim(), attachments };
}

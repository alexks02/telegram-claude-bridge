/** Files in both directions: what you send the bot, and what it sends back. */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { basename, extname, join } from 'path';
import { tmpdir } from 'os';
import { Context } from 'telegraf';
import { bot } from './bot.js';
import {
  FILE_SEND_TIMEOUT_MS,
  INBOX_KEEP_DAYS,
  MAX_ATTACHMENT_BYTES,
  MAX_INCOMING_BYTES,
  botToken,
  ffmpegCli,
  inboxDir,
  workspaceRoot,
} from './config.js';
import type { Attachment } from './format.js';
import { enqueueTurn } from './turns.js';
import { tabFor } from './tabs.js';
import type { Project } from './types.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const PHOTO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * Upload a file to the chat over the Bot API directly.
 *
 * Same reason as everything else that leaves this process: Telegraf streams
 * uploads with `Transfer-Encoding: chunked` and some networks stall those
 * indefinitely, while a plain `Content-Length` body goes through.
 */
export async function uploadFile(
  method: 'sendVideo' | 'sendPhoto' | 'sendDocument',
  field: 'video' | 'photo' | 'document',
  chat: number,
  threadId: number | undefined,
  file: { buffer: Buffer; name: string; type: string },
  caption?: string
): Promise<void> {
  const form = new FormData();
  form.append('chat_id', String(chat));
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) form.append('caption', caption.slice(0, 1000));
  form.append(field, new Blob([new Uint8Array(file.buffer)], { type: file.type }), file.name);

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    { method: 'POST', body: form, signal: AbortSignal.timeout(FILE_SEND_TIMEOUT_MS) }
  );

  const result = (await response.json()) as { ok: boolean; description?: string };
  if (!result.ok) throw new Error(result.description || `${method} returned ${response.status}`);
}

/**
 * Resolve a path Claude asked to send, refusing anything outside the workspace.
 *
 * The path comes from model output, which can be steered by anything the model
 * read along the way — so the workspace boundary is what keeps a stray "send
 * /Users/you/.ssh/id_rsa" from being honoured.
 */
export function resolveAttachment(attachment: Attachment, project: Project): string {
  // Claude may be working in another repository than the tab's project (it does
  // `cd` around), so a relative path is tried against the workspace as well.
  const candidates = attachment.path.startsWith('/')
    ? [attachment.path]
    : [join(project.path, attachment.path), join(workspaceRoot, attachment.path)];

  const candidate = candidates.find((option) => existsSync(option));
  if (!candidate) throw new Error(`no such file: ${attachment.path}`);

  const real = realpathSync(candidate);
  if (real !== workspaceRoot && !real.startsWith(`${workspaceRoot}/`)) {
    throw new Error(`refusing to send a file outside ${workspaceRoot}`);
  }

  const stats = statSync(real);
  if (!stats.isFile()) throw new Error(`not a file: ${attachment.path}`);
  if (stats.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `${basename(real)} is ${(stats.size / 1024 / 1024).toFixed(1)} MB — over Telegram's 50 MB limit`
    );
  }

  return real;
}

/** Re-encode a video as H.264 mp4 so Telegram plays it inline. */
export async function toMp4(path: string): Promise<{ buffer: Buffer; name: string; type: string }> {
  const workDir = await mkdtemp(join(tmpdir(), 'bridge-video-'));
  const output = join(workDir, 'clip.mp4');

  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        ffmpegCli,
        ['-y', '-i', path,
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
         '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
         output, '-loglevel', 'error'],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolvePromise() : reject(new Error(stderr.trim() || `ffmpeg exited ${code}`))
      );
    });

    return {
      buffer: await readFile(output),
      name: `${basename(path, extname(path))}.mp4`,
      type: 'video/mp4',
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Send one file, choosing the method by extension and degrading gracefully. */
export async function sendAttachment(
  ctx: Context,
  attachment: Attachment,
  project: Project
): Promise<void> {
  const path = resolveAttachment(attachment, project);
  const name = basename(path);
  const extension = extname(name).toLowerCase();
  const buffer = await readFile(path);
  const chat = ctx.chat!.id;
  const threadId =
    ctx.message && 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;

  const asDocument = () =>
    uploadFile(
      'sendDocument',
      'document',
      chat,
      threadId,
      { buffer, name, type: 'application/octet-stream' },
      attachment.caption
    );

  console.log(`📎 Sending ${name} (${(buffer.length / 1024).toFixed(0)} KB)`);

  if (VIDEO_EXTENSIONS.has(extension)) {
    // Telegram accepts webm but delivers it as a plain file; the same clip as
    // H.264 mp4 arrives as a video you can play in the chat. Playwright records
    // webm, so this is the normal case rather than the exception.
    let payload: { buffer: Buffer; name: string; type: string } = {
      buffer,
      name,
      type: 'video/mp4',
    };
    if (extension === '.webm') {
      const converted = await toMp4(path).catch((error) => {
        console.warn(`⚠️  Could not transcode ${name}:`, error.message);
        return undefined;
      });
      if (converted) payload = converted;
      else payload = { buffer, name, type: 'video/webm' };
    }

    try {
      await uploadFile('sendVideo', 'video', chat, threadId, payload, attachment.caption);
      return;
    } catch (error) {
      // Telegram is picky about codecs; as a file it always arrives
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️  sendVideo refused ${name} (${errorMsg}) — sending as a document`);
      await asDocument();
      return;
    }
  }

  if (PHOTO_EXTENSIONS.has(extension)) {
    try {
      await uploadFile(
        'sendPhoto',
        'photo',
        chat,
        threadId,
        { buffer, name, type: `image/${extension.slice(1)}` },
        attachment.caption
      );
      return;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️  sendPhoto refused ${name} (${errorMsg}) — sending as a document`);
      await asDocument();
      return;
    }
  }

  await asDocument();
}

/**
 * Save a file the owner sent so Claude can look at it.
 *
 * The CLI has no way to receive an attachment, but it reads images and text from
 * disk perfectly well — so an incoming photo becomes a path in the prompt, and
 * Claude opens it with its own Read tool.
 */
export async function saveIncomingFile(fileId: string, suggestedName: string): Promise<string> {
  mkdirSync(inboxDir, { recursive: true });

  const link = await bot.telegram.getFileLink(fileId);
  const response = await fetch(link.href, { signal: AbortSignal.timeout(FILE_SEND_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`could not download the file: ${response.status}`);

  const safeName = basename(suggestedName).replace(/[^\w.\-]+/g, '_') || 'file';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(inboxDir, `${stamp}-${safeName}`);

  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return path;
}

/** Old inbox files are nobody's memory — drop them on startup. */
export function pruneInbox(): void {
  if (!existsSync(inboxDir)) return;
  const cutoff = Date.now() - INBOX_KEEP_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const entry of readdirSync(inboxDir)) {
    const path = join(inboxDir, entry);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path);
        removed += 1;
      }
    } catch {
      // Someone else's cleanup won the race — fine
    }
  }
  if (removed) console.log(`🧹 Removed ${removed} inbox file(s) older than ${INBOX_KEEP_DAYS} days`);
}

/** Turn an attachment into a normal request: a prompt that points at the file. */
export async function handleIncomingFile(
  ctx: Context,
  fileId: string,
  suggestedName: string,
  size: number | undefined,
  caption: string | undefined,
  kind: 'image' | 'file'
): Promise<void> {
  const tab = tabFor(ctx);

  if (size && size > MAX_INCOMING_BYTES) {
    await ctx.reply(
      `⚠️ ${suggestedName} is ${(size / 1024 / 1024).toFixed(1)} MB — Telegram only lets bots download files up to 20 MB.`
    );
    return;
  }

  let path: string;
  try {
    path = await saveIncomingFile(fileId, suggestedName);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ Incoming file failed:', errorMsg);
    await ctx.reply(`❌ Could not receive the file: ${errorMsg}`);
    return;
  }

  console.log(`📥 Received ${kind} → ${path}`);

  const ask =
    caption?.trim() ||
    (kind === 'image'
      ? 'Look at this screenshot and tell me what it shows.'
      : 'Look at this file and tell me what it contains.');

  const prompt = `${ask}\n\n(The attached ${kind} is saved at ${path} — read it.)`;

  const queued = enqueueTurn(ctx, prompt, tab);
  if (queued) {
    await ctx.reply(
      `⏳ ${tab.project.name} is still working on an earlier request — this one is queued.`
    );
  }
}

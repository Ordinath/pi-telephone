import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { formatBytes, inboxFile, isImageMime } from '../src/files.js';
import { slugify } from '../src/addresses.js';
import type { InboundMessage } from '../src/protocol.js';

export interface InboundRecord {
  id: string;
  from: string;
  expectReply: boolean;
  answered: boolean;
  receivedAt: number;
}
const DAY_MS = 24 * 60 * 60 * 1000;

export function recentInbound(messages: InboundRecord[], now: number): InboundRecord[] {
  return messages.filter(message => now - message.receivedAt < DAY_MS);
}
export function rememberInbound(messages: InboundRecord[], message: InboundMessage, now: number): InboundRecord[] {
  return [...recentInbound(messages, now), {
    id: message.id, from: message.from.address, expectReply: message.expectReply, answered: false, receivedAt: now,
  }];
}
export function replyTarget(messages: InboundRecord[], replyTo?: string): { id: string; from?: string } {
  if (replyTo !== undefined) return messages.find(message => message.id === replyTo) ?? { id: replyTo };
  const newestFirst = [...messages].reverse();
  const target = newestFirst.find(message => message.expectReply && !message.answered) ?? newestFirst[0];
  if (!target) throw new Error('No inbound telephone message to reply to.');
  return target;
}
export function markAnswered(messages: InboundRecord[], id: string | undefined): InboundRecord[] {
  return messages.map(message => message.id === id ? { ...message, answered: true } : message);
}
export function nameCandidates(explicit: string | undefined, previous: string | undefined, fallback: string): string[] {
  if (explicit !== undefined) return [explicit];
  if (previous !== undefined) return [previous];
  const base = slugify(fallback);
  return [base, ...Array.from({ length: 8 }, (_, i) => `${base.slice(0, 46)}-${i + 2}`)];
}

export function resolveFilePath(path: string, cwd: string): string {
  return resolve(cwd, path === '~' ? homedir() : path.startsWith('~/') ? homedir() + path.slice(1) : path);
}

export interface ImageBlock { type: 'image'; data: string; mimeType: string }
export async function attachedImages(files: { path: string; mime: string }[] = []): Promise<ImageBlock[]> {
  const images: ImageBlock[] = [];
  for (const entry of files.filter(file => isImageMime(file.mime)).slice(0, 4)) {
    try {
      const file = await inboxFile(entry.path);
      if (!isImageMime(file.mime) || file.size > 3500000) continue;
      const bytes = await readFile(file.path);
      if (bytes.length <= 3500000) images.push({ type: 'image', data: bytes.toString('base64'), mimeType: file.mime });
    } catch { /* The saved file remains available. */ }
  }
  return images;
}
export async function viewFile(path: string) {
  const file = await inboxFile(path);
  const content: ({ type: 'text'; text: string } | ImageBlock)[] = [{ type: 'text', text: `${file.path} (${file.mime}, ${formatBytes(file.size)})${isImageMime(file.mime) && file.size > 3500000 ? '; open this image with your Read tool.' : ''}` }];
  content.push(...await attachedImages([file]));
  return content;
}

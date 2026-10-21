import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { formatBytes, inboxFile, isImageMime } from '../src/files.js';
import { slugify } from '../src/addresses.ts';

export interface TelephoneState { on: boolean; name?: string; allow: string[] }
export interface ReceivedMessage {
  id: string;
  from: string;
  expectReply: boolean;
  answered: boolean;
  receivedAt: number;
}
interface Entry { type: string; customType?: string; data?: unknown; details?: unknown; timestamp?: string }

export function restoreState(entries: readonly Entry[]): TelephoneState {
  const data = entries.filter(entry => entry.type === 'custom' && entry.customType === 'telephone-state').at(-1)?.data;
  if (typeof data !== 'object' || data === null || !('on' in data) || typeof data.on !== 'boolean'
    || !('allow' in data) || !Array.isArray(data.allow) || !data.allow.every((entry): entry is string => typeof entry === 'string')
    || ('name' in data && data.name !== undefined && typeof data.name !== 'string')) return { on: false, allow: ['owner'] };
  return { on: data.on, name: 'name' in data && typeof data.name === 'string' ? data.name : undefined, allow: [...data.allow] };
}

export function recentMessages(messages: readonly ReceivedMessage[], now: number): ReceivedMessage[] {
  return messages.filter(message => message.receivedAt > now - 24 * 60 * 60 * 1000);
}

export function restoreInbox(entries: readonly Entry[], now: number): ReceivedMessage[] {
  return recentMessages(entries.flatMap(entry => {
    if (entry.type !== 'custom_message' || entry.customType !== 'telephone' || !entry.timestamp) return [];
    const receivedAt = Date.parse(entry.timestamp);
    const message = entry.details;
    if (!Number.isFinite(receivedAt) || typeof message !== 'object' || message === null ||
        !('id' in message) || typeof message.id !== 'string' ||
        !('from' in message) || typeof message.from !== 'object' || message.from === null ||
        !('address' in message.from) || typeof message.from.address !== 'string' ||
        !('expectReply' in message) || typeof message.expectReply !== 'boolean') return [];
    return [{ id: message.id, from: message.from.address, expectReply: message.expectReply, answered: false, receivedAt }];
  }), now);
}

export function replyTarget(messages: readonly ReceivedMessage[], replyTo: string | undefined, now: number): string {
  if (replyTo !== undefined) return replyTo;
  const recent = recentMessages(messages, now);
  const target = recent.filter(message => message.expectReply && !message.answered).at(-1) ?? recent.at(-1);
  if (!target) throw new Error('No inbound telephone message to reply to.');
  return target.id;
}

export function nameCandidates(explicit: string | undefined, previous: string | undefined, derived: string): string[] {
  if (explicit !== undefined) return [explicit];
  if (previous !== undefined) return [previous];
  const base = slugify(derived);
  return [base, ...Array.from({ length: 8 }, (_, index) => `${base.slice(0, 46)}-${index + 2}`)];
}

export function parseCommand(input: string): { sub: string; arg: string; message: string } {
  const [sub = 'status', rest = ''] = input.trim().split(/\s+(.*)/s);
  const [arg = '', message = ''] = rest.split(/\s+(.*)/s);
  return { sub: sub || 'status', arg, message };
}

export function required(value: string | undefined, parameter: string): string {
  if (!value?.trim()) throw new Error(`${parameter} is required.`);
  return value;
}

export function timeoutMs(seconds = 600): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new Error('timeoutSec must be greater than 0 and at most 3600.');
  return seconds * 1000;
}

export function resolveFilePath(path: string, cwd: string): string {
  return resolve(cwd, path === '~' ? homedir() : path.startsWith('~/') ? homedir() + path.slice(1) : path);
}

export function parseFileCommand(input: string): { path: string; message: string } {
  const match = input.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s"']+))(?:\s+([\s\S]*))?$/);
  if (!match) throw new Error('Use /telephone file <address> <path> [message]; quote paths containing spaces.');
  return { path: match[1] ?? match[2] ?? match[3], message: match[4] ?? '' };
}
export interface ImageBlock { type: 'image'; data: string; mimeType: string }
export async function imageBlock(path: string): Promise<ImageBlock | undefined> {
  const file = await inboxFile(path);
  if (!isImageMime(file.mime) || file.size > 20000000) return;
  const bytes = await readFile(file.path);
  if (bytes.length > 20000000) return;
  const { resizeImage } = await import('@earendil-works/pi-coding-agent');
  if (typeof resizeImage === 'function') {
    const image = await resizeImage(bytes, file.mime);
    return image ? { type: 'image', data: image.data, mimeType: image.mimeType } : undefined;
  }
  const data = bytes.toString('base64');
  if (data.length <= 4500000) return { type: 'image', data, mimeType: file.mime };
}
export async function attachedImages(files: { path: string; mime: string }[] = []): Promise<ImageBlock[]> {
  const images: ImageBlock[] = [];
  for (const file of files.filter(file => isImageMime(file.mime)).slice(0, 4)) {
    try { const image = await imageBlock(file.path); if (image) images.push(image); } catch { /* The saved file remains available. */ }
  }
  return images;
}
export async function viewFile(path: string) {
  const file = await inboxFile(path);
  const content: ({ type: 'text'; text: string } | ImageBlock)[] = [{ type: 'text', text: `${file.path} (${file.mime}, ${formatBytes(file.size)})` }];
  if (isImageMime(file.mime)) {
    const image = await imageBlock(file.path);
    if (image) content.push(image);
  }
  return content;
}

import { slugify } from '../src/addresses.ts';

export interface TelephoneState { on: boolean; name?: string; allow: string[] }
export interface ReceivedMessage {
  id: string;
  from: string;
  expectReply: boolean;
  answered: boolean;
  receivedAt: number;
}
interface Entry { type: string; customType?: string; data?: unknown }

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

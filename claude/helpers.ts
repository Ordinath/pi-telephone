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
export function replyTarget(messages: InboundRecord[], replyTo?: string): InboundRecord {
  const newestFirst = [...messages].reverse();
  const target = replyTo !== undefined ? messages.find(message => message.id === replyTo)
    : newestFirst.find(message => message.expectReply && !message.answered) ?? newestFirst[0];
  if (!target) throw new Error(replyTo === undefined ? 'No inbound telephone message to reply to.' : `No inbound telephone message with id ${replyTo}.`);
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

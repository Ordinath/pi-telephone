import test from 'node:test';
import assert from 'node:assert/strict';
import { validName } from '../src/addresses.js';
import {
  nameCandidates, parseCommand, recentMessages, replyTarget, required, restoreInbox, restoreState, timeoutMs,
  type ReceivedMessage,
} from '../pi/helpers.js';

const now = 200_000_000;
const message = (id: string, patch: Partial<ReceivedMessage> = {}): ReceivedMessage => ({
  id, from: 'caller@machine', expectReply: true, answered: false, receivedAt: now - 1000, ...patch,
});

test('reply selection prefers the newest unanswered request, then the newest inbound message', () => {
  const messages = [message('old'), message('new'), message('answered', { answered: true }), message('update', { expectReply: false })];
  assert.equal(replyTarget(messages, undefined, now), 'new');
  assert.equal(replyTarget(messages.map(value => ({ ...value, answered: true })), undefined, now), 'update');
  assert.equal(replyTarget(messages, 'old', now), 'old');
  assert.equal(replyTarget([], 'explicit-core-id', now), 'explicit-core-id');
  assert.deepEqual(messages.map(value => value.answered), [false, false, true, false]);
});

test('reply history expires after 24 hours, including the exact boundary', () => {
  const expired = message('expired', { receivedAt: now - 86_400_000 });
  const recent = message('recent', { receivedAt: now - 86_400_000 + 1, expectReply: false });
  assert.deepEqual(recentMessages([expired, recent], now), [recent]);
  assert.equal(replyTarget([expired, recent], undefined, now), 'recent');
  assert.throws(() => replyTarget([expired], undefined, now), /No inbound telephone message/);
  assert.throws(() => replyTarget([], undefined, now), /No inbound telephone message/);
});

test('names prefer explicit or previous names and suffix only auto-derived names', () => {
  assert.deepEqual(nameCandidates('chosen', 'previous', 'Project'), ['chosen']);
  assert.deepEqual(nameCandidates(undefined, 'previous', 'Project'), ['previous']);
  assert.deepEqual(nameCandidates(undefined, undefined, 'My Project'), [
    'my-project', 'my-project-2', 'my-project-3', 'my-project-4', 'my-project-5', 'my-project-6', 'my-project-7', 'my-project-8', 'my-project-9',
  ]);
  assert.ok(nameCandidates(undefined, undefined, 'A'.repeat(80)).every(validName));
  assert.equal(nameCandidates(undefined, undefined, '...')[0], 'session');
});

test('commands default to status and preserve a call message including newlines', () => {
  assert.deepEqual(parseCommand(''), { sub: 'status', arg: '', message: '' });
  assert.deepEqual(parseCommand('  '), { sub: 'status', arg: '', message: '' });
  assert.deepEqual(parseCommand('on alpha'), { sub: 'on', arg: 'alpha', message: '' });
  assert.deepEqual(parseCommand(' call beta@host  Please review\nthese two  lines. '), {
    sub: 'call', arg: 'beta@host', message: 'Please review\nthese two  lines.',
  });
  assert.deepEqual(parseCommand('allow user:someone@example.com'), { sub: 'allow', arg: 'user:someone@example.com', message: '' });
});

test('state restores only the last telephone custom entry and copies its allowlist', () => {
  const last = { on: true, name: 'alpha', allow: ['owner', 'local'] };
  const entries = [
    { type: 'custom', customType: 'telephone-state', data: { on: false, allow: [] } },
    { type: 'custom', customType: 'telephone-state', data: last },
    { type: 'custom_message', customType: 'telephone-state', data: { on: false, allow: [] } },
    { type: 'custom', customType: 'other', data: { on: false, allow: [] } },
  ];
  const restored = restoreState(entries);
  assert.deepEqual(restored, last);
  restored.allow.push('*');
  assert.deepEqual(last.allow, ['owner', 'local']);
  assert.deepEqual(restoreState([]), { on: false, allow: ['owner'] });
  for (const data of [null, {}, { on: true, allow: [1] }, { on: true, allow: [], name: 3 }]) {
    assert.deepEqual(restoreState([{ type: 'custom', customType: 'telephone-state', data }]), { on: false, allow: ['owner'] });
  }
  assert.deepEqual(restoreState([{ type: 'custom', customType: 'telephone-state', data: { on: false, name: 'alpha', allow: [] } }]), { on: false, name: 'alpha', allow: [] });
});

test('inbox restoration retains answered metadata but discards expired and malformed records', () => {
  const kept = message('kept', { answered: true });
  assert.deepEqual(restoreInbox([
    { type: 'custom', customType: 'telephone-inbox', data: [message('earlier')] },
    { type: 'custom', customType: 'telephone-inbox', data: [kept, message('expired', { receivedAt: 0 }), null, {}] },
  ], now), [kept]);
  assert.deepEqual(restoreInbox([], now), []);
});

test('required fields and ask timeouts reject invalid values', () => {
  assert.equal(required('hello\nthere', 'message'), 'hello\nthere');
  for (const value of [undefined, '', '  ']) assert.throws(() => required(value, 'message'), /message is required/);
  assert.equal(timeoutMs(), 600_000);
  assert.equal(timeoutMs(3600), 3_600_000);
  assert.equal(timeoutMs(0.5), 500);
  for (const value of [0, -1, 3601, NaN, Infinity]) assert.throws(() => timeoutMs(value), /timeoutSec/);
});

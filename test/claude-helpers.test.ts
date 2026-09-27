import test from 'node:test';
import assert from 'node:assert/strict';
import { validName } from '../src/addresses.js';
import { markAnswered, nameCandidates, recentInbound, rememberInbound, replyTarget, type InboundRecord } from '../claude/helpers.js';
import type { InboundMessage } from '../src/protocol.js';

const record = (id: string, expectReply = true, answered = false, receivedAt = 0): InboundRecord => ({
  id, from: 'caller@machine', expectReply, answered, receivedAt,
});

test('Claude reply target prefers the latest unanswered call, then the latest message', () => {
  const messages = [record('older'), record('latest-call'), record('answered', true, true), record('note', false)];
  assert.equal(replyTarget(messages).id, 'latest-call');
  const answered = markAnswered(messages, 'latest-call');
  assert.equal(replyTarget(answered).id, 'older');
  assert.equal(replyTarget(markAnswered(answered, 'older')).id, 'note');
  assert.equal(messages[1].answered, false);
  assert.deepEqual(markAnswered(messages, undefined), messages);
  assert.equal(replyTarget(messages, 'answered').id, 'answered');
  assert.equal(replyTarget(messages, 'note').id, 'note');
  assert.throws(() => replyTarget([], undefined), /No inbound telephone message to reply to/);
  assert.throws(() => replyTarget(messages, 'missing'), /No inbound telephone message with id missing/);
});

test('Claude inbound history keeps only messages received within the last 24 hours', () => {
  const day = 24 * 60 * 60 * 1000;
  const messages = [record('expired', true, false, 0), record('retained', false, true, 1)];
  assert.deepEqual(recentInbound(messages, day).map(message => message.id), ['retained']);
  const message: InboundMessage = {
    id: 'new', from: { address: 'other@host', session: 'other', machine: 'host', fqdn: 'host', login: 'owner', local: true },
    text: 'Question', expectReply: true, isReplyToOwnCall: false, sentAt: new Date(0).toISOString(),
  };
  const history = rememberInbound(messages, message, day);
  assert.deepEqual(history, [messages[1], { id: 'new', from: 'other@host', expectReply: true, answered: false, receivedAt: day }]);
  assert.equal(replyTarget(history).id, 'new');
  assert.equal(messages.length, 2);
});

test('Claude name candidates preserve explicit and previous names, suffix only derived names', () => {
  assert.deepEqual(nameCandidates('explicit', 'previous', 'Working Directory'), ['explicit']);
  assert.deepEqual(nameCandidates(undefined, 'previous', 'Working Directory'), ['previous']);
  assert.deepEqual(nameCandidates('', 'previous', 'Working Directory'), ['']);
  assert.deepEqual(nameCandidates(undefined, undefined, 'Working Directory'), [
    'working-directory', 'working-directory-2', 'working-directory-3', 'working-directory-4', 'working-directory-5',
    'working-directory-6', 'working-directory-7', 'working-directory-8', 'working-directory-9',
  ]);
  assert.equal(nameCandidates(undefined, undefined, '...')[0], 'session');
  const long = nameCandidates(undefined, undefined, 'X'.repeat(60));
  assert.equal(long.length, 9);
  assert.equal(long[8], `${'x'.repeat(46)}-9`);
  assert.ok(long.every(validName));
});

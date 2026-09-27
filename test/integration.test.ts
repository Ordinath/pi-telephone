import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { TelephoneClient } from '../src/client.js';
import { createExchange } from '../src/exchange/exchange.js';
import { DEFAULT_CONFIG, saveConfig } from '../src/config.js';
import type { IdentityProvider, MachineIdentity } from '../src/identity.js';
import type { InboundMessage } from '../src/protocol.js';

// Any unexpected auto-spawn must also remain local-only.
process.env.PI_TELEPHONE_NETWORK = 'off';
process.env.PI_TELEPHONE_IDLE_EXIT_MS = '100';

class StaticIdentity implements IdentityProvider {
  constructor(private own: MachineIdentity, private other: MachineIdentity, private machines: Map<number, MachineIdentity>) {}
  async self() { return { ...this.own, ipv4: this.own.ips[0] }; }
  async peers() { return [{ ...this.other, ips: ['127.0.0.1'], online: true }]; }
  async whois(ip: string, hint?: { fromPort?: number }) { return ip === '127.0.0.1' && hint?.fromPort ? this.machines.get(hint.fromPort) : undefined; }
  isTailnetAddress(ip: string) { return ip === '127.0.0.1'; }
}
async function ports(): Promise<[number, number]> {
  const servers = [createServer(), createServer()];
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
  const numbers = servers.map(server => { const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port'); return address.port; });
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  return [numbers[0], numbers[1]];
}
async function setup(t: TestContext, differentLogin = false) {
  const root = await mkdtemp('/tmp/pi-tel-');
  const homeA = `${root}/a`, homeB = `${root}/b`;
  const [portA, portB] = await ports();
  const alice: MachineIdentity = { fqdn: 'alpha.tailaaaa.ts.net', short: 'alpha', login: 'alice@example.com', displayName: 'Alice Example', ips: ['100.64.0.1'] };
  const bob: MachineIdentity = { fqdn: 'beta.tailbbbb.ts.net', short: 'beta', login: differentLogin ? 'bob@example.com' : alice.login, displayName: 'Bob Example', ips: ['100.64.0.2'] };
  const machines = new Map([[portA, alice], [portB, bob]]);
  const identityA = new StaticIdentity(alice, bob, machines);
  const identityB = new StaticIdentity(bob, alice, machines);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(homeA); await mkdir(homeB);
  // The listener override and the configured peer port differ only in this loopback fixture.
  await saveConfig(homeA, { ...DEFAULT_CONFIG, port: portB });
  await saveConfig(homeB, { ...DEFAULT_CONFIG, port: portA });
  let clock = Date.now();
  const optsA = { home: homeA, identity: identityA, port: portA, listenHost: '127.0.0.1', now: () => clock };
  const optsB = { home: homeB, identity: identityB, port: portB, listenHost: '127.0.0.1', now: () => clock };
  let exchangeA = createExchange(optsA);
  const exchangeB = createExchange(optsB);
  const clients: TelephoneClient[] = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await Promise.all([exchangeA.stop(), exchangeB.stop()]); await rm(root, { recursive: true, force: true }); });
  await exchangeA.start(); await exchangeB.start();
  async function client(home: string, name: string, allow?: string[]) {
    const messages: InboundMessage[] = [];
    let handler: ((message: InboundMessage) => Promise<void>) | undefined;
    const phone = new TelephoneClient({ home, harness: 'pi', version: 'test', onMessage: async message => { messages.push(message); await handler?.(message); return { accepted: true }; } });
    clients.push(phone);
    await phone.register({ key: `${name}-${clients.length}`, name, harness: 'pi', cwd: `/work/${name}`, hostPid: process.pid }, allow);
    return { phone, messages, handle(fn: (message: InboundMessage) => Promise<void>) { handler = fn; } };
  }
  const a = await client(homeA, 'alice');
  const b = await client(homeB, 'bob');
  return {
    a, b, alice, bob, homeA, homeB, client,
    advance(ms: number) { clock += ms; },
    async stopB() { await exchangeB.stop(); },
    async restartA() { await exchangeA.stop(); exchangeA = createExchange(optsA); await exchangeA.start(); },
  };
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await sleep(10); }
}

test('directory omits warnings for peers without an exchange', async t => {
  const f = await setup(t);
  await f.b.phone.close();
  await f.stopB();
  assert.deepEqual((await f.a.phone.directory()).warnings, []);
});

test('a: local send and reply by id', async t => {
  const f = await setup(t);
  const local = await f.client(f.homeA, 'reviewer');
  const sent = await f.a.phone.send({ to: 'reviewer', text: 'Review this change' });
  assert.equal(local.messages[0].id, sent.id);
  assert.equal(local.messages[0].from.local, true);
  await local.phone.send({ replyTo: sent.id, text: 'Reviewed' });
  assert.equal(f.a.messages[0].replyTo, sent.id);
  assert.equal(f.a.messages[0].isReplyToOwnCall, true);
  assert.equal(f.a.messages[0].text, 'Reviewed');
});

test('b: cross-exchange ask is resolved by a fast reply without onMessage', async t => {
  const f = await setup(t);
  f.b.handle(async message => { await f.b.phone.send({ replyTo: message.id, text: 'Answer' }); });
  const result = await f.a.phone.ask({ to: 'bob@beta', text: 'Question', timeoutMs: 3000 });
  assert.equal(result.reply.replyTo, result.sent.id);
  assert.equal(result.reply.text, 'Answer');
  assert.equal(result.reply.isReplyToOwnCall, true);
  assert.equal(result.reply.from.fqdn, f.bob.fqdn);
  assert.equal(f.a.messages.length, 0);
});

test('c: an untrusted login is refused, then delivered after adding trust', async t => {
  const f = await setup(t, true);
  await f.b.phone.update({ allow: ['*'] });
  await assert.rejects(f.a.phone.send({ to: 'bob@beta', text: 'Hello' }), { code: 'not_trusted' });
  await f.b.phone.setTrustedUsers({ add: [f.alice.login.toUpperCase()] });
  await f.a.phone.send({ to: 'bob@beta', text: 'Hello again' });
  assert.equal(f.b.messages.length, 1);
  assert.deepEqual((await f.b.phone.getConfig()).config.trustedUsers, [f.alice.login]);
});

test('d: allowlist hides sessions and owner admits another machine of the same user', async t => {
  const f = await setup(t);
  await f.a.phone.send({ to: 'bob@beta', text: 'Owner call' });
  assert.ok((await f.a.phone.directory()).entries.some(entry => entry.session === 'bob' && entry.cwd === '/work/bob'));
  await f.b.phone.update({ allow: ['somebody@alpha'] });
  await assert.rejects(f.a.phone.send({ to: 'bob@beta', text: 'Excluded' }), { code: 'not_reachable' });
  assert.equal((await f.a.phone.directory()).entries.some(entry => entry.session === 'bob'), false);
  await assert.rejects(f.a.phone.send({ to: 'missing@beta', text: 'Missing' }), { code: 'not_reachable' });
});

test('e: a solicited reply bypasses trust, but an unsolicited message does not', async t => {
  const f = await setup(t, true);
  await f.b.phone.setTrustedUsers({ add: [f.alice.login] });
  await f.b.phone.update({ allow: ['*'] });
  f.b.handle(async message => { await f.b.phone.send({ replyTo: message.id, text: 'Solicited answer' }); });
  const result = await f.a.phone.ask({ to: 'bob@beta', text: 'Please answer', timeoutMs: 3000 });
  assert.equal(result.reply.isReplyToOwnCall, true);
  assert.deepEqual((await f.a.phone.getConfig()).config.trustedUsers, []);
  await assert.rejects(f.b.phone.send({ to: 'alice@alpha', text: 'Unsolicited' }), { code: 'not_trusted' });
});

test('f: deadlock guard returns busy_waiting when a call is not a reply', async t => {
  const f = await setup(t);
  const controller = new AbortController();
  const first = f.a.phone.ask({ to: 'bob@beta', text: 'First question', timeoutMs: 3000, signal: controller.signal });
  const second = f.a.phone.ask({ to: 'bob@beta', text: 'Second question', timeoutMs: 3000, signal: controller.signal });
  const firstAborted = assert.rejects(first, { code: 'aborted' });
  const secondAborted = assert.rejects(second, { code: 'aborted' });
  await until(() => f.b.messages.length === 2);
  await assert.rejects(f.b.phone.ask({ to: 'alice@alpha', text: 'A new question', timeoutMs: 3000 }), error => error instanceof Error && 'code' in error && error.code === 'busy_waiting' && error.message.includes(f.b.messages[0].id));
  controller.abort();
  await Promise.all([firstAborted, secondAborted]);
});

test('g: live session names cannot be claimed by another client', async t => {
  const f = await setup(t);
  const other = await f.client(f.homeA, 'other');
  await assert.rejects(other.phone.update({ name: 'alice' }), { code: 'name_taken' });
  await assert.rejects(other.phone.register({ key: 'new-key', name: 'alice', harness: 'pi', cwd: '/work', hostPid: process.pid }), { code: 'name_taken' });
});

test('h: a client reconnects and re-registers after the exchange restarts', async t => {
  const f = await setup(t);
  await f.a.phone.update({ status: 'busy', allow: ['owner', 'local'] });
  const disconnected = once(f.a.phone, 'disconnected');
  const reconnected = once(f.a.phone, 'reconnected');
  await f.restartA();
  await disconnected;
  await reconnected;
  const entry = (await f.a.phone.directory()).entries.find(entry => entry.session === 'alice');
  assert.equal(entry?.status, 'busy');
  await f.b.phone.send({ to: 'alice@alpha', text: 'After restart' });
  assert.equal(f.a.messages[0].text, 'After restart');
});

test('i: message byte size, pair and overall rate limits are enforced', async t => {
  const f = await setup(t);
  await assert.rejects(f.a.phone.send({ to: 'bob@beta', text: 'é'.repeat(131073) }), { code: 'too_large' });
  for (let i = 0; i < 20; i++) await f.a.phone.send({ to: 'bob@beta', text: `Message ${i}` });
  await assert.rejects(f.a.phone.send({ to: 'bob@beta', text: 'One too many' }), { code: 'rate_limited' });
  f.advance(60001);
  await f.a.phone.send({ to: 'bob@beta', text: 'A new minute' });
  for (let caller = 0; caller < 6; caller++) {
    const extra = await f.client(f.homeA, `extra-${caller}`);
    for (let i = 0; i < (caller === 5 ? 19 : 20); i++) await extra.phone.send({ to: 'bob@beta', text: 'Overall limit' });
  }
  await assert.rejects(f.a.phone.send({ to: 'bob@beta', text: 'Overall full' }), { code: 'rate_limited' });
});

test('j: send infers replyTo for the only unanswered inbound call', async t => {
  const f = await setup(t);
  let inferred: string | undefined;
  f.b.handle(async () => { inferred = (await f.b.phone.send({ to: 'alice@alpha', text: 'Inferred answer' })).inferredReplyTo; });
  const result = await f.a.phone.ask({ to: 'bob@beta', text: 'Only question', timeoutMs: 3000 });
  await until(() => inferred !== undefined);
  assert.equal(inferred, result.sent.id);
  assert.equal(result.reply.replyTo, result.sent.id);
});

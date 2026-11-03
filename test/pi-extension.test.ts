import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createEventBus, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createExchange } from '../src/exchange/exchange.js';
import type { IdentityProvider, MachineIdentity } from '../src/identity.js';
import telephone, { type TelephoneApiV1 } from '../pi/index.js';

process.env.PI_TELEPHONE_NETWORK = 'off';

const machine: MachineIdentity = { fqdn: 'alpha.tailaaaa.ts.net', short: 'alpha', login: 'alice@example.com', displayName: 'Alice', ips: [] };
const identity: IdentityProvider = {
  async self() { return { ...machine, ipv4: undefined }; },
  async peers() { return []; },
  async whois() { return undefined; },
  isTailnetAddress: () => false,
};

async function exchange(t: TestContext): Promise<void> {
  const home = await mkdtemp('/tmp/pi-tel-ext-');
  process.env.PI_TELEPHONE_HOME = home;
  const instance = createExchange({ home, identity, port: 0 });
  await instance.start();
  t.after(async () => { await instance.stop(); await rm(home, { recursive: true, force: true }); });
}

// One pi process: a fake ExtensionAPI and context around the real extension and Pi's own event bus.
async function session(t: TestContext, id: string, state?: { on: boolean; name?: string; allow: string[] }) {
  const events = createEventBus();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const entries: { type: string; customType: string; data: unknown }[] = state ? [{ type: 'custom', customType: 'telephone-state', data: state }] : [];
  const notices: string[] = [];
  const pi = {
    events, on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(event, handler); },
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {},
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: 'custom', customType, data }); },
    getSessionName: () => undefined,
  };
  const ctx = {
    cwd: '/work', hasUI: false, isIdle: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => id },
    ui: { setStatus() {}, notify: (text: string) => { notices.push(text); }, confirm: async () => false },
  };
  await telephone(pi as unknown as ExtensionAPI);
  const stop = async () => { await handlers.get('session_shutdown')!({ type: 'session_shutdown' }, ctx); };
  t.after(stop);
  return {
    entries, notices, stop, events,
    start() { handlers.get('session_start')!({ type: 'session_start', reason: 'startup' }, ctx); },
    api(version = 1): TelephoneApiV1 | undefined {
      let api: TelephoneApiV1 | undefined;
      events.emit('pi-telephone:api', { version, provide: (value: TelephoneApiV1) => { api = value; } });
      return api;
    },
    saved() { return entries.filter(entry => entry.customType === 'telephone-state').at(-1)?.data; },
  };
}

async function on(api: TelephoneApiV1): Promise<string> {
  const deadline = Date.now() + 3000;
  while (true) {
    const status = await api.status();
    if (status.on) return status.address!;
    if (Date.now() > deadline) throw new Error('Telephone did not turn on');
    await sleep(10);
  }
}

test('a restored session whose name is live elsewhere takes a suffixed name, and the API hands the name over and back', async t => {
  await exchange(t);
  const state = { on: true, name: 'pa', allow: ['owner'] };
  const main = await session(t, '019f0000-0000-7000-8000-0000000000a1', state);
  main.start();
  const mainApi = main.api()!;
  assert.equal(await on(mainApi), 'pa@alpha');
  // A fork restores the parent's state while the parent still holds the name.
  const fork = await session(t, '019f0000-0000-7000-8000-00000000b2c3', state);
  fork.start();
  const forkApi = fork.api()!;
  assert.equal(await on(forkApi), 'pa-00b2c3@alpha');
  assert.deepEqual(fork.saved(), { on: true, name: 'pa-00b2c3', allow: ['owner'] });
  assert.match(fork.notices.join('\n'), /pa is used by another live session, so this session answers as pa-00b2c3@alpha/);
  // Day start: main moves aside, the fork claims the name.
  assert.deepEqual(await mainApi.on('pa-main'), { address: 'pa-main@alpha' });
  assert.deepEqual(await forkApi.on('pa'), { address: 'pa@alpha' });
  assert.deepEqual(await forkApi.status(), { on: true, name: 'pa', address: 'pa@alpha' });
  await assert.rejects(mainApi.on('pa'), { code: 'name_taken' });
  // Day end: the fork goes off, main takes the name back.
  await forkApi.off();
  assert.deepEqual(await forkApi.status(), { on: false, name: 'pa', address: undefined });
  assert.deepEqual(await mainApi.on('pa'), { address: 'pa@alpha' });
  assert.deepEqual(main.saved(), { on: true, name: 'pa', allow: ['owner'] });
  assert.deepEqual(fork.saved(), { on: false, name: 'pa', allow: ['owner'] });
});

test('an API call before session_start waits for it, other versions get nothing, and a closed session refuses', async t => {
  await exchange(t);
  const early = await session(t, '019f0000-0000-7000-8000-0000000000d4');
  assert.equal(early.api(2), undefined);
  const api = early.api()!;
  const claimed = api.on('early');
  early.start();
  assert.deepEqual(await claimed, { address: 'early@alpha' });
  await early.stop();
  await assert.rejects(api.status(), { code: 'not_active' });
});

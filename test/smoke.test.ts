import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { TelephoneClient } from '../src/client.js';
import type { InboundMessage } from '../src/protocol.js';
import { paths, isFsError } from '../src/config.js';

// The exchange gives a client this long to connect before it exits idle; shorter windows race the client's polling.
const idleExitMs = '1500';

// A plain Node process, as pi-fleet's core is: no Pi, no tsx, only the published pi-telephone/host export.
const hostScript = `
import { TelephoneClient } from 'pi-telephone/host';
const received = [];
const line = (name, onMessage) => {
  const client = new TelephoneClient({ harness: 'pi-fleet', version: 'smoke', features: [], onMessage });
  return { client, address: client.register({ key: 'pi-fleet:' + name, name, harness: 'pi-fleet', cwd: process.cwd(), hostPid: process.pid }) };
};
const a = line('line-a', async () => ({ accepted: true }));
const b = line('line-b', async message => { received.push(message); return { accepted: true }; });
const addresses = await Promise.all([a.address, b.address]);
await a.client.send({ to: 'line-b', text: 'Hello' });
while (!received.length) await new Promise(resolve => setTimeout(resolve, 10));
const entries = (await a.client.directory()).entries.map(entry => [entry.address, entry.harness]);
await Promise.all([a.client.close(), b.client.close()]);
console.log(JSON.stringify({ addresses, from: [received[0].from.session, received[0].from.harness, received[0].from.local], entries }));
`;

test('a plain Node host starts the exchange on demand through pi-telephone/host and runs two lines from one process', { timeout: 15000 }, async t => {
  const home = await mkdtemp('/tmp/pi-tel-host-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', hostScript], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_TELEPHONE_HOME: home, PI_TELEPHONE_NETWORK: 'off', PI_TELEPHONE_IDLE_EXIT_MS: idleExitMs },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
  const result = JSON.parse(output);
  assert.deepEqual(result.addresses.map((address: string) => address.split('@')[0]), ['line-a', 'line-b']);
  assert.deepEqual(result.from, ['line-a', 'pi-fleet', true]);
  assert.deepEqual(result.entries.map(([, harness]: string[]) => harness), ['pi-fleet', 'pi-fleet']);
  // The exchange outlives its host process and exits on its own once idle.
  const deadline = Date.now() + 5000;
  while ((await stat(paths(home).lock).then(() => true, error => { if (!isFsError(error, 'ENOENT')) throw error; return false; }))) {
    if (Date.now() > deadline) assert.fail('Exchange did not exit after its lines closed');
    await sleep(25);
  }
});

test('under systemd the exchange starts in its own transient user unit, and without a working systemd-run it starts detached', { timeout: 30000 }, async t => {
  const root = await mkdtemp('/tmp/pi-tel-systemd-');
  const keys = ['PATH', 'FAKE_SYSTEMD_LOG', 'FAKE_SYSTEMD_FAIL', 'FAKE_SYSTEMD_STALL', 'INVOCATION_ID', 'PI_TELEPHONE_NETWORK', 'PI_TELEPHONE_IDLE_EXIT_MS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const clients: TelephoneClient[] = [];
  const homes: string[] = [];
  t.after(async () => {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    delete (process.versions as Record<string, string>).bun;
    await Promise.all(clients.map(client => client.close()));
    // Stop every exchange a case may have started, also one whose client failed or that is still in its slow start, and wait until it has exited.
    const slowPids = (await readFile(`${root}/slow.pids`, 'utf8').catch(() => '')).split('\n');
    const lockPids = await Promise.all(homes.map(home => readFile(paths(home).lock, 'utf8').catch(() => '')));
    for (const pid of new Set([...slowPids, ...lockPids].map(Number).filter(Boolean))) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (!isFsError(error, 'ESRCH')) throw error; continue; }
      for (const deadline = Date.now() + 3000; Date.now() < deadline; await sleep(25)) {
        try { process.kill(pid, 0); } catch (error) { if (!isFsError(error, 'ESRCH')) throw error; break; }
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const bin = `${root}/bin`, log = `${root}/systemd-run.log`;
  await mkdir(bin);
  await mkdir(`${root}/decoy/node`, { recursive: true });
  // Records its arguments, then runs the command in the background with the --setenv values, as systemd does in a new unit.
  await writeFile(`${bin}/systemd-run`, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SYSTEMD_LOG"
[ -n "$FAKE_SYSTEMD_STALL" ] && exec sleep 10
[ -n "$FAKE_SYSTEMD_FAIL" ] && exit 1
while [ $# -gt 0 ]; do case "$1" in --setenv=*) export "\${1#--setenv=}" ;; --*) ;; *) break ;; esac; shift; done
nohup "$@" >/dev/null 2>&1 &
`, { mode: 0o755 });
  const entry = fileURLToPath(new URL('../dist/exchange.mjs', import.meta.url));
  // An exchange that needs 2.5 s to come up, for example with a large inbox to scan.
  const slowEntry = `${root}/slow-exchange.mjs`;
  await writeFile(slowEntry, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(`${root}/slow.pids`)}, process.pid + '\\n');\n`
    + `await new Promise(resolve => setTimeout(resolve, 2500));\nawait import(${JSON.stringify(pathToFileURL(entry).href)});\n`);
  Object.assign(process.env, { PATH: `${bin}:${previous.PATH}`, FAKE_SYSTEMD_LOG: log, PI_TELEPHONE_NETWORK: 'off', PI_TELEPHONE_IDLE_EXIT_MS: idleExitMs });
  async function start(name: string, env: Record<string, string | undefined>, exchangeEntry = entry): Promise<string> {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const home = `${root}/${name}`;
    homes.push(home);
    const client = new TelephoneClient({ harness: 'pi-fleet', version: 'test', home, exchangeEntry, onMessage: async () => ({ accepted: true }) });
    clients.push(client);
    await client.connect();
    return home;
  }
  const unitHome = await start('unit', { INVOCATION_ID: 'test' });
  const failHome = await start('fail', { FAKE_SYSTEMD_FAIL: '1' });
  // systemd-run hangs until its 3 s timeout; the detached fallback still gets its full start window.
  const stallHome = await start('stall', { FAKE_SYSTEMD_FAIL: undefined, FAKE_SYSTEMD_STALL: '1' }, slowEntry);
  // A standalone Pi binary resolves node on PATH for the unit, skipping a directory named node.
  Object.defineProperty(process.versions, 'bun', { value: '1.3.14', configurable: true });
  const standaloneHome = await start('standalone', { FAKE_SYSTEMD_STALL: undefined, PATH: `${root}/decoy:${bin}:${dirname(process.execPath)}:${previous.PATH}` });
  delete (process.versions as Record<string, string>).bun;
  await start('plain', { INVOCATION_ID: undefined, PATH: `${bin}:${previous.PATH}` });
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 4, calls.join('\n'));
  for (const [index, [home, executable, script]] of ([[unitHome, process.execPath, entry], [failHome, process.execPath, entry], [stallHome, process.execPath, slowEntry],
    [standaloneHome, `${dirname(process.execPath)}/node`, entry]] as const).entries()) {
    const unit = `pi-telephone-exchange-${createHash('sha256').update(home).digest('hex').slice(0, 8)}`;
    assert.ok(calls[index].startsWith(`--user --quiet --collect --unit=${unit} `), calls[index]);
    assert.ok(calls[index].includes(` --setenv=PI_TELEPHONE_HOME=${home} `), calls[index]);
    assert.ok(calls[index].endsWith(` ${executable} ${script}`), calls[index]);
  }
});

test('inside a standalone Pi binary the daemon starts with node from PATH, and a missing node is reported at once', { timeout: 15000 }, async t => {
  const home = await mkdtemp('/tmp/pi-tel-standalone-');
  const previous = { execPath: process.execPath, path: process.env.PATH, network: process.env.PI_TELEPHONE_NETWORK, idle: process.env.PI_TELEPHONE_IDLE_EXIT_MS };
  // Like Pi's Bun-compiled release binary: process.execPath is pi itself, which cannot run the daemon script.
  Object.defineProperty(process.versions, 'bun', { value: '1.3.14', configurable: true });
  process.execPath = '/usr/bin/false';
  process.env.PATH = `${dirname(previous.execPath)}:${previous.path}`;
  process.env.PI_TELEPHONE_NETWORK = 'off';
  process.env.PI_TELEPHONE_IDLE_EXIT_MS = idleExitMs;
  const entry = fileURLToPath(new URL('../dist/exchange.mjs', import.meta.url));
  const onMessage = async () => ({ accepted: true });
  const client = new TelephoneClient({ harness: 'pi', version: 'test', home: `${home}/a`, exchangeEntry: entry, onMessage });
  const other = new TelephoneClient({ harness: 'pi', version: 'test', home: `${home}/b`, exchangeEntry: entry, onMessage });
  let pid: number | undefined;
  t.after(async () => {
    delete (process.versions as Record<string, string>).bun;
    process.execPath = previous.execPath;
    for (const [key, value] of [['PATH', previous.path], ['PI_TELEPHONE_NETWORK', previous.network], ['PI_TELEPHONE_IDLE_EXIT_MS', previous.idle]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    await client.close();
    await other.close();
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (!isFsError(error, 'ESRCH')) throw error; } }
    await rm(home, { recursive: true, force: true });
  });
  await client.connect();
  pid = Number(await readFile(paths(`${home}/a`).lock, 'utf8'));
  assert.ok(pid > 0);
  await mkdir(`${home}/empty-bin`);
  process.env.PATH = `${home}/empty-bin`;
  const started = Date.now();
  await assert.rejects(other.connect(), { code: 'unreachable', message: /needs Node\.js 20 or newer on PATH/ });
  assert.ok(Date.now() - started < 2000);
});

test('bundled daemon starts on demand, locks exclusively and removes private state on idle exit', { timeout: 15000 }, async t => {
  const home = await mkdtemp('/tmp/pi-tel-smoke-');
  const previous = { home: process.env.PI_TELEPHONE_HOME, network: process.env.PI_TELEPHONE_NETWORK, idle: process.env.PI_TELEPHONE_IDLE_EXIT_MS };
  process.env.PI_TELEPHONE_HOME = home;
  process.env.PI_TELEPHONE_NETWORK = 'off';
  process.env.PI_TELEPHONE_IDLE_EXIT_MS = idleExitMs;
  const entry = fileURLToPath(new URL('../dist/exchange.mjs', import.meta.url));
  const client = new TelephoneClient({ harness: 'pi', version: 'test', exchangeEntry: entry, onMessage: async () => ({ accepted: true }) });
  const messages: InboundMessage[] = [];
  const receiver = new TelephoneClient({ harness: 'pi', version: 'test', exchangeEntry: entry, onMessage: async message => { messages.push(message); return { accepted: true }; } });
  const p = paths(home);
  let pid: number | undefined;
  t.after(async () => {
    await client.close();
    await receiver.close();
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (!isFsError(error, 'ESRCH')) throw error; } }
    for (const [key, value] of [['PI_TELEPHONE_HOME', previous.home], ['PI_TELEPHONE_NETWORK', previous.network], ['PI_TELEPHONE_IDLE_EXIT_MS', previous.idle]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  const info = await client.connect();
  assert.equal(info.listening, null);
  pid = Number(await readFile(p.lock, 'utf8'));
  assert.ok(pid > 0);
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  const socketStat = await stat(p.socket);
  assert.equal(socketStat.mode & 0o777, 0o600);
  const second = spawn(process.execPath, [entry], { env: { ...process.env }, stdio: 'pipe' });
  let output = '';
  second.stdout.on('data', chunk => { output += chunk; });
  second.stderr.on('data', chunk => { output += chunk; });
  const [code, signal] = await once(second, 'exit');
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(output, '');
  assert.equal(Number(await readFile(p.lock, 'utf8')), pid);
  assert.equal((await stat(p.socket)).ino, socketStat.ino);
  await client.getConfig();
  await client.register({ key: 'sender', name: 'sender', harness: 'pi', cwd: home, hostPid: process.pid });
  await receiver.register({ key: 'receiver', name: 'receiver', harness: 'pi', cwd: home, hostPid: process.pid });
  const bytes = Buffer.from([0, 255, 1, 2, 3]);
  await writeFile(`${home}/source.bin`, bytes);
  await client.send({ to: 'receiver', text: '', files: [`${home}/source.bin`] });
  assert.deepEqual(await readFile(messages[0].files![0].path), bytes);
  await receiver.close();
  await client.close();
  const deadline = Date.now() + 5000;
  while (true) {
    const remaining = await Promise.all([p.socket, p.lock].map(path => stat(path).then(() => true).catch(error => { if (!isFsError(error, 'ENOENT')) throw error; return false; })));
    if (remaining.every(exists => !exists)) break;
    if (Date.now() > deadline) assert.fail('Daemon did not remove socket and lock after idle exit');
    await sleep(25);
  }
});

test('cli stop returns after the exchange has exited, and never starts one', { timeout: 20000 }, async t => {
  const root = await mkdtemp('/tmp/pi-tel-stop-');
  const pids: number[] = [];
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (!isFsError(error, 'ESRCH')) throw error; } }
    await rm(root, { recursive: true, force: true });
  });
  const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
  const env = (home: string) => ({ PATH: process.env.PATH, HOME: process.env.HOME, PI_TELEPHONE_HOME: home, PI_TELEPHONE_NETWORK: 'off', PI_TELEPHONE_IDLE_EXIT_MS: '60000' });
  async function run(home: string, command: string): Promise<{ code: number | null; output: string }> {
    const child = spawn(process.execPath, [cli, command], { env: env(home), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'exit');
    return { code, output: output.trim() };
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if (!isFsError(error, 'ESRCH')) throw error; return false; } };
  // No exchange: stop says so and starts none.
  const empty = `${root}/empty`;
  assert.deepEqual(await run(empty, 'stop'), { code: 0, output: 'No exchange is running' });
  await assert.rejects(stat(paths(empty).log), { code: 'ENOENT' });
  // A running exchange: stop returns only after its process has exited.
  const home = `${root}/running`;
  assert.equal((await run(home, 'status')).code, 0);
  const pid = Number(await readFile(paths(home).lock, 'utf8'));
  pids.push(pid);
  assert.ok(alive(pid));
  assert.deepEqual(await run(home, 'stop'), { code: 0, output: 'Exchange stopped' });
  assert.equal(alive(pid), false);
  // An exchange whose home was deleted under it cannot be reached; stop must not start and stop a new one in its place.
  const deleted = `${root}/deleted`;
  assert.equal((await run(deleted, 'status')).code, 0);
  pids.push(Number(await readFile(paths(deleted).lock, 'utf8')));
  await rm(deleted, { recursive: true, force: true });
  assert.deepEqual(await run(deleted, 'stop'), { code: 0, output: 'No exchange is running' });
  await assert.rejects(stat(deleted), { code: 'ENOENT' });
});

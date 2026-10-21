import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { TelephoneClient } from '../src/client.js';
import type { InboundMessage } from '../src/protocol.js';
import { paths, isFsError } from '../src/config.js';

test('bundled daemon starts on demand, locks exclusively and removes private state on idle exit', { timeout: 15000 }, async t => {
  const home = await mkdtemp('/tmp/pi-tel-smoke-');
  const previous = { home: process.env.PI_TELEPHONE_HOME, network: process.env.PI_TELEPHONE_NETWORK, idle: process.env.PI_TELEPHONE_IDLE_EXIT_MS };
  process.env.PI_TELEPHONE_HOME = home;
  process.env.PI_TELEPHONE_NETWORK = 'off';
  process.env.PI_TELEPHONE_IDLE_EXIT_MS = '200';
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

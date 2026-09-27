import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, log, paths, prepareHome, isFsError } from '../config.js';
import { TailscaleIdentityProvider, type IdentityProvider } from '../identity.js';
import { createExchange } from './exchange.js';

const p = paths();
await prepareHome(p.home);
const claim = `${p.lock}.claim`;
async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isFsError(error, 'ESRCH'); }
}
async function socketAccepts(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(p.socket);
    socket.setTimeout(250);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}
async function releaseClaim(): Promise<void> {
  if ((await readFile(claim, 'utf8').catch(() => '')) === String(process.pid)) await unlink(claim).catch(() => {});
}
async function acquireLock(): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const file = await open(claim, 'wx', 0o600);
      try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
      break;
    } catch (error) {
      if (!isFsError(error, 'EEXIST')) throw error;
      const owner = Number(await readFile(claim, 'utf8').catch(() => ''));
      const age = await stat(claim).then(info => Date.now() - info.mtimeMs).catch(() => 0);
      if ((owner && !await pidAlive(owner)) || age > 15000) await unlink(claim).catch(() => {});
      await sleep(50);
      if (attempt === 99) return false;
    }
  }
  try {
    try {
      const file = await open(p.lock, 'wx', 0o600);
      try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
    } catch (error) {
      if (!isFsError(error, 'EEXIST')) throw error;
      const pid = Number(await readFile(p.lock, 'utf8').catch(() => ''));
      if (await pidAlive(pid) && await socketAccepts()) { await releaseClaim(); return false; }
      const temp = `${p.lock}.${process.pid}.tmp`;
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
      try { await rename(temp, p.lock); } finally { await unlink(temp).catch(() => {}); }
    }
    if ((await readFile(p.lock, 'utf8')) === String(process.pid)) return true;
    await releaseClaim();
    return false;
  } catch (error) { await releaseClaim(); throw error; }
}
if (!await acquireLock()) process.exit(0);
let exchange: ReturnType<typeof createExchange> | undefined;
let cleanupPromise: Promise<void> | undefined;
function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    await exchange?.stop();
    if ((await readFile(p.lock, 'utf8').catch(() => '')) === String(process.pid)) {
      await unlink(p.socket).catch(() => {});
      await unlink(p.lock).catch(() => {});
    }
    await releaseClaim();
  })();
  return cleanupPromise;
}
process.once('beforeExit', () => void cleanup());
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().then(() => process.exit(0)); });
try {
  await unlink(p.socket).catch(error => { if (!isFsError(error, 'ENOENT')) throw error; });
  const config = await loadConfig(p.home);
  const identity: IdentityProvider = process.env.PI_TELEPHONE_NETWORK === 'off' ? {
    async self() { throw new Error('Network disabled'); },
    async peers() { return []; },
    async whois() { return undefined; },
    isTailnetAddress() { return false; },
  } : new TailscaleIdentityProvider(config.tailscaleCli);
  const idleOverride = process.env.PI_TELEPHONE_IDLE_EXIT_MS;
  const idleExitMs = idleOverride === undefined ? undefined : Number(idleOverride);
  if (idleExitMs !== undefined && (!Number.isFinite(idleExitMs) || idleExitMs < 0)) throw new Error('Invalid PI_TELEPHONE_IDLE_EXIT_MS');
  exchange = createExchange({ home: p.home, identity, port: config.port, idleExitMs });
  await exchange.start();
  await releaseClaim();
  await log(p.home, 'info', `Exchange started pid=${process.pid}`);
} catch (error) {
  await log(p.home, 'error', `Exchange startup failed: ${error instanceof Error ? error.message : String(error)}`);
  await cleanup();
  process.exitCode = 1;
}

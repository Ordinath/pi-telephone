import { open, readFile, stat, unlink } from 'node:fs/promises';
import { loadConfig, log, paths, prepareHome, isFsError } from '../config.js';
import { TailscaleIdentityProvider, type IdentityProvider } from '../identity.js';
import { createExchange } from './exchange.js';

const p = paths();
await prepareHome(p.home);
async function acquireLock(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(p.lock, 'wx', 0o600);
      try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
      return true;
    } catch (error) {
      if (!isFsError(error, 'EEXIST')) throw error;
      let pid: number;
      try {
        pid = Number(await readFile(p.lock, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) {
          if (Date.now() - (await stat(p.lock)).mtimeMs < 5000) return false;
        } else {
          try { process.kill(pid, 0); return false; }
          catch (error) { if (!isFsError(error, 'ESRCH')) return false; }
        }
        // Only the holder of the lock removes a socket, never a contender.
        await unlink(p.lock);
      } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
    }
  }
  return false;
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
  await log(p.home, 'info', `Exchange started pid=${process.pid}`);
} catch (error) {
  await log(p.home, 'error', `Exchange startup failed: ${error instanceof Error ? error.message : String(error)}`);
  await cleanup();
  process.exitCode = 1;
}

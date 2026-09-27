import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config } from './protocol.js';

export const DEFAULT_CONFIG: Config = { port: 47474, trustedUsers: [], tailscaleCli: null, maxMessageBytes: 262144 };
export function homePath(home?: string): string { return resolve(home ?? process.env.PI_TELEPHONE_HOME ?? join(homedir(), '.pi-telephone')); }
export function paths(home?: string) {
  const root = homePath(home);
  const normal = join(root, 'exchange.sock');
  const socket = Buffer.byteLength(normal) <= 100 ? normal : join(tmpdir(), `pi-telephone-${process.getuid?.() ?? 'user'}`, 'exchange.sock');
  return { home: root, socket, socketPath: join(root, 'socket-path'), lock: join(root, 'exchange.lock'), config: join(root, 'config.json'), log: join(root, 'exchange.log') };
}
export async function prepareHome(home?: string): Promise<void> {
  const p = paths(home);
  await mkdir(p.home, { recursive: true, mode: 0o700 });
  await chmod(p.home, 0o700);
  if (p.socket !== join(p.home, 'exchange.sock')) {
    const directory = join(p.socket, '..');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(p.socketPath, p.socket, { mode: 0o600 });
  }
}
export async function clientSocketPath(home?: string): Promise<string> {
  const p = paths(home);
  try { return (await readFile(p.socketPath, 'utf8')).trim(); }
  catch (error) { if (!isFsError(error, 'ENOENT')) throw error; return p.socket; }
}
export function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
export async function loadConfig(home?: string): Promise<Config> {
  try {
    const value = JSON.parse(await readFile(paths(home).config, 'utf8'));
    const config: Config = { ...DEFAULT_CONFIG, ...value };
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
        !Number.isInteger(config.maxMessageBytes) || config.maxMessageBytes < 1 ||
        !Array.isArray(config.trustedUsers) || !config.trustedUsers.every(user => typeof user === 'string' && !!user.trim()) ||
        !(config.tailscaleCli === null || typeof config.tailscaleCli === 'string')) throw new Error('Invalid config.json');
    return config;
  } catch (error) {
    if (!isFsError(error, 'ENOENT')) throw error;
    const config = { ...DEFAULT_CONFIG, trustedUsers: [] };
    await saveConfig(home, config);
    return config;
  }
}
export async function saveConfig(home: string | undefined, config: Config): Promise<void> {
  const path = paths(home).config;
  await writeFile(`${path}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export async function log(home: string | undefined, level: string, message: string): Promise<void> {
  const { appendFile, stat } = await import('node:fs/promises');
  const path = paths(home).log;
  try {
    if ((await stat(path)).size >= 5 * 1024 * 1024) await rename(path, `${path}.1`);
  } catch (error) { if (!isFsError(error, 'ENOENT')) return; }
  await appendFile(path, `${new Date().toISOString()} ${level} ${message.replace(/[\r\n]/g, ' ')}\n`, { mode: 0o600 }).catch(() => {});
}

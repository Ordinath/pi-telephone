import { delimiter, isAbsolute, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { clientSocketPath, homePath, isFsError } from './config.js';
import { readFrames, writeFrame } from './ndjson.js';
import {
  CLIENT_FEATURES, PROTO_VERSION, TelephoneError, wireHarness, type Config, type Directory, type ExchangeInfo, type Harness, type InboundMessage,
  type SendInput, type SendResult, type ServerFrame, type Session, type SessionPatch, type TrustPatch,
} from './protocol.js';
export { TelephoneError } from './protocol.js';
export interface ClientOptions {
  harness: Harness;
  version: string;
  onMessage: (message: InboundMessage) => Promise<{ accepted: boolean; reason?: string }>;
  home?: string;
  exchangeEntry?: string;
  /** What this host can receive; default ['files']. Without 'files' the exchange refuses file sends to it. */
  features?: string[];
  /** Pass replies to this client's own asks to onMessage too; the ask returns only after resolveReply(message). */
  deferReplies?: boolean;
  /** False: only connect to a running exchange, and fail with not_running instead of starting one. Default true. */
  start?: boolean;
}
// When the clients of one process start together, one spawns the exchange and the rest wait for its socket.
const recentSpawns = new Map<string, number>();
// As a shell finds a command: an empty PATH entry means the current directory, and only an executable regular file counts.
function findExecutable(name: string, path = ''): string | undefined {
  for (const directory of path.split(delimiter)) {
    const candidate = resolve(directory || '.', name);
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate; } } catch { /* Not in this directory. */ }
  }
  return undefined;
}
// systemd stops every process of a unit with it, even a detached one, so a host that runs as a unit starts the exchange in its own
// transient user unit. False when that is not possible; the caller then starts it detached, and a duplicate exits on the exchange lock.
function startInSystemdUnit(runtime: string, entry: string, env: Record<string, string | undefined>, home: string): Promise<boolean> {
  const executable = isAbsolute(runtime) ? runtime : findExecutable(runtime, env.PATH);
  if (!process.env.INVOCATION_ID || !executable) return Promise.resolve(false);
  const unit = `pi-telephone-exchange-${createHash('sha256').update(home).digest('hex').slice(0, 8)}`;
  const settings = Object.entries(env).flatMap(([key, value]) => value === undefined ? [] : [`--setenv=${key}=${value}`]);
  return new Promise(resolve => execFile('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unit}`, ...settings, executable, entry],
    { timeout: 3000 }, error => resolve(!error)));
}
interface PendingRequest { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
interface ReplyWait { resolve: (message: InboundMessage) => void; reject: (error: Error) => void }
export class TelephoneClient extends EventEmitter {
  private socket?: Socket;
  private connecting?: Promise<ExchangeInfo>;
  private info?: ExchangeInfo;
  private closed = false;
  private wasConnected = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelay = 250;
  private registration?: { session: Session; allow: string[]; status?: 'idle' | 'busy' };
  private requests = new Map<string, PendingRequest>();
  private replies = new Map<string, ReplyWait>();
  private readonly home: string;
  constructor(private readonly opts: ClientOptions) { super(); this.home = homePath(opts.home); }
  connect(): Promise<ExchangeInfo> {
    if (this.closed) return Promise.reject(new TelephoneError('closed'));
    if (this.info && this.socket && !this.socket.destroyed) return Promise.resolve(this.info);
    this.connecting ??= this.establish().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async ensureExchange(): Promise<Socket> {
    let deadline = Date.now() + 5000;
    let spawned = false;
    let failed: NodeJS.ErrnoException | undefined;
    let backoff = 25;
    while (!this.closed) {
      try {
        const path = await clientSocketPath(this.home);
        return await new Promise<Socket>((resolve, reject) => {
          const socket = createConnection(path);
          socket.once('error', reject);
          socket.once('connect', () => { socket.off('error', reject); resolve(socket); });
        });
      } catch (error) {
        if (!isFsError(error, 'ENOENT') && !isFsError(error, 'ECONNREFUSED')) throw error;
        if (this.opts.start === false) throw new TelephoneError('not_running', 'No exchange is running');
        if (!spawned && Date.now() - (recentSpawns.get(this.home) ?? 0) > 2000) {
          recentSpawns.set(this.home, Date.now());
          spawned = true;
          const entry = this.opts.exchangeEntry ?? fileURLToPath(new URL('../dist/exchange.mjs', import.meta.url));
          const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'].includes(key) || key.startsWith('PI_TELEPHONE_'))), PI_TELEPHONE_HOME: this.home };
          // A standalone Pi build (Bun or a Node single executable) is its own binary and cannot run a script, so use node from PATH.
          const runtime = process.versions.bun || process.getBuiltinModule?.('node:sea')?.isSea() ? 'node' : process.execPath;
          if (!await startInSystemdUnit(runtime, entry, env, this.home)) {
            const child = spawn(runtime, [entry], { detached: true, stdio: 'ignore', env });
            child.on('error', error => { failed = error; });
            child.unref();
          }
          // A slow or failed systemd-run must not shorten the time the exchange itself has to start.
          deadline = Date.now() + 5000;
        }
        if (failed) throw new TelephoneError('unreachable', failed.code === 'ENOENT' ? 'Cannot start the exchange: pi-telephone needs Node.js 20 or newer on PATH' : `Cannot start the exchange: ${failed.message}`);
        if (Date.now() >= deadline) throw new TelephoneError('unreachable', 'Exchange did not start within 5 seconds');
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 500);
      }
    }
    throw new TelephoneError('closed');
  }
  private async establish(): Promise<ExchangeInfo> {
    const socket = await this.ensureExchange();
    if (this.closed) { socket.destroy(); throw new TelephoneError('closed'); }
    this.socket = socket;
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.info = undefined;
      const error = new TelephoneError(this.closed ? 'closed' : 'disconnected');
      for (const request of this.requests.values()) request.reject(error);
      this.requests.clear();
      for (const wait of this.replies.values()) wait.reject(error);
      this.replies.clear();
      if (!this.closed) { this.emit('disconnected'); this.scheduleReconnect(); }
    });
    readFrames(socket, value => { void this.receive(value as ServerFrame, socket).catch(() => socket.destroy()); });
    try {
      const result = await this.request<{ exchange: ExchangeInfo }>({ t: 'hello', proto: PROTO_VERSION, client: { harness: this.opts.harness, version: this.opts.version, pid: process.pid, features: this.opts.features ?? CLIENT_FEATURES } });
      if (this.registration) {
        await this.request({ t: 'register', session: this.wireSession(this.registration.session, result.exchange), allow: this.registration.allow });
        if (this.registration.status) await this.request({ t: 'update', status: this.registration.status });
      }
      this.info = result.exchange;
      this.reconnectDelay = 250;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      const event = this.wasConnected ? 'reconnected' : 'connected';
      this.wasConnected = true;
      this.emit(event, this.info);
      return this.info;
    } catch (error) { socket.destroy(); throw error; }
  }
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error: unknown) => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
        this.emit('retrying', error);
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
  }
  private request<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new TelephoneError('disconnected'));
    const rid = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.requests.set(rid, { resolve: value => resolve(value as T), reject });
      try { writeFrame(socket, { ...body, rid }); }
      catch (error) { this.requests.delete(rid); reject(error); }
    });
  }
  private async receive(frame: ServerFrame, socket: Socket): Promise<void> {
    if (frame.t === 'deliver') {
      const message = frame.message;
      const wait = !this.opts.deferReplies && message.isReplyToOwnCall && message.replyTo ? this.replies.get(message.replyTo) : undefined;
      let ack: { accepted: boolean; reason?: string };
      if (wait) { this.replies.delete(message.replyTo!); wait.resolve(message); ack = { accepted: true }; }
      else {
        try { ack = await this.opts.onMessage(message); }
        catch { ack = { accepted: false, reason: 'Recipient handler failed' }; }
      }
      if (!socket.destroyed) writeFrame(socket, { t: 'ack', id: message.id, ...ack });
      return;
    }
    const request = this.requests.get(frame.rid);
    if (!request) return;
    this.requests.delete(frame.rid);
    if (frame.t === 'error') request.reject(new TelephoneError(frame.code, frame.message));
    else { const { t, rid, ...result } = frame; request.resolve(result); }
  }
  // A 0.2.x exchange refuses harness names it does not know, so such a line registers as 'cli' until the exchange restarts.
  private wireSession(session: Session, exchange: ExchangeInfo): Session {
    return { ...session, harness: wireHarness(session.harness, exchange.features) as Harness };
  }
  /** With deferReplies: true when an ask of this client waits for message id `id`. */
  waiting(id: string): boolean { return this.replies.has(id); }
  /** With deferReplies: hand a reply to the ask that waits for it; false when none waits. */
  resolveReply(message: InboundMessage): boolean {
    const wait = message.isReplyToOwnCall && message.replyTo ? this.replies.get(message.replyTo) : undefined;
    if (!wait) return false;
    this.replies.delete(message.replyTo!);
    wait.resolve(message);
    return true;
  }
  async register(session: Session, allow: string[] = ['owner']): Promise<string> {
    const exchange = await this.connect();
    const result = await this.request<{ address: string }>({ t: 'register', session: this.wireSession(session, exchange), allow });
    this.registration = { session: { ...session }, allow: [...allow] };
    return result.address;
  }
  async update(patch: SessionPatch): Promise<string> {
    await this.connect();
    const result = await this.request<{ address: string }>({ t: 'update', ...patch });
    if (this.registration) {
      if (patch.name !== undefined) this.registration.session.name = patch.name;
      if (patch.allow !== undefined) this.registration.allow = [...patch.allow];
      if (patch.status !== undefined) this.registration.status = patch.status;
    }
    return result.address;
  }
  async unregister(): Promise<void> {
    await this.connect();
    await this.request({ t: 'unregister' });
    this.registration = undefined;
  }
  async directory(): Promise<Directory> { await this.connect(); return this.request<Directory>({ t: 'directory' }); }
  private fileInputs(files: string[] | undefined): { path: string }[] | undefined {
    if (files === undefined) return undefined;
    if (!Array.isArray(files) || !files.length || files.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new TelephoneError('invalid_request', 'Files must be absolute paths.');
    if (!this.info?.features?.includes('files')) throw new TelephoneError('exchange_outdated', `This machine's telephone exchange runs pi-telephone ${this.info?.version}, which cannot send files. Restart it once with /telephone restart in Pi or \`npx pi-telephone stop\`, then send again.`);
    return files.map(path => ({ path }));
  }
  async send(input: SendInput): Promise<SendResult> {
    await this.connect();
    return this.request<SendResult>({ t: 'send', ...input, id: input.id ?? randomUUID(), files: this.fileInputs(input.files) });
  }
  /** `id` lets the host know the call's message id before the reply arrives; it must be a fresh UUID. */
  async ask(input: { id?: string; to: string; text: string; timeoutMs: number; signal?: AbortSignal; files?: string[] }): Promise<{ sent: SendResult; reply: InboundMessage }> {
    await this.connect();
    const files = this.fileInputs(input.files);
    if (input.signal?.aborted) throw new TelephoneError('aborted');
    const id = input.id ?? randomUUID();
    if (this.replies.has(id)) throw new TelephoneError('invalid_id');
    let cancel: (error: Error) => void = () => {};
    let received: InboundMessage | undefined;
    const reply = new Promise<InboundMessage>((resolve, reject) => {
      cancel = reject;
      this.replies.set(id, { resolve: message => { received = message; resolve(message); }, reject });
    });
    const onAbort = () => cancel(new TelephoneError('aborted'));
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => cancel(new TelephoneError('timeout', 'Telephone call timed out')), input.timeoutMs);
    try {
      const sent = this.request<SendResult>({ t: 'send', id, to: input.to, text: input.text, expectReply: true, files });
      const [sendResult, replyResult] = await Promise.all([sent, reply]);
      return { sent: sendResult, reply: replyResult };
    } catch (error) {
      if (received) return { sent: { id, status: 'delivered', to: input.to }, reply: received };
      if (this.socket && !this.socket.destroyed) void this.request({ t: 'cancelWait', id }).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      this.replies.delete(id);
    }
  }
  async getConfig(): Promise<{ config: Config; owner: string; inboxBytes: number }> { await this.connect(); return this.request({ t: 'getConfig' }); }
  async setTrustedUsers(patch: TrustPatch): Promise<{ trustedUsers: string[] }> { await this.connect(); return this.request({ t: 'setTrustedUsers', ...patch }); }
  async shutdownExchange(): Promise<void> { await this.connect(); await this.request({ t: 'shutdown' }); }
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    if (socket && !socket.destroyed) await new Promise<void>(resolve => { socket.once('close', resolve); socket.destroy(); });
    await this.connecting?.catch(() => {});
  }
}

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { clientSocketPath, homePath, isFsError } from './config.js';
import { readFrames, writeFrame } from './ndjson.js';
import {
  PROTO_VERSION, TelephoneError, type Config, type Directory, type ExchangeInfo, type Harness, type InboundMessage,
  type SendInput, type SendResult, type ServerFrame, type Session, type SessionPatch, type TrustPatch,
} from './protocol.js';
export { TelephoneError } from './protocol.js';
export interface ClientOptions {
  harness: Harness;
  version: string;
  onMessage: (message: InboundMessage) => Promise<{ accepted: boolean; reason?: string }>;
  home?: string;
  exchangeEntry?: string;
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
    const deadline = Date.now() + 5000;
    let spawned = false;
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
        if (!spawned) {
          const entry = this.opts.exchangeEntry ?? fileURLToPath(new URL('../dist/exchange.mjs', import.meta.url));
          const child = spawn(process.execPath, [entry], { detached: true, stdio: 'ignore', env: { ...process.env, PI_TELEPHONE_HOME: this.home } });
          child.on('error', () => {});
          child.unref();
          spawned = true;
        }
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
      const result = await this.request<{ exchange: ExchangeInfo }>({ t: 'hello', proto: PROTO_VERSION, client: { harness: this.opts.harness, version: this.opts.version, pid: process.pid } });
      if (this.registration) {
        await this.request({ t: 'register', session: this.registration.session, allow: this.registration.allow });
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
      void this.connect().catch(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
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
      const wait = message.isReplyToOwnCall && message.replyTo ? this.replies.get(message.replyTo) : undefined;
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
  async register(session: Session, allow: string[] = ['owner']): Promise<string> {
    await this.connect();
    const result = await this.request<{ address: string }>({ t: 'register', session, allow });
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
  async send(input: SendInput): Promise<SendResult> {
    await this.connect();
    return this.request<SendResult>({ t: 'send', id: randomUUID(), ...input });
  }
  async ask(input: { to: string; text: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ sent: SendResult; reply: InboundMessage }> {
    await this.connect();
    if (input.signal?.aborted) throw new TelephoneError('aborted');
    const id = randomUUID();
    let cancel: (error: Error) => void = () => {};
    const reply = new Promise<InboundMessage>((resolve, reject) => {
      cancel = reject;
      this.replies.set(id, { resolve, reject });
    });
    const onAbort = () => cancel(new TelephoneError('aborted'));
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => cancel(new TelephoneError('timeout', 'Telephone call timed out')), input.timeoutMs);
    try {
      const sent = this.request<SendResult>({ t: 'send', id, to: input.to, text: input.text, expectReply: true });
      const [sendResult, replyResult] = await Promise.all([sent, reply]);
      return { sent: sendResult, reply: replyResult };
    } catch (error) {
      if (this.socket && !this.socket.destroyed) void this.request({ t: 'cancelWait', id }).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      this.replies.delete(id);
    }
  }
  async getConfig(): Promise<{ config: Config; owner: string }> { await this.connect(); return this.request({ t: 'getConfig' }); }
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

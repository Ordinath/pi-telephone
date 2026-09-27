import { chmod, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createServer, type Socket } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { displayMachine, formatAddress, ipv4, parseAddress, resolveMachine, validName, type Peer } from '../addresses.js';
import { loadConfig, log, paths, prepareHome, saveConfig } from '../config.js';
import type { IdentityProvider } from '../identity.js';
import { readFrames, writeFrame } from '../ndjson.js';
import { allows, isTrusted, validateAllow, type Caller } from '../policy.js';
import {
  PROTO_VERSION, VERSION, TelephoneError, isUuid,
  type Config, type Directory, type ExchangeInfo, type Harness, type InboundMessage, type MachineIdentity,
  type NetworkDelivery, type NetworkDirectory, type NetworkHello, type Request, type Session, type SessionStatus,
} from '../protocol.js';
import { closeServer, listen, networkServer, peerRequest, type HttpInput, type HttpOutput } from './http.js';

interface Registration { session: Session; allow: string[]; status: SessionStatus }
interface Connection { socket: Socket; hello: boolean; registration?: Registration }
interface Route { session: string; machine: MachineIdentity; local: boolean; ip?: string; port: number }
interface LedgerEntry { at: number; fromSessionKey: string; to: Route }
interface Remembered { at: number; targetKey: string; route: Route; message: InboundMessage; answered: boolean }
interface Waiting { at: number; sessionKey: string; to: Route }
interface PendingAck { connection: Connection; finish: (accepted: boolean) => void }
interface Discovery { at: number; hasExchange: boolean; reason?: string }
export interface ExchangeOptions {
  home: string;
  identity: IdentityProvider;
  port: number;
  listenHost?: string;
  now?: () => number;
  idleExitMs?: number;
}

export function createExchange(options: ExchangeOptions): { start(): Promise<void>; stop(): Promise<void> } {
  if (options.listenHost !== undefined && options.listenHost !== '127.0.0.1') throw new Error('listenHost is only for loopback tests');
  const now = options.now ?? Date.now;
  const p = paths(options.home);
  let config: Config;
  let self: MachineIdentity = { fqdn: hostname().toLowerCase(), short: hostname().split('.')[0].toLowerCase(), login: '', ips: [] };
  let listening: ExchangeInfo['listening'] = null;
  let network: HttpServer | undefined;
  let networkRefresh: Promise<void> | undefined;
  let initialRefreshDone: () => void;
  const initialRefresh = new Promise<void>(resolve => { initialRefreshDone = resolve; });
  let lastNetworkState: string | null | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  let started = false;
  let ownsSocket = false;
  let configWrites = Promise.resolve();
  const connections = new Set<Connection>();
  const names = new Map<string, Connection>();
  const ledger = new Map<string, LedgerEntry>();
  const inbound = new Map<string, Remembered>();
  const waits = new Map<string, Waiting>();
  const pendingSends = new Map<string, { sessionKey: string; cancelled: boolean }>();
  const peerEndpoints = new Map<string, { ip: string; port: number }>();
  const acks = new Map<string, PendingAck>();
  const discovery = new Map<string, Discovery>();
  const pairRates = new Map<string, number[]>();
  const targetRates = new Map<string, number[]>();
  const local = createServer(socket => {
    const connection: Connection = { socket, hello: false };
    connections.add(connection);
    clearTimeout(idleTimer);
    socket.on('error', () => {});
    socket.on('close', () => {
      connections.delete(connection);
      unregister(connection);
      for (const ack of acks.values()) if (ack.connection === connection) ack.finish(false);
      scheduleIdle();
    });
    readFrames(socket, frame => {
      if (!isObject(frame)) { socket.destroy(); return; }
      if (frame.t === 'ack') {
        const ack = typeof frame.id === 'string' ? acks.get(frame.id) : undefined;
        if (ack?.connection === connection) ack.finish(frame.accepted === true);
        return;
      }
      if (typeof frame.rid !== 'string' || typeof frame.t !== 'string') { socket.destroy(); return; }
      // Request-specific fields are checked by handleLocal before use.
      const request = frame as Request;
      void handleLocal(connection, request).then(result => {
        if (!socket.destroyed) writeFrame(socket, { t: 'ok', rid: request.rid, ...result });
        if (request.t === 'shutdown') setImmediate(() => void stop());
      }).catch(error => {
        if (!socket.destroyed) writeFrame(socket, {
          t: 'error', rid: request.rid, code: error instanceof TelephoneError ? error.code : 'invalid_request',
          message: error instanceof TelephoneError ? error.message : 'Invalid request',
        });
      });
    });
  });

  function scheduleIdle(): void {
    if (stopping || connections.size) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void stop(), options.idleExitMs ?? 600000);
  }
  function prune(): void {
    for (const [id, entry] of ledger) if (entry.at <= now() - 86400000) ledger.delete(id);
    for (const [id, entry] of inbound) if (entry.at <= now() - 86400000) inbound.delete(id);
    for (const [id, entry] of waits) if (entry.at <= now() - 3600000) waits.delete(id);
    for (const rates of [pairRates, targetRates]) {
      for (const [key, times] of rates) {
        const active = times.filter(time => time > now() - 60000);
        if (active.length) rates.set(key, active); else rates.delete(key);
      }
    }
    while (ledger.size > 10000) ledger.delete(ledger.keys().next().value!);
  }
  function sameRoute(a: Route, b: Route): boolean {
    return a.session === b.session && a.local === b.local && a.machine.fqdn.toLowerCase() === b.machine.fqdn.toLowerCase();
  }
  function address(route: Route): string {
    const known = [...discovery].filter(([, entry]) => entry.hasExchange).map(([fqdn]) => ({ fqdn, short: fqdn.split('.')[0], login: '', ips: [], online: true, hasExchange: true }));
    return formatAddress(route.session, displayMachine(route.machine, self, known));
  }
  function ownAddress(connection: Connection): string {
    return address({ session: registered(connection).session.name, machine: self, local: true, port: options.port });
  }
  function registered(connection: Connection): Registration {
    if (!connection.registration) throw new TelephoneError('not_registered');
    return connection.registration;
  }
  function unregister(connection: Connection): void {
    if (!connection.registration) return;
    const { session } = connection.registration;
    if (names.get(session.name) === connection) names.delete(session.name);
    for (const [id, wait] of waits) if (wait.sessionKey === session.key) waits.delete(id);
    for (const send of pendingSends.values()) if (send.sessionKey === session.key) send.cancelled = true;
    connection.registration = undefined;
  }
  function logNetworkState(): void {
    const address = listening?.address ?? null;
    if (lastNetworkState === address) return;
    lastNetworkState = address;
    void log(options.home, 'info', address ? `Listening on ${address}:${options.port}` : 'Running local-only');
  }
  async function refreshNetwork(): Promise<void> {
    if (stopping) return;
    try {
      const current = await options.identity.self();
      if (stopping) return;
      self = current;
      const host = options.listenHost ?? current.ipv4;
      if (host && !options.listenHost && !options.identity.isTailnetAddress(host)) throw new Error('Not a Tailscale address');
      if (host === listening?.address) return;
      if (network) { await closeServer(network); network = undefined; listening = null; }
      if (!host) { logNetworkState(); return; }
      const server = networkServer(config.maxMessageBytes + 16384, handleNetwork);
      try { await listen(server, host, options.port); }
      catch (error) { await closeServer(server); throw error; }
      network = server;
      listening = { address: host, port: options.port };
      logNetworkState();
    } catch {
      if (network) await closeServer(network);
      network = undefined;
      listening = null;
      logNetworkState();
    }
  }
  async function peers(): Promise<Peer[]> {
    try { return await options.identity.peers(); } catch { return []; }
  }
  async function discover(): Promise<Peer[]> {
    const all = await peers();
    await Promise.all(all.filter(peer => peer.online).map(async peer => {
      const cached = discovery.get(peer.fqdn);
      if (cached && cached.at > now() - (cached.hasExchange ? 60000 : 10000)) return;
      const endpoint = peerEndpoints.get(peer.fqdn);
      const ip = endpoint?.ip ?? ipv4(peer);
      if (!ip) { discovery.set(peer.fqdn, { at: now(), hasExchange: false, reason: 'No Tailscale IPv4' }); return; }
      try {
        const hello = await remote<NetworkHello>(ip, endpoint?.port ?? config.port, '/v1/hello', 1500);
        if (hello.proto !== PROTO_VERSION) throw new TelephoneError('proto_mismatch');
        discovery.set(peer.fqdn, { at: now(), hasExchange: true });
      } catch (error) {
        const reason = error instanceof TelephoneError ? error.code : 'unreachable';
        discovery.set(peer.fqdn, { at: now(), hasExchange: reason === 'proto_mismatch', reason });
      }
      return;
    }));
    return all.map(peer => ({ ...peer, hasExchange: discovery.get(peer.fqdn)?.hasExchange ?? false }));
  }
  function remote<T>(host: string, port: number, path: string, timeout: number, body?: NetworkDelivery): Promise<T> {
    return peerRequest<T>({ host, port, path, timeout, body, fromPort: options.port, localAddress: listening?.address });
  }
  function callerFor(connection: Connection): Caller {
    return { session: connection.registration?.session.name, machine: self, local: true };
  }
  async function directory(connection: Connection): Promise<Directory> {
    const all = await discover();
    const caller = callerFor(connection);
    const entries: Directory['entries'] = [];
    const warnings: string[] = [];
    for (const target of names.values()) {
      const registration = registered(target);
      if (!allows(registration.allow, caller, self.login)) continue;
      const machine = displayMachine(self, self, all);
      entries.push({ address: formatAddress(registration.session.name, machine), session: registration.session.name, machine, fqdn: self.fqdn,
        harness: registration.session.harness, status: registration.status, cwd: registration.session.cwd, local: true, self: target === connection });
    }
    await Promise.all(all.filter(peer => peer.online).map(async peer => {
      const state = discovery.get(peer.fqdn);
      if (!peer.hasExchange) return;
      if (state?.reason) { warnings.push(`${peer.short}: ${state.reason}`); return; }
      try {
        const endpoint = peerEndpoints.get(peer.fqdn);
        const result = await remote<NetworkDirectory>(endpoint?.ip ?? ipv4(peer)!, endpoint?.port ?? config.port, `/v1/directory${caller.session ? `?as=${encodeURIComponent(caller.session)}` : ''}`, 3000);
        const machine = displayMachine(peer, self, all);
        for (const session of result.sessions) entries.push({ ...session, address: formatAddress(session.session, machine), machine, fqdn: peer.fqdn, local: false, self: false });
      } catch (error) {
        const reason = error instanceof TelephoneError ? error.code : 'unreachable';
        if (reason === 'not_trusted') discovery.set(peer.fqdn, { at: now(), hasExchange: true, reason });
        warnings.push(`${peer.short}: ${reason}`);
      }
      return;
    }));
    return { entries, warnings };
  }
  async function resolve(to: string): Promise<Route> {
    const parsed = parseAddress(to);
    let all = await peers();
    if (parsed.machine && all.filter(peer => peer.online && peer.short.toLowerCase() === parsed.machine).length > 1) all = await discover();
    const machine = resolveMachine(parsed.machine, self, all);
    const local = machine.fqdn === self.fqdn;
    const endpoint = peerEndpoints.get(machine.fqdn);
    const ip = endpoint?.ip ?? ipv4(machine);
    if (!local && !ip) throw new TelephoneError('unreachable', 'Machine has no Tailscale IPv4');
    return { session: parsed.session, machine, local, ip, port: endpoint?.port ?? config.port };
  }
  async function send(connection: Connection, request: Extract<Request, { t: 'send' }>) {
    const sender = registered(connection);
    prune();
    if (!isUuid(request.id) || ledger.has(request.id) || inbound.has(request.id) || pendingSends.has(request.id)) throw new TelephoneError('invalid_id');
    if (typeof request.text !== 'string' || (request.expectReply !== undefined && typeof request.expectReply !== 'boolean')) throw new TelephoneError('invalid_request');
    if (Buffer.byteLength(request.text) > config.maxMessageBytes) throw new TelephoneError('too_large');
    const remembered = request.replyTo ? inbound.get(request.replyTo) : undefined;
    if (!request.to && (!remembered || remembered.targetKey !== sender.session.key)) throw new TelephoneError('invalid_address', 'A destination or a received message id is required');
    const pending = { sessionKey: sender.session.key, cancelled: false };
    pendingSends.set(request.id, pending);
    let route: Route;
    try { route = request.to ? await resolve(request.to) : remembered!.route; }
    finally { pendingSends.delete(request.id); }
    if (connection.registration !== sender || connection.socket.destroyed) throw new TelephoneError('not_registered');
    if (remembered && remembered.targetKey === sender.session.key && (!request.to || sameRoute(route, remembered.route))) route = remembered.route;
    let replyTo = request.replyTo;
    let inferredReplyTo: string | undefined;
    if (!replyTo) {
      const candidates = [...inbound.values()].filter(entry => entry.targetKey === sender.session.key && entry.message.expectReply && !entry.answered && sameRoute(route, entry.route));
      if (candidates.length === 1) { replyTo = candidates[0].message.id; inferredReplyTo = replyTo; route = candidates[0].route; }
    }
    if (replyTo !== undefined && !isUuid(replyTo)) throw new TelephoneError('invalid_id');
    // Reserve before delivery, so an immediate reply can be authorized.
    if (ledger.has(request.id) || inbound.has(request.id)) throw new TelephoneError('invalid_id');
    ledger.set(request.id, { at: now(), fromSessionKey: sender.session.key, to: route });
    prune();
    if (request.expectReply && !pending.cancelled) waits.set(request.id, { at: now(), sessionKey: sender.session.key, to: route });
    const message: NetworkDelivery = {
      proto: PROTO_VERSION, id: request.id, from: { session: sender.session.name, harness: sender.session.harness },
      fromPort: options.port, to: { session: route.session }, text: request.text, expectReply: request.expectReply === true, replyTo, sentAt: new Date(now()).toISOString(),
    };
    try {
      if (route.local) await deliver(message, self, true);
      else await remote(route.ip!, route.port, '/v1/deliver', 8000, message);
      if (replyTo) { const entry = inbound.get(replyTo); if (entry?.targetKey === sender.session.key) entry.answered = true; }
      void log(options.home, 'info', `Sent ${request.id} bytes=${Buffer.byteLength(request.text)} to=${address(route)}`);
      return { id: request.id, status: 'delivered', to: address(route), ...(inferredReplyTo ? { inferredReplyTo } : {}) };
    } catch (error) {
      ledger.delete(request.id);
      waits.delete(request.id);
      void log(options.home, 'info', `Refused ${request.id} decision=${error instanceof TelephoneError ? error.code : 'unreachable'}`);
      throw error;
    }
  }
  async function deliver(body: NetworkDelivery, machine: MachineIdentity, localCaller: boolean, sourceIP?: string): Promise<void> {
    prune();
    const target = names.get(body.to.session);
    const registration = target?.registration;
    const route: Route = { session: body.from.session, machine, local: localCaller, ip: sourceIP, port: body.fromPort };
    const previous = body.replyTo ? ledger.get(body.replyTo) : undefined;
    const isReply = !!(registration && previous && previous.fromSessionKey === registration.session.key && sameRoute(previous.to, route));
    if (!isReply && !localCaller && !isTrusted(machine.login, self.login, config.trustedUsers)) throw new TelephoneError('not_trusted');
    if (!target || !registration || (!isReply && !allows(registration.allow, { session: body.from.session, machine, local: localCaller }, self.login))) throw new TelephoneError('not_reachable');
    if (Buffer.byteLength(body.text) > config.maxMessageBytes) throw new TelephoneError('too_large');
    if (inbound.has(body.id) || acks.has(body.id) || (!localCaller && ledger.has(body.id))) throw new TelephoneError('invalid_id');
    const pair = `${machine.fqdn}\0${body.from.session}\0${registration.session.key}`;
    const pairTimes = pairRates.get(pair) ?? [];
    const targetTimes = targetRates.get(registration.session.key) ?? [];
    if (pairTimes.length >= 20 || targetTimes.length >= 120) throw new TelephoneError('rate_limited');
    pairRates.set(pair, [...pairTimes, now()]);
    targetRates.set(registration.session.key, [...targetTimes, now()]);
    if (body.expectReply) {
      for (const [id, wait] of waits) {
        if (wait.sessionKey === registration.session.key && sameRoute(wait.to, route) && body.replyTo !== id) {
          throw new TelephoneError('busy_waiting', `${registration.session.name} is waiting for your reply to message ${id}; answer it with a reply instead.`);
        }
      }
    }
    const fromAddress = address(route);
    const message: InboundMessage = {
      id: body.id, from: { address: fromAddress, session: body.from.session, machine: fromAddress.split('@')[1], fqdn: machine.fqdn,
        login: machine.login, displayName: machine.displayName, harness: body.from.harness, local: localCaller },
      text: body.text, expectReply: body.expectReply, replyTo: body.replyTo, isReplyToOwnCall: isReply, sentAt: body.sentAt,
    };
    // Remember before waking the adapter, which may immediately reply by id.
    inbound.set(body.id, { at: now(), targetKey: registration.session.key, route, message, answered: false });
    if (!localCaller && sourceIP) peerEndpoints.set(machine.fqdn, { ip: sourceIP, port: body.fromPort });
    const accepted = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => finish(false), 5000);
      function finish(accepted: boolean): void { clearTimeout(timer); acks.delete(body.id); resolve(accepted); }
      acks.set(body.id, { connection: target, finish });
      try { writeFrame(target.socket, { t: 'deliver', message }); } catch { finish(false); }
    });
    if (!accepted) { inbound.delete(body.id); throw new TelephoneError('delivery_failed', 'Recipient rejected the message or did not acknowledge it'); }
    if (isReply && body.replyTo) waits.delete(body.replyTo);
  }
  async function handleNetwork(input: HttpInput): Promise<HttpOutput> {
    if (!options.identity.isTailnetAddress(input.sourceIP) || self.ips.includes(input.sourceIP)) throw new TelephoneError('forbidden');
    const isDelivery = input.method === 'POST' && input.url.pathname === '/v1/deliver';
    const fromPort = isDelivery && isObject(input.body) && typeof input.body.fromPort === 'number' ? input.body.fromPort : input.fromPort;
    const machine = await options.identity.whois(input.sourceIP, { fromPort });
    if (!machine) throw new TelephoneError('forbidden');
    discovery.set(machine.fqdn, { at: now(), hasExchange: true });
    const body = isDelivery ? validateDelivery(input.body) : undefined;
    if (input.method === 'GET' && input.url.pathname === '/v1/hello') return { body: { proto: PROTO_VERSION, version: VERSION, machine: machineInfo() } };
    if (body) { await deliver(body, machine, false, input.sourceIP); return { body: { status: 'delivered' } }; }
    if (!isTrusted(machine.login, self.login, config.trustedUsers)) throw new TelephoneError('not_trusted');
    if (input.method === 'GET' && input.url.pathname === '/v1/directory') {
      const session = input.url.searchParams.get('as') ?? undefined;
      if (session !== undefined && !validName(session)) throw new TelephoneError('invalid_request');
      const caller: Caller = { session, machine, local: false };
      return { body: { sessions: [...names.values()].flatMap(connection => {
        const registration = registered(connection);
        if (!allows(registration.allow, caller, self.login)) return [];
        return [{ session: registration.session.name, harness: registration.session.harness, status: registration.status,
          ...(machine.login.toLowerCase() === self.login.toLowerCase() ? { cwd: registration.session.cwd } : {}) }];
      }) } };
    }
    return { status: 404, body: { error: 'not_reachable' } };
  }
  function machineInfo(): ExchangeInfo['machine'] { return { fqdn: self.fqdn, short: self.short, login: self.login }; }
  async function handleLocal(connection: Connection, request: Request): Promise<Record<string, unknown>> {
    await initialRefresh;
    if (request.t === 'hello') {
      if (request.proto !== PROTO_VERSION) throw new TelephoneError('proto_mismatch');
      connection.hello = true;
      return { exchange: { proto: PROTO_VERSION, version: VERSION, machine: machineInfo(), listening } };
    }
    if (!connection.hello) throw new TelephoneError('hello_required');
    switch (request.t) {
      case 'register': {
        const { session } = request;
        if (!session || !validName(session.name)) throw new TelephoneError('invalid_name');
        if (typeof session.key !== 'string' || !session.key || typeof session.cwd !== 'string' || !Number.isInteger(session.hostPid) || !validHarness(session.harness)) throw new TelephoneError('invalid_request');
        const allow = request.allow ?? ['owner'];
        validateAllow(allow);
        if ((names.has(session.name) && names.get(session.name) !== connection) || [...names.values()].some(other => other !== connection && other.registration?.session.key === session.key)) throw new TelephoneError('name_taken');
        unregister(connection);
        connection.registration = { session: { ...session }, allow: [...allow], status: 'idle' };
        names.set(session.name, connection);
        return { address: ownAddress(connection) };
      }
      case 'update': {
        const registration = registered(connection);
        if (request.name !== undefined) {
          if (!validName(request.name)) throw new TelephoneError('invalid_name');
          if (names.has(request.name) && names.get(request.name) !== connection) throw new TelephoneError('name_taken');
        }
        if (request.allow !== undefined) validateAllow(request.allow);
        if (request.status !== undefined && request.status !== 'idle' && request.status !== 'busy') throw new TelephoneError('invalid_request');
        if (request.name !== undefined) { names.delete(registration.session.name); registration.session.name = request.name; names.set(request.name, connection); }
        if (request.allow !== undefined) registration.allow = [...request.allow];
        if (request.status !== undefined) registration.status = request.status;
        return { address: ownAddress(connection) };
      }
      case 'unregister': unregister(connection); return {};
      case 'directory': return { ...await directory(connection) };
      case 'send': return send(connection, request);
      case 'cancelWait': {
        const key = registered(connection).session.key;
        if (waits.get(request.id)?.sessionKey === key) waits.delete(request.id);
        const pending = pendingSends.get(request.id);
        if (pending?.sessionKey === key) pending.cancelled = true;
        return {};
      }
      case 'getConfig': return { config: { ...config, trustedUsers: [...config.trustedUsers] }, owner: self.login };
      case 'setTrustedUsers': {
        for (const list of [request.add, request.remove]) if (list !== undefined && (!Array.isArray(list) || !list.every(user => typeof user === 'string' && !!user.trim() && !/\s/.test(user)))) throw new TelephoneError('invalid_request');
        const write = configWrites.then(async () => {
          const users = new Set(config.trustedUsers.map(user => user.toLowerCase()));
          for (const user of request.add ?? []) users.add(user.toLowerCase());
          for (const user of request.remove ?? []) users.delete(user.toLowerCase());
          const next = { ...config, trustedUsers: [...users] };
          await saveConfig(options.home, next);
          config = next;
        });
        configWrites = write.catch(() => {});
        await write;
        return { trustedUsers: [...config.trustedUsers] };
      }
      case 'shutdown': return {};
      default: throw new TelephoneError('invalid_request');
    }
  }
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await prepareHome(options.home);
    config = await loadConfig(options.home);
    await new Promise<void>((resolve, reject) => {
      local.once('error', reject);
      local.listen(p.socket, () => { local.off('error', reject); ownsSocket = true; resolve(); });
    });
    try {
      await chmod(p.socket, 0o600);
      networkRefresh = refreshNetwork();
      await networkRefresh;
    } finally { initialRefreshDone(); }
    if (stopping) return;
    retryTimer = setInterval(() => { networkRefresh = refreshNetwork(); }, 30000);
    scheduleIdle();
  }
  function stop(): Promise<void> {
    stopping ??= (async () => {
      clearInterval(retryTimer);
      clearTimeout(idleTimer);
      for (const connection of connections) connection.socket.destroy();
      await networkRefresh;
      if (network) await closeServer(network);
      await new Promise<void>(resolve => local.close(() => resolve()));
      if (ownsSocket) await unlink(p.socket).catch(() => {});
      await configWrites;
    })();
    return stopping;
  }
  return { start, stop };
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validHarness(value: unknown): value is Harness { return value === 'pi' || value === 'claude-code' || value === 'cli'; }
function validateDelivery(value: unknown): NetworkDelivery {
  if (!isObject(value) || !isObject(value.from) || !isObject(value.to) || !validName(value.from.session) || !validName(value.to.session) ||
      !validHarness(value.from.harness) || typeof value.text !== 'string' || typeof value.expectReply !== 'boolean' ||
      typeof value.sentAt !== 'string' || !Number.isFinite(Date.parse(value.sentAt)) ||
      typeof value.fromPort !== 'number' || !Number.isInteger(value.fromPort) || value.fromPort < 1 || value.fromPort > 65535) throw new TelephoneError('invalid_request');
  if (value.proto !== PROTO_VERSION) throw new TelephoneError('proto_mismatch');
  if (!isUuid(value.id) || (value.replyTo !== undefined && !isUuid(value.replyTo))) throw new TelephoneError('invalid_id');
  return {
    proto: value.proto, id: value.id, from: { session: value.from.session, harness: value.from.harness },
    fromPort: value.fromPort, to: { session: value.to.session }, text: value.text,
    expectReply: value.expectReply, replyTo: value.replyTo, sentAt: value.sentAt,
  };
}

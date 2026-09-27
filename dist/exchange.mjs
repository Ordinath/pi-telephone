// src/exchange/main.ts
import { open, readFile as readFile2, stat, unlink as unlink2 } from "node:fs/promises";

// src/config.ts
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
var DEFAULT_CONFIG = { port: 47474, trustedUsers: [], tailscaleCli: null, maxMessageBytes: 262144 };
function homePath(home) {
  return resolve(home ?? process.env.PI_TELEPHONE_HOME ?? join(homedir(), ".pi-telephone"));
}
function paths(home) {
  const root = homePath(home);
  const normal = join(root, "exchange.sock");
  const socket = Buffer.byteLength(normal) <= 100 ? normal : join(tmpdir(), `pi-telephone-${process.getuid?.() ?? "user"}`, "exchange.sock");
  return { home: root, socket, socketPath: join(root, "socket-path"), lock: join(root, "exchange.lock"), config: join(root, "config.json"), log: join(root, "exchange.log") };
}
async function prepareHome(home) {
  const p2 = paths(home);
  await mkdir(p2.home, { recursive: true, mode: 448 });
  await chmod(p2.home, 448);
  if (p2.socket !== join(p2.home, "exchange.sock")) {
    const directory = join(p2.socket, "..");
    await mkdir(directory, { recursive: true, mode: 448 });
    await chmod(directory, 448);
    await writeFile(p2.socketPath, p2.socket, { mode: 384 });
  }
}
function isFsError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
async function loadConfig(home) {
  try {
    const value = JSON.parse(await readFile(paths(home).config, "utf8"));
    const config = { ...DEFAULT_CONFIG, ...value };
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !Number.isInteger(config.maxMessageBytes) || config.maxMessageBytes < 1 || !Array.isArray(config.trustedUsers) || !config.trustedUsers.every((user) => typeof user === "string" && !!user.trim()) || !(config.tailscaleCli === null || typeof config.tailscaleCli === "string")) throw new Error("Invalid config.json");
    return config;
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error;
    const config = { ...DEFAULT_CONFIG, trustedUsers: [] };
    await saveConfig(home, config);
    return config;
  }
}
async function saveConfig(home, config) {
  const path = paths(home).config;
  await writeFile(`${path}.tmp`, `${JSON.stringify(config, null, 2)}
`, { mode: 384 });
  await rename(`${path}.tmp`, path);
}
async function log(home, level, message) {
  const { appendFile, stat: stat2 } = await import("node:fs/promises");
  const path = paths(home).log;
  try {
    if ((await stat2(path)).size >= 5 * 1024 * 1024) await rename(path, `${path}.1`);
  } catch (error) {
    if (!isFsError(error, "ENOENT")) return;
  }
  await appendFile(path, `${(/* @__PURE__ */ new Date()).toISOString()} ${level} ${message.replace(/[\r\n]/g, " ")}
`, { mode: 384 }).catch(() => {
  });
}

// src/identity.ts
import { execFile } from "node:child_process";
import { isIP as isIP2 } from "node:net";
import { promisify } from "node:util";

// src/addresses.ts
import { isIP } from "node:net";

// src/protocol.ts
var PROTO_VERSION = 1;
var VERSION = false ? "0.1.0" : "0.1.0";
var TelephoneError = class extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
    this.name = "TelephoneError";
  }
};
function isUuid(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

// src/addresses.ts
function validName(name) {
  return typeof name === "string" && /^[a-z0-9][a-z0-9._-]{0,47}$/.test(name);
}
function normalizeMachine(value) {
  return value.toLowerCase().replace(/\.$/, "");
}
function parseAddress(value) {
  if (typeof value !== "string") throw new TelephoneError("invalid_address");
  const parts = value.split("@");
  if (parts.length > 2 || !validName(parts[0]) || parts.length === 2 && !parts[1]) {
    throw new TelephoneError("invalid_address");
  }
  return { session: parts[0], machine: parts[1] && normalizeMachine(parts[1]) };
}
function formatAddress(session, machine2) {
  return `${session}@${machine2}`;
}
function displayMachine(machine2, self, peers) {
  const active = [self, ...peers.filter((peer) => peer.online && peer.hasExchange)];
  return active.some((peer) => peer.fqdn !== machine2.fqdn && peer.short === machine2.short) ? machine2.fqdn : machine2.short;
}
function resolveMachine(value, self, peers) {
  const name = value && normalizeMachine(value);
  if (!name || name === self.fqdn.toLowerCase() || name === self.short.toLowerCase()) return self;
  const exact = peers.find((peer) => normalizeMachine(peer.fqdn) === name);
  if (exact) return exact;
  const matches = peers.filter((peer) => peer.online && peer.short.toLowerCase() === name);
  const running = matches.filter((peer) => peer.hasExchange);
  const candidates = running.length ? running : matches;
  if (candidates.length === 1) return candidates[0];
  const ipMatch = peers.find((peer) => peer.ips.some((ip) => ip.toLowerCase() === name));
  if (ipMatch) return ipMatch;
  throw new TelephoneError("unknown_machine", `Cannot resolve ${value}. Candidates: ${(candidates.length ? candidates : peers).map((peer) => peer.fqdn).join(", ") || "none"}`);
}
function ipv4(machine2) {
  return machine2.ips.find((ip) => isIP(ip) === 4);
}

// src/identity.ts
function machine(name, ips, user) {
  if (!name || !user?.LoginName || !Array.isArray(ips) || !ips.length) throw new Error("Incomplete Tailscale identity");
  const fqdn = normalizeMachine(name);
  return { fqdn, short: fqdn.split(".")[0], login: user.LoginName, displayName: user.DisplayName, ips };
}
function parseStatus(value) {
  if (value.BackendState !== void 0 && value.BackendState !== "Running") throw new Error("Tailscale is not running");
  const parseNode = (node) => machine(node.DNSName, node.TailscaleIPs, value.User[String(node.UserID)]);
  const self = parseNode(value.Self);
  const peers = [];
  for (const node of Object.values(value.Peer ?? {})) {
    try {
      peers.push({ ...parseNode(node), online: node.Online === true });
    } catch {
    }
  }
  return { self: { ...self, ipv4: ipv4(self) }, peers };
}
function parseWhois(value) {
  return machine(value.Node.Name, value.Node.Addresses.map((address) => address.split("/")[0]), value.UserProfile);
}
var exec = promisify(execFile);
var TailscaleIdentityProvider = class {
  constructor(tailscaleCli = null) {
    this.tailscaleCli = tailscaleCli;
  }
  executable;
  status;
  pendingStatus;
  identities = /* @__PURE__ */ new Map();
  async command(args) {
    this.executable ??= this.resolveCli();
    const { stdout } = await exec(await this.executable, args, { timeout: 5e3, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }
  async resolveCli() {
    if (this.tailscaleCli) return this.tailscaleCli;
    for (const executable of ["tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
      try {
        await exec(executable, ["version"], { timeout: 5e3 });
        return executable;
      } catch {
      }
    }
    this.executable = void 0;
    throw new Error("Tailscale CLI is unavailable");
  }
  async getStatus() {
    if (this.status && this.status.expires > Date.now()) return this.status.value;
    this.pendingStatus ??= this.command(["status", "--json"]).then((output) => {
      const value = parseStatus(JSON.parse(output));
      this.status = { expires: Date.now() + 3e4, value };
      return value;
    }).finally(() => {
      this.pendingStatus = void 0;
    });
    return this.pendingStatus;
  }
  async self() {
    return (await this.getStatus()).self;
  }
  async peers() {
    return (await this.getStatus()).peers;
  }
  async whois(ip) {
    const cached = this.identities.get(ip);
    if (cached && cached.expires > Date.now()) return cached.value;
    let value;
    try {
      value = parseWhois(JSON.parse(await this.command(["whois", "--json", ip])));
    } catch {
      value = void 0;
    }
    this.identities.set(ip, { expires: Date.now() + (value ? 3e5 : 3e4), value });
    return value;
  }
  isTailnetAddress(ip) {
    if (isIP2(ip) === 4) {
      const parts = ip.split(".").map(Number);
      return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
    }
    return isIP2(ip) === 6 && /^fd7a:115c:a1e0:/i.test(ip);
  }
};

// src/exchange/exchange.ts
import { chmod as chmod2, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { createServer as createServer2 } from "node:net";

// src/ndjson.ts
var MAX_LINE_BYTES = 1024 * 1024;
function writeFrame(socket, frame) {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("NDJSON line exceeds 1 MiB");
  socket.write(`${line}
`);
}
function readFrames(socket, receive) {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      try {
        receive(JSON.parse(line.toString("utf8")));
      } catch {
        socket.destroy();
        return;
      }
    }
    if (pending.length > MAX_LINE_BYTES) socket.destroy();
  });
}

// src/policy.ts
function parseAllowEntry(value) {
  if (value === "owner" || value === "local") return { kind: value };
  if (value === "*") return { kind: "any" };
  if (value.startsWith("user:") && value.length > 5 && !/\s/.test(value)) {
    return { kind: "user", login: value.slice(5).toLowerCase() };
  }
  const parts = value.split("@");
  if (parts.length === 2 && (parts[0] === "*" || validName(parts[0])) && (parts[1] === "*" || /^[a-z0-9][a-z0-9._-]*\.?$/i.test(parts[1]))) {
    return { kind: "address", session: parts[0], machine: normalizeMachine(parts[1]) };
  }
  throw new TelephoneError("invalid_allow", `Invalid allowlist entry: ${value}`);
}
function validateAllow(allow) {
  if (!Array.isArray(allow) || !allow.every((entry) => typeof entry === "string")) throw new TelephoneError("invalid_allow");
  allow.forEach(parseAllowEntry);
}
function isTrusted(login, owner, trustedUsers) {
  const value = login.toLowerCase();
  return !!value && (value === owner.toLowerCase() || trustedUsers.some((user) => user.toLowerCase() === value));
}
function allows(allow, caller, owner) {
  return allow.some((value) => {
    const entry = parseAllowEntry(value);
    switch (entry.kind) {
      case "owner":
        return caller.local || !!owner && caller.machine.login.toLowerCase() === owner.toLowerCase();
      case "local":
        return caller.local;
      case "any":
        return true;
      case "user":
        return caller.machine.login.toLowerCase() === entry.login;
      case "address":
        return (entry.session === "*" || entry.session === caller.session) && (entry.machine === "*" || entry.machine === normalizeMachine(caller.machine.fqdn) || entry.machine === caller.machine.short.toLowerCase());
    }
  });
}

// src/exchange/http.ts
import { createServer, request } from "node:http";
var errorStatus = {
  forbidden: 403,
  not_trusted: 403,
  not_reachable: 404,
  busy_waiting: 409,
  too_large: 413,
  rate_limited: 429,
  delivery_failed: 502,
  invalid_id: 400,
  proto_mismatch: 400,
  invalid_request: 400
};
function normalizedIP(ip) {
  return ip.replace(/^::ffff:/, "");
}
function networkServer(maxBytes, handle) {
  const server = createServer((req, res) => {
    const timer = setTimeout(() => {
      req.destroy();
      res.destroy();
    }, 1e4);
    res.on("close", () => clearTimeout(timer));
    void serve(req, res, maxBytes, handle);
  });
  server.requestTimeout = 1e4;
  server.headersTimeout = 1e4;
  return server;
}
async function serve(req, res, maxBytes, handle) {
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxBytes) throw new TelephoneError("too_large");
      chunks.push(chunk);
    }
    let body;
    if (size) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new TelephoneError("invalid_request");
      }
    }
    const header = req.headers["x-telephone-from-port"];
    const port = typeof header === "string" ? Number(header) : void 0;
    const result = await handle({
      method: req.method ?? "",
      url: new URL(req.url ?? "/", "http://exchange"),
      sourceIP: normalizedIP(req.socket.remoteAddress ?? ""),
      fromPort: port && Number.isInteger(port) && port <= 65535 ? port : void 0,
      body
    });
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  } catch (error) {
    const code = error instanceof TelephoneError ? error.code : "invalid_request";
    res.writeHead(errorStatus[code] ?? 400, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ error: code, message: error instanceof TelephoneError ? error.message : "Invalid request" }));
    req.resume();
  }
}
function peerRequest(options) {
  return new Promise((resolve2, reject) => {
    const body = options.body === void 0 ? void 0 : JSON.stringify(options.body);
    const req = request({
      host: options.host,
      port: options.port,
      path: options.path,
      method: body === void 0 ? "GET" : "POST",
      localAddress: options.localAddress,
      agent: false,
      headers: { "content-type": "application/json", "x-telephone-from-port": String(options.fromPort), ...body ? { "content-length": Buffer.byteLength(body) } : {} }
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > (options.maxBytes ?? 1024 * 1024)) {
          req.destroy(new TelephoneError("unreachable", "Peer response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200) reject(new TelephoneError(typeof value.error === "string" ? value.error : "unreachable", value.message));
          else resolve2(value);
        } catch {
          reject(new TelephoneError("unreachable", "Invalid peer response"));
        }
      });
    });
    const timer = setTimeout(() => req.destroy(new TelephoneError("unreachable", "Peer request timed out")), options.timeout);
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof TelephoneError ? error : new TelephoneError("unreachable", error.message));
    });
    req.on("close", () => clearTimeout(timer));
    req.end(body);
  });
}
async function listen(server, host, port) {
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve2();
    });
  });
}
async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve2) => server.close(() => resolve2()));
}

// src/exchange/exchange.ts
function createExchange(options) {
  if (options.listenHost !== void 0 && options.listenHost !== "127.0.0.1") throw new Error("listenHost is only for loopback tests");
  const now = options.now ?? Date.now;
  const p2 = paths(options.home);
  let config;
  let self = { fqdn: hostname().toLowerCase(), short: hostname().split(".")[0].toLowerCase(), login: "", ips: [] };
  let listening = null;
  let network;
  let networkRefresh;
  let initialRefreshDone;
  const initialRefresh = new Promise((resolve3) => {
    initialRefreshDone = resolve3;
  });
  let lastNetworkState;
  let retryTimer;
  let idleTimer;
  let stopping;
  let started = false;
  let ownsSocket = false;
  let configWrites = Promise.resolve();
  const connections = /* @__PURE__ */ new Set();
  const names = /* @__PURE__ */ new Map();
  const ledger = /* @__PURE__ */ new Map();
  const inbound = /* @__PURE__ */ new Map();
  const waits = /* @__PURE__ */ new Map();
  const pendingSends = /* @__PURE__ */ new Map();
  const peerEndpoints = /* @__PURE__ */ new Map();
  const acks = /* @__PURE__ */ new Map();
  const discovery = /* @__PURE__ */ new Map();
  const pairRates = /* @__PURE__ */ new Map();
  const targetRates = /* @__PURE__ */ new Map();
  const local = createServer2((socket) => {
    const connection = { socket, hello: false };
    connections.add(connection);
    clearTimeout(idleTimer);
    socket.on("error", () => {
    });
    socket.on("close", () => {
      connections.delete(connection);
      unregister(connection);
      for (const ack of acks.values()) if (ack.connection === connection) ack.finish(false);
      scheduleIdle();
    });
    readFrames(socket, (frame) => {
      if (!isObject(frame)) {
        socket.destroy();
        return;
      }
      if (frame.t === "ack") {
        const ack = typeof frame.id === "string" ? acks.get(frame.id) : void 0;
        if (ack?.connection === connection) ack.finish(frame.accepted === true);
        return;
      }
      if (typeof frame.rid !== "string" || typeof frame.t !== "string") {
        socket.destroy();
        return;
      }
      const request2 = frame;
      void handleLocal(connection, request2).then((result) => {
        if (!socket.destroyed) writeFrame(socket, { t: "ok", rid: request2.rid, ...result });
        if (request2.t === "shutdown") setImmediate(() => void stop());
      }).catch((error) => {
        if (!socket.destroyed) writeFrame(socket, {
          t: "error",
          rid: request2.rid,
          code: error instanceof TelephoneError ? error.code : "invalid_request",
          message: error instanceof TelephoneError ? error.message : "Invalid request"
        });
      });
    });
  });
  function scheduleIdle() {
    if (stopping || connections.size) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void stop(), options.idleExitMs ?? 6e5);
  }
  function prune() {
    for (const [id, entry] of ledger) if (entry.at <= now() - 864e5) ledger.delete(id);
    for (const [id, entry] of inbound) if (entry.at <= now() - 864e5) inbound.delete(id);
    for (const [id, entry] of waits) if (entry.at <= now() - 36e5) waits.delete(id);
    for (const rates of [pairRates, targetRates]) {
      for (const [key, times] of rates) {
        const active = times.filter((time) => time > now() - 6e4);
        if (active.length) rates.set(key, active);
        else rates.delete(key);
      }
    }
    while (ledger.size > 1e4) ledger.delete(ledger.keys().next().value);
  }
  function sameRoute(a, b) {
    return a.session === b.session && a.local === b.local && a.machine.fqdn.toLowerCase() === b.machine.fqdn.toLowerCase();
  }
  function address(route) {
    const known = [...discovery].filter(([, entry]) => entry.hasExchange).map(([fqdn]) => ({ fqdn, short: fqdn.split(".")[0], login: "", ips: [], online: true, hasExchange: true }));
    return formatAddress(route.session, displayMachine(route.machine, self, known));
  }
  function ownAddress(connection) {
    return address({ session: registered(connection).session.name, machine: self, local: true, port: options.port });
  }
  function registered(connection) {
    if (!connection.registration) throw new TelephoneError("not_registered");
    return connection.registration;
  }
  function unregister(connection) {
    if (!connection.registration) return;
    const { session } = connection.registration;
    if (names.get(session.name) === connection) names.delete(session.name);
    for (const [id, wait] of waits) if (wait.sessionKey === session.key) waits.delete(id);
    for (const send2 of pendingSends.values()) if (send2.sessionKey === session.key) send2.cancelled = true;
    connection.registration = void 0;
  }
  function logNetworkState() {
    const address2 = listening?.address ?? null;
    if (lastNetworkState === address2) return;
    lastNetworkState = address2;
    void log(options.home, "info", address2 ? `Listening on ${address2}:${options.port}` : "Running local-only");
  }
  async function refreshNetwork() {
    if (stopping) return;
    try {
      const current = await options.identity.self();
      if (stopping) return;
      self = current;
      const host = options.listenHost ?? current.ipv4;
      if (host && !options.listenHost && !options.identity.isTailnetAddress(host)) throw new Error("Not a Tailscale address");
      if (host === listening?.address) return;
      if (network) {
        await closeServer(network);
        network = void 0;
        listening = null;
      }
      if (!host) {
        logNetworkState();
        return;
      }
      const server = networkServer(config.maxMessageBytes + 16384, handleNetwork);
      try {
        await listen(server, host, options.port);
      } catch (error) {
        await closeServer(server);
        throw error;
      }
      network = server;
      listening = { address: host, port: options.port };
      logNetworkState();
    } catch {
      if (network) await closeServer(network);
      network = void 0;
      listening = null;
      logNetworkState();
    }
  }
  async function peers() {
    try {
      return await options.identity.peers();
    } catch {
      return [];
    }
  }
  async function discover() {
    const all = await peers();
    await Promise.all(all.filter((peer) => peer.online).map(async (peer) => {
      const cached = discovery.get(peer.fqdn);
      if (cached && cached.at > now() - (cached.hasExchange ? 6e4 : 1e4)) return;
      const endpoint = peerEndpoints.get(peer.fqdn);
      const ip = endpoint?.ip ?? ipv4(peer);
      if (!ip) {
        discovery.set(peer.fqdn, { at: now(), hasExchange: false, reason: "No Tailscale IPv4" });
        return;
      }
      try {
        const hello = await remote(ip, endpoint?.port ?? config.port, "/v1/hello", 1500);
        if (hello.proto !== PROTO_VERSION) throw new TelephoneError("proto_mismatch");
        discovery.set(peer.fqdn, { at: now(), hasExchange: true });
      } catch (error) {
        const reason = error instanceof TelephoneError ? error.code : "unreachable";
        discovery.set(peer.fqdn, { at: now(), hasExchange: reason === "proto_mismatch", reason });
      }
      return;
    }));
    return all.map((peer) => ({ ...peer, hasExchange: discovery.get(peer.fqdn)?.hasExchange ?? false }));
  }
  function remote(host, port, path, timeout, body) {
    return peerRequest({ host, port, path, timeout, body, fromPort: options.port, localAddress: listening?.address });
  }
  function callerFor(connection) {
    return { session: connection.registration?.session.name, machine: self, local: true };
  }
  async function directory(connection) {
    const all = await discover();
    const caller = callerFor(connection);
    const entries = [];
    const warnings = [];
    for (const target of names.values()) {
      const registration = registered(target);
      if (!allows(registration.allow, caller, self.login)) continue;
      const machine2 = displayMachine(self, self, all);
      entries.push({
        address: formatAddress(registration.session.name, machine2),
        session: registration.session.name,
        machine: machine2,
        fqdn: self.fqdn,
        harness: registration.session.harness,
        status: registration.status,
        cwd: registration.session.cwd,
        local: true,
        self: target === connection
      });
    }
    await Promise.all(all.filter((peer) => peer.online).map(async (peer) => {
      const state = discovery.get(peer.fqdn);
      if (!peer.hasExchange) return;
      if (state?.reason) {
        warnings.push(`${peer.short}: ${state.reason}`);
        return;
      }
      try {
        const endpoint = peerEndpoints.get(peer.fqdn);
        const result = await remote(endpoint?.ip ?? ipv4(peer), endpoint?.port ?? config.port, `/v1/directory${caller.session ? `?as=${encodeURIComponent(caller.session)}` : ""}`, 3e3);
        const machine2 = displayMachine(peer, self, all);
        for (const session of result.sessions) entries.push({ ...session, address: formatAddress(session.session, machine2), machine: machine2, fqdn: peer.fqdn, local: false, self: false });
      } catch (error) {
        const reason = error instanceof TelephoneError ? error.code : "unreachable";
        if (reason === "not_trusted") discovery.set(peer.fqdn, { at: now(), hasExchange: true, reason });
        warnings.push(`${peer.short}: ${reason}`);
      }
      return;
    }));
    return { entries, warnings };
  }
  async function resolve2(to) {
    const parsed = parseAddress(to);
    let all = await peers();
    if (parsed.machine && all.filter((peer) => peer.online && peer.short.toLowerCase() === parsed.machine).length > 1) all = await discover();
    const machine2 = resolveMachine(parsed.machine, self, all);
    const local2 = machine2.fqdn === self.fqdn;
    const endpoint = peerEndpoints.get(machine2.fqdn);
    const ip = endpoint?.ip ?? ipv4(machine2);
    if (!local2 && !ip) throw new TelephoneError("unreachable", "Machine has no Tailscale IPv4");
    return { session: parsed.session, machine: machine2, local: local2, ip, port: endpoint?.port ?? config.port };
  }
  async function send(connection, request2) {
    const sender = registered(connection);
    prune();
    if (!isUuid(request2.id) || ledger.has(request2.id) || inbound.has(request2.id) || pendingSends.has(request2.id)) throw new TelephoneError("invalid_id");
    if (typeof request2.text !== "string" || request2.expectReply !== void 0 && typeof request2.expectReply !== "boolean") throw new TelephoneError("invalid_request");
    if (Buffer.byteLength(request2.text) > config.maxMessageBytes) throw new TelephoneError("too_large");
    const remembered = request2.replyTo ? inbound.get(request2.replyTo) : void 0;
    if (!request2.to && (!remembered || remembered.targetKey !== sender.session.key)) throw new TelephoneError("invalid_address", "A destination or a received message id is required");
    const pending = { sessionKey: sender.session.key, cancelled: false };
    pendingSends.set(request2.id, pending);
    let route;
    try {
      route = request2.to ? await resolve2(request2.to) : remembered.route;
    } finally {
      pendingSends.delete(request2.id);
    }
    if (connection.registration !== sender || connection.socket.destroyed) throw new TelephoneError("not_registered");
    if (remembered && remembered.targetKey === sender.session.key && (!request2.to || sameRoute(route, remembered.route))) route = remembered.route;
    let replyTo = request2.replyTo;
    let inferredReplyTo;
    if (!replyTo) {
      const candidates = [...inbound.values()].filter((entry) => entry.targetKey === sender.session.key && entry.message.expectReply && !entry.answered && sameRoute(route, entry.route));
      if (candidates.length === 1) {
        replyTo = candidates[0].message.id;
        inferredReplyTo = replyTo;
        route = candidates[0].route;
      }
    }
    if (replyTo !== void 0 && !isUuid(replyTo)) throw new TelephoneError("invalid_id");
    if (ledger.has(request2.id) || inbound.has(request2.id)) throw new TelephoneError("invalid_id");
    ledger.set(request2.id, { at: now(), fromSessionKey: sender.session.key, to: route });
    prune();
    if (request2.expectReply && !pending.cancelled) waits.set(request2.id, { at: now(), sessionKey: sender.session.key, to: route });
    const message = {
      proto: PROTO_VERSION,
      id: request2.id,
      from: { session: sender.session.name, harness: sender.session.harness },
      fromPort: options.port,
      to: { session: route.session },
      text: request2.text,
      expectReply: request2.expectReply === true,
      replyTo,
      sentAt: new Date(now()).toISOString()
    };
    try {
      if (route.local) await deliver(message, self, true);
      else await remote(route.ip, route.port, "/v1/deliver", 8e3, message);
      if (replyTo) {
        const entry = inbound.get(replyTo);
        if (entry?.targetKey === sender.session.key) entry.answered = true;
      }
      void log(options.home, "info", `Sent ${request2.id} bytes=${Buffer.byteLength(request2.text)} to=${address(route)}`);
      return { id: request2.id, status: "delivered", to: address(route), ...inferredReplyTo ? { inferredReplyTo } : {} };
    } catch (error) {
      ledger.delete(request2.id);
      waits.delete(request2.id);
      void log(options.home, "info", `Refused ${request2.id} decision=${error instanceof TelephoneError ? error.code : "unreachable"}`);
      throw error;
    }
  }
  async function deliver(body, machine2, localCaller, sourceIP) {
    prune();
    const target = names.get(body.to.session);
    const registration = target?.registration;
    const route = { session: body.from.session, machine: machine2, local: localCaller, ip: sourceIP, port: body.fromPort };
    const previous = body.replyTo ? ledger.get(body.replyTo) : void 0;
    const isReply = !!(registration && previous && previous.fromSessionKey === registration.session.key && sameRoute(previous.to, route));
    if (!isReply && !localCaller && !isTrusted(machine2.login, self.login, config.trustedUsers)) throw new TelephoneError("not_trusted");
    if (!target || !registration || !isReply && !allows(registration.allow, { session: body.from.session, machine: machine2, local: localCaller }, self.login)) throw new TelephoneError("not_reachable");
    if (Buffer.byteLength(body.text) > config.maxMessageBytes) throw new TelephoneError("too_large");
    if (inbound.has(body.id) || acks.has(body.id) || !localCaller && ledger.has(body.id)) throw new TelephoneError("invalid_id");
    const pair = `${machine2.fqdn}\0${body.from.session}\0${registration.session.key}`;
    const pairTimes = pairRates.get(pair) ?? [];
    const targetTimes = targetRates.get(registration.session.key) ?? [];
    if (pairTimes.length >= 20 || targetTimes.length >= 120) throw new TelephoneError("rate_limited");
    pairRates.set(pair, [...pairTimes, now()]);
    targetRates.set(registration.session.key, [...targetTimes, now()]);
    if (body.expectReply) {
      for (const [id, wait] of waits) {
        if (wait.sessionKey === registration.session.key && sameRoute(wait.to, route) && body.replyTo !== id) {
          throw new TelephoneError("busy_waiting", `${registration.session.name} is waiting for your reply to message ${id}; answer it with a reply instead.`);
        }
      }
    }
    const fromAddress = address(route);
    const message = {
      id: body.id,
      from: {
        address: fromAddress,
        session: body.from.session,
        machine: fromAddress.split("@")[1],
        fqdn: machine2.fqdn,
        login: machine2.login,
        displayName: machine2.displayName,
        harness: body.from.harness,
        local: localCaller
      },
      text: body.text,
      expectReply: body.expectReply,
      replyTo: body.replyTo,
      isReplyToOwnCall: isReply,
      sentAt: body.sentAt
    };
    inbound.set(body.id, { at: now(), targetKey: registration.session.key, route, message, answered: false });
    if (!localCaller && sourceIP) peerEndpoints.set(machine2.fqdn, { ip: sourceIP, port: body.fromPort });
    const accepted = await new Promise((resolve3) => {
      const timer = setTimeout(() => finish(false), 5e3);
      function finish(accepted2) {
        clearTimeout(timer);
        acks.delete(body.id);
        resolve3(accepted2);
      }
      acks.set(body.id, { connection: target, finish });
      try {
        writeFrame(target.socket, { t: "deliver", message });
      } catch {
        finish(false);
      }
    });
    if (!accepted) {
      inbound.delete(body.id);
      throw new TelephoneError("delivery_failed", "Recipient rejected the message or did not acknowledge it");
    }
    if (isReply && body.replyTo) waits.delete(body.replyTo);
  }
  async function handleNetwork(input) {
    if (!options.identity.isTailnetAddress(input.sourceIP) || self.ips.includes(input.sourceIP)) throw new TelephoneError("forbidden");
    const isDelivery = input.method === "POST" && input.url.pathname === "/v1/deliver";
    const fromPort = isDelivery && isObject(input.body) && typeof input.body.fromPort === "number" ? input.body.fromPort : input.fromPort;
    const machine2 = await options.identity.whois(input.sourceIP, { fromPort });
    if (!machine2) throw new TelephoneError("forbidden");
    discovery.set(machine2.fqdn, { at: now(), hasExchange: true });
    const body = isDelivery ? validateDelivery(input.body) : void 0;
    if (input.method === "GET" && input.url.pathname === "/v1/hello") return { body: { proto: PROTO_VERSION, version: VERSION, machine: machineInfo() } };
    if (body) {
      await deliver(body, machine2, false, input.sourceIP);
      return { body: { status: "delivered" } };
    }
    if (!isTrusted(machine2.login, self.login, config.trustedUsers)) throw new TelephoneError("not_trusted");
    if (input.method === "GET" && input.url.pathname === "/v1/directory") {
      const session = input.url.searchParams.get("as") ?? void 0;
      if (session !== void 0 && !validName(session)) throw new TelephoneError("invalid_request");
      const caller = { session, machine: machine2, local: false };
      return { body: { sessions: [...names.values()].flatMap((connection) => {
        const registration = registered(connection);
        if (!allows(registration.allow, caller, self.login)) return [];
        return [{
          session: registration.session.name,
          harness: registration.session.harness,
          status: registration.status,
          ...machine2.login.toLowerCase() === self.login.toLowerCase() ? { cwd: registration.session.cwd } : {}
        }];
      }) } };
    }
    return { status: 404, body: { error: "not_reachable" } };
  }
  function machineInfo() {
    return { fqdn: self.fqdn, short: self.short, login: self.login };
  }
  async function handleLocal(connection, request2) {
    await initialRefresh;
    if (request2.t === "hello") {
      if (request2.proto !== PROTO_VERSION) throw new TelephoneError("proto_mismatch");
      connection.hello = true;
      return { exchange: { proto: PROTO_VERSION, version: VERSION, machine: machineInfo(), listening } };
    }
    if (!connection.hello) throw new TelephoneError("hello_required");
    switch (request2.t) {
      case "register": {
        const { session } = request2;
        if (!session || !validName(session.name)) throw new TelephoneError("invalid_name");
        if (typeof session.key !== "string" || !session.key || typeof session.cwd !== "string" || !Number.isInteger(session.hostPid) || !validHarness(session.harness)) throw new TelephoneError("invalid_request");
        const allow = request2.allow ?? ["owner"];
        validateAllow(allow);
        if (names.has(session.name) && names.get(session.name) !== connection || [...names.values()].some((other) => other !== connection && other.registration?.session.key === session.key)) throw new TelephoneError("name_taken");
        unregister(connection);
        connection.registration = { session: { ...session }, allow: [...allow], status: "idle" };
        names.set(session.name, connection);
        return { address: ownAddress(connection) };
      }
      case "update": {
        const registration = registered(connection);
        if (request2.name !== void 0) {
          if (!validName(request2.name)) throw new TelephoneError("invalid_name");
          if (names.has(request2.name) && names.get(request2.name) !== connection) throw new TelephoneError("name_taken");
        }
        if (request2.allow !== void 0) validateAllow(request2.allow);
        if (request2.status !== void 0 && request2.status !== "idle" && request2.status !== "busy") throw new TelephoneError("invalid_request");
        if (request2.name !== void 0) {
          names.delete(registration.session.name);
          registration.session.name = request2.name;
          names.set(request2.name, connection);
        }
        if (request2.allow !== void 0) registration.allow = [...request2.allow];
        if (request2.status !== void 0) registration.status = request2.status;
        return { address: ownAddress(connection) };
      }
      case "unregister":
        unregister(connection);
        return {};
      case "directory":
        return { ...await directory(connection) };
      case "send":
        return send(connection, request2);
      case "cancelWait": {
        const key = registered(connection).session.key;
        if (waits.get(request2.id)?.sessionKey === key) waits.delete(request2.id);
        const pending = pendingSends.get(request2.id);
        if (pending?.sessionKey === key) pending.cancelled = true;
        return {};
      }
      case "getConfig":
        return { config: { ...config, trustedUsers: [...config.trustedUsers] }, owner: self.login };
      case "setTrustedUsers": {
        for (const list of [request2.add, request2.remove]) if (list !== void 0 && (!Array.isArray(list) || !list.every((user) => typeof user === "string" && !!user.trim() && !/\s/.test(user)))) throw new TelephoneError("invalid_request");
        const write = configWrites.then(async () => {
          const users = new Set(config.trustedUsers.map((user) => user.toLowerCase()));
          for (const user of request2.add ?? []) users.add(user.toLowerCase());
          for (const user of request2.remove ?? []) users.delete(user.toLowerCase());
          const next = { ...config, trustedUsers: [...users] };
          await saveConfig(options.home, next);
          config = next;
        });
        configWrites = write.catch(() => {
        });
        await write;
        return { trustedUsers: [...config.trustedUsers] };
      }
      case "shutdown":
        return {};
      default:
        throw new TelephoneError("invalid_request");
    }
  }
  async function start() {
    if (started) return;
    started = true;
    await prepareHome(options.home);
    config = await loadConfig(options.home);
    await new Promise((resolve3, reject) => {
      local.once("error", reject);
      local.listen(p2.socket, () => {
        local.off("error", reject);
        ownsSocket = true;
        resolve3();
      });
    });
    try {
      await chmod2(p2.socket, 384);
      networkRefresh = refreshNetwork();
      await networkRefresh;
    } finally {
      initialRefreshDone();
    }
    if (stopping) return;
    retryTimer = setInterval(() => {
      networkRefresh = refreshNetwork();
    }, 3e4);
    scheduleIdle();
  }
  function stop() {
    stopping ??= (async () => {
      clearInterval(retryTimer);
      clearTimeout(idleTimer);
      for (const connection of connections) connection.socket.destroy();
      await networkRefresh;
      if (network) await closeServer(network);
      await new Promise((resolve3) => local.close(() => resolve3()));
      if (ownsSocket) await unlink(p2.socket).catch(() => {
      });
      await configWrites;
    })();
    return stopping;
  }
  return { start, stop };
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validHarness(value) {
  return value === "pi" || value === "claude-code" || value === "cli";
}
function validateDelivery(value) {
  if (!isObject(value) || !isObject(value.from) || !isObject(value.to) || !validName(value.from.session) || !validName(value.to.session) || !validHarness(value.from.harness) || typeof value.text !== "string" || typeof value.expectReply !== "boolean" || typeof value.sentAt !== "string" || !Number.isFinite(Date.parse(value.sentAt)) || typeof value.fromPort !== "number" || !Number.isInteger(value.fromPort) || value.fromPort < 1 || value.fromPort > 65535) throw new TelephoneError("invalid_request");
  if (value.proto !== PROTO_VERSION) throw new TelephoneError("proto_mismatch");
  if (!isUuid(value.id) || value.replyTo !== void 0 && !isUuid(value.replyTo)) throw new TelephoneError("invalid_id");
  return {
    proto: value.proto,
    id: value.id,
    from: { session: value.from.session, harness: value.from.harness },
    fromPort: value.fromPort,
    to: { session: value.to.session },
    text: value.text,
    expectReply: value.expectReply,
    replyTo: value.replyTo,
    sentAt: value.sentAt
  };
}

// src/exchange/main.ts
var p = paths();
await prepareHome(p.home);
async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(p.lock, "wx", 384);
      try {
        await file.writeFile(String(process.pid));
      } finally {
        await file.close();
      }
      return true;
    } catch (error) {
      if (!isFsError(error, "EEXIST")) throw error;
      let pid;
      try {
        pid = Number(await readFile2(p.lock, "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) {
          if (Date.now() - (await stat(p.lock)).mtimeMs < 5e3) return false;
        } else {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error2) {
            if (!isFsError(error2, "ESRCH")) return false;
          }
        }
        await unlink2(p.lock);
      } catch (error2) {
        if (!isFsError(error2, "ENOENT")) throw error2;
      }
    }
  }
  return false;
}
if (!await acquireLock()) process.exit(0);
var exchange;
var cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    await exchange?.stop();
    if (await readFile2(p.lock, "utf8").catch(() => "") === String(process.pid)) {
      await unlink2(p.socket).catch(() => {
      });
      await unlink2(p.lock).catch(() => {
      });
    }
  })();
  return cleanupPromise;
}
process.once("beforeExit", () => void cleanup());
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  void cleanup().then(() => process.exit(0));
});
try {
  await unlink2(p.socket).catch((error) => {
    if (!isFsError(error, "ENOENT")) throw error;
  });
  const config = await loadConfig(p.home);
  const identity = process.env.PI_TELEPHONE_NETWORK === "off" ? {
    async self() {
      throw new Error("Network disabled");
    },
    async peers() {
      return [];
    },
    async whois() {
      return void 0;
    },
    isTailnetAddress() {
      return false;
    }
  } : new TailscaleIdentityProvider(config.tailscaleCli);
  const idleOverride = process.env.PI_TELEPHONE_IDLE_EXIT_MS;
  const idleExitMs = idleOverride === void 0 ? void 0 : Number(idleOverride);
  if (idleExitMs !== void 0 && (!Number.isFinite(idleExitMs) || idleExitMs < 0)) throw new Error("Invalid PI_TELEPHONE_IDLE_EXIT_MS");
  exchange = createExchange({ home: p.home, identity, port: config.port, idleExitMs });
  await exchange.start();
  await log(p.home, "info", `Exchange started pid=${process.pid}`);
} catch (error) {
  await log(p.home, "error", `Exchange startup failed: ${error instanceof Error ? error.message : String(error)}`);
  await cleanup();
  process.exitCode = 1;
}

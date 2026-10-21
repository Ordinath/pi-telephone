// src/exchange/main.ts
import { open as open2, readFile as readFile3, rename as rename3, stat as stat2, unlink as unlink2 } from "node:fs/promises";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

// src/config.ts
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
var DEFAULT_CONFIG = { port: 47474, trustedUsers: [], tailscaleCli: null, maxMessageBytes: 262144, maxFileBytes: 5e7, maxFiles: 10, inboxMaxBytes: 1e9, inboxDays: 7 };
function homePath(home) {
  return resolve(home ?? process.env.PI_TELEPHONE_HOME ?? join(homedir(), ".pi-telephone"));
}
function inboxPath(home) {
  return join(homePath(home), "inbox");
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
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !Number.isInteger(config.maxMessageBytes) || config.maxMessageBytes < 1 || [config.maxFileBytes, config.maxFiles, config.inboxMaxBytes, config.inboxDays].some((value2) => !Number.isSafeInteger(value2) || value2 < 1) || !Array.isArray(config.trustedUsers) || !config.trustedUsers.every((user) => typeof user === "string" && !!user.trim()) || !(config.tailscaleCli === null || typeof config.tailscaleCli === "string")) throw new Error("Invalid config.json");
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
  const { appendFile, stat: stat3 } = await import("node:fs/promises");
  const path = paths(home).log;
  try {
    if ((await stat3(path)).size >= 5 * 1024 * 1024) await rename(path, `${path}.1`);
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
var FEATURES = ["files"];
var VERSION = false ? "0.2.0" : "0.2.0";
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
var CLI_CANDIDATES = ["tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
async function firstWorkingCli(candidates = CLI_CANDIDATES) {
  for (const executable of candidates) {
    try {
      const { stdout } = await exec(executable, ["status", "--json"], { timeout: 5e3, maxBuffer: 8 * 1024 * 1024 });
      if (JSON.parse(stdout)?.Self) return executable;
    } catch {
    }
  }
  return void 0;
}
var TailscaleIdentityProvider = class {
  constructor(tailscaleCli = null) {
    this.tailscaleCli = tailscaleCli;
  }
  executable;
  status;
  pendingStatus;
  identities = /* @__PURE__ */ new Map();
  pendingWhois = /* @__PURE__ */ new Map();
  async command(args) {
    this.executable ??= this.resolveCli();
    const { stdout } = await exec(await this.executable, args, { timeout: 5e3, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }
  async resolveCli() {
    if (this.tailscaleCli) return this.tailscaleCli;
    const executable = await firstWorkingCli();
    if (executable) return executable;
    this.executable = void 0;
    throw new Error("No Tailscale CLI reported status");
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
    let pending = this.pendingWhois.get(ip);
    if (!pending) {
      pending = (async () => {
        let value;
        try {
          value = parseWhois(JSON.parse(await this.command(["whois", "--json", ip])));
        } catch {
          value = void 0;
        }
        this.identities.set(ip, { expires: Date.now() + (value ? 3e5 : 3e4), value });
        return value;
      })().finally(() => {
        this.pendingWhois.delete(ip);
      });
      this.pendingWhois.set(ip, pending);
    }
    return pending;
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
import { randomUUID, createHash as createHash2 } from "node:crypto";
import { createReadStream as createReadStream2 } from "node:fs";
import { isAbsolute, join as join2 } from "node:path";
import { chmod as chmod2, mkdir as mkdir2, open, readdir, readFile as readFile2, rename as rename2, rm, rmdir, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { createServer as createServer2 } from "node:net";

// src/files.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, extname, sep } from "node:path";
function bytePrefix(text, max) {
  let result = "";
  for (const char of text) {
    if (Buffer.byteLength(result + char) > max) break;
    result += char;
  }
  return result;
}
function safeFileName(name) {
  const clean = name.split(/[/\\]/).at(-1).normalize("NFC").replace(/[^\p{L}\p{N} ._()+-]/gu, "_").replace(/_+/g, "_").replace(/ +/g, " ").replace(/^[. _]+|[. ]+$/g, "");
  const ext = bytePrefix(extname(clean), 99);
  const stem = clean.slice(0, clean.length - extname(clean).length);
  return (bytePrefix(stem, 100 - Buffer.byteLength(ext)) || (ext ? "f" : "")) + ext || "file";
}
function uniqueNames(names) {
  const used = /* @__PURE__ */ new Set();
  return names.map((input) => {
    const name = safeFileName(input), ext = extname(name), stem = name.slice(0, name.length - ext.length);
    let unique = name;
    for (let n = 2; used.has(unique.toLowerCase()); n++) {
      const suffix = `-${n}${bytePrefix(ext, 99 - Buffer.byteLength(`-${n}`))}`;
      unique = (bytePrefix(stem, 100 - Buffer.byteLength(suffix)) || "f") + suffix;
    }
    used.add(unique.toLowerCase());
    return unique;
  });
}
var extensions = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  yaml: "text/yaml",
  log: "text/plain",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip"
};
function detectMime(head, name) {
  const hex = head.toString("hex"), text = head.toString("latin1");
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (/^GIF8[79]a/.test(text)) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  if (text.startsWith("%PDF-")) return "application/pdf";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") return "audio/wav";
  if (text.startsWith("OggS")) return "audio/ogg";
  if (text.startsWith("fLaC")) return "audio/flac";
  if (text.startsWith("ID3") || head[0] === 255 && (head[1] & 224) === 224) return "audio/mpeg";
  if (text.slice(4, 8) === "ftyp") return ["M4A ", "M4B "].includes(text.slice(8, 12)) ? "audio/mp4" : "video/mp4";
  if (hex.startsWith("1a45dfa3")) return "video/webm";
  if (["504b0304", "504b0506", "504b0708"].some((magic) => hex.startsWith(magic))) return "application/zip";
  return extensions[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";
}
function formatBytes(n) {
  return n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(1)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(1)} GB`;
}
async function hashFile(path) {
  const hash = createHash("sha256");
  let size = 0, head = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
    if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
  }
  return { size, sha256: hash.digest("hex"), head };
}

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
function allows(allow, caller, owner, selfFqdn) {
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
        return (entry.session === "*" || entry.session === caller.session) && (entry.machine === "*" || entry.machine === normalizeMachine(caller.machine.fqdn) || entry.machine === caller.machine.short.toLowerCase() && normalizeMachine(caller.machine.fqdn).split(".").slice(1).join(".") === normalizeMachine(selfFqdn).split(".").slice(1).join("."));
    }
  });
}

// src/exchange/http.ts
import { once } from "node:events";
import { createServer, request } from "node:http";
var peerErrors = {
  not_trusted: "Peer does not trust this machine",
  not_reachable: "Recipient is not reachable",
  busy_waiting: "The recipient is waiting for your reply to one of its calls; answer it with a reply instead of asking.",
  too_large: "Message is too large",
  rate_limited: "Peer rate limit exceeded",
  delivery_failed: "Recipient did not accept the message",
  invalid_id: "Invalid message id",
  invalid_request: "Invalid request",
  proto_mismatch: "Incompatible telephone protocol",
  forbidden: "Peer refused the request",
  recipient_unsupported: "The recipient session runs an older pi-telephone and cannot receive files until it restarts.",
  inbox_full: "The recipient inbox is full",
  checksum_mismatch: "File checksum did not match",
  upload_expired: "File upload expired"
};
var errorStatus = {
  forbidden: 403,
  not_trusted: 403,
  not_reachable: 404,
  busy_waiting: 409,
  recipient_unsupported: 409,
  inbox_full: 507,
  checksum_mismatch: 422,
  upload_expired: 410,
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
function networkServer(maxBytes, authenticate, handle) {
  const server = createServer((req, res) => {
    const upload = req.method === "PUT" && req.url?.startsWith("/v1/upload/");
    const abort = () => {
      req.destroy();
      res.destroy();
    };
    const timer = setTimeout(abort, upload ? 15 * 6e4 : 1e4);
    if (upload) req.setTimeout(3e4, abort);
    res.on("close", () => clearTimeout(timer));
    void serve(req, res, maxBytes, authenticate, handle);
  });
  server.maxConnections = 64;
  server.requestTimeout = 0;
  server.headersTimeout = 1e4;
  return server;
}
async function serve(req, res, maxBytes, authenticate, handle) {
  try {
    const header = req.headers["x-telephone-from-port"];
    const port = typeof header === "string" ? Number(header) : void 0;
    const input = {
      method: req.method ?? "",
      url: new URL(req.url ?? "/", "http://exchange"),
      sourceIP: normalizedIP(req.socket.remoteAddress ?? ""),
      fromPort: port && Number.isInteger(port) && port <= 65535 ? port : void 0,
      body: void 0
    };
    const identity = await authenticate(input);
    const upload = input.method === "PUT" && input.url.pathname.startsWith("/v1/upload/");
    let size = 0;
    const chunks = [];
    if (!upload) for await (const chunk of req.iterator({ destroyOnReturn: false })) {
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
    const result = await handle({ ...input, body, stream: upload ? req : void 0 }, identity);
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
      method: options.upload ? "PUT" : body === void 0 ? "GET" : "POST",
      localAddress: options.localAddress,
      agent: false,
      headers: { "content-type": options.upload ? "application/octet-stream" : "application/json", "x-telephone-from-port": String(options.fromPort), ...options.upload ? { "content-length": options.size } : body ? { "content-length": Buffer.byteLength(body) } : {} }
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
          if (res.statusCode !== 200) {
            const code = typeof value?.error === "string" && Object.hasOwn(peerErrors, value.error) ? value.error : "unreachable";
            reject(new TelephoneError(code, peerErrors[code] ?? "Peer request failed"));
          } else resolve2(value);
        } catch {
          reject(new TelephoneError("unreachable", "Invalid peer response"));
        }
      });
    });
    const timer = setTimeout(() => req.destroy(new TelephoneError("unreachable", "Peer request timed out")), options.timeout);
    const connectTimer = options.connectTimeout === void 0 ? void 0 : setTimeout(() => req.destroy(new TelephoneError("unreachable", "Peer did not accept the connection")), options.connectTimeout);
    req.on("socket", (socket) => socket.once("connect", () => clearTimeout(connectTimer)));
    req.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(connectTimer);
      reject(error instanceof TelephoneError ? error : new TelephoneError("unreachable", error.message));
    });
    req.on("close", () => {
      clearTimeout(timer);
      clearTimeout(connectTimer);
    });
    if (options.upload) {
      req.setTimeout(3e4, () => req.destroy(new TelephoneError("unreachable", "File upload stalled")));
      void (async () => {
        for await (const chunk of options.upload) {
          if (req.destroyed) break;
          if (!req.write(chunk)) await once(req, "drain");
        }
        req.end();
      })().catch((error) => req.destroy(error));
    } else req.end(body);
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
  let admissions = Promise.resolve();
  let inboxBytes = 0;
  let lastPrune = -Infinity;
  let inboxPruning;
  let retentionTimer;
  let uploadTimer;
  const inbox = inboxPath(options.home);
  const uploads = /* @__PURE__ */ new Map();
  const reservations = /* @__PURE__ */ new Map();
  const transfers = /* @__PURE__ */ new Set();
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
    if (stopping) {
      socket.destroy();
      return;
    }
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
    while (inbound.size > 1e4) inbound.delete(inbound.keys().next().value);
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
  function logNetworkState(reason) {
    const address2 = listening?.address ?? null;
    if (lastNetworkState === address2) return;
    lastNetworkState = address2;
    void log(options.home, "info", address2 ? `Listening on ${address2}:${options.port}` : `Running local-only${reason ? `: ${reason}` : ""}`);
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
      const server = networkServer(config.maxMessageBytes + 16384, authenticateNetwork, handleNetwork);
      try {
        await listen(server, host, options.port);
      } catch (error) {
        await closeServer(server);
        throw error;
      }
      network = server;
      listening = { address: host, port: options.port };
      logNetworkState();
    } catch (error) {
      if (network) await closeServer(network);
      network = void 0;
      listening = null;
      logNetworkState(error instanceof Error ? error.message : String(error));
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
    await Promise.all(all.filter((peer) => peer.online).map(probe));
    return all.map((peer) => ({ ...peer, hasExchange: discovery.get(peer.fqdn)?.hasExchange ?? false }));
  }
  async function probe(peer) {
    const cached = discovery.get(peer.fqdn);
    if (cached && cached.at > now() - (cached.hasExchange ? 6e4 : 1e4)) return;
    const endpoint = peerEndpoints.get(peer.fqdn);
    const ip = endpoint?.ip ?? ipv4(peer);
    if (!ip) {
      discovery.set(peer.fqdn, { at: now(), hasExchange: false, reason: "No Tailscale IPv4" });
      return;
    }
    try {
      const hello = await remote(ip, endpoint?.port ?? config.port, "/v1/hello", 5e3, void 0, 1500);
      if (hello.proto !== PROTO_VERSION) throw new TelephoneError("proto_mismatch");
      discovery.set(peer.fqdn, { at: now(), hasExchange: true, hello });
    } catch (error) {
      const reason = error instanceof TelephoneError ? error.code : "unreachable";
      discovery.set(peer.fqdn, { at: now(), hasExchange: reason === "proto_mismatch", reason });
    }
  }
  function remote(host, port, path, timeout, body, connectTimeout) {
    return peerRequest({ host, port, path, timeout, body, connectTimeout, fromPort: options.port, localAddress: listening?.address });
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
      if (!allows(registration.allow, caller, self.login, self.fqdn)) continue;
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
    async function query(peer) {
      const state = discovery.get(peer.fqdn);
      if (!peer.hasExchange) return;
      if (state?.reason) {
        warnings.push(`${peer.short}: ${state.reason}`);
        return;
      }
      try {
        const endpoint = peerEndpoints.get(peer.fqdn);
        const result = await remote(endpoint?.ip ?? ipv4(peer), endpoint?.port ?? config.port, `/v1/directory${caller.session ? `?as=${encodeURIComponent(caller.session)}` : ""}`, 5e3, void 0, 1500);
        const machine2 = displayMachine(peer, self, all);
        if (!Array.isArray(result.sessions)) throw new TelephoneError("unreachable", "Invalid peer directory");
        for (const session of result.sessions) {
          if (!isObject(session) || !validName(session.session) || !validHarness(session.harness) || session.status !== "idle" && session.status !== "busy") continue;
          entries.push({
            session: session.session,
            harness: session.harness,
            status: session.status,
            ...self.login && peer.login.toLowerCase() === self.login.toLowerCase() && typeof session.cwd === "string" && session.cwd.length <= 1024 && !/[\x00-\x1f\x7f-\x9f]/.test(session.cwd) ? { cwd: session.cwd } : {},
            address: formatAddress(session.session, machine2),
            machine: machine2,
            fqdn: peer.fqdn,
            local: false,
            self: false
          });
        }
      } catch (error) {
        const reason = error instanceof TelephoneError ? error.code : "unreachable";
        if (reason === "not_trusted") discovery.set(peer.fqdn, { at: now(), hasExchange: true, reason });
        warnings.push(`${peer.short}: ${reason}`);
      }
    }
    await Promise.all(all.filter((peer) => peer.online).map(query));
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
    if (!isUuid(request2.id) || ledger.has(request2.id) || inbound.has(request2.id) || pendingSends.has(request2.id) || reservations.has(request2.id)) throw new TelephoneError("invalid_id");
    if (typeof request2.text !== "string" || request2.expectReply !== void 0 && typeof request2.expectReply !== "boolean") throw new TelephoneError("invalid_request");
    if (Buffer.byteLength(request2.text) > config.maxMessageBytes) throw new TelephoneError("too_large");
    const remembered = request2.replyTo ? inbound.get(request2.replyTo) : void 0;
    if (!request2.to && (!remembered || remembered.targetKey !== sender.session.key)) throw new TelephoneError("invalid_address", "A destination or a received message id is required");
    const pending = { sessionKey: sender.session.key, cancelled: false };
    pendingSends.set(request2.id, pending);
    let route;
    let files;
    try {
      if (request2.files !== void 0) {
        if (!Array.isArray(request2.files) || !request2.files.length || request2.files.length > config.maxFiles) throw new TelephoneError("invalid_request");
        const names2 = uniqueNames(request2.files.map((file) => {
          if (!file || typeof file.path !== "string" || !isAbsolute(file.path)) throw new TelephoneError("invalid_request");
          return file.path;
        }));
        files = [];
        let total = 0;
        for (const [index, file] of request2.files.entries()) {
          let hashed;
          try {
            const info = await stat(file.path);
            if (!info.isFile()) throw new Error("Not a regular file");
            if (info.size > config.maxFileBytes - total) throw new TelephoneError("too_large", `Files exceed this exchange's limit of ${formatBytes(config.maxFileBytes)} per message.`);
            hashed = await hashFile(file.path);
          } catch (error) {
            if (error instanceof TelephoneError) throw error;
            throw new TelephoneError("file_unreadable", `Cannot read file: ${file.path}`);
          }
          total += hashed.size;
          if (total > config.maxFileBytes) throw new TelephoneError("too_large", `Files exceed this exchange's limit of ${formatBytes(config.maxFileBytes)} per message.`);
          files.push({ name: names2[index], size: hashed.size, sha256: hashed.sha256, mime: detectMime(hashed.head, file.path) });
        }
      }
      route = request2.to ? await resolve2(request2.to) : remembered.route;
    } finally {
      pendingSends.delete(request2.id);
    }
    if (connection.registration !== sender || connection.socket.destroyed) throw new TelephoneError("not_registered");
    if (remembered && remembered.targetKey === sender.session.key && (!request2.to || sameRoute(route, remembered.route))) route = remembered.route;
    let replyTo = request2.replyTo;
    let inferredReplyTo;
    if (!replyTo) {
      const candidates = [...inbound.values()].filter((entry) => entry.targetKey === sender.session.key && entry.expectReply && !entry.answered && sameRoute(route, entry.route));
      if (candidates.length === 1) {
        replyTo = candidates[0].id;
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
      sentAt: new Date(now()).toISOString(),
      ...files ? { files } : {}
    };
    try {
      if (files) {
        if (route.local) {
          const admission2 = await admit(message, self, true);
          await storeFiles(admission2, randomUUID(), async (directory2) => {
            for (const [index, file] of files.entries()) {
              await receiveFiles(createReadStream2(request2.files[index].path), [file], directory2, "checksum_mismatch");
            }
          });
        } else {
          const cached = discovery.get(route.machine.fqdn);
          const hello = cached?.hello && cached.at > now() - 6e4 ? cached.hello : await remote(route.ip, route.port, "/v1/hello", 5e3, void 0, 1500);
          if (hello !== cached?.hello) discovery.set(route.machine.fqdn, { at: now(), hasExchange: true, hello });
          const version = typeof hello.version === "string" && /^[\w.+-]{1,64}$/.test(hello.version) ? hello.version : "unknown";
          if (!Array.isArray(hello.features) || !hello.features.includes("files")) throw new TelephoneError("peer_unsupported", `${route.machine.short} runs pi-telephone ${version}, which cannot receive files; it needs 0.2.0 or later. Text messages still work.`);
          if (hello.proto !== PROTO_VERSION) throw new TelephoneError("proto_mismatch");
          const peerLimits = hello.limits;
          if (!peerLimits || ![peerLimits.maxFileBytes, peerLimits.maxFiles].every((value) => Number.isSafeInteger(value) && value > 0)) throw new TelephoneError("peer_unsupported", "Peer does not advertise valid file limits.");
          const total = files.reduce((sum, file) => sum + file.size, 0);
          if (total > peerLimits.maxFileBytes || files.length > peerLimits.maxFiles) throw new TelephoneError("too_large", `Files exceed ${route.machine.short}'s limit of ${formatBytes(peerLimits.maxFileBytes)} or ${peerLimits.maxFiles} files per message.`);
          const offered = await remote(route.ip, route.port, "/v1/offer", 15e3, message, 1500);
          if (!isUuid(offered.upload)) throw new TelephoneError("unreachable", "Invalid upload id");
          async function* bytes() {
            for (const file of request2.files) yield* createReadStream2(file.path);
          }
          await peerRequest({
            host: route.ip,
            port: route.port,
            path: `/v1/upload/${offered.upload}`,
            timeout: 15 * 6e4,
            connectTimeout: 1500,
            fromPort: options.port,
            localAddress: listening?.address,
            upload: bytes(),
            size: total
          });
        }
      } else if (route.local) await deliver(message, self, true);
      else await remote(route.ip, route.port, "/v1/deliver", 8e3, message);
      if (replyTo) {
        const entry = inbound.get(replyTo);
        if (entry?.targetKey === sender.session.key) entry.answered = true;
      }
      void log(options.home, "info", `Sent ${request2.id} bytes=${Buffer.byteLength(request2.text)} files=${files?.length ?? 0} fileBytes=${files?.reduce((sum, file) => sum + file.size, 0) ?? 0} to=${address(route)}`);
      return { id: request2.id, status: "delivered", to: address(route), ...inferredReplyTo ? { inferredReplyTo } : {}, ...files ? { files } : {} };
    } catch (error) {
      ledger.delete(request2.id);
      waits.delete(request2.id);
      void log(options.home, "info", `Refused ${request2.id} decision=${error instanceof TelephoneError ? error.code : "unreachable"}`);
      throw error;
    }
  }
  async function admission(body, machine2, localCaller, sourceIP) {
    if (stopping) throw new TelephoneError("not_reachable");
    prune();
    const target = names.get(body.to.session);
    const registration = target?.registration;
    const route = { session: body.from.session, machine: machine2, local: localCaller, ip: sourceIP, port: body.fromPort };
    const previous = body.replyTo ? ledger.get(body.replyTo) : void 0;
    const isReply = !!(registration && previous && previous.fromSessionKey === registration.session.key && sameRoute(previous.to, route));
    if (!isReply && !localCaller && !isTrusted(machine2.login, self.login, config.trustedUsers)) throw new TelephoneError("not_trusted");
    if (!target || !registration || !isReply && !allows(registration.allow, { session: body.from.session, machine: machine2, local: localCaller }, self.login, self.fqdn)) throw new TelephoneError("not_reachable");
    if (Buffer.byteLength(body.text) > config.maxMessageBytes) throw new TelephoneError("too_large");
    if (inbound.has(body.id) || acks.has(body.id) || reservations.has(body.id) || !localCaller && ledger.has(body.id)) throw new TelephoneError("invalid_id");
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
    if (body.files) {
      if (!target.features?.includes("files")) throw new TelephoneError("recipient_unsupported", "The recipient session runs an older pi-telephone and cannot receive files until it restarts.");
      await pruneInbox();
      const total = body.files.reduce((sum, file) => sum + file.size, 0);
      const reserved = [...reservations.values()].reduce((sum, size) => sum + size, 0);
      if (inboxBytes + reserved + total > config.inboxMaxBytes) throw new TelephoneError("inbox_full", "The recipient inbox is full");
      reservations.set(body.id, total);
    }
    return { body, key: registration.session.key, route, isReply };
  }
  function admit(body, machine2, localCaller, sourceIP) {
    const result = admissions.then(() => admission(body, machine2, localCaller, sourceIP));
    admissions = result.then(() => {
    }, () => {
    });
    return result;
  }
  async function deliver(body, machine2, localCaller, sourceIP) {
    await handover(await admit(body, machine2, localCaller, sourceIP));
  }
  async function handover(admitted, files) {
    const { body, key, route, isReply } = admitted;
    const target = names.get(body.to.session);
    const { machine: machine2, local: localCaller, ip: sourceIP } = route;
    if (stopping || !target || target.registration?.session.key !== key || files && !target.features?.includes("files")) throw new TelephoneError("not_reachable");
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
      sentAt: body.sentAt,
      ...files ? { files } : {}
    };
    inbound.set(body.id, { at: now(), targetKey: key, route, id: body.id, expectReply: body.expectReply, answered: false });
    prune();
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
  async function pruneInbox() {
    if (inboxPruning) return inboxPruning;
    inboxPruning = (async () => {
      const created = await mkdir2(inbox, { recursive: true, mode: 448 });
      if (!created && lastPrune > now() - 6e4) return;
      for (const session of await readdir(inbox, { withFileTypes: true })) {
        if (!session.isDirectory() || session.name === ".incoming") continue;
        const directory2 = join2(inbox, session.name);
        for (const message of await readdir(directory2, { withFileTypes: true })) {
          if (!message.isDirectory() || reservations.has(message.name)) continue;
          const path = join2(directory2, message.name);
          if ((await stat(path)).mtimeMs > now() - config.inboxDays * 864e5) continue;
          await rm(path, { recursive: true, force: true });
        }
        await rmdir(directory2).catch(() => {
        });
      }
      let total = 0;
      for (const session of await readdir(inbox, { withFileTypes: true })) {
        if (session.isDirectory() && session.name !== ".incoming") total += await directoryBytes(join2(inbox, session.name));
      }
      inboxBytes = total;
      lastPrune = now();
    })().finally(() => {
      inboxPruning = void 0;
    });
    return inboxPruning;
  }
  function storeFiles(admitted, uploadId, write) {
    const result = saveFiles(admitted, uploadId, write);
    transfers.add(result);
    return result.finally(() => transfers.delete(result));
  }
  async function saveFiles(admitted, uploadId, write) {
    const { body, key } = admitted;
    const stage = join2(inbox, ".incoming", uploadId);
    const directory2 = join2(inbox, body.to.session, body.id);
    const files = body.files;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let moved = false;
    try {
      await mkdir2(join2(inbox, ".incoming"), { recursive: true, mode: 448 });
      await mkdir2(stage, { mode: 448 });
      await write(stage);
      const target = names.get(body.to.session);
      if (stopping || !target || target.registration?.session.key !== key || !target.features?.includes("files")) throw new TelephoneError("not_reachable");
      await mkdir2(join2(inbox, body.to.session), { recursive: true, mode: 448 });
      await rename2(stage, directory2);
      moved = true;
      inboxBytes += total;
      reservations.set(body.id, 0);
      const received = [];
      for (const file of files) {
        const path = join2(directory2, file.name), head = Buffer.alloc(64);
        const handle = await open(path, "r");
        let bytesRead;
        try {
          ({ bytesRead } = await handle.read(head, 0, head.length, 0));
        } finally {
          await handle.close();
        }
        received.push({ ...file, path, mime: detectMime(head.subarray(0, bytesRead), file.name) });
      }
      await handover(admitted, received);
    } catch (error) {
      if (moved) {
        await rm(directory2, { recursive: true, force: true });
        inboxBytes -= total;
      }
      throw error;
    } finally {
      try {
        await rm(stage, { recursive: true, force: true });
      } finally {
        reservations.delete(body.id);
      }
    }
  }
  async function authenticateNetwork(input) {
    if (!options.identity.isTailnetAddress(input.sourceIP) || self.ips.includes(input.sourceIP)) throw new TelephoneError("forbidden");
    const machine2 = await options.identity.whois(input.sourceIP, { fromPort: input.fromPort });
    if (!machine2) throw new TelephoneError("forbidden");
    const cached = discovery.get(machine2.fqdn);
    discovery.set(machine2.fqdn, { at: cached?.hello ? cached.at : now(), hasExchange: true, hello: cached?.hello });
    return machine2;
  }
  async function handleNetwork(input, machine2) {
    if (input.method === "PUT" && input.url.pathname.startsWith("/v1/upload/")) {
      const id = input.url.pathname.slice("/v1/upload/".length);
      const upload = uploads.get(id);
      if (!upload || upload.started || upload.created <= now() - 6e4) {
        if (upload && !upload.started) {
          uploads.delete(id);
          reservations.delete(upload.admission.body.id);
        }
        throw new TelephoneError("upload_expired");
      }
      if (upload.machine.fqdn !== machine2.fqdn) throw new TelephoneError("forbidden");
      if ([...uploads.values()].filter((active) => active.started && active.machine.fqdn === machine2.fqdn).length >= 4) throw new TelephoneError("rate_limited");
      upload.started = true;
      try {
        await storeFiles(upload.admission, id, async (directory2) => {
          if (!input.stream || input.stream.headers["content-length"] !== String(upload.total)) throw new TelephoneError("invalid_request");
          await receiveFiles(input.stream.iterator({ destroyOnReturn: false }), upload.admission.body.files, directory2);
        });
      } finally {
        uploads.delete(id);
      }
      return { body: { status: "delivered" } };
    }
    const offer = input.method === "POST" && input.url.pathname === "/v1/offer";
    const body = input.method === "POST" && (input.url.pathname === "/v1/deliver" || offer) ? validateDelivery(input.body) : void 0;
    if (offer && body) {
      body.files = validateFiles(isObject(input.body) ? input.body.files : void 0, config);
      const admitted = await admit(body, machine2, false, input.sourceIP);
      const upload = randomUUID();
      uploads.set(upload, { admission: admitted, machine: machine2, sourceIP: input.sourceIP, total: body.files.reduce((sum, file) => sum + file.size, 0), created: now(), started: false });
      return { body: { upload } };
    }
    if (input.method === "GET" && input.url.pathname === "/v1/hello") return { body: { proto: PROTO_VERSION, version: VERSION, features: FEATURES, limits: limits(), machine: machineInfo() } };
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
        if (!allows(registration.allow, caller, self.login, self.fqdn)) return [];
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
  function limits() {
    return { maxFileBytes: config.maxFileBytes, maxFiles: config.maxFiles };
  }
  function machineInfo() {
    return { fqdn: self.fqdn, short: self.short, login: self.login };
  }
  async function handleLocal(connection, request2) {
    await initialRefresh;
    if (request2.t === "hello") {
      if (request2.proto !== PROTO_VERSION) throw new TelephoneError("proto_mismatch");
      if (request2.client?.features !== void 0 && (!Array.isArray(request2.client.features) || !request2.client.features.every((feature) => typeof feature === "string"))) throw new TelephoneError("invalid_request");
      connection.hello = true;
      connection.features = request2.client?.features;
      return { exchange: { proto: PROTO_VERSION, version: VERSION, features: FEATURES, limits: limits(), machine: machineInfo(), listening } };
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
        return { config: { ...config, trustedUsers: [...config.trustedUsers] }, owner: self.login, inboxBytes: inboxBytes + [...reservations.values()].reduce((sum, bytes) => sum + bytes, 0) };
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
    await mkdir2(inbox, { recursive: true, mode: 448 });
    await rm(join2(inbox, ".incoming"), { recursive: true, force: true });
    await mkdir2(join2(inbox, ".incoming"), { mode: 448 });
    await pruneInbox();
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
    retentionTimer = setInterval(() => {
      void pruneInbox().catch(() => {
      });
    }, 36e5);
    uploadTimer = setInterval(() => {
      for (const [id, upload] of uploads) if (!upload.started && upload.created <= now() - 6e4) {
        uploads.delete(id);
        reservations.delete(upload.admission.body.id);
      }
    }, 1e3);
    scheduleIdle();
  }
  function stop() {
    stopping ??= (async () => {
      clearInterval(retryTimer);
      clearInterval(retentionTimer);
      clearInterval(uploadTimer);
      clearTimeout(idleTimer);
      const closed = new Promise((resolve3) => local.close(() => resolve3()));
      for (const connection of connections) connection.socket.destroy();
      await networkRefresh;
      if (network) await closeServer(network);
      await closed;
      if (ownsSocket && await readFile2(p2.lock, "utf8").catch(() => "") === String(process.pid)) await unlink(p2.socket).catch(() => {
      });
      await configWrites;
      await admissions;
      await Promise.allSettled(transfers);
      await inboxPruning;
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
async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join2(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}
async function receiveFiles(source, files, directory, lengthError = "invalid_request") {
  const iterator = source[Symbol.asyncIterator]();
  let rest = Buffer.alloc(0);
  try {
    for (const file of files) {
      const handle = await open(join2(directory, file.name), "wx", 384);
      const hash = createHash2("sha256");
      let remaining = file.size;
      try {
        while (remaining) {
          if (!rest.length) {
            const next = await iterator.next();
            if (next.done) throw new TelephoneError(lengthError, "File body is shorter than offered");
            rest = next.value;
          }
          const chunk = rest.subarray(0, remaining);
          rest = rest.subarray(chunk.length);
          remaining -= chunk.length;
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
      } finally {
        await handle.close();
      }
      if (hash.digest("hex") !== file.sha256) throw new TelephoneError("checksum_mismatch");
    }
    if (rest.length || !(await iterator.next()).done) throw new TelephoneError(lengthError, "File body is longer than offered");
  } finally {
    await iterator.return?.();
  }
}
function validateFiles(value, config) {
  if (!Array.isArray(value) || !value.length || value.length > config.maxFiles) throw new TelephoneError("invalid_request");
  let total = 0;
  const files = value.map((file) => {
    if (!isObject(file) || typeof file.name !== "string" || !file.name.length || file.name.length > 255 || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new TelephoneError("invalid_request");
    total += file.size;
    if (total > config.maxFileBytes) throw new TelephoneError("too_large");
    return {
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      mime: typeof file.mime === "string" && file.mime.length <= 100 && /^[\w.+-]+\/[\w.+-]+$/.test(file.mime) ? file.mime : "application/octet-stream"
    };
  });
  const names = uniqueNames(files.map((file) => file.name));
  return files.map((file, index) => ({ ...file, name: names[index] }));
}

// src/exchange/main.ts
var p = paths();
await prepareHome(p.home);
var claim = `${p.lock}.claim`;
async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFsError(error, "ESRCH");
  }
}
async function socketAccepts() {
  return new Promise((resolve2) => {
    const socket = createConnection(p.socket);
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve2(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve2(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve2(false);
    });
  });
}
async function releaseClaim() {
  if (await readFile3(claim, "utf8").catch(() => "") === String(process.pid)) await unlink2(claim).catch(() => {
  });
}
async function acquireLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const file = await open2(claim, "wx", 384);
      try {
        await file.writeFile(String(process.pid));
      } finally {
        await file.close();
      }
      break;
    } catch (error) {
      if (!isFsError(error, "EEXIST")) throw error;
      const owner = Number(await readFile3(claim, "utf8").catch(() => ""));
      const age = await stat2(claim).then((info) => Date.now() - info.mtimeMs).catch(() => 0);
      if (owner && !await pidAlive(owner) || age > 15e3) await unlink2(claim).catch(() => {
      });
      await sleep(50);
      if (attempt === 99) return false;
    }
  }
  try {
    try {
      const file = await open2(p.lock, "wx", 384);
      try {
        await file.writeFile(String(process.pid));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!isFsError(error, "EEXIST")) throw error;
      const pid = Number(await readFile3(p.lock, "utf8").catch(() => ""));
      if (await pidAlive(pid) && await socketAccepts()) {
        await releaseClaim();
        return false;
      }
      const temp = `${p.lock}.${process.pid}.tmp`;
      const file = await open2(temp, "wx", 384);
      try {
        await file.writeFile(String(process.pid));
      } finally {
        await file.close();
      }
      try {
        await rename3(temp, p.lock);
      } finally {
        await unlink2(temp).catch(() => {
        });
      }
    }
    if (await readFile3(p.lock, "utf8") === String(process.pid)) return true;
    await releaseClaim();
    return false;
  } catch (error) {
    await releaseClaim();
    throw error;
  }
}
if (!await acquireLock()) process.exit(0);
var exchange;
var cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    await exchange?.stop();
    if (await readFile3(p.lock, "utf8").catch(() => "") === String(process.pid)) {
      await unlink2(p.socket).catch(() => {
      });
      await unlink2(p.lock).catch(() => {
      });
    }
    await releaseClaim();
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
  await releaseClaim();
  await log(p.home, "info", `Exchange started pid=${process.pid}`);
} catch (error) {
  await log(p.home, "error", `Exchange startup failed: ${error instanceof Error ? error.message : String(error)}`);
  await cleanup();
  process.exitCode = 1;
}

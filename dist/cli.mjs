#!/usr/bin/env node

// src/client.ts
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// src/config.ts
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
function homePath(home) {
  return resolve(home ?? process.env.PI_TELEPHONE_HOME ?? join(homedir(), ".pi-telephone"));
}
function paths(home) {
  const root = homePath(home);
  const normal = join(root, "exchange.sock");
  const socket = Buffer.byteLength(normal) <= 100 ? normal : join(tmpdir(), `pi-telephone-${process.getuid?.() ?? "user"}`, "exchange.sock");
  return { home: root, socket, socketPath: join(root, "socket-path"), lock: join(root, "exchange.lock"), config: join(root, "config.json"), log: join(root, "exchange.log") };
}
async function clientSocketPath(home) {
  const p = paths(home);
  try {
    return (await readFile(p.socketPath, "utf8")).trim();
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error;
    return p.socket;
  }
}
function isFsError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
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

// src/protocol.ts
var PROTO_VERSION = 1;
var VERSION = false ? "0.1.0" : "0.1.1";
var TelephoneError = class extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
    this.name = "TelephoneError";
  }
};

// src/client.ts
var TelephoneClient = class extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.home = homePath(opts.home);
  }
  socket;
  connecting;
  info;
  closed = false;
  wasConnected = false;
  reconnectTimer;
  reconnectDelay = 250;
  registration;
  requests = /* @__PURE__ */ new Map();
  replies = /* @__PURE__ */ new Map();
  home;
  connect() {
    if (this.closed) return Promise.reject(new TelephoneError("closed"));
    if (this.info && this.socket && !this.socket.destroyed) return Promise.resolve(this.info);
    this.connecting ??= this.establish().finally(() => {
      this.connecting = void 0;
    });
    return this.connecting;
  }
  async ensureExchange() {
    const deadline = Date.now() + 5e3;
    let spawned = false;
    let backoff = 25;
    while (!this.closed) {
      try {
        const path = await clientSocketPath(this.home);
        return await new Promise((resolve2, reject) => {
          const socket = createConnection(path);
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.off("error", reject);
            resolve2(socket);
          });
        });
      } catch (error) {
        if (!isFsError(error, "ENOENT") && !isFsError(error, "ECONNREFUSED")) throw error;
        if (!spawned) {
          const entry = this.opts.exchangeEntry ?? fileURLToPath(new URL("../dist/exchange.mjs", import.meta.url));
          const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"].includes(key) || key.startsWith("PI_TELEPHONE_")));
          const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore", env: { ...env, PI_TELEPHONE_HOME: this.home } });
          child.on("error", () => {
          });
          child.unref();
          spawned = true;
        }
        if (Date.now() >= deadline) throw new TelephoneError("unreachable", "Exchange did not start within 5 seconds");
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 500);
      }
    }
    throw new TelephoneError("closed");
  }
  async establish() {
    const socket = await this.ensureExchange();
    if (this.closed) {
      socket.destroy();
      throw new TelephoneError("closed");
    }
    this.socket = socket;
    socket.on("error", () => {
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = void 0;
      this.info = void 0;
      const error = new TelephoneError(this.closed ? "closed" : "disconnected");
      for (const request of this.requests.values()) request.reject(error);
      this.requests.clear();
      for (const wait of this.replies.values()) wait.reject(error);
      this.replies.clear();
      if (!this.closed) {
        this.emit("disconnected");
        this.scheduleReconnect();
      }
    });
    readFrames(socket, (value) => {
      void this.receive(value, socket).catch(() => socket.destroy());
    });
    try {
      const result = await this.request({ t: "hello", proto: PROTO_VERSION, client: { harness: this.opts.harness, version: this.opts.version, pid: process.pid } });
      if (this.registration) {
        await this.request({ t: "register", session: this.registration.session, allow: this.registration.allow });
        if (this.registration.status) await this.request({ t: "update", status: this.registration.status });
      }
      this.info = result.exchange;
      this.reconnectDelay = 250;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
      const event = this.wasConnected ? "reconnected" : "connected";
      this.wasConnected = true;
      this.emit(event, this.info);
      return this.info;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = void 0;
      void this.connect().catch(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5e3);
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
  }
  request(body) {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new TelephoneError("disconnected"));
    const rid = randomUUID();
    return new Promise((resolve2, reject) => {
      this.requests.set(rid, { resolve: (value) => resolve2(value), reject });
      try {
        writeFrame(socket, { ...body, rid });
      } catch (error) {
        this.requests.delete(rid);
        reject(error);
      }
    });
  }
  async receive(frame, socket) {
    if (frame.t === "deliver") {
      const message = frame.message;
      const wait = message.isReplyToOwnCall && message.replyTo ? this.replies.get(message.replyTo) : void 0;
      let ack;
      if (wait) {
        this.replies.delete(message.replyTo);
        wait.resolve(message);
        ack = { accepted: true };
      } else {
        try {
          ack = await this.opts.onMessage(message);
        } catch {
          ack = { accepted: false, reason: "Recipient handler failed" };
        }
      }
      if (!socket.destroyed) writeFrame(socket, { t: "ack", id: message.id, ...ack });
      return;
    }
    const request = this.requests.get(frame.rid);
    if (!request) return;
    this.requests.delete(frame.rid);
    if (frame.t === "error") request.reject(new TelephoneError(frame.code, frame.message));
    else {
      const { t, rid, ...result } = frame;
      request.resolve(result);
    }
  }
  async register(session, allow = ["owner"]) {
    await this.connect();
    const result = await this.request({ t: "register", session, allow });
    this.registration = { session: { ...session }, allow: [...allow] };
    return result.address;
  }
  async update(patch) {
    await this.connect();
    const result = await this.request({ t: "update", ...patch });
    if (this.registration) {
      if (patch.name !== void 0) this.registration.session.name = patch.name;
      if (patch.allow !== void 0) this.registration.allow = [...patch.allow];
      if (patch.status !== void 0) this.registration.status = patch.status;
    }
    return result.address;
  }
  async unregister() {
    await this.connect();
    await this.request({ t: "unregister" });
    this.registration = void 0;
  }
  async directory() {
    await this.connect();
    return this.request({ t: "directory" });
  }
  async send(input) {
    await this.connect();
    return this.request({ t: "send", id: randomUUID(), ...input });
  }
  async ask(input) {
    await this.connect();
    if (input.signal?.aborted) throw new TelephoneError("aborted");
    const id = randomUUID();
    let cancel = () => {
    };
    let received;
    const reply = new Promise((resolve2, reject) => {
      cancel = reject;
      this.replies.set(id, { resolve: (message) => {
        received = message;
        resolve2(message);
      }, reject });
    });
    const onAbort = () => cancel(new TelephoneError("aborted"));
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => cancel(new TelephoneError("timeout", "Telephone call timed out")), input.timeoutMs);
    try {
      const sent = this.request({ t: "send", id, to: input.to, text: input.text, expectReply: true });
      const [sendResult, replyResult] = await Promise.all([sent, reply]);
      return { sent: sendResult, reply: replyResult };
    } catch (error) {
      if (received) return { sent: { id, status: "delivered", to: input.to }, reply: received };
      if (this.socket && !this.socket.destroyed) void this.request({ t: "cancelWait", id }).catch(() => {
      });
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      this.replies.delete(id);
    }
  }
  async getConfig() {
    await this.connect();
    return this.request({ t: "getConfig" });
  }
  async setTrustedUsers(patch) {
    await this.connect();
    return this.request({ t: "setTrustedUsers", ...patch });
  }
  async shutdownExchange() {
    await this.connect();
    await this.request({ t: "shutdown" });
  }
  async close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    if (socket && !socket.destroyed) await new Promise((resolve2) => {
      socket.once("close", resolve2);
      socket.destroy();
    });
    await this.connecting?.catch(() => {
    });
  }
};

// src/cli.ts
var [command = "help", login] = process.argv.slice(2);
var help = "Usage: pi-telephone status | list | trust <login> | untrust <login> | stop | help";
if (command === "help") console.log(help);
else if (!["status", "list", "trust", "untrust", "stop"].includes(command) || ["trust", "untrust"].includes(command) && !login) {
  console.error(help);
  process.exitCode = 1;
} else {
  const client = new TelephoneClient({ harness: "cli", version: VERSION, onMessage: async () => ({ accepted: false }) });
  try {
    const info = await client.connect();
    switch (command) {
      case "status": {
        const { config, owner } = await client.getConfig();
        const { entries } = await client.directory();
        console.log(`Exchange ${info.version} (protocol ${info.proto}) on ${info.machine.fqdn}`);
        console.log(`Listening: ${info.listening ? `${info.listening.address}:${info.listening.port}` : "local only"}`);
        console.log(`Owner: ${owner || "Tailscale unavailable"}`);
        console.log(`Trusted users: ${config.trustedUsers.join(", ") || "none (owner is always trusted)"}`);
        const local = entries.filter((entry) => entry.local);
        if (local.length) console.table(local);
        else console.log("No sessions.");
        break;
      }
      case "list": {
        const { entries, warnings } = await client.directory();
        if (entries.length) console.table(entries);
        else console.log("No sessions.");
        for (const warning of warnings) console.error(warning);
        break;
      }
      case "trust":
        console.log((await client.setTrustedUsers({ add: [login] })).trustedUsers.join("\n"));
        break;
      case "untrust":
        console.log((await client.setTrustedUsers({ remove: [login] })).trustedUsers.join("\n"));
        break;
      case "stop":
        await client.shutdownExchange();
        console.log("Exchange stopped");
        break;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Telephone command failed");
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

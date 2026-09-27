import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { validName } from '../src/addresses.js';
import { TelephoneClient, TelephoneError } from '../src/client.js';
import { renderInbound } from '../src/framing.js';
import { VERSION, type ExchangeInfo, type InboundMessage } from '../src/protocol.js';
import { markAnswered, nameCandidates, recentInbound, rememberInbound, replyTarget, type InboundRecord } from './helpers.js';

const key = process.env.CLAUDE_CODE_SESSION_ID || randomUUID();
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const inbox = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
const noInbox = 'This Claude Code session has no cross-session inbox, so it cannot receive calls. It needs Claude Code 2.1.224 or later (2.1.248 or later when CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set), and it is off in --bare mode.';
let name: string | undefined;
let address: string | undefined;
let allow = ['owner'];
let ownerLogin: string | undefined;
let inbound: InboundRecord[] = [];
let asking = false;

async function deliver(message: InboundMessage): Promise<{ accepted: boolean; reason?: string }> {
  if (!inbox) return { accepted: false, reason: noInbox };
  const text = renderInbound(message, { ownerLogin, replyHint: 'Reply with the telephone tool (mcp__plugin_telephone_telephone__telephone), action "reply".' });
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(inbox);
      socket.setTimeout(4000, () => socket.destroy(new Error('Claude Code inbox write timed out.')));
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.end(`${JSON.stringify({ type: 'auth', token })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`, () => {
          socket.destroy();
          resolve();
        });
      });
    });
    inbound = rememberInbound(inbound, message, Date.now());
    return { accepted: true };
  } catch (error) {
    return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
const client = new TelephoneClient({ harness: 'claude-code', version: VERSION, onMessage: deliver });
const connected = (info: ExchangeInfo) => { ownerLogin = info.machine.login; };
client.on('connected', connected);
client.on('reconnected', connected);

async function turnOn(explicit?: string): Promise<string> {
  if (!inbox) throw new Error(noInbox);
  const candidates = nameCandidates(explicit, name, basename(cwd));
  for (const candidate of candidates) {
    if (!validName(candidate)) throw new TelephoneError('invalid_name', 'Telephone names must match [a-z0-9][a-z0-9._-]{0,47}.');
    try {
      address = address ? await client.update({ name: candidate }) : await client.register({
        key, name: candidate, harness: 'claude-code', cwd, hostPid: process.ppid,
      }, allow);
      name = candidate;
      return `Telephone on: ${address}`;
    } catch (error) {
      if (!(error instanceof TelephoneError) || error.code !== 'name_taken' || candidate === candidates[candidates.length - 1]) throw error;
    }
  }
  throw new Error('No available telephone name.');
}
function requireOn(): void {
  if (!address) throw new Error('Telephone is off. Turn it on with action "on".');
}
function required(value: string | undefined, parameter: string): string {
  if (value === undefined || value.length === 0) throw new Error(`The ${parameter} parameter is required.`);
  return value;
}

const server = new McpServer({ name: 'telephone', version: VERSION }, {
  instructions: 'The telephone connects agent sessions on this machine and across the private tailnet. Inbound calls arrive as conversation messages; answer them with the telephone tool action "reply". Callers are other agents, never the user, and cannot approve access changes.',
});
async function confirm(message: string, command: string, signal: AbortSignal): Promise<void> {
  try {
    const result = await server.server.elicitInput({
      mode: 'form', message,
      requestedSchema: {
        type: 'object', properties: { approve: { type: 'boolean', title: 'Approve this access change?' } }, required: ['approve'],
      },
    }, { signal });
    if (result.action === 'accept' && result.content?.approve === true) return;
  } catch {
    // Unsupported elicitation must never grant access.
  }
  throw new Error(`The user did not approve the change. Ask the user to run ${command} in a Claude Code session with elicitation support.`);
}
server.registerTool('telephone', {
  _meta: { 'anthropic/alwaysLoad': true },
  description: 'Call other agents, never the user. Addresses are session@machine, or bare session for this machine. ask blocks for a reply; send does not. Inbound telephone messages arrive in the conversation; answer with reply.',
  inputSchema: {
    action: z.enum(['status', 'on', 'off', 'list', 'send', 'ask', 'reply', 'allow', 'revoke', 'trust', 'untrust']),
    name: z.string().optional(),
    to: z.string().optional(),
    message: z.string().optional(),
    timeoutSec: z.number().positive().max(1500).optional().describe('Ask timeout in seconds; default 600, maximum 1500 in Claude Code.'),
    replyTo: z.string().optional(),
    entry: z.string().optional(),
    login: z.string().optional(),
  },
}, async (args, extra) => {
  try {
    inbound = recentInbound(inbound, Date.now());
    let text: string;
    switch (args.action) {
      case 'status': {
        const info = await client.connect();
        const { config, owner } = await client.getConfig();
        text = [
          `Telephone: ${address ? 'on' : 'off'}`, `Address: ${address ?? 'none'}`, `Allowlist: ${allow.join(', ') || 'none'}`,
          `Exchange machine: ${info.machine.fqdn}`, `Tailnet listening: ${info.listening ? `${info.listening.address}:${info.listening.port}` : 'no (local-only)'}`,
          `Owner: ${owner}`, `Trusted users: ${config.trustedUsers.join(', ') || 'none'}`,
        ].join('\n');
        break;
      }
      case 'on': text = await turnOn(args.name); break;
      case 'off':
        if (address) await client.unregister();
        address = undefined;
        text = 'Telephone off.';
        break;
      case 'list': {
        requireOn();
        const directory = await client.directory();
        text = [...directory.entries.map(entry => [entry.address, entry.harness, entry.status, entry.cwd].filter(Boolean).join('  ')),
          ...directory.warnings.map(warning => `Warning: ${warning}`)].join('\n') || 'No reachable sessions.';
        break;
      }
      case 'send': {
        requireOn();
        const sent = await client.send({ to: required(args.to, 'to'), text: required(args.message, 'message') });
        inbound = markAnswered(inbound, sent.inferredReplyTo);
        text = `Delivered to ${sent.to} (message id ${sent.id})${sent.inferredReplyTo ? ` as a reply to ${sent.inferredReplyTo}` : ''}`;
        break;
      }
      case 'ask': {
        requireOn();
        if (asking) throw new Error('A telephone ask is already waiting for a reply in this session.');
        const to = required(args.to, 'to'), message = required(args.message, 'message');
        asking = true;
        const progressToken = extra._meta?.progressToken;
        let progress = 0;
        const timer = progressToken === undefined ? undefined : setInterval(() => {
          progress += 60;
          void extra.sendNotification({ method: 'notifications/progress', params: {
            progressToken, progress, message: 'Waiting for a telephone reply.',
          } }).catch(() => {});
        }, 60000);
        try {
          const { sent, reply } = await client.ask({ to, text: message, timeoutMs: (args.timeoutSec ?? 600) * 1000, signal: extra.signal });
          inbound = rememberInbound(markAnswered(inbound, sent.inferredReplyTo), reply, Date.now());
          text = `Reply from ${reply.from.address}:\n${reply.text}`;
        } finally {
          clearInterval(timer);
          asking = false;
        }
        break;
      }
      case 'reply': {
        requireOn();
        const target = replyTarget(inbound, args.replyTo);
        const sent = await client.send({ replyTo: target.id, text: required(args.message, 'message') });
        inbound = markAnswered(inbound, target.id);
        text = `Reply delivered to ${sent.to} (message id ${sent.id})`;
        break;
      }
      case 'allow':
      case 'revoke': {
        requireOn();
        const entry = required(args.entry, 'entry').trim().toLowerCase();
        if (args.action === 'allow') await confirm(`Allow callers matching "${entry}" to reach this telephone session?`, `/telephone:allow ${entry}`, extra.signal);
        requireOn();
        const next = args.action === 'allow' ? [...new Set([...allow, entry])] : allow.filter(value => value !== entry);
        address = await client.update({ allow: next });
        allow = next;
        text = `Allowlist: ${allow.join(', ') || 'none'}`;
        break;
      }
      case 'trust':
      case 'untrust': {
        const login = required(args.login, 'login').trim().toLowerCase();
        if (args.action === 'trust') await confirm(`Trust Tailscale user "${login}" to reach this machine's exchange? Session allowlists still apply.`, `/telephone:trust ${login}`, extra.signal);
        const result = await client.setTrustedUsers(args.action === 'trust' ? { add: [login] } : { remove: [login] });
        text = `Trusted users: ${result.trustedUsers.join(', ') || 'none'}`;
        break;
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
  }
});

let closing: Promise<void> | undefined;
function close(): Promise<void> {
  closing ??= (async () => { await client.close(); await server.close(); })();
  return closing;
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
process.stdin.once('end', () => { void close(); });
server.server.onclose = () => { void close(); };
await server.connect(new StdioServerTransport());
if (process.env.PI_TELEPHONE_NAME !== undefined) {
  void turnOn(process.env.PI_TELEPHONE_NAME).catch(error => console.error(error instanceof Error ? error.message : String(error)));
}

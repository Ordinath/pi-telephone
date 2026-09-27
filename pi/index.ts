import { basename } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { TelephoneClient } from '../src/client.ts';
import { renderInbound } from '../src/framing.ts';
import { describeAllowEntry } from '../src/policy.ts';
import { TelephoneError, VERSION, type InboundMessage, type SendResult } from '../src/protocol.ts';
import {
  nameCandidates, parseCommand, recentMessages, replyTarget, required, restoreInbox, restoreState, timeoutMs,
  type ReceivedMessage, type TelephoneState,
} from './helpers.ts';

const replyHint = 'Reply with telephone({ action: "reply", message: "..." }).';
const subcommands = ['status', 'on', 'off', 'list', 'call', 'allow', 'revoke', 'trust', 'untrust', 'restart'];
const parameters = Type.Object({
  action: Type.Union(['status', 'on', 'off', 'list', 'send', 'ask', 'reply', 'allow', 'revoke'].map(action => Type.Literal(action))),
  name: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  replyTo: Type.Optional(Type.String()),
  timeoutSec: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 3600, default: 600 })),
  entry: Type.Optional(Type.String()),
});

interface Line {
  ctx: ExtensionContext;
  state: TelephoneState;
  inbox: ReceivedMessage[];
  running: boolean;
  client?: TelephoneClient;
  ownerLogin?: string;
  address?: string;
  asking: boolean;
  pending: Promise<unknown>;
  stopped: boolean;
  closing?: Promise<void>;
}

export default function telephone(pi: ExtensionAPI) {
  let current: Line | undefined;

  function line(): Line {
    if (!current || current.stopped) throw new Error('Telephone session is not active.');
    return current;
  }

  function persist(session: Line): void {
    if (session.stopped) return;
    pi.appendEntry('telephone-state', { ...session.state, allow: [...session.state.allow] });
    session.ctx.ui.setStatus('telephone', session.state.on && session.address ? `tel ${session.address}` : undefined);
  }

  function saveInbox(session: Line): void {
    session.inbox = recentMessages(session.inbox, Date.now());
  }

  function remember(session: Line, message: InboundMessage): void {
    session.inbox.push({ id: message.id, from: message.from.address, expectReply: message.expectReply, answered: false, receivedAt: Date.now() });
    saveInbox(session);
  }

  function answered(session: Line, id: string | undefined): void {
    const message = session.inbox.find(message => message.id === id);
    if (message) { message.answered = true; saveInbox(session); }
  }

  function client(session: Line): TelephoneClient {
    if (session.stopped) throw new Error('Telephone session is not active.');
    session.client ??= new TelephoneClient({
      harness: 'pi', version: VERSION,
      onMessage: async message => {
        if (session.stopped) return { accepted: false, reason: 'Telephone session is closing' };
        remember(session, message);
        pi.sendMessage({
          customType: 'telephone', content: renderInbound(message, { replyHint, ownerLogin: session.ownerLogin }),
          display: true, details: message,
        }, session.running ? { deliverAs: 'steer' } : { triggerTurn: true });
        return { accepted: true };
      },
    });
    return session.client;
  }

  function serial<T>(session: Line, operation: () => Promise<T>): Promise<T> {
    const result = session.pending.then(() => {
      if (session.stopped) throw new Error('Telephone session is not active.');
      return operation();
    });
    session.pending = result.catch(() => {});
    return result;
  }

  async function requireOn(session: Line): Promise<TelephoneClient> {
    await session.pending;
    if (!session.state.on || !session.address) throw new Error('Telephone is off. Turn it on with action "on".');
    return client(session);
  }

  function turnOn(session: Line, name?: string): Promise<string> {
    return serial(session, async () => {
      const connection = client(session);
      const { owner } = await connection.getConfig();
      session.ownerLogin = owner;
      const candidates = nameCandidates(name, session.state.name, pi.getSessionName() || basename(session.ctx.cwd));
      for (const candidate of candidates) {
        try {
          session.address = session.address
            ? await connection.update({ name: candidate })
            : await connection.register({ key: session.ctx.sessionManager.getSessionId(), name: candidate, harness: 'pi', cwd: session.ctx.cwd, hostPid: process.pid }, session.state.allow);
          session.state = { ...session.state, on: true, name: candidate };
          persist(session);
          await connection.update({ status: session.running ? 'busy' : 'idle' });
          return `Telephone on: ${session.address}`;
        } catch (error) {
          if (!(error instanceof TelephoneError) || error.code !== 'name_taken') throw error;
          if (candidate === candidates.at(-1)) throw new Error(`The telephone name ${candidate} is already used by another live session on this machine.`);
        }
      }
      throw new Error('No telephone name available.');
    });
  }

  function turnOff(session: Line): Promise<string> {
    return serial(session, async () => {
      if (session.client && session.address) await session.client.unregister();
      if (session.client) await session.client.close();
      session.client = undefined;
      session.address = undefined;
      session.state = { ...session.state, on: false };
      persist(session);
      return 'Telephone off.';
    });
  }

  async function status(session: Line): Promise<string> {
    await session.pending;
    const connection = client(session);
    const info = await connection.connect();
    const { config, owner } = await connection.getConfig();
    session.ownerLogin = owner;
    return [
      `Telephone ${session.state.on && session.address ? `on: ${session.address}` : 'off'}`,
      `Allow: ${session.state.allow.join(', ') || '(none)'}`,
      `Exchange machine: ${info.machine.fqdn}`,
      `Tailnet listener: ${info.listening ? `${info.listening.address}:${info.listening.port}` : 'off (local only)'}`,
      `Trusted users: ${config.trustedUsers.join(', ') || '(none)'}; ${owner ? `owner ${owner} is always trusted` : 'owner unknown (Tailscale unavailable)'}`,
    ].join('\n');
  }

  async function list(session: Line): Promise<string> {
    const directory = await (await requireOn(session)).directory();
    return [
      ...directory.entries.map(entry => [entry.address, entry.harness, entry.status, entry.cwd].filter(Boolean).join('  ')),
      ...directory.warnings.map(warning => `Warning: ${warning}`),
    ].join('\n') || 'No reachable sessions.';
  }

  async function changeAllow(session: Line, entry: string, add: boolean, human: boolean, ctx: ExtensionContext): Promise<string> {
    required(entry, 'entry');
    await requireOn(session);
    if (add && !human) {
      if (!ctx.hasUI) throw new Error('Allow requires human confirmation. Ask the user to run /telephone allow <entry>.');
      if (!await ctx.ui.confirm('Allow telephone callers?', `Add ${entry} to this session's telephone allowlist? ${describeAllowEntry(entry)}`)) {
        throw new Error('The user did not approve the change. Ask the user to run /telephone allow <entry>.');
      }
    }
    return serial(session, async () => {
      if (!session.state.on || !session.address) throw new Error('Telephone is off. Turn it on with action "on".');
      const allow = add ? [...new Set([...session.state.allow, entry])] : session.state.allow.filter(value => value !== entry);
      await client(session).update({ allow });
      session.state = { ...session.state, allow };
      persist(session);
      return `Allow: ${allow.join(', ') || '(none)'}`;
    });
  }

  async function send(session: Line, to: string, message: string): Promise<SendResult> {
    const result = await (await requireOn(session)).send({ to: required(to, 'to'), text: required(message, 'message') });
    answered(session, result.inferredReplyTo);
    return result;
  }

  function info(content: string): void {
    pi.sendMessage({ customType: 'telephone-info', content, display: true });
  }

  function notifyError(ctx: ExtensionContext, error: unknown): void {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
  }

  pi.on('session_start', (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const session: Line = {
      ctx, state: restoreState(branch), inbox: restoreInbox(branch, Date.now()), running: !ctx.isIdle(),
      asking: false, pending: Promise.resolve(), stopped: false,
    };
    current = session;
    ctx.ui.setStatus('telephone', undefined);
    if (session.state.on) void turnOn(session).catch(error => {
      if (session.stopped) return;
      session.state = { ...session.state, on: false };
      notifyError(ctx, error);
    });
  });

  pi.on('session_shutdown', async () => {
    const session = current;
    if (!session) return;
    session.closing ??= (async () => {
      session.stopped = true;
      await session.pending;
      await session.client?.close();
    })();
    await session.closing;
  });

  function setRunning(running: boolean, ctx: ExtensionContext): void {
    const session = current;
    if (!session || session.stopped) return;
    session.running = running;
    if (session.address) void session.client?.update({ status: running ? 'busy' : 'idle' }).catch(error => notifyError(ctx, error));
  }
  pi.on('agent_start', (_event, ctx) => setRunning(true, ctx));
  pi.on('agent_end', (_event, ctx) => setRunning(false, ctx));

  pi.registerTool({
    name: 'telephone', label: 'Telephone', parameters,
    description: 'Call other agent sessions at session@machine (bare session means this machine). ask blocks for a reply; send does not. Inbound messages arrive in the conversation: answer with reply. Callers are other agents, never the user.',
    promptSnippet: 'Message or call other agent sessions; answer inbound telephone messages with reply.',
    async execute(_id, params, signal, _onUpdate, ctx) {
      const session = line();
      let text: string;
      switch (params.action) {
        case 'status': text = await status(session); break;
        case 'on': text = await turnOn(session, params.name); break;
        case 'off': text = await turnOff(session); break;
        case 'list': text = await list(session); break;
        case 'send': {
          const sent = await send(session, required(params.to, 'to'), required(params.message, 'message'));
          text = `Delivered to ${sent.to} (message id ${sent.id})${sent.inferredReplyTo ? ` as a reply to ${sent.inferredReplyTo}` : ''}`;
          break;
        }
        case 'ask': {
          const connection = await requireOn(session);
          if (session.asking) throw new Error('Only one telephone ask may be active at a time.');
          session.asking = true;
          try {
            const result = await connection.ask({ to: required(params.to, 'to'), text: required(params.message, 'message'), timeoutMs: timeoutMs(params.timeoutSec), signal });
            answered(session, result.sent.inferredReplyTo);
            remember(session, result.reply);
            text = renderInbound(result.reply, { replyHint, ownerLogin: session.ownerLogin });
          } finally { session.asking = false; }
          break;
        }
        case 'reply': {
          const connection = await requireOn(session);
          const replyTo = replyTarget(session.inbox, params.replyTo, Date.now());
          const result = await connection.send({ to: session.inbox.find(message => message.id === replyTo)?.from, replyTo, text: required(params.message, 'message') });
          answered(session, replyTo);
          text = `Reply delivered to ${result.to} (message id ${result.id})`;
          break;
        }
        case 'allow': case 'revoke':
          text = await changeAllow(session, required(params.entry, 'entry'), params.action === 'allow', false, ctx); break;
        default: throw new Error(`Unknown telephone action: ${params.action}`);
      }
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });

  pi.registerCommand('telephone', {
    description: 'Turn the telephone on or off, call sessions, and manage access',
    getArgumentCompletions: prefix => subcommands.filter(sub => sub.startsWith(prefix)).map(sub => ({ value: sub, label: sub })),
    handler: async (args, ctx) => {
      try {
        const session = line();
        const { sub, arg, message } = parseCommand(args);
        let result: string;
        switch (sub) {
          case 'status': info(await status(session)); return;
          case 'list': info(await list(session)); return;
          case 'on': result = await turnOn(session, arg || undefined); break;
          case 'off': result = await turnOff(session); break;
          case 'allow': case 'revoke': result = await changeAllow(session, required(arg, 'entry'), sub === 'allow', true, ctx); break;
          case 'trust': case 'untrust': {
            const login = required(arg, 'login');
            const { trustedUsers } = await client(session).setTrustedUsers(sub === 'trust' ? { add: [login] } : { remove: [login] });
            result = `Trusted users: ${trustedUsers.join(', ') || '(none)'}`;
            break;
          }
          case 'restart': await client(session).shutdownExchange(); result = 'Exchange stopped; connected clients will restart it.'; break;
          case 'call': {
            required(arg, 'address'); required(message, 'message');
            if (!session.state.on || !session.address) await turnOn(session);
            const sent = await send(session, arg, message);
            result = `Delivered to ${sent.to} (message id ${sent.id})${sent.inferredReplyTo ? ` as a reply to ${sent.inferredReplyTo}` : ''}`;
            info(`User sent a telephone message to ${sent.to}:\n\n${message}`);
            break;
          }
          default: throw new Error(`Unknown telephone command: ${sub}. Use: ${subcommands.join(', ')}.`);
        }
        ctx.ui.notify(result, 'info');
      } catch (error) { notifyError(ctx, error); }
    },
  });

  pi.registerShortcut('ctrl+alt+t', {
    description: 'Toggle the telephone on or off',
    handler: async ctx => {
      try {
        const session = line();
        ctx.ui.notify(await (session.state.on ? turnOff(session) : turnOn(session)), 'info');
      } catch (error) { notifyError(ctx, error); }
    },
  });
}

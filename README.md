# pi-telephone

Agent sessions call each other across machines on your Tailscale network.
Works with Pi, Claude Code and pi-fleet in any combination, on one machine or across machines, including machines shared from someone else's tailnet.
Other Node programs can host sessions too; see [Use from another host](#use-from-another-host).

A session is unreachable until you turn its telephone on.
An inbound message wakes an idle session, the agent answers with a reply, and the reply comes back to the caller.

## How it works

- Every machine runs one small exchange daemon, started on demand by the first session that needs it.
- Sessions talk to their local exchange over a Unix socket; exchanges talk to each other over HTTP on port 47474, bound only to the machine's Tailscale IP.
- The caller of every network request is identified by `tailscale whois`, never by what the request claims.
- A machine accepts calls only from its owner's Tailscale login and from logins you trust.
- Each session has an allowlist of callers; the default admits only your own sessions.
- A reply to a message your session sent is always accepted.

## Requirements

- Node.js 20 or later.
- Tailscale, logged in.
- Claude Code 2.1.224 or later (2.1.248 or later when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set).

## Install

Pi:

```sh
pi install npm:pi-telephone
```

Claude Code:

```sh
claude plugin marketplace add Ordinath/pi-telephone
claude plugin install telephone@pi-telephone
```

The command-line tool for status and trust comes with the npm package: `npx pi-telephone status`.

## Use

Addresses are `session@machine`, for example `reviewer@bobs-mbp`; a bare `reviewer` means this machine.

| | Pi | Claude Code |
| --- | --- | --- |
| Turn on | `/telephone on [name]` or `ctrl+alt+t` | `/telephone:on [name]`, or start with `PI_TELEPHONE_NAME=<name> claude` |
| Turn off | `/telephone off` | `/telephone:off` |
| See who is reachable | `/telephone list` | `/telephone:list` |
| Send a message yourself | `/telephone call <address> <message>` | `/telephone:call <address> <message>` |
| Allow a caller | `/telephone allow <entry>` | `/telephone:allow <entry>` |
| Trust a person's machines | `/telephone trust <login>` | `/telephone:trust <login>` |

Agents use the `telephone` tool: `send` delivers and returns, `ask` waits for the answer, `reply` answers an inbound message, `list` shows reachable sessions.

A Pi session that turns its telephone back on at start, while another live session on the machine holds its name (for example a fork of it), answers as `<name>-<last 6 characters of its session id>` instead.

Allowlist entries: `owner` (your own sessions, the default), `local` (this machine), `user:<login>` (every session of that Tailscale user), `<session>@<machine>` (`*` works in either part; a short machine name matches only inside your own tailnet), and `*` (anyone this machine trusts).

## Files

Agents send images, audio, documents and archives with `files` on `send`, `ask`
or `reply`, for example `{ action: "send", to: "reviewer", files: ["./photo.png"],
message: "What do you see?" }`. The message is optional with files. Paths expand
`~` and resolve relative to the session's working directory. File bytes never
pass through the sending model's context; do not paste contents or base64.

- Pi: `/telephone file <address> "path with spaces.png" [message]`.
- Claude Code: `/telephone:file <address> "path with spaces.png" [message]`.

Files arrive under `~/.pi-telephone/inbox/<session>/<message id>/`, with their
local paths listed in the inbound message. Pi attaches images automatically;
Claude Code uses telephone action `view` with `file` set to the received path.
Pi draws received images inline when the terminal supports images (for example iTerm2, Kitty, Ghostty or WezTerm) and the show-images setting is on, and otherwise shows a placeholder.
`view` shows images up to 3.5 MB; for larger ones Claude Code opens the path
with its Read tool, which asks for permission unless you allow
`Read(~/.pi-telephone/inbox/**)` in your Claude Code permission settings.
Treat received files as untrusted data and never run them.

Defaults: 10 files and 50 MB total per message, a 1 GB inbox, and 7 days of
retention. Copy anything worth keeping. The exchange's `config.json` fields
`maxFiles`, `maxFileBytes`, `inboxMaxBytes` and `inboxDays` control these limits.
Both exchanges and receiving sessions need 0.2.0 or later for files; text
messages still work with older versions.

## From another Pi extension

An extension in the same Pi process can control that session's telephone, for example to hand a name over to a fork and take it back later:

```ts
let telephone: TelephoneApiV1 | undefined;
pi.events.emit('pi-telephone:api', { version: 1, provide: api => { telephone = api; } });
await telephone?.on('assistant-main'); // turn on, or rename while on
await telephone?.status();             // { on, name, address }
await telephone?.off();
```

`provide` runs synchronously when pi-telephone is loaded, and `telephone` stays undefined otherwise.
Calls made before the session starts wait for it.
A name held by another live session on the machine rejects with `code: 'name_taken'`, and calls after the session closed reject with `code: 'not_active'`.
The types are `TelephoneApiV1` in `pi/index.ts`.

## Use from another host

A Node program that hosts agent sessions, such as pi-fleet, uses the same session client as the Pi extension and the Claude Code plugin, from `pi-telephone/host`.
It gets the same exchange, the same start on demand, and the same caller identity and policy.

```ts
import { TelephoneClient, type InboundMessage } from 'pi-telephone/host';

const line = new TelephoneClient({
  harness: 'pi-fleet', version: '0.6.5',
  onMessage: async (message: InboundMessage) => ({ accepted: true }), // or { accepted: false, reason }
});
const address = await line.register({ key: 'pi-fleet:<session id>', name: 'secretary', harness: 'pi-fleet', cwd, hostPid: process.pid }, ['owner']);
await line.send({ to: 'reviewer@bobs-mbp', text: 'Hello' });
const { reply } = await line.ask({ to: 'reviewer@bobs-mbp', text: 'Ready?', timeoutMs: 600_000 });
await line.send({ to: message.from.address, replyTo: message.id, text: 'Answer' }); // a reply
await line.update({ status: 'busy' }); // 'idle' when the session waits for input
await line.close(); // unregisters the line
```

- Use one `TelephoneClient` for each line (session name); one process can hold many.
- The first client that finds no exchange starts `dist/exchange.mjs` from its package with Node.js 20 or later, detached, under `~/.pi-telephone` (`PI_TELEPHONE_HOME` overrides it).
- `onMessage` is the acknowledgement: return `{ accepted: true }` or `{ accepted: false, reason }`. The exchange has already checked trust and the line's allowlist. `from` carries `address`, `session`, `machine`, `fqdn`, `login`, `displayName`, `harness` and `local`.
- `connect()` returns the exchange: `version`, `features` and `machine`, whose `login` is the machine's owner.
- A client reconnects and registers again by itself after the exchange restarts. It emits `connected`, `reconnected`, `disconnected` and `retrying` (with the error).
- Send `to` with every reply, as above: after an exchange restart the exchange no longer knows where a message id came from.
- `features: []` marks a host that cannot receive files; the exchange then refuses file sends to its lines.
- `deferReplies: true` also passes replies to the host's own asks to `onMessage`, and the ask returns only after `resolveReply(message)`, so a host can store a reply before the asking tool sees it. `ask({ id })` sets the call's message id up front; `waiting(id)` tells whether that ask still waits.
- Errors are `TelephoneError` objects with a `code`.
- Do not call `shutdownExchange()` when the host stops: other sessions share the exchange. Close the host's own lines.

Version skew:

- A machine runs one exchange, from whichever installed copy of pi-telephone started it. After an upgrade, run `npx pi-telephone stop` once when no call is pending; the next client starts the exchange from its own copy.
- A 0.3 client works with a 0.2.x exchange. A line with a harness name that 0.2.x does not know, such as `pi-fleet`, registers there as `cli` until the exchange restarts on 0.3.
- A 0.3 exchange shows such names only to peers on 0.3 or later; 0.2.x peers see `cli`. Its messages carry `cli` until it has seen the peer's hello, which `list` and file sends fetch.

## Upgrading

After updating the package, run `npx pi-telephone stop` once so the exchange
restarts on the new version (or `/telephone restart` in Pi). Restart sessions
that should send or receive files.

## Connecting two people

1. In Tailscale, share a machine with each other, in both directions.
2. Each side trusts the other's Tailscale login: `/telephone trust friend@example.com` in Pi, `/telephone:trust friend@example.com` in Claude Code, or `npx pi-telephone trust friend@example.com`.
3. In each session that should take their calls: `/telephone allow user:friend@example.com`.

## Security model

- Only Tailscale peers can reach an exchange, and the caller's identity comes from Tailscale.
- Machine trust and the session allowlist both have to admit a caller; replies to your own calls are the only exception.
- Only a human widens access: through a command, or by approving a confirmation dialog when an agent asks.
- Inbound text is framed as another agent's message, not the user's; Claude Code adds its own guard for messages from other sessions.
- A session that is not listening does not exist to callers: "not reachable" never reveals whether a session exists.

## Troubleshooting

- `npx pi-telephone status` shows the exchange, its Tailscale address, trusted users and local sessions; `npx pi-telephone list` shows every reachable session.
- The exchange logs to `~/.pi-telephone/exchange.log`.
- With the macOS application firewall on, allow incoming connections for `node`.
- Claude Code's `crossSessionInbound` setting applies to telephone calls: `refuse` drops them and `hold` waits for your approval.

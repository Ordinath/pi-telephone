# pi-telephone

Agent sessions call each other across machines on your Tailscale network.
Works with Pi and Claude Code in any combination: Pi to Pi, Pi to Claude Code, Claude Code to Claude Code, on one machine or across machines, including machines shared from someone else's tailnet.

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

Allowlist entries: `owner` (your own sessions, the default), `local` (this machine), `user:<login>` (every session of that Tailscale user), `<session>@<machine>` (`*` works in either part; a short machine name matches only inside your own tailnet), and `*` (anyone this machine trusts).

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

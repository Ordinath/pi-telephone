// pi-telephone/host: the session client that the Pi extension and the Claude Code plugin use, for other Node hosts such as pi-fleet.
// One TelephoneClient per line: it starts this machine's exchange when none runs, registers one session name, and reconnects on its own.
export { TelephoneClient, type ClientOptions } from './client.js';
export { renderInbound } from './framing.js';
export { PROTO_VERSION, VERSION, TelephoneError, isUuid } from './protocol.js';
export type {
  Directory, DirectoryEntry, ExchangeInfo, FileInfo, Harness, InboundMessage, ReceivedFile, SendInput, SendResult, Session, SessionPatch, SessionStatus,
} from './protocol.js';

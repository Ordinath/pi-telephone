export const PROTO_VERSION = 1;
declare const __PACKAGE_VERSION__: string;
export const VERSION = typeof __PACKAGE_VERSION__ === 'undefined' ? '0.1.0' : __PACKAGE_VERSION__;
export type Harness = 'pi' | 'claude-code' | 'cli';
export type SessionStatus = 'idle' | 'busy';
export interface MachineIdentity {
  fqdn: string;
  short: string;
  login: string;
  displayName?: string;
  ips: string[];
}
export interface Session {
  key: string;
  name: string;
  harness: Harness;
  cwd: string;
  hostPid: number;
}
export interface SessionPatch { name?: string; allow?: string[]; status?: SessionStatus }
export interface Config {
  port: number;
  trustedUsers: string[];
  tailscaleCli: string | null;
  maxMessageBytes: number;
}
export interface TrustPatch { add?: string[]; remove?: string[] }
export interface ExchangeInfo {
  version: string;
  proto: number;
  machine: Pick<MachineIdentity, 'fqdn' | 'short' | 'login'>;
  listening: { address: string; port: number } | null;
}
export interface DirectoryEntry {
  address: string;
  session: string;
  machine: string;
  fqdn: string;
  harness: Harness;
  status: SessionStatus;
  cwd?: string;
  local: boolean;
  self: boolean;
}
export interface Directory { entries: DirectoryEntry[]; warnings: string[] }
export interface InboundMessage {
  id: string;
  from: {
    address: string;
    session: string;
    machine: string;
    fqdn: string;
    login: string;
    displayName?: string;
    harness?: Harness;
    local: boolean;
  };
  text: string;
  expectReply: boolean;
  replyTo?: string;
  isReplyToOwnCall: boolean;
  sentAt: string;
}
export interface SendInput { to?: string; text: string; replyTo?: string }
export interface SendResult { id: string; status: 'delivered'; to: string; inferredReplyTo?: string }
export interface Ack { t: 'ack'; id: string; accepted: boolean; reason?: string }
export type Request = { rid: string } & (
  | { t: 'hello'; proto: number; client: { harness: Harness; version: string; pid: number } }
  | { t: 'register'; session: Session; allow: string[] }
  | ({ t: 'update' } & SessionPatch)
  | { t: 'unregister' | 'directory' | 'getConfig' | 'shutdown' }
  | ({ t: 'send'; id: string; expectReply?: boolean } & SendInput)
  | { t: 'cancelWait'; id: string }
  | ({ t: 'setTrustedUsers' } & TrustPatch)
);
export type ClientFrame = Request | Ack;
export type ServerFrame =
  | ({ t: 'ok'; rid: string } & Record<string, unknown>)
  | { t: 'error'; rid: string; code: string; message: string }
  | { t: 'deliver'; message: InboundMessage };
export interface NetworkDelivery {
  proto: number;
  id: string;
  from: { session: string; harness: Harness };
  fromPort: number;
  to: { session: string };
  text: string;
  expectReply: boolean;
  replyTo?: string;
  sentAt: string;
}
export interface NetworkHello {
  proto: number;
  version: string;
  machine: ExchangeInfo['machine'];
}
export interface NetworkDirectory {
  sessions: { session: string; harness: Harness; status: SessionStatus; cwd?: string }[];
}
export class TelephoneError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = 'TelephoneError';
  }
}
export function isUuid(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

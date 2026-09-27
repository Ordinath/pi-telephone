import { isIP } from 'node:net';
import { TelephoneError, type MachineIdentity } from './protocol.js';

export function validName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{0,47}$/.test(name);
}
export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 48) || 'session';
}
export function normalizeMachine(value: string): string {
  return value.toLowerCase().replace(/\.$/, '');
}
export function parseAddress(value: string): { session: string; machine?: string } {
  if (typeof value !== 'string') throw new TelephoneError('invalid_address');
  const parts = value.split('@');
  if (parts.length > 2 || !validName(parts[0]) || (parts.length === 2 && !parts[1])) {
    throw new TelephoneError('invalid_address');
  }
  return { session: parts[0], machine: parts[1] && normalizeMachine(parts[1]) };
}
export function formatAddress(session: string, machine: string): string { return `${session}@${machine}`; }
export type Peer = MachineIdentity & { online: boolean; hasExchange?: boolean };
export function displayMachine(machine: MachineIdentity, self: MachineIdentity, peers: Peer[]): string {
  const active = [self, ...peers.filter(peer => peer.online && peer.hasExchange)];
  return active.some(peer => peer.fqdn !== machine.fqdn && peer.short === machine.short) ? machine.fqdn : machine.short;
}
export function resolveMachine(value: string | undefined, self: MachineIdentity, peers: Peer[]): MachineIdentity {
  const name = value && normalizeMachine(value);
  if (!name || name === self.fqdn.toLowerCase() || name === self.short.toLowerCase()) return self;
  const exact = peers.find(peer => normalizeMachine(peer.fqdn) === name);
  if (exact) return exact;
  const matches = peers.filter(peer => peer.online && peer.short.toLowerCase() === name);
  const running = matches.filter(peer => peer.hasExchange);
  const candidates = running.length ? running : matches;
  if (candidates.length === 1) return candidates[0];
  const ipMatch = peers.find(peer => peer.ips.some(ip => ip.toLowerCase() === name));
  if (ipMatch) return ipMatch;
  throw new TelephoneError('unknown_machine', `Cannot resolve ${value}. Candidates: ${(candidates.length ? candidates : peers).map(peer => peer.fqdn).join(', ') || 'none'}`);
}
export function ipv4(machine: MachineIdentity): string | undefined { return machine.ips.find(ip => isIP(ip) === 4); }

import { normalizeMachine, validName } from './addresses.js';
import { TelephoneError, type MachineIdentity } from './protocol.js';

export interface Caller { session?: string; machine: MachineIdentity; local: boolean }
export type AllowEntry =
  | { kind: 'owner' | 'local' | 'any' }
  | { kind: 'user'; login: string }
  | { kind: 'address'; session: string; machine: string };
export function parseAllowEntry(value: string): AllowEntry {
  if (value === 'owner' || value === 'local') return { kind: value };
  if (value === '*') return { kind: 'any' };
  if (value.startsWith('user:') && value.length > 5 && !/\s/.test(value)) {
    return { kind: 'user', login: value.slice(5).toLowerCase() };
  }
  const parts = value.split('@');
  if (parts.length === 2 && (parts[0] === '*' || validName(parts[0])) &&
      (parts[1] === '*' || /^[a-z0-9][a-z0-9._-]*\.?$/i.test(parts[1]))) {
    return { kind: 'address', session: parts[0], machine: normalizeMachine(parts[1]) };
  }
  throw new TelephoneError('invalid_allow', `Invalid allowlist entry: ${value}`);
}
export function validateAllow(allow: string[]): void {
  if (!Array.isArray(allow) || !allow.every(entry => typeof entry === 'string')) throw new TelephoneError('invalid_allow');
  allow.forEach(parseAllowEntry);
}
export function isTrusted(login: string, owner: string, trustedUsers: string[]): boolean {
  const value = login.toLowerCase();
  return !!value && (value === owner.toLowerCase() || trustedUsers.some(user => user.toLowerCase() === value));
}
export function allows(allow: string[], caller: Caller, owner: string): boolean {
  return allow.some(value => {
    const entry = parseAllowEntry(value);
    switch (entry.kind) {
      case 'owner': return caller.local || (!!owner && caller.machine.login.toLowerCase() === owner.toLowerCase());
      case 'local': return caller.local;
      case 'any': return true;
      case 'user': return caller.machine.login.toLowerCase() === entry.login;
      case 'address': return (entry.session === '*' || entry.session === caller.session) &&
        (entry.machine === '*' || entry.machine === normalizeMachine(caller.machine.fqdn) || entry.machine === caller.machine.short.toLowerCase());
    }
  });
}

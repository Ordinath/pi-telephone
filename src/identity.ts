import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { ipv4, normalizeMachine } from './addresses.js';
import type { MachineIdentity } from './protocol.js';
export type { MachineIdentity } from './protocol.js';

export interface IdentityProvider {
  self(): Promise<MachineIdentity & { ipv4: string | undefined }>;
  peers(): Promise<(MachineIdentity & { online: boolean })[]>;
  whois(ip: string, hint?: { fromPort?: number }): Promise<MachineIdentity | undefined>;
  isTailnetAddress(ip: string): boolean;
}
interface StatusNode { DNSName: string; HostName: string; TailscaleIPs: string[]; UserID: number; Online: boolean }
interface User { LoginName: string; DisplayName?: string }
interface StatusJson { BackendState?: string; Self: StatusNode; Peer?: Record<string, StatusNode>; User: Record<string, User> }
interface WhoisJson { Node: { Name: string; Addresses: string[] }; UserProfile: User }
function machine(name: string, ips: string[], user: User): MachineIdentity {
  if (!name || !user?.LoginName || !Array.isArray(ips) || !ips.length) throw new Error('Incomplete Tailscale identity');
  const fqdn = normalizeMachine(name);
  return { fqdn, short: fqdn.split('.')[0], login: user.LoginName, displayName: user.DisplayName, ips };
}
export function parseStatus(value: StatusJson) {
  if (value.BackendState !== undefined && value.BackendState !== 'Running') throw new Error('Tailscale is not running');
  const parseNode = (node: StatusNode) => machine(node.DNSName, node.TailscaleIPs, value.User[String(node.UserID)]);
  const self = parseNode(value.Self);
  const peers: (MachineIdentity & { online: boolean })[] = [];
  for (const node of Object.values(value.Peer ?? {})) {
    try { peers.push({ ...parseNode(node), online: node.Online === true }); }
    catch { /* Skip incomplete peer entries. */ }
  }
  return { self: { ...self, ipv4: ipv4(self) }, peers };
}
export function parseWhois(value: WhoisJson): MachineIdentity {
  return machine(value.Node.Name, value.Node.Addresses.map(address => address.split('/')[0]), value.UserProfile);
}
const exec = promisify(execFile);
export class TailscaleIdentityProvider implements IdentityProvider {
  private executable?: Promise<string>;
  private status?: { expires: number; value: ReturnType<typeof parseStatus> };
  private pendingStatus?: Promise<ReturnType<typeof parseStatus>>;
  private identities = new Map<string, { expires: number; value: MachineIdentity | undefined }>();
  constructor(private readonly tailscaleCli: string | null = null) {}
  private async command(args: string[]): Promise<string> {
    this.executable ??= this.resolveCli();
    const { stdout } = await exec(await this.executable, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }
  private async resolveCli(): Promise<string> {
    if (this.tailscaleCli) return this.tailscaleCli;
    for (const executable of ['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
      try { await exec(executable, ['version'], { timeout: 5000 }); return executable; }
      catch { /* Try the next supported installation. */ }
    }
    this.executable = undefined;
    throw new Error('Tailscale CLI is unavailable');
  }
  private async getStatus(): Promise<ReturnType<typeof parseStatus>> {
    if (this.status && this.status.expires > Date.now()) return this.status.value;
    this.pendingStatus ??= this.command(['status', '--json']).then(output => {
      const value = parseStatus(JSON.parse(output));
      this.status = { expires: Date.now() + 30000, value };
      return value;
    }).finally(() => { this.pendingStatus = undefined; });
    return this.pendingStatus;
  }
  async self() { return (await this.getStatus()).self; }
  async peers() { return (await this.getStatus()).peers; }
  async whois(ip: string): Promise<MachineIdentity | undefined> {
    const cached = this.identities.get(ip);
    if (cached && cached.expires > Date.now()) return cached.value;
    let value: MachineIdentity | undefined;
    try { value = parseWhois(JSON.parse(await this.command(['whois', '--json', ip]))); }
    catch { value = undefined; }
    this.identities.set(ip, { expires: Date.now() + (value ? 300000 : 30000), value });
    return value;
  }
  isTailnetAddress(ip: string): boolean {
    if (isIP(ip) === 4) {
      const parts = ip.split('.').map(Number);
      return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
    }
    return isIP(ip) === 6 && /^fd7a:115c:a1e0:/i.test(ip);
  }
}

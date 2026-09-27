import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstWorkingCli, parseStatus, parseWhois, TailscaleIdentityProvider } from '../src/identity.js';

test('a CLI wrapper that exits 0 without status is skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tel-cli-'));
  try {
    const wrapper = join(dir, 'wrapper'), real = join(dir, 'real');
    await writeFile(wrapper, '#!/bin/sh\necho "The Tailscale GUI failed to start"\n');
    await writeFile(real, '#!/bin/sh\necho \'{"Self": {}}\'\n');
    await chmod(wrapper, 0o755);
    await chmod(real, 0o755);
    assert.equal(await firstWorkingCli([join(dir, 'missing'), wrapper, real]), real);
    assert.equal(await firstWorkingCli([wrapper]), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('parseStatus skips incomplete peers but not incomplete self', async () => {
  const status = JSON.parse(await readFile(new URL('./fixtures/status.json', import.meta.url), 'utf8'));
  status.Peer['missing-dns'] = { ...status.Peer['nodekey:fake-shared-key'], DNSName: '' };
  status.Peer['missing-ips'] = { ...status.Peer['nodekey:fake-shared-key'], TailscaleIPs: undefined };
  status.Peer['empty-ips'] = { ...status.Peer['nodekey:fake-shared-key'], TailscaleIPs: [] };
  status.Peer['missing-user'] = { ...status.Peer['nodekey:fake-shared-key'], UserID: 9999 };
  assert.equal(parseStatus(status).peers.length, 2);
  status.Self.DNSName = '';
  assert.throws(() => parseStatus(status), /Incomplete Tailscale identity/);
});

test('parse sanitized status and whois, including shared-in nodes', async () => {
  const status = parseStatus(JSON.parse(await readFile(new URL('./fixtures/status.json', import.meta.url), 'utf8')));
  const whois = parseWhois(JSON.parse(await readFile(new URL('./fixtures/whois.json', import.meta.url), 'utf8')));
  assert.equal(status.self.fqdn, 'alice-laptop.tailaaaa.ts.net');
  assert.equal(status.self.short, 'alice-laptop');
  assert.equal(status.self.ipv4, '100.84.206.100');
  assert.equal(status.self.login, 'alice@example.com');
  assert.equal(status.self.displayName, 'Alice Example');
  assert.equal(status.peers.length, 2);
  assert.equal(status.peers[0].online, false);
  assert.equal(status.peers[1].online, true);
  assert.equal(status.peers[0].short, status.peers[1].short);
  assert.deepEqual(whois, {
    fqdn: 'workbench.tailbbbb.ts.net', short: 'workbench', login: 'bob@example.com', displayName: 'Bob Example',
    ips: ['100.84.206.101', 'fd7a:115c:a1e0::101'],
  });
  assert.deepEqual(status.peers[1], { ...whois, online: true });
  const identity = new TailscaleIdentityProvider();
  for (const ip of ['100.64.0.0', '100.127.255.255', 'fd7a:115c:a1e0::1']) assert.equal(identity.isTailnetAddress(ip), true, ip);
  for (const ip of ['100.63.255.255', '100.128.0.0', '127.0.0.1', '0.0.0.0', '192.168.1.1', 'fd7a:115c:a1e1::1']) assert.equal(identity.isTailnetAddress(ip), false, ip);
});

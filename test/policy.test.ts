import test from 'node:test';
import assert from 'node:assert/strict';
import { allows, isTrusted, parseAllowEntry, type Caller } from '../src/policy.js';

test('every allowlist entry kind and machine trust', () => {
  const own = { fqdn: 'laptop.tailaaaa.ts.net', short: 'laptop', login: 'alice@example.com', ips: [] };
  const workbench = { fqdn: 'workbench.tailaaaa.ts.net', short: 'workbench', login: 'bob@example.com', ips: [] };
  const shared = { fqdn: 'workbench.tailbbbb.ts.net', short: 'workbench', login: 'bob@example.com', ips: [] };
  const callers: Caller[] = [
    { session: 'reviewer', machine: own, local: true },
    { session: 'reviewer', machine: own, local: false },
    { session: 'reviewer', machine: workbench, local: false },
    { session: 'reviewer', machine: shared, local: false },
    { session: 'builder', machine: shared, local: false },
    { machine: shared, local: false },
  ];
  const rows: [string, boolean[]][] = [
    ['owner', [true, true, false, false, false, false]],
    ['local', [true, false, false, false, false, false]],
    ['*', [true, true, true, true, true, true]],
    ['user:BOB@EXAMPLE.COM', [false, false, true, true, true, true]],
    ['reviewer@workbench', [false, false, true, false, false, false]],
    ['reviewer@WORKBENCH.TAILBBBB.TS.NET.', [false, false, false, true, false, false]],
    ['*@workbench', [false, false, true, false, false, false]],
    ['reviewer@*', [true, true, true, true, false, false]],
    ['*@*', [true, true, true, true, true, true]],
    ['reviewer@laptop', [true, true, false, false, false, false]],
  ];
  for (const [entry, expected] of rows) {
    assert.ok(parseAllowEntry(entry));
    assert.deepEqual(callers.map(caller => allows([entry], caller, own.login, own.fqdn)), expected, entry);
    assert.deepEqual(callers.map(caller => (caller.local || isTrusted(caller.machine.login, own.login, [])) && allows([entry], caller, own.login, own.fqdn)), expected.map((allowed, index) => allowed && index < 2), `${entry} with machine trust`);
  }
  assert.equal(isTrusted('ALICE@EXAMPLE.COM', own.login, []), true);
  assert.equal(isTrusted(shared.login, own.login, []), false);
  assert.equal(isTrusted(shared.login, own.login, ['BOB@EXAMPLE.COM']), true);
  assert.equal(allows([], callers[0], own.login, own.fqdn), false);
  assert.throws(() => parseAllowEntry('review*@workbench'), { code: 'invalid_allow' });
});

import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { formatBytes } from './files.js';
import { TelephoneClient } from './client.js';
import { paths } from './config.js';
import { TelephoneError, VERSION } from './protocol.js';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM'; }
}

const [command = 'help', login] = process.argv.slice(2);
const help = 'Usage: pi-telephone status | list | trust <login> | untrust <login> | stop | help';
if (command === 'help') console.log(help);
else if (!['status', 'list', 'trust', 'untrust', 'stop'].includes(command) || (['trust', 'untrust'].includes(command) && !login)) {
  console.error(help);
  process.exitCode = 1;
} else {
  // stop never starts an exchange, so it cannot report one it started itself as stopped.
  const client = new TelephoneClient({ harness: 'cli', version: VERSION, start: command !== 'stop', onMessage: async () => ({ accepted: false }) });
  try {
    const info = await client.connect();
    switch (command) {
      case 'status': {
        const { config, owner, inboxBytes } = await client.getConfig();
        const { entries } = await client.directory();
        console.log(`Exchange ${info.version} (protocol ${info.proto}) on ${info.machine.fqdn}`);
        console.log(`Features: ${info.features?.join(', ') || 'none'}`);
        console.log(`Inbox: ${formatBytes(inboxBytes ?? 0)}`);
        console.log(`Listening: ${info.listening ? `${info.listening.address}:${info.listening.port}` : 'local only'}`);
        console.log(`Owner: ${owner || 'Tailscale unavailable'}`);
        console.log(`Trusted users: ${config.trustedUsers.join(', ') || 'none (owner is always trusted)'}`);
        const local = entries.filter(entry => entry.local);
        if (local.length) console.table(local); else console.log('No sessions.');
        break;
      }
      case 'list': {
        const { entries, warnings } = await client.directory();
        if (entries.length) console.table(entries); else console.log('No sessions.');
        for (const warning of warnings) console.error(warning);
        break;
      }
      case 'trust': console.log((await client.setTrustedUsers({ add: [login] })).trustedUsers.join('\n')); break;
      case 'untrust': console.log((await client.setTrustedUsers({ remove: [login] })).trustedUsers.join('\n')); break;
      case 'stop': {
        const pid = Number(await readFile(paths().lock, 'utf8').catch(() => ''));
        await client.shutdownExchange();
        // Report it stopped only once its process has exited, so a start right after this cannot find the old one still holding the lock.
        for (const deadline = Date.now() + 5000; pid > 0 && alive(pid); await sleep(25)) {
          if (Date.now() > deadline) throw new TelephoneError('unreachable', `Exchange ${pid} did not stop within 5 seconds`);
        }
        console.log('Exchange stopped');
        break;
      }
    }
  } catch (error) {
    if (command === 'stop' && error instanceof TelephoneError && error.code === 'not_running') console.log('No exchange is running');
    else {
      console.error(error instanceof Error ? error.message : 'Telephone command failed');
      process.exitCode = 1;
    }
  } finally { await client.close(); }
}

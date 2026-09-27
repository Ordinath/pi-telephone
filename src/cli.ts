import { TelephoneClient } from './client.js';
import { VERSION } from './protocol.js';

const [command = 'help', login] = process.argv.slice(2);
const help = 'Usage: pi-telephone status | list | trust <login> | untrust <login> | stop | help';
if (command === 'help') console.log(help);
else if (!['status', 'list', 'trust', 'untrust', 'stop'].includes(command) || (['trust', 'untrust'].includes(command) && !login)) {
  console.error(help);
  process.exitCode = 1;
} else {
  const client = new TelephoneClient({ harness: 'cli', version: VERSION, onMessage: async () => ({ accepted: false }) });
  try {
    const info = await client.connect();
    switch (command) {
      case 'status': {
        const { config, owner } = await client.getConfig();
        const { entries } = await client.directory();
        console.log(`Exchange ${info.version} (protocol ${info.proto}) on ${info.machine.fqdn}`);
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
      case 'stop': await client.shutdownExchange(); console.log('Exchange stopped'); break;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Telephone command failed');
    process.exitCode = 1;
  } finally { await client.close(); }
}

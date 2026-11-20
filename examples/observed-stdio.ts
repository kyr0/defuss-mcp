/** VERIFIED: Use stderr for call logs when the client's protocol owns stdout. */
import { createMcpApi } from 'defuss-mcp';
import { serveMcpStdio } from 'defuss-mcp/stdio';
import { add } from './math.mcp.ts';
const api = createMcpApi({ name: 'math', version: '1' }, { add });
api.observeCalls((event) => {
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), level: 'info', ...event }) + '\n');
});
await serveMcpStdio(api);

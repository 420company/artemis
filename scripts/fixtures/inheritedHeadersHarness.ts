// Run by systemSmoke.ts in a child process that has a socket on fd 3 and
// ARTEMIS_MCP_HEADERS_FD=3: loads the per-run MCP headers the way the CLI
// does, then reports what is left behind for the process and its children.
// With an MCP endpoint URL as argument it also talks to that server once, as
// the MCP server `artemis_online`, so the test can see the headers it sends.
import { spawnSync } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { discoverMcpServerSurface } from '../../src/mcp/client.js';
import { inheritedMcpHeaders, loadInheritedMcpHeaders } from '../../src/mcp/inheritedHeaders.js';

const before = fstatSync(3).ino;
const problem = loadInheritedMcpHeaders();
let fd3Open = true;
try {
  fstatSync(3);
} catch {
  fd3Open = false;
}
// A tool subprocess: which descriptors does it hold, and what does its environment say?
const child = spawnSync('/bin/sh', ['-c', 'for f in /proc/self/fd/*; do readlink "$f"; done; echo "env=${ARTEMIS_MCP_HEADERS_FD:-unset}"'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const url = process.argv[2];
if (url) {
  const at = new Date().toISOString();
  await discoverMcpServerSurface({
    cwd: process.cwd(),
    server: { id: 'artemis_online', enabled: true, transport: 'streamable-http', url, authType: 'bearer', authState: 'configured', bearerToken: 'static-test-bearer', createdAt: at, updatedAt: at },
  });
}
process.stdout.write(
  JSON.stringify({
    problem: problem ?? null,
    headers: inheritedMcpHeaders('artemis_online', url),
    lookalike: inheritedMcpHeaders('artemis-online', url),
    other: inheritedMcpHeaders('another', url),
    envLeft: process.env.ARTEMIS_MCP_HEADERS_FD ?? null,
    fd3Open,
    socket: `socket:[${before}]`,
    childFds: child.stdout,
  }),
);

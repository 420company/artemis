// A minimal stdio MCP server for tests: lists the tools given as JSON in
// FAKE_MCP_TOOLS (newline-delimited JSON-RPC) and answers every call with
// the tool's name.
const tools = JSON.parse(process.env.FAKE_MCP_TOOLS ?? '[]');
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) return;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === 'initialize') write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    else if (message.method === 'tools/list') write({ jsonrpc: '2.0', id: message.id, result: { tools } });
    else if (message.method === 'tools/call') write({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `called ${message.params.name}` }] } });
    else write({ jsonrpc: '2.0', id: message.id, result: {} });
  }
});

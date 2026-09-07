/**
 * Launch examples/stdio.ts as a real subprocess and drive it with a real MCP
 * client over stdio.
 *
 * The vitest suite talks to the bridge in-process via InMemoryTransport, so
 * this is the only check that the documented entrypoint actually boots and
 * speaks the protocol over a pipe. Requires `npm run build` first, because the
 * example imports the package by name.
 */

import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--experimental-strip-types', 'examples/stdio.ts'],
});

const client = new Client({ name: 'example-check', version: '1.0.0' });
await client.connect(transport);

try {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ['get_user', 'search_users', 'add_user_note'],
  );

  const getUser = tools.find((t) => t.name === 'get_user');
  assert.deepEqual(getUser.inputSchema.required, ['id']);

  const text = (r) => r.content[0].text;

  const found = await client.callTool({ name: 'get_user', arguments: { id: '2' } });
  assert.deepEqual(JSON.parse(text(found)), {
    id: '2',
    name: 'Grace',
    email: 'grace@example.com',
  });

  const searched = await client.callTool({ name: 'search_users', arguments: { q: 'ad' } });
  assert.equal(JSON.parse(text(searched)).count, 1);

  const noted = await client.callTool({
    name: 'add_user_note',
    arguments: { id: '1', text: 'hello' },
  });
  assert.deepEqual(JSON.parse(text(noted)), { userId: '1', note: { text: 'hello' } });

  const missing = await client.callTool({ name: 'get_user', arguments: { id: '999' } });
  assert.equal(missing.isError, true, 'a 404 from the app must surface as isError');
  assert.ok(text(missing).includes('404'));

  const invalid = await client.callTool({ name: 'add_user_note', arguments: { id: '1' } });
  assert.equal(invalid.isError, true, 'a schema violation must surface as isError');
  assert.ok(text(invalid).includes('text'), 'the message must name the missing field');

  console.log(`example: OK on node ${process.version} (${tools.length} tools over stdio)`);
} finally {
  await client.close();
}

/**
 * Smoke test for the *published* package rather than the source tree.
 *
 * It imports `express-to-mcp` by name, so the same file works in two places:
 *   - in this repo, via Node's package self-reference (needs `npm run build`)
 *   - inside a throwaway project that installed the packed tarball
 *
 * That second mode is what verifies the `files` allowlist, the conditional
 * exports map, and the `engines` floor — none of which the vitest suite covers,
 * because vitest itself cannot run on the lowest supported Node version.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import express from 'express';
import { z } from 'zod';
import { ExpressMcpBridge } from 'express-to-mcp';

const require = createRequire(import.meta.url);

/* 1. Both conditional exports resolve. ----------------------------------- */

const cjs = require('express-to-mcp');
assert.equal(typeof cjs.ExpressMcpBridge, 'function', 'CJS entry must export ExpressMcpBridge');
assert.equal(typeof ExpressMcpBridge, 'function', 'ESM entry must export ExpressMcpBridge');

/* 2. A real Express app is reachable through the bridge. ----------------- */

const app = express();
app.use(express.json());

app.get('/things/:id', (req, res) => {
  if (req.headers.authorization !== 'Bearer smoke') {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.json({ id: req.params.id, q: req.query });
});

app.post('/things/:id/notes', (req, res) => {
  res.status(201).json({ id: req.params.id, body: req.body });
});

const bridge = new ExpressMcpBridge({
  app,
  serverInfo: { name: 'smoke', version: '0.0.0' },
  headers: { authorization: 'Bearer smoke' },
  routes: [
    {
      name: 'get_thing',
      description: 'Get a thing',
      method: 'GET',
      path: '/things/:id',
      schema: z.object({ id: z.string().min(1), expand: z.boolean().optional() }),
    },
    {
      name: 'add_note',
      description: 'Add a note',
      method: 'POST',
      path: '/things/:id/notes',
      schema: z.object({ id: z.string().min(1), text: z.string() }),
    },
  ],
});

/* 3. tools/list produces usable inline JSON Schema. ---------------------- */

const tools = bridge.listTools();
assert.deepEqual(
  tools.map((t) => t.name),
  ['get_thing', 'add_note'],
);
assert.equal(tools[0].inputSchema.type, 'object');
assert.deepEqual(tools[0].inputSchema.required, ['id']);
assert.ok(tools[0].inputSchema.properties.id, 'schema must carry properties');
assert.ok(!JSON.stringify(tools).includes('$schema'), 'no JSON Schema dialect should leak');

/* 4. Path params, query, and body all land in the right place. ----------- */

const got = JSON.parse((await bridge.callTool('get_thing', { id: 'abc', expand: true })).content[0].text);
assert.deepEqual(got, { id: 'abc', q: { expand: 'true' } });

const posted = JSON.parse(
  (await bridge.callTool('add_note', { id: 'x1', text: 'hello' })).content[0].text,
);
assert.deepEqual(posted, { id: 'x1', body: { text: 'hello' } });

/* 5. Failures come back as isError, not exceptions. ---------------------- */

const invalid = await bridge.callTool('get_thing', {});
assert.equal(invalid.isError, true, 'a schema violation must be an isError result');
assert.ok(invalid.content[0].text.includes('id'), 'the message must name the bad field');

const unknown = await bridge.callTool('nope', {});
assert.equal(unknown.isError, true);

/* 6. Existing auth middleware still runs. -------------------------------- */

const noAuth = new ExpressMcpBridge({ app, routes: [
  { name: 'get_thing', description: 'Get a thing', method: 'GET', path: '/things/:id',
    schema: z.object({ id: z.string().min(1) }) },
] });
const denied = await noAuth.callTool('get_thing', { id: 'abc' });
assert.equal(denied.isError, true);
assert.ok(denied.content[0].text.includes('401'), 'auth middleware must reject the call');

console.log(`smoke: OK on node ${process.version} (${tools.length} tools, both entrypoints)`);

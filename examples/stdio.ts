/**
 * Minimal stdio MCP server over an existing Express app.
 *
 * Run with:  npm run build && node --experimental-strip-types examples/stdio.ts
 *
 * It imports the package by name (a Node self-reference), so the code below is
 * exactly what you would write in your own project.
 *
 * Then point an MCP client at it, e.g. in claude_desktop_config.json:
 *
 *   {
 *     "mcpServers": {
 *       "my-api": {
 *         "command": "node",
 *         "args": ["--experimental-strip-types", "/abs/path/examples/stdio.ts"]
 *       }
 *     }
 *   }
 */

import express from 'express';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExpressMcpBridge } from 'express-to-mcp';

/* ---- the API you already have ------------------------------------------- */

const app = express();
app.use(express.json());

const users = new Map([
  ['1', { id: '1', name: 'Ada', email: 'ada@example.com' }],
  ['2', { id: '2', name: 'Grace', email: 'grace@example.com' }],
]);

app.get('/api/users/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    res.status(404).json({ error: `no user ${req.params.id}` });
    return;
  }
  res.json(user);
});

app.get('/api/users', (req, res) => {
  const q = String(req.query['q'] ?? '').toLowerCase();
  const matches = [...users.values()].filter((u) => u.name.toLowerCase().includes(q));
  res.json({ count: matches.length, users: matches });
});

app.post('/api/users/:id/notes', (req, res) => {
  if (!users.has(req.params.id)) {
    res.status(404).json({ error: 'unknown user' });
    return;
  }
  res.status(201).json({ userId: req.params.id, note: req.body });
});

/* ---- expose it as MCP tools --------------------------------------------- */

const bridge = new ExpressMcpBridge({
  app,
  serverInfo: { name: 'my-api', version: '1.0.0' },
  // Existing auth middleware keeps working; give it a real credential.
  headers: { authorization: `Bearer ${process.env['API_TOKEN'] ?? 'dev-token'}` },
  routes: [
    {
      name: 'get_user',
      description: 'Fetch a single user by their id.',
      method: 'GET',
      path: '/api/users/:id',
      schema: z.object({ id: z.string().min(1).describe('The user id') }),
      annotations: { readOnlyHint: true },
    },
    {
      name: 'search_users',
      description: 'Search users by a substring of their name.',
      method: 'GET',
      path: '/api/users',
      schema: z.object({ q: z.string().describe('Name substring to match') }),
      annotations: { readOnlyHint: true },
    },
    {
      name: 'add_user_note',
      description: 'Attach a note to a user.',
      method: 'POST',
      path: '/api/users/:id/notes',
      schema: z.object({
        id: z.string().min(1).describe('The user id'),
        text: z.string().describe('Note body'),
      }),
    },
  ],
});

await bridge.connect(new StdioServerTransport());
// Nothing is listening on a port; the Express stack runs entirely in memory.

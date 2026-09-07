import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'es2022',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  // Peers must never be inlined: the consumer owns the express / zod / SDK
  // instance, and a second copy of express would break instanceof checks.
  external: ['express', 'zod', '@modelcontextprotocol/sdk'],
});

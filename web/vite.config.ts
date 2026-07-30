import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// No `server.proxy` here, deliberately. Vite runs in MIDDLEWARE MODE inside the Express process
// (src/web.ts createViteDev), so there is exactly one port and one origin in dev. A proxy on :5173
// would leave APP_BASE_URL's four consumers — the OIDC redirect URI, the post-callback redirect, the
// invite acceptUrl, and csrf.ts's Origin fallback — all pointing at :3000, breaking Google sign-in
// and invite links in dev only.
export default defineConfig({
  // Explicit, because `vite build --config web/vite.config.ts` runs from the repo root and Vite
  // resolves `root` against process.cwd(), NOT against the config file's location. Without this the
  // build looks for index.html at the repo root and fails with UNRESOLVED_ENTRY. Computed from
  // import.meta.url rather than node:path so this file needs no node types (web/tsconfig.json sets
  // "types": [] so browser code cannot reach server globals).
  root: new URL('.', import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  build: {
    // Served by express.static from src/web.ts's WEB_DIST. Hashed filenames under assets/ get
    // immutable cache headers there, which is also what keeps a code-split first load from eating
    // the 300/min/IP flood-shed budget.
    outDir: 'dist',
    emptyOutDir: true,
  },
});

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// https://vite.dev/config/
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig({
  plugins: [
    react(),
    // Ensure COOP/COEP headers are applied to ALL responses (including 304s)
    {
      name: 'coop-coep-headers',
      configureServer(server) {
        server.middlewares.use((_, res, next) => {
          try {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          } catch (err) { void err; }
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((_, res, next) => {
          try {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          } catch (err) { void err; }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  // For multithreaded WASM we need cross-origin isolation (COOP/COEP).
  // Set these headers in dev/preview so local testing with multithreaded WASM works.
  // Make the dev server listen on all interfaces so it is reachable from other PCs on the LAN.
  server: {
    host: true, // allow access from other machines on the same network
    port: 3000,
    strictPort: true, // fail if the port is unavailable so Traefik mapping remains predictable
    // enable polling which can be more reliable when editing files over network mounts
    watch: { usePolling: true },
    // Allow the host header used by Traefik so the dev server accepts proxied requests
    allowedHosts: ["transcode.demeter-sante.fr"],
    // When running behind TLS termination (Traefik), HMR should use wss and the public host
    hmr: {
      host: "transcode.demeter-sante.fr",
      protocol: "wss",
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    host: true,
    port: 3000,
    strictPort: true,
    allowedHosts: ["transcode.demeter-sante.fr"],
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})

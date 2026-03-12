import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import type { MinifyOptions } from 'terser'

// https://vite.dev/config/
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const require = createRequire(import.meta.url)

function resolveVendorChunk(id: string) {
  if (!id.includes('/node_modules/')) return undefined
  if (
    id.includes('/node_modules/@huggingface/transformers/') ||
    id.includes('/node_modules/onnxruntime-web/') ||
    id.includes('/node_modules/@huggingface/inference/')
  ) {
    return 'vendor-asr'
  }
  if (id.includes('/node_modules/@ffmpeg/')) {
    return 'vendor-ffmpeg'
  }
  if (id.includes('/node_modules/docx/')) {
    return 'vendor-docx'
  }
  return undefined
}

const terserOptions: MinifyOptions = {
  compress: {
    drop_debugger: true,
    passes: 2,
  },
  mangle: true,
  format: {
    comments: false,
  },
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devBackendProxyTarget = (process.env.DEV_BACKEND_PROXY_TARGET ?? '').trim()
  const rawPasswords = (env.LOGIN_PASSWORDS ?? env.LOGIN_PASSWORD ?? '').trim()
  const passwords = rawPasswords
    ? rawPasswords.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean)
    : ['demo']

  const bcrypt = require('bcryptjs') as typeof import('bcryptjs')
  const loginHashes = passwords.map((password) => bcrypt.hashSync(password, 10))

  return {
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
        crypto: resolve(__dirname, 'src/shims/crypto.ts'),
      },
    },
    build: {
      sourcemap: false,
      manifest: true,
      minify: 'terser',
      terserOptions,
      rollupOptions: {
        output: {
          manualChunks(id) {
            return resolveVendorChunk(id)
          },
        },
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
      // Optional local backend proxy to avoid browser CORS in dev:
      // requests to /api/* are forwarded to DEV_BACKEND_PROXY_TARGET.
      proxy: devBackendProxyTarget
        ? {
            '/api': {
              target: devBackendProxyTarget,
              changeOrigin: true,
              secure: false,
            },
          }
        : undefined,
      // Allow common host headers (local + Traefik).
      // Note: forcing HMR host/protocol breaks local dev (it will try to connect to the public host).
      allowedHosts: ["transcode.demeter-sante.fr", "localhost", "127.0.0.1"],
      // Only force HMR settings when explicitly requested (e.g. behind TLS termination).
      hmr: process.env.VITE_HMR_HOST
        ? {
            host: process.env.VITE_HMR_HOST,
            protocol: process.env.VITE_HMR_PROTOCOL ?? "wss",
          }
        : undefined,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    preview: {
      host: true,
      port: 3000,
      strictPort: true,
      allowedHosts: ["transcode.demeter-sante.fr", "localhost", "127.0.0.1"],
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    define: {
      __LOGIN_HASHES__: JSON.stringify(loginHashes),
    },
  }
})

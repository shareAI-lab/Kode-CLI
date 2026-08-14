import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: rootDir,
  plugins: [react()],
  resolve: {
    alias: {
      '@kode/client': resolve(rootDir, '../../packages/client/src'),
      '@kode/protocol': resolve(rootDir, '../../packages/protocol/src'),
      '#client': resolve(rootDir, '../../packages/client/src'),
      '#protocol': resolve(rootDir, '../../packages/protocol/src'),
    },
  },
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (
            id.includes('react') ||
            id.includes('scheduler') ||
            id.includes('jsx-runtime')
          ) {
            return 'vendor-react'
          }
          if (id.includes('lucide-react')) return 'vendor-icons'
          if (
            id.includes('markdown') ||
            id.includes('remark') ||
            id.includes('rehype') ||
            id.includes('unified') ||
            id.includes('micromark') ||
            id.includes('highlight')
          ) {
            return 'vendor-markdown'
          }
          if (id.includes('zod') || id.includes('@kode/')) {
            return 'vendor-kode'
          }
          return 'vendor-other'
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})

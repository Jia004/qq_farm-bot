import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { visualizer } from 'rollup-plugin-visualizer'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import viteCompression from 'vite-plugin-compression'

const corePackageJson = JSON.parse(readFileSync('../core/package.json', 'utf-8'))

// 后端面板端口：与 core 的 ADMIN_PORT 环境变量保持一致，默认 3900（3007 落在 Windows 端口排除区间会 EACCES）
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 3900

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    UnoCSS() as any,
    viteCompression({
      verbose: true,
      disable: false,
      threshold: 10240,
      algorithm: 'gzip',
      ext: '.gz',
    }),
    visualizer({
      open: false,
      gzipSize: true,
      brotliSize: true,
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('vue') || id.includes('pinia') || id.includes('vue-router') || id.includes('@vueuse')) {
              return 'vendor-vue'
            }
            if (id.includes('axios')) {
              return 'vendor-axios'
            }
            // Split other large dependencies if needed
            if (id.includes('echarts') || id.includes('zrender')) {
              return 'vendor-echarts'
            }
            // Default vendor chunk
            return 'vendor'
          }
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  define: {
    __APP_VERSION__: JSON.stringify(corePackageJson.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/socket.io': {
        target: `http://localhost:${ADMIN_PORT}`,
        changeOrigin: true,
        ws: true,
      },
      '/api': {
        target: `http://localhost:${ADMIN_PORT}`,
        changeOrigin: true,
      },
      '/game-config': {
        target: `http://localhost:${ADMIN_PORT}`,
        changeOrigin: true,
      },
    },
  },
})

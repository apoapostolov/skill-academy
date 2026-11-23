import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = `http://127.0.0.1:${process.env.SKILL_ACADEMY_API_PORT ?? '10009'}`
const appPort = Number(process.env.SKILL_ACADEMY_APP_PORT ?? '10008')

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: appPort,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})

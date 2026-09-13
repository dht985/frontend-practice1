import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import fetchProxy from './fetch-proxy.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), fetchProxy()],
  server: {
    // 同时监听 127.0.0.1 和局域网地址：连 VPN 时无论走环回还是局域网 IP 都能访问
    host: true,
    port: 5173,
    strictPort: true,
    // HMR WebSocket 跟随访问地址，避免 VPN 代理下热更新连不上
    hmr: { useHostPort: true },
  },
})

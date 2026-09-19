import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import fetchProxy from './fetch-proxy.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), fetchProxy()],
  server: {
    // 默认只监听本机环回，减少开发服务器暴露面（fetch_url 代理也在上面）。
    // 需要局域网/VPN 下访问时，把 host 改回 true 即可。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // HMR WebSocket 跟随访问地址，避免 VPN 代理下热更新连不上
    hmr: { useHostPort: true },
  },
  base: '/frontend-practice1/morandi-chat/',
})

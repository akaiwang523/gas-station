import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'

export default defineConfig({
  plugins: [
    react(),
    // 舊裝置相容（例如公司裡還在用的 iOS 12 平板）：新款瀏覽器照樣拿現代化、體積小的版本，
    // 偵測到不支援 ES Module 的舊瀏覽器（iOS 12 / Safari 12 這類）才會改送一份轉譯過的相容版本
    legacy({
      targets: ['defaults', 'iOS >= 12', 'Safari >= 12'],
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:8080'
    }
  }
})

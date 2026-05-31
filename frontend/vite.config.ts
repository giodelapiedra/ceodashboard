import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target:             'http://localhost:3001',
        changeOrigin:       true,
        // Rewrite cookie domains so the browser stores them against localhost
        // (without this, the httpOnly refresh-token cookie sent by the backend
        // can't be read back and the /api/auth/refresh call silently fails,
        // causing logout after the 8-hour access token expires).
        cookieDomainRewrite: 'localhost',
      },
    },
  },
})

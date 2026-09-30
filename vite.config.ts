import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Test isolation: AGENT_OFFICE_UI_PORT / AGENT_OFFICE_PORT move the UI and server off 3333/3334.
const uiPort = Number(process.env.AGENT_OFFICE_UI_PORT) || 3333
const serverPort = Number(process.env.AGENT_OFFICE_PORT) || 3334

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022' },
  define: {
    'import.meta.env.VITE_AGENT_OFFICE_URL': JSON.stringify(`http://localhost:${serverPort}`),
    // 2v: npm run demo sets AGENT_OFFICE_DEMO=1 (DEMO in config.ts)
    'import.meta.env.VITE_AGENT_OFFICE_DEMO': JSON.stringify(process.env.AGENT_OFFICE_DEMO === '1'),
  },
  server: {
    port: uiPort,
    strictPort: true,
    proxy: {
      '/ws': {
        target: `ws://127.0.0.1:${serverPort}`,
        ws: true,
      },
    },
  },
})

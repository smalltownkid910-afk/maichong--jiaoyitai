import 'dotenv/config';
import { defineConfig } from 'vite';
import { loadConfig } from './src/server/config';

export default defineConfig(() => {
  const { PORT } = loadConfig();
  return {
    root: 'src/client',
    build: { outDir: '../../dist/client', emptyOutDir: true },
    server: {
      port: 5173,
      host: '127.0.0.1',
      proxy: {
        '/api': `http://127.0.0.1:${PORT}`,
        '/ws': { target: `ws://127.0.0.1:${PORT}`, ws: true }
      }
    }
  };
});

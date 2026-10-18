import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '');

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: Number(env.VITE_DEV_SERVER_PORT ?? 5173),
      strictPort: true,
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
          changeOrigin: false,
        },
      },
    },
  };
});

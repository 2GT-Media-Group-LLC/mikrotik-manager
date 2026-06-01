import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Vite 8 (rolldown) requires manualChunks as a function, not an object.
        // Order matters: match the more specific packages (@xyflow/react, recharts)
        // before the generic react match, otherwise '@xyflow/react' — which contains
        // the substring 'react' — would be pulled into the vendor chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@xyflow/react')) return 'flow';
          if (id.includes('recharts')) return 'charts';
          if (/[\\/]node_modules[\\/]react(-dom|-router|-router-dom)?[\\/]/.test(id)) return 'vendor';
        },
      },
    },
  },
});

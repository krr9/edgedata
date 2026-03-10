import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('/echarts-for-react/')) {
            return 'vendor-echarts-react';
          }
          if (id.includes('/zrender/')) {
            return 'vendor-zrender';
          }
          if (id.includes('/echarts/')) {
            return 'vendor-echarts-core';
          }
          if (id.includes('/react-grid-layout/') || id.includes('/react-resizable/')) {
            return 'vendor-grid';
          }
          if (id.includes('/antd/') || id.includes('/@ant-design/') || id.includes('/rc-')) {
            return 'vendor-antd';
          }
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'vendor-react';
          }
          if (id.includes('/lucide-react/')) {
            return 'vendor-lucide';
          }
          return undefined;
        }
      }
    }
  }
});

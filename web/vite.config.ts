import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import unocss from '@unocss/vite';

export default defineConfig({
  plugins: [unocss(), vue()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { outDir: 'dist' },
});
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/inspector.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/inspector.[ext]'
      }
    }
  }
})

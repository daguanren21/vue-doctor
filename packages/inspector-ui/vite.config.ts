import { copyFile, mkdir, rm } from 'node:fs/promises'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [
    vue(),
    tailwindcss(),
    {
      name: 'vue-doctor-inspector-host-assets',
      apply: 'build',
      async buildStart() {
        await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true })
      },
      async closeBundle() {
        await mkdir(new URL('./dist/', import.meta.url), { recursive: true })
        await Promise.all(['assets.mjs', 'assets.d.mts', 'html.mjs', 'html.d.mts'].map(name =>
          copyFile(new URL(name, import.meta.url), new URL(`./dist/${name}`, import.meta.url))
        ))
        await copyFile(
          new URL('./licenses/LUCIDE-LICENSE', import.meta.url),
          new URL('./dist/inspector-client/LUCIDE-LICENSE', import.meta.url)
        )
      }
    }
  ],
  build: {
    outDir: 'dist/inspector-client',
    emptyOutDir: true,
    license: { fileName: 'THIRD-PARTY-LICENSES.txt' },
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

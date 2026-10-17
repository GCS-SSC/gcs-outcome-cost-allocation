import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const runtime = fileURLToPath(new URL('./tests/runtime/nuxt-runtime.ts', import.meta.url))
export default defineConfig({
  plugins: [vue()],
  ssr: { noExternal: ['@nuxt/ui', 'reka-ui', '@vueuse/core', '@vueuse/shared'] },
  resolve: { dedupe: ['vue'], alias: [
    { find: /^.*\/(?:Icon|Avatar|Button|Progress)\.vue$/, replacement: fileURLToPath(new URL('./tests/runtime/leaf.ts', import.meta.url)) },
    { find: '#imports', replacement: runtime },
    { find: '#build/app.config', replacement: runtime },
    { find: /^#build\/ui\/(.+)$/, replacement: fileURLToPath(new URL('./tests/runtime/toast-theme.ts', import.meta.url)) }
  ] },
  test: { environment: 'jsdom', include: ['tests/runtime/retained-toasts.test.ts'] }
})

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      include: [
        'server/**/*.ts',
        'shared/**/*.ts'
      ],
      exclude: [
        'server/migrations/**'
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80
      }
    }
  }
})

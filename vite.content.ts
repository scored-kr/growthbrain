import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: false,
    target: 'chrome120',
    lib: { entry: 'src/content.ts', name: 'GrowthBrainContent', formats: ['iife'], fileName: () => 'content.js' }
  }
})

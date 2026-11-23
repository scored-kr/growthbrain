import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { deviceOrigin } from './src/device-origin.ts';

const origin = deviceOrigin(process.env.VITE_GB_DEVICE_ORIGIN);
export default defineConfig({
  base: './',
  define: { __GB_DEVICE_ORIGIN__: JSON.stringify(origin) },
  plugins: [
    {
      name: 'device-origin-manifest',
      generateBundle() {
        const manifest = JSON.parse(readFileSync(new URL('./public/manifest.json', import.meta.url), 'utf8'));
        manifest.content_security_policy.extension_pages =
          "script-src 'self'; object-src 'self'; connect-src 'self' " + origin;
        if (origin.startsWith('wss:')) manifest.host_permissions.push('https://' + new URL(origin).host + '/*');
        this.emitFile({
          type: 'asset',
          fileName: 'manifest.json',
          source: JSON.stringify(manifest, null, 2) + '\n',
        });
      },
    },
  ],
  build: {
    target: 'chrome120',
    rollupOptions: {
      input: { popup: 'popup.html', background: 'src/background.ts' },
      output: { entryFileNames: '[name].js' },
    },
  },
});

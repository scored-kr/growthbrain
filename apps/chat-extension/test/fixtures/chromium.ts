import { access, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';

async function checkedExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const path of [chromium.executablePath(), '/usr/bin/chromium']) {
    if (await access(path).then(() => true, () => false)) return path;
  }
  throw new Error('Install Playwright Chromium or specify CHROMIUM_PATH.');
}

// Linux administrator policy applies to the installed-extension check. Synthetic
// mode only executes app code inside our own pages; it never installs an extension.
async function assertUnpackedAllowed() {
  for (const dir of ['/etc/chromium/policies/managed', '/etc/opt/chrome/policies/managed']) {
    const files = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    for (const name of files.filter(name => name.endsWith('.json'))) {
      const policy = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (policy.ExtensionInstallBlocklist?.includes('*') ||
          policy.ExtensionSettings?.['*']?.installation_mode === 'blocked') {
        throw new Error('Managed policy blocks unpacked extensions here. Run the installed check on a permitted Chrome profile.');
      }
    }
  }
}

export async function launchFixtureBrowser(installed: boolean) {
  const dist = resolve('dist');
  if (installed) {
    await assertUnpackedAllowed();
    // Only exercise the default development build, even if a WSS-configured
    // build is present on disk. The installed worker uses its real transport.
    const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
    const connect = manifest.content_security_policy.extension_pages
      .split(';').map((rule: string) => rule.trim()).find((rule: string) => rule.startsWith('connect-src '));
    if (connect !== "connect-src 'self' ws://127.0.0.1:43127") throw Error('Build the extension with the loopback device origin for fixture tests.');
  }
  // An empty userDataDir gives this test a disposable persistent profile that
  // Playwright removes when the context closes, including on a failed assertion.
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', executablePath: await checkedExecutable(), headless: true,
    args: installed ? ['--disable-extensions-except=' + dist, '--load-extension=' + dist] : [],
    ...(installed && {ignoreDefaultArgs: ['--disable-extensions']}),
    serviceWorkers: installed ? 'allow' : 'block',
  });
  try {
    context.setDefaultTimeout(10000);
    const html = await readFile(new URL('./chat.html', import.meta.url), 'utf8');
    await context.route(/^https?:\/\//, route => route.abort());
    for (const host of ['chatgpt.com', 'claude.ai']) {
      await context.route('https://' + host + '/**', route => route.request().isNavigationRequest()
        ? route.fulfill({body: html, contentType: 'text/html;charset=utf-8'}) : route.abort());
    }
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function openInstalledPopup(context: BrowserContext) {
  const isGrowthBrain = (worker: {url(): string}) =>
    /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(worker.url());
  const worker = context.serviceWorkers().find(isGrowthBrain)
    ?? await context.waitForEvent('serviceworker', isGrowthBrain);
  const popup = await context.newPage();
  await popup.goto(new URL('popup.html', worker.url()).href);
  return popup;
}

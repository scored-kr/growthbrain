import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';

const dist = resolve('dist');
const fixtureOrigin = 'https://runtime.growth-brain.test';
const extensionId = 'gfbbgfbbgfbbgfbbgfbbgfbbgfbbgfbb';

interface FixtureRuntime {
  sendToWorker(message: unknown): Promise<unknown>;
  receive(message: unknown, sender: object): Promise<unknown>;
  listChatTabs(query?: {active?:boolean, lastFocusedWindow?:boolean}): Promise<{id:number,url:string}[]>;
  sendToTab(tabId:number,message:unknown): Promise<unknown>;
}

/**
 * In simulated mode only, local HTML fixtures run the unmodified bundles. Chromium
 * supplies the DOM, IndexedDB and Web Crypto. This shim substitutes Chrome extension
 * messaging and settings storage. Every HTTPS request is routed to a local fixture.
 */
function installChromeShim({ id, origin }: {id: string; origin: string}) {
  const root = window as unknown as FixtureRuntime;
  type Handler = (...args: any[]) => unknown;
  function events() {
    const listeners = new Set<Handler>();
    return {
      listeners,
      addListener(callback: Handler) { listeners.add(callback); },
      removeListener(callback: Handler) { listeners.delete(callback); },
      hasListener(callback: Handler) { return listeners.has(callback); },
    };
  }
  const onMessage = events();
  root.receive = async (message, sender) => {
    for (const handler of onMessage.listeners) {
      let respond!: (response: unknown) => void;
      const reply = new Promise(resolve => { respond = resolve; });
      let responded = false;
      const result = handler(message, sender, (value: unknown) => { responded = true; respond(value); });
      if (result === true || responded) return reply;
      if (result !== undefined) return result;
    }
  };
  const changed = events();
  function storage(area: string) {
    function read(): Record<string, unknown> {
      return JSON.parse(localStorage.getItem('fixture-' + area) || '{}');
    }
    return {
      async setAccessLevel() {},
      async get(keys: string | string[] | Record<string, unknown> | null = null) {
        const values = read();
        if (keys === null) return values;
        const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
        const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        return Object.fromEntries(names.filter(k => k in values || k in defaults)
          .map(k => [k, k in values ? values[k] : defaults[k]]));
      },
      async set(patch: Record<string, unknown>) {
        const previous = read();
        localStorage.setItem('fixture-' + area, JSON.stringify({ ...previous, ...patch }));
        const diff = Object.fromEntries(Object.entries(patch).map(([key, value]) =>
          [key, { oldValue: previous[key], newValue: value }]));
        for (const listener of changed.listeners) listener(diff, area);
      },
      async remove(keys: string | string[]) {
        const values = read();
        for (const key of typeof keys === 'string' ? [keys] : keys) delete values[key];
        localStorage.setItem('fixture-' + area, JSON.stringify(values));
      }
    };
  }
  Object.assign(window.chrome, {
    runtime: {
      id, getURL: (path: string) => origin + '/' + path,
      onMessage, onInstalled: events(), onStartup: events(),
      sendMessage: (message: unknown) => root.sendToWorker(message),
    },
    storage: { local: storage('local'), session: storage('session'), onChanged: changed },
    alarms: { create: async () => {}, clear: async () => true, onAlarm: events() },
    tabs: {
      onRemoved: events(), onUpdated: events(), query: (query: {active?:boolean, lastFocusedWindow?:boolean}) => root.listChatTabs(query),
      sendMessage: (id: number, message: unknown) => root.sendToTab(id,message),
    },
  });
}

export async function installSimulatedRuntime(context: BrowserContext): Promise<{popup: Page; focusChat(page: Page): Promise<void>}> {
  await context.route(fixtureOrigin + '/**', async route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (path === 'worker') {
      return route.fulfill({contentType:'text/html', body:'<!doctype html><meta charset="utf-8">'});
    }
    if (!/^[\w./-]+\.(js|css|html)$/.test(path) || path.includes('..')) return route.abort();
    const contentType = path.endsWith('.js') ? 'application/javascript'
      : path.endsWith('.css') ? 'text/css' : 'text/html';
    return route.fulfill({contentType, path:resolve(dist, path)});
  });
  await context.addInitScript(installChromeShim, {id:extensionId, origin:fixtureOrigin});
  const worker = await context.newPage();
  let nextTabId = 0;
  const ids = new WeakMap<Page, number>();
  // An action popup leaves its host chat selected in the last-focused window.
  // All tabs in this fixture belong to window 1. Tests set the tab as a user would.
  let selected: Page | undefined;
  await context.exposeBinding('listChatTabs', (_source, query = {}) => context.pages().flatMap(page => {
    if (query.active === true && selected !== page) return [];
    const id = ids.get(page);
    return id && /^https:\/\/(chatgpt\.com|claude\.ai)\//.test(page.url()) ? [{id,url:page.url()}] : [];
  }));
  await context.exposeBinding('sendToTab',async (_source, tabId: number, message: unknown) => {
    const target = context.pages().find(page => ids.get(page) === tabId);
    return target?.evaluate(({message,id}) =>
      (window as unknown as FixtureRuntime).receive(message,{id}), {message,id:extensionId});
  });
  await context.exposeBinding('sendToWorker', async ({page}, message: unknown) => {
    if (!ids.has(page)) ids.set(page, ++nextTabId);
    const url = page.url();
    const sender = { id:extensionId, origin:new URL(url).origin, url, frameId:0,
      tab:{ id:ids.get(page), url, windowId:1 } };
    return worker.evaluate(({message,sender}) =>
      (window as unknown as FixtureRuntime).receive(message,sender), {message,sender});
  });
  await worker.goto(fixtureOrigin + '/worker');
  await worker.addScriptTag({type:'module', url:fixtureOrigin + '/background.js'});
  const content = await readFile(resolve(dist, 'content.js'), 'utf8');
  await context.addInitScript((content: string) => {
    if (['chatgpt.com', 'claude.ai'].includes(location.hostname)) {
      window.addEventListener('DOMContentLoaded', () => {
        const script = document.createElement('script');
        script.textContent = content;
        document.head.append(script);
      }, {once:true});
    }
  }, content);
  const popup = await context.newPage();
  await popup.goto(fixtureOrigin + '/popup.html');
  return {popup, async focusChat(page) { await page.bringToFront(); selected = page; }};
}

import { Plugin } from '@opencode/plugin';
import { readFileSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createPoolProxy } from './proxy.mjs';

// The provider allows 4 parallel streams per key. With several keys saved in the panel
// (reformboss-keys.json) requests are spread across them: each key keeps its own 4 slots,
// a 429 on one key retries the same request on another key.
const PREFERRED_PORT = 43729;
const PER_KEY = 4;

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

export default Plugin.define({
  id: 'reformboss-panel',
  async setup(ctx) {
    if (process.env.REFORMBOSS_NO_PROXY === '1') return;
    const configDir = resolve(homedir(), '.config', 'opencode');
    const config = readJsonFile(resolve(configDir, 'opencode.json'));
    const provider = config?.provider?.reformboss;
    const baseURL = typeof provider?.options?.baseURL === 'string' ? provider.options.baseURL : 'https://api.reformboss.com/v1';
    const primary = typeof provider?.options?.apiKey === 'string' && /^[\w.-]{16,256}$/.test(provider.options.apiKey)
      ? provider.options.apiKey
      : null;
    const keysFile = resolve(configDir, 'reformboss-keys.json');
    const keys = () => {
      const stored = readJsonFile(keysFile);
      const list = Array.isArray(stored) ? stored : [];
      return [...new Set([primary, ...list].filter(key => typeof key === 'string' && /^[\w.-]{16,256}$/.test(key)))];
    };
    if (keys().length < 2) {
      console.log('[reformboss-panel] ротация ключей выключена: в reformboss-keys.json меньше двух ключей');
      return;
    }
    let proxy;
    const portFile = resolve(configDir, 'reformboss-panel-port.json');
    try {
      const create = port => createPoolProxy({
        keys,
        upstream: baseURL,
        perKey: PER_KEY,
        port,
        log: (level, message, detail) => console.log('[reformboss-panel]', message, detail ? JSON.stringify(detail) : ''),
      });
      proxy = create(PREFERRED_PORT);
      try { await proxy.listen(); }
      catch (error) {
        if (error?.code !== 'EADDRINUSE') throw error;
        console.log('[reformboss-panel] порт', PREFERRED_PORT, 'занят, беру свободный');
        proxy = create(0);
        await proxy.listen();
      }
      await writeFile(portFile, JSON.stringify({ port: proxy.port, keys: keys().length, perKey: PER_KEY, at: Date.now() }));
    } catch (error) {
      console.log('[reformboss-panel] прокси ротации не запустился:', error?.message || error);
      return;
    }
    const proxyURL = 'http://127.0.0.1:' + proxy.port + '/v1';
    try {
      await ctx.provider.transform(editor => {
        editor.update('reformboss', record => {
          record.settings = { ...(record.settings || {}), baseURL: proxyURL };
        });
      });
    } catch (error) {
      console.log('[reformboss-panel] не удалось перевести провайдера на прокси:', error?.message || error);
      await proxy.close();
      return;
    }
    console.log('[reformboss-panel] ротация ключей включена:', keys().length, 'ключей ×', PER_KEY, 'потоков,', proxyURL);
    return () => { void proxy.close(); void unlink(portFile).catch(() => {}); };
  },
});
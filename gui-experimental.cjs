"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { Plugin, Slot, Command } = require('@opencode/plugin/gui');
const { Ipc } = require('@opencode/plugin/gui');
const { Schema } = require('effect');
const { onCleanup } = require('solid-js');
const { BrowserWindow, session } = require('electron');

const HOST = 'https://reformboss.com';
// Runs only on ReformBoss's own sign-in page. The official Telegram widget handles
// its popup and returns the signed result to the site's existing callback page.
const LOGIN_BRIDGE = `(() => {
  if (window.__reformBossPanelLogin) return;
  const link = document.querySelector('main a[href^="https://oauth.telegram.org/auth?"]');
  if (!link) return;
  const auth = new URL(link.href);
  if (auth.searchParams.get('origin') !== location.origin || auth.searchParams.get('return_to') !== location.origin + '/tg-callback') return;
  const bot = auth.searchParams.get('bot_id');
  if (!/^\\d+$/.test(bot || '')) return;
  window.__reformBossPanelLogin = true;
  const note = document.createElement('p'); note.setAttribute('role', 'status'); link.parentElement.after(note);
  const script = document.createElement('script'); script.src = 'https://telegram.org/js/telegram-widget.js?22'; script.async = true;
  script.onerror = () => { note.textContent = 'Не удалось загрузить вход Telegram. Закройте окно и попробуйте снова.'; };
  document.head.append(script);
  link.addEventListener('click', event => {
    event.preventDefault(); event.stopImmediatePropagation();
    if (!window.Telegram?.Login?.auth) { note.textContent = 'Telegram ещё загружается. Нажмите ещё раз через несколько секунд.'; return; }
    note.textContent = 'Подтвердите вход в окне Telegram.';
    window.Telegram.Login.auth({ bot_id: bot, request_access: 'write' }, user => {
      if (!user) { note.textContent = 'Вход не завершён. Можно попробовать снова.'; return; }
      const result = btoa(unescape(encodeURIComponent(JSON.stringify(user))));
      location.href = '/tg-callback#tgAuthResult=' + result;
    });
  });
})()`;
const api = Ipc.define({ id: 'reformboss-panel.data', methods: {
  refresh: { output: Schema.String }, login: {}, saveKeys: { input: Schema.String, output: Schema.Number },
  syncPlan: { output: Schema.String }, syncApply: { input: Schema.String, output: Schema.String },
  poolStatus: { output: Schema.String },
}});
function text(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, entity => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
  })[entity]).trim();
}

const rankName = value => value.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';

function readModels(profile, catalog, health) {
  if (profile && !Number.isSafeInteger(profile.rank)) throw Error('rank');
  const profileRank = profile?.ranks_detail?.find(row => row.rank === profile.rank);
  const names = new Set([profile?.rank_name, profileRank?.name].filter(value => typeof value === 'string').map(rankName).filter(Boolean));
  if (profile && !names.size) throw Error('rank');
  const table = catalog.match(/<table\b[^>]*\bid="cat"[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table) throw Error('catalog');
  const probes = new Map((Array.isArray(health?.models) ? health.models : []).map(row => [row.id, row]));
  const models = new Map();
  let count = 0;
  for (const [, row] of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const model = row.match(/<th\b[^>]*class="model-name"[^>]*>([^<]+)<\/th>/i);
    const cells = [...row.matchAll(/<td\b[^>]*>([^<]*)<\/td>/gi)];
    if (!model || cells.length !== 5) continue;
    count++;
    if (profile && !text(cells[4][1]).split(',').some(name => names.has(rankName(name)))) continue;
    const id = text(model[1]);
    const probe = probes.get(id);
    const checkedAt = Number.isFinite(probe?.checked_at) && probe.checked_at > 0 ? probe.checked_at : null;
    const seconds = checkedAt === null ? NaN : Date.now() / 1000 - checkedAt;
    const probeState = probe?.state === 'busy' ? 'limited' : probe?.state;
    const state = seconds >= 0 && seconds < 900 && ['up', 'down', 'limited'].includes(probeState)
      ? probeState : 'unknown';
    const uptime = probe?.uptime_24h;
    const uptime1h = probe?.uptime_1h;
    const latencyMs = probe?.latency_ms;
    const percent = value => (Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);
    models.set(id, {
      id, state, checkedAt,
      lab: typeof probe?.lab === 'string' ? probe.lab : guessLab(id),
      uptime: percent(uptime), uptime1h: percent(uptime1h),
      latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : null,
    });
  }
  if (!count) throw Error('catalog');
  return { state: 'ready', rank: profile?.rank_name || profileRank?.name || null, models: [...models.values()] };
}

// Provider groups come from the public probe feed ("lab"). Brand marks are vendored as
// inline SVG so the panel never loads images from the network.
const LABS = {
  gpt: { name: 'OpenAI', color: '#8ce0bd', icon: 'openai' },
  claude: { name: 'Anthropic', color: '#e0917a', icon: 'anthropic' },
  gemini: { name: 'Google', color: '#a996d6', icon: 'googlegemini' },
  deepseek: { name: 'DeepSeek', color: '#7b9dff', icon: 'deepseek' },
  qwen: { name: 'Qwen', color: '#9b8cff', icon: 'qwen' },
  kimi: { name: 'Moonshot', color: '#dfe7f2', icon: 'kimi' },
  glm: { name: 'Zhipu', color: '#7d95ff', letter: 'G' },
  grok: { name: 'xAI', color: '#c3ccd8', letter: 'x' },
  minimax: { name: 'MiniMax', color: '#f06a8c', icon: 'minimax' },
  mimo: { name: 'Xiaomi', color: '#ff9558', icon: 'xiaomi' },
  agnes: { name: 'Agnes', color: '#c0a8ff', letter: 'A' },
  other: { name: 'Другое', color: '#8b98a5', letter: 'R' },
};

const MARKERS = {
  up: { label: 'Работает', color: '#5ed6a0' },
  limited: { label: 'Работает с перебоями', color: '#efbd6a' },
  down: { label: 'Не работает', color: '#f0746f' },
  unknown: { label: 'Нет свежих данных', color: '#8b98a5' },
};

const LAB_ORDER = ['deepseek', 'claude', 'gemini', 'minimax', 'moonshot', 'qwen', 'kimi', 'glm', 'grok', 'gpt', 'mimo', 'agnes'];

function guessLab(id) {
  const value = String(id).toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(value)) return 'claude';
  if (/gpt|openai/.test(value)) return 'gpt';
  if (/gemini/.test(value)) return 'gemini';
  if (/deepseek/.test(value)) return 'deepseek';
  if (/qwen/.test(value)) return 'qwen';
  if (/kimi|moonshot/.test(value)) return 'kimi';
  if (/glm|zhipu/.test(value)) return 'glm';
  if (/grok|xai/.test(value)) return 'grok';
  if (/minimax/.test(value)) return 'minimax';
  if (/mimo/.test(value)) return 'mimo';
  if (/agnes/.test(value)) return 'agnes';
  return 'other';
}

const BRANDS = [['deepseek', 'DeepSeek'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['minimax', 'MiniMax'], ['moonshot', 'Moonshot'], ['qwen', 'Qwen'], ['kimi', 'Kimi'], ['glm', 'GLM'], ['grok', 'Grok'], ['gpt', 'GPT'], ['mimo', 'MiMo'], ['agnes', 'Agnes'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['flash', 'Flash'], ['flashx', 'FlashX'], ['prime', 'Prime'], ['auto', 'Auto'], ['astra', 'Astra'], ['terra', 'Terra'], ['carbon', 'Carbon'], ['hydrogen', 'Hydrogen'], ['argon', 'Argon'], ['sol', 'Sol'], ['luna', 'Luna'], ['max', 'Max'], ['pro', 'Pro']];

function prettyName(id) {
  const base = String(id).split('/').filter(Boolean).pop() || String(id);
  const out = [];
  for (const part of base.split(/[-_\s]+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    const exact = BRANDS.find(([key]) => key === lower);
    if (exact) { out.push(exact[1]); continue; }
    const prefix = BRANDS
      .filter(([key]) => lower.startsWith(key) && /^\d/.test(lower.slice(key.length)))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (prefix) { out.push(prefix[1]); out.push(part.slice(prefix[0].length)); continue; }
    out.push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return out.filter((token, index) => token !== out[index - 1]).join(' ');
}

const ICONS = {
  openai: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  anthropic: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  googlegemini: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  deepseek: "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45",
  qwen: "M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z",
  kimi: "M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441",
  minimax: "M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997",
  xiaomi: "M12 0C8.016 0 4.756.255 2.493 2.516.23 4.776 0 8.033 0 12.012c0 3.98.23 7.235 2.494 9.497C4.757 23.77 8.017 24 12 24c3.983 0 7.243-.23 9.506-2.491C23.77 19.247 24 15.99 24 12.012c0-3.984-.233-7.243-2.502-9.504C19.234.252 15.978 0 12 0zM4.906 7.405h5.624c1.47 0 3.007.068 3.764.827.746.746.827 2.233.83 3.676v4.54a.15.15 0 0 1-.152.147h-1.947a.15.15 0 0 1-.152-.148V11.83c-.002-.806-.048-1.634-.464-2.051-.358-.36-1.026-.441-1.72-.458H7.158a.15.15 0 0 0-.151.147v6.98a.15.15 0 0 1-.152.148H4.906a.15.15 0 0 1-.15-.148V7.554a.15.15 0 0 1 .15-.149zm12.131 0h1.949a.15.15 0 0 1 .15.15v8.892a.15.15 0 0 1-.15.148h-1.949a.15.15 0 0 1-.151-.148V7.554a.15.15 0 0 1 .151-.149zM8.92 10.948h2.046c.083 0 .15.066.15.147v5.352a.15.15 0 0 1-.15.148H8.92a.15.15 0 0 1-.152-.148v-5.352a.15.15 0 0 1 .152-.147Z",
};

const GEAR = "M12 15.5A3.5 3.5 0 0 1 8.5 12A3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5a3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97s-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1s.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64z";

exports.default = Plugin.define({
  main(ctx) {
    const { readFile, writeFile, rename, unlink } = require('node:fs/promises');
    const { createHash, randomUUID } = require('node:crypto');
    const { resolve } = require('node:path');
    const { homedir } = require('node:os');
    const site = session.fromPartition('persist:reformboss-panel-v2');
    let loginWindow, pending, last, lastAt = 0, generation = 0, cachedCatalog, cachedProbes;
    let liveCatalog, liveProbes;
    const windows = new Set();
    const allowed = url => { try { return [HOST, 'https://oauth.telegram.org'].includes(new URL(url).origin); } catch { return false; } };
    function secureWindow(win) {
      windows.add(win);
      win.webContents.on('close', () => ctx.log.write('info', 'ReformBoss auth page requested close'));
      win.on('closed', () => { windows.delete(win); ctx.log.write('info', 'ReformBoss auth window closed'); });
      win.webContents.on('render-process-gone', (_event, details) => ctx.log.write('error', 'ReformBoss auth renderer stopped', { reason: details.reason }));
      win.webContents.on('did-finish-load', () => {
        const u = new URL(win.webContents.getURL());
        if (u.origin === HOST && u.pathname === '/sign-in') {
          void win.webContents.executeJavaScript(LOGIN_BRIDGE).catch(() => ctx.log.write('error', 'ReformBoss login widget unavailable'));
        }
      });
      for (const event of ['will-navigate', 'will-redirect']) win.webContents.on(event, (e, url) => {
        if (!allowed(url)) { e.preventDefault(); return; }
      });
      win.webContents.setWindowOpenHandler(({url}) => allowed(url)
        ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: site, sandbox: true, contextIsolation: true, nodeIntegration: false } } }
        : { action: 'deny' });
      win.webContents.on('did-create-window', child => secureWindow(child));
    }
    site.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    async function refresh(force = false) {
      if (pending) return pending;
      if (!force && last && Date.now() - lastAt < 10000) return last;
      const revision = generation;
      const task = (async () => {
        let result;
        try {
          async function load(path, authenticated = false) {
            const response = await site.fetch(HOST + path, {
              credentials: authenticated ? 'include' : 'omit', redirect: 'error', cache: 'no-store',
              signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10000)]),
            });
            if (authenticated && [401, 403].includes(response.status)) return null;
            if (!response.ok) throw Error(path + ' HTTP ' + response.status);
            return path === '/pricing' ? response.text() : response.json();
          }
          const [profile, catalog, health] = await Promise.allSettled([
            load('/console/api/me', true), load('/pricing'), load('/api/status.json'),
          ]);
          for (const [source, response] of Object.entries({ profile, catalog, health })) {
            if (response.status === 'rejected') ctx.log.write('warn', 'ReformBoss model source unavailable', { source });
          }
          if (generation !== revision) return refresh();
          liveCatalog = catalog.status === 'fulfilled' ? catalog.value : undefined;
          if (liveCatalog) {
            try { catalogIds(liveCatalog); cachedCatalog = liveCatalog; }
            catch { liveCatalog = undefined; }
          }
          let account = profile.status === 'fulfilled' ? profile.value : null;
          if (!Number.isSafeInteger(account?.rank)) account = null;
          const hasLiveProbes = health.status === 'fulfilled' && Array.isArray(health.value?.models);
          liveProbes = hasLiveProbes ? health.value : undefined;
          if (hasLiveProbes) cachedProbes = health.value;
          if (!cachedCatalog) throw Error('catalog');
          try { result = readModels(account, cachedCatalog, cachedProbes); }
          catch (error) {
            if (error.message !== 'rank') throw error;
            account = null;
            result = readModels(null, cachedCatalog, cachedProbes);
            result.profileState = 'error';
          }
          result.probes = hasLiveProbes ? 'live' : cachedProbes ? 'cached' : 'unavailable';
          if (!account && !result.profileState) result.profileState = profile.status === 'rejected' ? 'error' : 'login';
        } catch (error) {
          ctx.log.write('warn', 'ReformBoss model list unavailable', { reason: ['catalog', 'rank'].includes(error.message) ? error.message : 'refresh' });
          result = { state: 'error', message: 'Каталог ReformBoss недоступен. Повторите обновление.' };
        }
        const encoded = JSON.stringify(result);
        if (generation === revision && result.state === 'ready') { last = encoded; lastAt = Date.now(); }
        return encoded;
      })().finally(() => { if (pending === task) pending = undefined; });
      pending = task;
      return task;
    }
    let saving = false, writingConfig = false;
    const configFile = () => resolve(homedir(), '.config', 'opencode', 'opencode.json');
    function catalogIds(catalog) {
      const table = catalog.match(/<table\b[^>]*\bid="cat"[^>]*>([\s\S]*?)<\/table>/i)?.[1];
      if (!table) throw Error('catalog');
      const ids = new Set();
      for (const [, row] of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const model = row.match(/<th\b[^>]*class="model-name"[^>]*>([^<]+)<\/th>/i);
        if (!model) continue;
        const id = text(model[1]);
        if (/^[\w.\-/]{1,120}$/.test(id)) ids.add(id);
      }
      if (ids.size < 5) throw Error('catalog');
      return ids;
    }
    function protectedModels(config) {
      const ids = new Set();
      const add = value => {
        const match = typeof value === 'string' ? value.match(/^reformboss\/(.+)$/) : null;
        if (match) ids.add(match[1]);
      };
      add(config.model); add(config.small_model);
      for (const agent of Object.values(config.agents || {})) add(typeof agent === 'string' ? agent : agent?.model);
      return ids;
    }
    async function gatewayIds(config) {
      const options = config?.provider?.reformboss?.options;
      const apiKey = typeof options?.apiKey === 'string' && /^[\w.-]{16,256}$/.test(options.apiKey) ? options.apiKey : null;
      if (!apiKey || typeof options?.baseURL !== 'string') throw Error('gateway');
      let endpoint;
      try {
        endpoint = new URL(options.baseURL);
        if (!['http:', 'https:'].includes(endpoint.protocol)) throw Error('gateway');
        endpoint.search = ''; endpoint.hash = '';
        endpoint.pathname = endpoint.pathname.replace(/\/+$/, '').replace(/\/models$/, '') + '/models';
      } catch { throw Error('gateway'); }
      const response = await site.fetch(endpoint.href, {
        credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { accept: 'application/json', authorization: 'Bearer ' + apiKey },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw Error('gateway');
      const payload = await response.json();
      if (!Array.isArray(payload?.data)) throw Error('gateway');
      const ids = new Set(payload.data.map(row => row?.id).filter(id => typeof id === 'string' && /^[\w.\-/]{1,120}$/.test(id)));
      if (!ids.size) throw Error('gateway');
      return ids;
    }
    async function readConfigRaw() {
      let raw;
      try { raw = await readFile(configFile(), 'utf8'); } catch { throw Error('config'); }
      let config;
      try { config = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw Error('config'); }
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('config');
      return { raw, config };
    }
    async function readConfig() {
      const { raw, config } = await readConfigRaw();
      const models = config?.provider?.reformboss?.models;
      if (!models || typeof models !== 'object' || Array.isArray(models)) throw Error('provider');
      return { raw, config, models };
    }
    function planModels({ raw, config, models }, access, view) {
      const current = new Set(Object.keys(models).filter(id => /^[\w.\-/]{1,120}$/.test(id)));
      const locked = protectedModels(config);
      let desired, alive, source, ranked = false, canRemove;
      if (access) {
        // The gateway is authoritative: it returns exactly the ids this key may use,
        // including rank restrictions, instead of the public catalogue.
        desired = access;
        alive = access;
        source = 'gateway';
        canRemove = true;
      } else {
        if (!liveCatalog) throw Error('catalog');
        const catalog = catalogIds(liveCatalog);
        ranked = view?.state === 'ready' && Boolean(view.rank);
        desired = ranked ? new Set(view.models.map(model => model.id)) : catalog;
        const probeIds = new Set((liveProbes?.models ?? [])
          .map(row => row?.id)
          .filter(id => typeof id === 'string' && /^[\w.\-/]{1,120}$/.test(id)));
        // A cached probe may prove that an alias exists, but never authorizes deletion.
        canRemove = view?.probes === 'live' && probeIds.size > 0;
        alive = new Set([...desired, ...probeIds]);
        source = 'catalog';
      }
      const plan = {
        add: [...desired].filter(id => !current.has(id)).sort(),
        remove: canRemove ? [...current].filter(id => !alive.has(id) && !locked.has(id)).sort() : [],
        locked: [...current].filter(id => !alive.has(id) && locked.has(id)).sort(),
        unchanged: [...current].filter(id => alive.has(id)).length,
        total: desired.size,
        source, ranked, canRemove,
      };
      const token = createHash('sha256').update(raw).update(JSON.stringify(plan)).digest('hex');
      return { ...plan, token };
    }
    async function currentPlan(snapshot) {
      const [viewResult, accessResult] = await Promise.allSettled([refresh(true), gatewayIds(snapshot.config)]);
      let view;
      if (viewResult.status === 'fulfilled') {
        try { view = JSON.parse(viewResult.value); } catch {}
      }
      const access = accessResult.status === 'fulfilled' ? accessResult.value : null;
      if (!access && !view) throw Error('catalog');
      return planModels(snapshot, access, view);
    }
    async function saveConfig(raw, config, kind) {
      const file = configFile();
      const temporary = file + '.' + randomUUID() + '.tmp';
      const stamp = new Date().toISOString().replace(/\D/g, '');
      const backup = 'opencode.json.bak-' + kind + '-' + stamp;
      await writeFile(resolve(file, '..', backup), raw, { mode: 0o600, flag: 'wx' });
      try {
        await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        if (await readFile(file, 'utf8') !== raw) throw Error('changed');
        await rename(temporary, file);
        return backup;
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }
    async function applyModels(token) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return { stale: true };
      const snapshot = await readConfig();
      const plan = await currentPlan(snapshot);
      if (token !== plan.token) return { stale: true };
      if (!plan.add.length && !plan.remove.length) return { added: 0, removed: 0, changed: false, backup: null };
      const { raw, config, models } = snapshot;
      for (const id of plan.remove) delete models[id];
      for (const id of plan.add) models[id] = { name: id, tool_call: true, reasoning: true, temperature: true, limit: { context: 1048576, output: 32768 } };
      if (!Object.keys(models).length) throw Error('empty');
      const backup = await saveConfig(raw, config, 'models');
      ctx.log.write('info', 'ReformBoss model list synced', { added: plan.add.length, removed: plan.remove.length, source: plan.source });
      return { added: plan.add.length, removed: plan.remove.length, changed: true, backup };
    }

    ctx.provide(api, {
      async saveKeys(input) {
        const incoming = [...new Set(input.trim().split(/[\s,]+/))];
        if (saving || incoming.length > 30 || incoming.some(key => !/^[\w.-]{16,256}$/.test(key))) throw Error('keys');
        saving = true;
        try {
          const file = resolve(homedir(), '.config', 'opencode', 'reformboss-keys.json');
          let existing;
          try { existing = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; existing = []; }
          const merged = [...new Set([...existing.map(key => key.trim()), ...incoming])];
          await writeFile(file + '.tmp', JSON.stringify(merged), { mode: 0o600 });
          await rename(file + '.tmp', file);
          return merged.length;
        } finally { saving = false; }
      },
      async syncPlan() {
        return JSON.stringify(await currentPlan(await readConfig()));
      },
      async syncApply(token) {
        if (writingConfig) throw Error('busy');
        writingConfig = true;
        try {
          return JSON.stringify(await applyModels(token));
        } finally { writingConfig = false; }
      },
      async poolStatus() {
        const file = resolve(homedir(), '.config', 'opencode', 'reformboss-panel-port.json');
        let info;
        try { info = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return JSON.stringify({ state: 'off' }); }
        if (!Number.isSafeInteger(info?.port)) return JSON.stringify({ state: 'off' });
        try {
          const response = await fetch('http://127.0.0.1:' + info.port + '/health', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
          if (!response.ok) throw Error('http ' + response.status);
          const health = await response.json();
          return JSON.stringify({ state: 'ready', port: info.port, keys: health.keys, perKey: health.perKey, models: health.models });
        } catch { return JSON.stringify({ state: 'off', port: info.port }); }
      },
      refresh: () => refresh(),
      login() {
        ctx.log.write('info', 'ReformBoss login requested');
        if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.show(); loginWindow.focus(); return; }
        loginWindow = new BrowserWindow({ width: 1000, height: 780, title: 'Вход в ReformBoss',
          autoHideMenuBar: true, webPreferences: { session: site, sandbox: true, contextIsolation: true, nodeIntegration: false } });
        // Authentication remains inside isolated website windows. No cookies or API keys cross IPC.
        secureWindow(loginWindow);
        loginWindow.on('closed', () => {
          loginWindow = undefined; last = undefined; pending = undefined;
          liveCatalog = undefined; liveProbes = undefined; generation++;
        });
        void loginWindow.loadURL(HOST + '/console/#keys').then(() => {
          ctx.log.write('info', 'ReformBoss login page loaded');
        }).catch(e => { ctx.log.write('error', 'ReformBoss login page failed', { code: e.code || 'load-error' }); });
      },
    });
    ctx.onCleanup(() => { ctx.log.write('info', 'ReformBoss panel cleanup'); for (const win of windows) if (!win.isDestroyed()) win.destroy(); windows.clear(); });
    ctx.log.write('info', 'ReformBoss panel main ready');
  },
  setup(ctx) {
    const bridge = ctx.main(api);
    let toggle = () => {}, showKeys = () => {};
    ctx.add(Command, { id: 'toggle-keys', title: 'ReformBoss: показать / скрыть модели', run: () => toggle() });
    ctx.add(Command, { id: 'boss', title: 'Добавить ключи ReformBoss', slash: { name: 'key' }, run: () => showKeys() });
    ctx.add(Slot, { at: 'window.bottom', order: 50, render() {
      const root = document.createElement('section');
      root.setAttribute('aria-label', 'ReformBoss — модели');
      root.style.cssText = 'position:fixed;left:16px;bottom:16px;width:320px;box-sizing:border-box;display:flex;flex-direction:column;max-width:calc(100vw - 16px);max-height:calc(100vh - 100px);z-index:20;background:var(--background-base, transparent);color:inherit;border:0;font:12px/1.45 Segoe UI,sans-serif;overflow:hidden';
      function el(tag, text, style, parent = root) { const node = document.createElement(tag); if (text) node.textContent = text; if (style) node.style.cssText = style; parent.append(node); return node; }
      const viewKey = 'reformboss-panel-view-v1';
      let view = 'list';
      try { const savedView = localStorage.getItem(viewKey); if (savedView === 'grid' || savedView === 'list') view = savedView; } catch {}
      const pinKey = 'reformboss-panel-pin-v1';
      const positionKey = 'reformboss-panel-position-v3';
      let pinned = true;
      try { if (localStorage.getItem(pinKey) === 'false') pinned = false; } catch {}
      const header = el('div', '', 'display:flex;align-items:center;justify-content:space-between;gap:4px;padding:7px 9px;direction:ltr;flex-shrink:0;user-select:none');
      header.title = 'Панель моделей ReformBoss';
      const summary = el('strong', 'ReformBoss', 'font-size:12px;font-weight:650;letter-spacing:.01em', header);
      function button(text, parent, handler) { const b = el('button', text, 'cursor:pointer;color:inherit;background:transparent;border:0;border-radius:6px;padding:4px 7px;font:inherit', parent); b.type = 'button'; b.onclick = handler; return b; }
      const body = el('div', '', 'padding:0 9px 12px 13px;direction:ltr;flex:1 1 auto;min-height:0;overflow:auto;scrollbar-width:thin');
      let opened = true, alive = true, loading = false;
      body.hidden = false;
      const settingsButton = button('', header, () => toggleSettings());
      settingsButton.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="' + GEAR + '"/></svg>';
      settingsButton.style.display = 'grid';
      settingsButton.style.placeItems = 'center';
      settingsButton.style.padding = '4px 6px';
      settingsButton.title = 'Настройки: фильтры и обновление';
      settingsButton.setAttribute('aria-label', 'Настройки панели');
      settingsButton.setAttribute('aria-expanded', 'false');
      const viewButton = button('▦', header, () => { view = view === 'list' ? 'grid' : 'list'; applyView(); });
      const collapse = button('−', header, () => toggle()); collapse.setAttribute('aria-label', 'Свернуть модели'); collapse.setAttribute('aria-expanded', 'true');
      collapse.style.cursor = 'pointer';

      const margin = 8;
      function clampPosition(x, y) {
        const rect = root.getBoundingClientRect();
        return {
          x: Math.round(Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))),
          y: Math.round(Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))),
        };
      }
      function setPosition(x, y, save = false) {
        const next = clampPosition(x, y);
        root.style.left = next.x + 'px'; root.style.top = next.y + 'px'; root.style.right = 'auto'; root.style.bottom = 'auto';
        if (save) try { localStorage.setItem(positionKey, JSON.stringify(next)); } catch {}
      }
      function restorePosition() {
        if (!root.style.top) return;
        const rect = root.getBoundingClientRect();
        setPosition(rect.left, rect.top);
      }
      try {
        const savedPos = JSON.parse(localStorage.getItem(positionKey) || 'null');
        if (Number.isFinite(savedPos?.x) && Number.isFinite(savedPos?.y)) requestAnimationFrame(() => setPosition(savedPos.x, savedPos.y));
      } catch {}
      function applyPinned() {
        header.style.cursor = pinned ? 'default' : 'grab';
        header.title = pinned ? 'ReformBoss — модели · позиция закреплена' : 'Перетащите панель за шапку — фиксатор выключен';
        try { localStorage.setItem(pinKey, String(pinned)); } catch {}
      }
      applyPinned();
      let drag;
      function moveDrag(event) {
        if (!drag || event.pointerId !== drag.id) return;
        setPosition(event.clientX - drag.dx, event.clientY - drag.dy);
        event.preventDefault();
      }
      function finishDrag(event) {
        if (!drag || (event && event.pointerId !== drag.id)) return;
        drag = undefined;
        window.removeEventListener('pointermove', moveDrag);
        window.removeEventListener('pointerup', finishDrag);
        window.removeEventListener('pointercancel', finishDrag);
        header.style.cursor = pinned ? 'default' : 'grab';
        const rect = root.getBoundingClientRect(); setPosition(rect.left, rect.top, true);
      }
      header.addEventListener('pointerdown', event => {
        if (pinned || drag || event.button !== 0 || event.target.closest('button')) return;
        const rect = root.getBoundingClientRect();
        drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        header.style.cursor = 'grabbing';
        window.addEventListener('pointermove', moveDrag);
        window.addEventListener('pointerup', finishDrag);
        window.addEventListener('pointercancel', finishDrag);
        event.preventDefault();
      });
      window.addEventListener('resize', restorePosition);

      toggle = () => {
        opened = !opened;
        body.hidden = !opened;
        collapse.setAttribute('aria-expanded', String(opened));
        collapse.textContent = opened ? '−' : '+';
        collapse.setAttribute('aria-label', opened ? 'Свернуть модели' : 'Развернуть модели');
        if (opened) void update();
      };
      const status = el('div', 'Подключение…', 'font-size:11px;color:#aeb9c5;margin-bottom:8px', body);
      status.setAttribute('role', 'status');
      const cards = el('div', '', 'display:flex;flex-direction:column;gap:9px', body);
      const views = {
        list: el('div', '', 'display:grid;gap:0', cards),
        grid: el('div', '', 'display:none;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:6px', cards),
      };
      function applyView() {
        views.list.style.display = view === 'list' ? 'grid' : 'none';
        views.grid.style.display = view === 'grid' ? 'grid' : 'none';
        viewButton.textContent = view === 'list' ? '▦' : '☰';
        viewButton.title = view === 'list' ? 'Показать сеткой' : 'Показать списком';
        viewButton.setAttribute('aria-label', viewButton.title);
        try { localStorage.setItem(viewKey, view); } catch {}
      }
      applyView();

      const filterKey = 'reformboss-panel-filter-v1';
      const FILTERS = [
        { key: 'all', label: 'Все' },
        { key: 'up', label: 'Работают' },
        { key: 'limited', label: 'Перебои' },
        { key: 'down', label: 'Не работают' },
        { key: 'unknown', label: 'Без проб' },
      ];
      const filter = { state: 'all', query: '' };
      try {
        const savedFilter = JSON.parse(localStorage.getItem(filterKey) || 'null');
        if (savedFilter && typeof savedFilter === 'object') {
          if (FILTERS.some(option => option.key === savedFilter.state)) filter.state = savedFilter.state;
          if (typeof savedFilter.query === 'string') filter.query = savedFilter.query.slice(0, 40);
        }
      } catch {}
      const filterActive = () => filter.state !== 'all' || filter.query.trim() !== '';
      function persistFilter() {
        try { localStorage.setItem(filterKey, JSON.stringify(filter)); } catch {}
        settingsButton.style.color = filterActive() ? '#5fd39a' : '';
        settingsButton.title = filterActive() ? 'Настройки · фильтр включён' : 'Настройки: фильтры и обновление';
      }
      const chipButtons = new Map();
      function updateChips() {
        for (const [key, chip] of chipButtons) {
          const selected = filter.state === key;
          chip.style.opacity = selected ? '1' : '.7';
          chip.style.borderColor = selected ? '#5fd39a' : 'color-mix(in srgb,currentColor 12%,transparent)';
          chip.style.color = selected ? '#5fd39a' : 'inherit';
          chip.setAttribute('aria-pressed', String(selected));
        }
      }
      let current = null;

      function updateStatus(shownCount) {
        if (!current) return;
        const { models, rank, profileState, probes } = current;
        let line = rank ? rank + ' · ' + models.length + ' моделей' : (profileState === 'error' ? 'Общий каталог · ранг недоступен' : 'Общий каталог · войдите для фильтра по рангу');
        if (probes === 'cached') line += ' · сохранённые пробы';
        if (probes === 'unavailable') line += ' · пробы недоступны';
        if (filterActive()) line += ' · показано ' + shownCount + ' из ' + models.length;
        status.textContent = line;
      }

      function renderModels() {
        views.list.replaceChildren(); views.grid.replaceChildren();
        if (!current) return;
        const query = filter.query.trim().toLowerCase();
        const shown = current.models.filter(model => (filter.state === 'all' || model.state === filter.state)
          && (!query || model.id.toLowerCase().includes(query) || prettyName(model.id).toLowerCase().includes(query)));
        if (!shown.length) el('div', current.models.length ? 'Под фильтр не попала ни одна модель.' : 'В каталоге нет моделей для этого ранга.', 'font-size:11px;opacity:.7;padding:6px 2px', views.list);
        const live = current.probes === 'live';
        for (const model of shown) {
          const lab = LABS[model.lab] || LABS.other;
          const marker = MARKERS[model.state] || MARKERS.unknown;
          const name = prettyName(model.id);
          const checked = model.checkedAt ? new Date(model.checkedAt * 1000) : null;
          const time = checked?.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
          const details = [];
          if (time) details.push('проба ' + time);
          if (model.latencyMs !== null) details.push(model.latencyMs + ' мс');
          if (model.uptime1h !== null && live) details.push(model.uptime1h.toLocaleString('ru-RU') + '% за час');
          if (model.uptime !== null && live) details.push(model.uptime.toLocaleString('ru-RU') + '% за 24 ч');
          const chip = size => {
            const box = document.createElement('span');
            box.style.cssText = 'flex:none;display:grid;place-items:center;width:' + size + 'px;height:' + size + 'px;border-radius:' + Math.round(size / 3) + 'px;background:color-mix(in srgb,' + lab.color + ' 15%,transparent);color:' + lab.color;
            const path = ICONS[lab.icon];
            if (path) box.innerHTML = '<svg viewBox="0 0 24 24" width="' + Math.round(size * 0.58) + '" height="' + Math.round(size * 0.58) + '" aria-hidden="true"><path fill="currentColor" d="' + path + '"/></svg>';
            else { box.textContent = lab.letter; box.style.font = '600 ' + Math.round(size * 0.46) + 'px/1 "Segoe UI",sans-serif'; }
            return box;
          };
          const dot = (color, style = '') => {
            const node = document.createElement('span');
            node.style.cssText = 'flex:none;width:6px;height:6px;border-radius:50%;background:' + color + ';' + style;
            return node;
          };
          const row = el('div', '', 'display:grid;grid-template-columns:28px minmax(0,1fr) 18px;gap:8px;align-items:center;padding:7px 2px;border-bottom:1px solid color-mix(in srgb,currentColor 9%,transparent)');
          row.append(chip(28));
          const info = el('div', '', 'min-width:0', row);
          el('div', name, 'color:#5fd39a;font-size:12.5px;font-weight:600;line-height:1.3;overflow-wrap:anywhere', info);
          const meta = el('div', '', 'display:flex;align-items:center;gap:5px;min-width:0;margin-top:1px;font-size:10.5px;opacity:.72', info);
          meta.append(dot(marker.color));
          el('span', marker.label + ' · ' + lab.name, 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap', meta);
          const more = el('button', '▾', 'cursor:pointer;background:transparent;border:0;color:inherit;opacity:.5;font:inherit;line-height:1;padding:2px;transition:transform .15s', row);
          more.type = 'button';
          more.setAttribute('aria-label', 'Подробности: ' + name);
          more.setAttribute('aria-expanded', 'false');
          const detail = el('div', details.join(' · ') || 'Нет данных о последней пробе', 'display:none;grid-column:1/-1;font-size:10px;opacity:.6;padding:0 2px 4px 36px', row);
          more.onclick = () => {
            const open = detail.style.display === 'none';
            detail.style.display = open ? 'block' : 'none';
            more.style.transform = open ? 'rotate(180deg)' : '';
            more.setAttribute('aria-expanded', String(open));
          };
          row.title = model.id + (checked ? ' · ' + checked.toLocaleString('ru-RU') : '');
          views.list.append(row);
          const card = el('div', '', 'position:relative;display:flex;flex-direction:column;gap:6px;min-width:0;padding:8px;border-radius:12px;background:color-mix(in srgb,currentColor 4%,transparent);border:1px solid color-mix(in srgb,currentColor 7%,transparent)');
          const state = dot(marker.color, 'position:absolute;top:8px;right:8px');
          state.title = marker.label;
          card.append(state, chip(30));
          el('div', name, 'color:#5fd39a;font-size:11.5px;font-weight:600;line-height:1.25;overflow-wrap:anywhere', card);
          el('div', marker.label, 'font-size:9.5px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', card);
          card.title = name + ' · ' + lab.name + (details.length ? ' · ' + details.join(' · ') : '');
          views.grid.append(card);
        }
        updateStatus(shown.length);
      }

      function renderAll() { persistFilter(); updateChips(); renderModels(); }

      const settings = el('div', '', 'display:none;flex-direction:column;gap:7px;margin:0 0 9px;padding:8px;border-radius:10px;background:color-mix(in srgb,currentColor 5%,transparent);border:1px solid color-mix(in srgb,currentColor 8%,transparent)', body);
      body.insertBefore(settings, cards);
      function toggleSettings(force) {
        const open = typeof force === 'boolean' ? force : settings.style.display === 'none';
        settings.style.display = open ? 'flex' : 'none';
        settingsButton.setAttribute('aria-expanded', String(open));
        settingsButton.style.opacity = open ? '1' : '';
      }
      el('div', 'Статус', 'font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;opacity:.5', settings);
      const chips = el('div', '', 'display:flex;flex-wrap:wrap;gap:4px', settings);
      for (const option of FILTERS) {
        const chip = el('button', option.label, 'cursor:pointer;font:inherit;font-size:10.5px;line-height:1;padding:4px 7px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);background:transparent;color:inherit;opacity:.7', chips);
        chip.type = 'button';
        chip.onclick = () => { filter.state = option.key; renderAll(); };
        chipButtons.set(option.key, chip);
      }
      const search = el('input', '', 'width:100%;box-sizing:border-box;font:inherit;font-size:11px;padding:5px 7px;border-radius:7px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;outline:none', settings);
      search.type = 'search';
      search.placeholder = 'Модель: поиск по названию';
      search.value = filter.query;
      search.setAttribute('aria-label', 'Поиск модели по названию');
      search.oninput = () => { filter.query = search.value.slice(0, 40); renderAll(); };
      const pinRow = el('label', '', 'display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;user-select:none', settings);
      const pinBox = el('input', '', 'margin:0;accent-color:#5fd39a;cursor:pointer', pinRow);
      pinBox.type = 'checkbox';
      pinBox.checked = pinned;
      pinBox.title = 'Выключите, чтобы перетащить панель за шапку';
      pinBox.onchange = () => { pinned = pinBox.checked; applyPinned(); };
      el('span', 'Фиксировать позицию', 'opacity:.8', pinRow);

      const syncBox = el('div', '', 'display:grid;gap:5px;padding-top:7px;border-top:1px solid color-mix(in srgb,currentColor 8%,transparent)', settings);
      el('div', 'Модели в opencode.json', 'font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;opacity:.5', syncBox);
      const syncStatus = el('div', '', 'font-size:10.5px;opacity:.7', syncBox);
      const syncDetails = el('details', '', 'display:none;font-size:10px;opacity:.75', syncBox);
      const syncDetailsSummary = el('summary', 'ID плана', 'cursor:pointer;opacity:.8;user-select:none', syncDetails);
      const syncDetailsList = el('div', '', 'display:grid;gap:2px;max-height:132px;overflow:auto;margin-top:4px;font-family:ui-monospace,Consolas,monospace;font-size:10px;line-height:1.35;overflow-wrap:anywhere', syncDetails);
      function renderSyncPlan(plan) {
        syncDetailsList.replaceChildren();
        const sections = [
          ['Добавить', '+', plan.add],
          ['Удалить', '−', plan.remove],
          ['Под защитой', '·', plan.locked],
        ];
        let total = 0;
        for (const [title, prefix, ids] of sections) {
          if (!ids.length) continue;
          total += ids.length;
          el('div', title + ' (' + ids.length + ')', 'margin-top:3px;opacity:.6;font-family:Segoe UI,sans-serif;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em', syncDetailsList);
          for (const id of ids) el('div', prefix + ' ' + id, '', syncDetailsList);
        }
        syncDetailsSummary.textContent = 'ID плана (' + total + ')';
        syncDetails.style.display = total ? 'block' : 'none';
      }
      const syncButtons = el('div', '', 'display:flex;gap:5px;flex-wrap:wrap', syncBox);
      const syncCheckButton = button('Сверить', syncButtons, () => void syncCheckModels());
      const syncApplyButton = button('Применить', syncButtons, () => void syncApplyModels());
      syncApplyButton.style.display = 'none';
      syncApplyButton.style.color = '#5fd39a';
      let syncToken;
      async function syncCheckModels() {
        syncToken = undefined;
        syncApplyButton.style.display = 'none';
        syncCheckButton.disabled = true;
        syncStatus.textContent = 'Сверяю доступные ключу модели с конфигом…';
        try {
          const plan = JSON.parse(await bridge.syncPlan());
          renderSyncPlan(plan);
          const parts = [];
          if (plan.add.length) parts.push('добавить ' + plan.add.length);
          if (plan.remove.length) parts.push('удалить ' + plan.remove.length);
          const source = plan.source === 'gateway'
            ? 'Доступно ключу: ' + plan.total + '.'
            : (plan.ranked ? 'Резерв: каталог по рангу.' : 'Резерв: общий каталог.');
          const note = plan.canRemove ? '' : ' Удаление пропущено: нет свежего списка /v1/models и проб.';
          if (!parts.length) {
            syncStatus.textContent = 'Совпадает: ' + plan.unchanged + ' без изменений.' + (plan.locked.length ? ' Под защитой: ' + plan.locked.length + '.' : '') + ' ' + source + note;
            return;
          }
          syncStatus.textContent = 'Будет ' + parts.join(', ') + ' · без изменений ' + plan.unchanged + (plan.locked.length ? ' · под защитой ' + plan.locked.length : '') + '. ' + source + ' Перед записью сделаю бэкап.' + note;
          syncToken = plan.token;
          syncApplyButton.style.display = '';
        } catch { syncStatus.textContent = 'Не удалось сверить: нет доступа к каталогу или opencode.json.'; }
        finally { syncCheckButton.disabled = false; }
      }
      async function syncApplyModels() {
        if (!syncToken) return;
        syncApplyButton.disabled = true; syncCheckButton.disabled = true;
        syncStatus.textContent = 'Записываю opencode.json…';
        try {
          const result = JSON.parse(await bridge.syncApply(syncToken));
          syncToken = undefined;
          syncApplyButton.style.display = 'none';
          if (result.stale) {
            syncDetails.style.display = 'none';
            syncStatus.textContent = 'План устарел: конфиг или доступные модели изменились. Нажмите «Сверить» ещё раз.';
            return;
          }
          if (result.changed === false) {
            syncStatus.textContent = 'Менять нечего — opencode.json не тронут.';
            return;
          }
          syncStatus.textContent = 'Готово: +' + result.added + ' / −' + result.removed + '. Бэкап: ' + result.backup + '. Перезапустите OpenCode, чтобы список моделей обновился.';
        } catch { syncStatus.textContent = 'Запись не удалась — opencode.json не изменён.'; }
        finally { syncApplyButton.disabled = false; syncCheckButton.disabled = false; }
      }

      const actions = el('div', '', 'display:flex;gap:5px;flex-wrap:wrap;align-items:center', settings);
      const keyForm = el('form', '', 'display:none;gap:5px;margin-top:2px', settings);
      const keyInput = el('input', '', 'min-width:0;font:inherit;font-size:11px;padding:5px 7px;border-radius:7px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;outline:none', keyForm);
      keyInput.type = 'password';
      keyInput.autocomplete = 'off';
      keyInput.placeholder = 'Ключи через пробел';
      keyInput.setAttribute('aria-label', 'Ключи ReformBoss через пробел');
      const keyStatus = el('div', '', 'font-size:11px', keyForm);
      const save = button('Сохранить ключи', keyForm, () => keyForm.requestSubmit());
      keyForm.onsubmit = async event => {
        event.preventDefault();
        save.disabled = true;
        try {
          const count = await bridge.saveKeys(keyInput.value);
          keyInput.value = '';
          keyStatus.textContent = 'Ключей сохранено: ' + count;
        } catch { keyStatus.textContent = 'Не удалось сохранить ключи. Проверьте формат.'; }
        finally { save.disabled = false; }
      };
      showKeys = () => {
        if (!opened) toggle();
        toggleSettings(true);
        keyForm.style.display = 'grid';
        keyInput.focus();
      };
      const loginWatchers = new Set();
      const refresh = button('Обновить', actions, () => void update());
      const login = button('Войти', actions, () => {
        status.textContent = 'Открываю окно входа…';
        void bridge.login().then(() => {
          if (!alive) return;
          let attempts = 0;
          const watcher = setInterval(() => {
            if (!alive || ++attempts > 30) { clearInterval(watcher); loginWatchers.delete(watcher); return; }
            void update().then(() => { if (status.dataset.signedIn === 'true') { clearInterval(watcher); loginWatchers.delete(watcher); } });
          }, 2000);
          loginWatchers.add(watcher);
        }).catch(e => { status.textContent = 'Не удалось открыть окно входа: ' + String(e?.message || e).slice(0, 180); });
      });
      const keysButton = button('Ключи', actions, () => {
        keyForm.style.display = keyForm.style.display === 'grid' ? 'none' : 'grid';
        if (keyForm.style.display === 'grid') keyInput.focus();
      });
      keysButton.style.opacity = '.7';
      keysButton.title = 'Сохранить ключи ReformBoss локально';
      login.title = 'Войти через Telegram в отдельном окне ReformBoss';
      updateChips();
      persistFilter();
      async function update() {
        if (!alive || loading) return;
        loading = true; refresh.disabled = true; status.textContent = 'Обновление…';
        try {
          const data = JSON.parse(await bridge.refresh({ signal: ctx.signal }));
          if (!alive) return;
          if (data.state === 'login') {
            current = null;
            summary.textContent = 'ReformBoss · вход';
            views.list.replaceChildren(); views.grid.replaceChildren();
            status.dataset.signedIn = 'false';
            status.textContent = 'Войдите в ReformBoss: настройки ⚙ → «Войти». После подтверждения данные появятся сами.';
          } else if (data.state === 'error') {
            status.textContent = current ? data.message + ' Показаны последние данные.' : data.message;
          }
          else {
            current = data;
            status.dataset.signedIn = String(Boolean(data.rank));
            const up = data.models.filter(model => model.state === 'up').length;
            summary.textContent = 'ReformBoss · ✓ ' + up + '/' + data.models.length;
            renderAll();
          }
        } catch { if (alive) status.textContent = current ? 'Обновление не удалось. Показаны последние данные.' : 'Плагин ещё загружается или недоступен. Нажмите «Обновить».'; }
        finally { loading = false; refresh.disabled = false; }
      }
      void update();
      const updateWhenVisible = () => { if (!document.hidden) void update(); };
      document.addEventListener('visibilitychange', updateWhenVisible);
      const timer = setInterval(updateWhenVisible, 20000);
      onCleanup(() => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', updateWhenVisible); for (const watcher of loginWatchers) clearInterval(watcher); loginWatchers.clear(); window.removeEventListener('resize', restorePosition); window.removeEventListener('pointermove', moveDrag); window.removeEventListener('pointerup', finishDrag); window.removeEventListener('pointercancel', finishDrag); toggle = () => {}; showKeys = () => {}; });
      return root;
    }});
  },
});

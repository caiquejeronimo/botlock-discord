import dns from 'node:dns';

// Muitos hosts não têm IPv6 funcionando; preferir IPv4 evita "fetch failed".
dns.setDefaultResultOrder('ipv4first');

export const API = 'https://api.deadlock-api.com';
export const ASSETS = 'https://assets.deadlock-api.com';
const HEADERS = { 'User-Agent': 'deadlock-discord-bot/0.3', Accept: 'application/json' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP com erros legíveis ----------
export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function getJson(url, { retries = 2 } = {}) {
  let err;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return await res.json();
      err = new ApiError(`HTTP ${res.status}`, { status: res.status });
      if (res.status !== 429 && res.status < 500) break; // 4xx: repetir não adianta
    } catch (e) {
      err = new ApiError(e.message, { code: e.cause?.code ?? e.name });
    }
    if (attempt < retries) await sleep(1000 * (attempt + 1));
  }
  console.error(`[API] ${url} -> ${err.status ?? err.code}: ${err.message}`);
  throw err;
}

export function describeError(e) {
  if (e.status === 429) return 'A API está limitando as requisições. Tente de novo em alguns segundos.';
  if (e.status) return `A API respondeu com erro ${e.status}. Tente novamente mais tarde.`;
  return `Não consegui conectar à API (${e.code ?? 'erro de rede'}). Use /status para diagnosticar.`;
}

// ---------- Heróis (nome + ícone) ----------
export const heroes = new Map();
const ICON_KEYS = ['icon_hero_card', 'icon_image_small', 'selection_image', 'top_bar_vertical_image'];

function pickIcon(images = {}) {
  for (const k of ICON_KEYS) if (typeof images[k] === 'string') return images[k];
  const guess = Object.entries(images).find(
    ([k, v]) => k.includes('icon') && typeof v === 'string' && /\.(png|webp|jpe?g)$/i.test(v),
  );
  return guess?.[1] ?? null;
}

export async function ensureHeroes() {
  if (heroes.size) return;
  try {
    const data = await getJson(`${ASSETS}/v2/heroes`);
    if (Array.isArray(data)) {
      for (const h of data) heroes.set(h.id, { name: h.name, icon: pickIcon(h.images) });
    }
  } catch { /* já logado; segue com nomes genéricos */ }
}

export const heroName = (id) => (id ? heroes.get(id)?.name ?? `Herói #${id}` : 'Escolhendo…');
export const heroIcon = (id) => heroes.get(id)?.icon ?? null;

// ---------- Partidas ----------
let activeCache = { at: 0, data: [] };
export async function activeMatches() {
  if (Date.now() - activeCache.at < 15_000) return activeCache.data; // protege a API
  const data = await getJson(`${API}/v1/matches/active`);
  activeCache = { at: Date.now(), data: Array.isArray(data) ? data : [] };
  return activeCache.data;
}

// Partidas ao vivo que têm um jogador específico (não precisa estar no feed em destaque).
const activeByAccount = new Map();
export async function activeMatchesFor(accountId) {
  const hit = activeByAccount.get(accountId);
  if (hit && Date.now() - hit.at < 15_000) return hit.data;
  const data = await getJson(`${API}/v1/matches/active?account_id=${accountId}`);
  const list = Array.isArray(data) ? data : [];
  if (activeByAccount.size > 500) activeByAccount.clear();
  activeByAccount.set(accountId, { at: Date.now(), data: list });
  return list;
}

const matchCache = new Map(); // partidas finalizadas não mudam
export async function matchMetadata(id) {
  if (matchCache.has(id)) return matchCache.get(id);
  const data = await getJson(`${API}/v1/matches/${id}/metadata`);
  if (matchCache.size >= 100) matchCache.delete(matchCache.keys().next().value);
  matchCache.set(id, data);
  return data;
}

export const matchHistory = (id) => getJson(`${API}/v1/players/${id}/match-history`);

// ---------- Nomes dos jogadores (opcional: se falhar, mostra o ID) ----------
const nameCache = new Map();
let namesRetryAt = 0;
export async function playerNames(ids) {
  const wanted = [...new Set(ids.filter(Boolean))].filter((id) => !nameCache.has(id));
  if (wanted.length && Date.now() >= namesRetryAt) {
    try {
      const data = await getJson(`${API}/v1/players/steam?account_ids=${wanted.join(',')}`, { retries: 0 });
      if (nameCache.size > 2000) nameCache.clear();
      for (const p of Array.isArray(data) ? data : []) nameCache.set(p.account_id, p.personaname ?? null);
    } catch {
      namesRetryAt = Date.now() + 5 * 60_000; // não insiste por 5 min
    }
  }
  return (id) => nameCache.get(id) ?? null;
}

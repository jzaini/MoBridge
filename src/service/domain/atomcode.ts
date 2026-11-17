import fs from 'node:fs/promises';
import { CLIENT_PREFIX, DEFAULT_PLAN_API, DEFAULT_GATEWAY, configFile } from '../config/atomcode.ts';

// AtomCode 模型目录：主来源是 CodingPlan 的实时接口（按账号档位返回），
// 接口不可用 / 离线时才回落到 ~/.atomcode/config.toml 里 /login 写下的快照。
// 两者的语义不同，界面上必须标清楚「实时」还是「离线快照」，不能混着说。
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number, value: CatalogResult }>();

export interface AtomcodeModel {
  /** 客户端可见 id（写入目标时展示的名字）。 */
  id: string;
  /** 真正发给上游的 model 名。 */
  upstream: string;
  name: string;
  context: number | null;
  images: boolean;
  levels: string[];
}

export interface AtomcodePlan {
  planName: string;
  planType: string;
  tier: string;
  expiresAt: string | null;
  remainingDays: number | null;
  quotaExhausted: boolean;
}

export interface CatalogResult {
  models: AtomcodeModel[];
  source: 'live' | 'offline' | 'none';
  plan: AtomcodePlan | null;
  fetchedAt: string | null;
  error: string | null;
}

export function planAPI(env = process.env) {
  return String(env.MOBRIDGE_ATOMCODE_PLAN_API || DEFAULT_PLAN_API).replace(/\/+$/, '');
}

function headers(token: string, clientVersion: string) {
  return { accept: 'application/json', authorization: 'Bearer ' + token, 'user-agent': 'atomcode/' + (clientVersion || '5.2.6') };
}

async function getJSON(url: string, token: string, clientVersion: string, fetchImpl: typeof fetch, timeoutMs = 20000) {
  const response = await fetchImpl(url, { headers: headers(token, clientVersion), signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 160)}`);
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error('上游返回的不是 JSON'); }
}

export function planTier(planName: unknown) {
  const name = String(planName || '').toLowerCase();
  if (name.includes('max')) return 'Max';
  if (name.includes('pro')) return 'Pro';
  return 'Lite';
}

export function clientModelID(id: string) {
  const short = String(id || '').split('/').pop() || String(id || 'model');
  return CLIENT_PREFIX + short;
}

function normalizeLive(raw: Record<string, unknown>): AtomcodeModel | null {
  const name = typeof raw.display_model_name === 'string' ? raw.display_model_name.trim() : '';
  if (!name) return null;
  const context = Number(raw.context_window);
  return {
    id: clientModelID(name), upstream: name, name,
    context: Number.isFinite(context) && context > 0 ? context : null,
    images: raw.supports_vision === true,
    levels: Array.isArray(raw.reasoning_effort_levels) ? (raw.reasoning_effort_levels as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  };
}

// 离线兜底：读 config.toml 的 [models.*] 段。只取顶层标量，够拿 model / context_window。
export async function readOfflineModels(home?: string): Promise<AtomcodeModel[]> {
  const text = await fs.readFile(configFile(home), 'utf8').catch(() => null);
  if (!text) return [];
  const models: AtomcodeModel[] = [];
  let section: { name: string, fields: Record<string, string> } | null = null;
  const flush = () => {
    if (!section || !/^models\./.test(section.name)) return;
    const upstream = section.fields.model;
    if (!upstream) return;
    if (section.fields.account && section.fields.account !== 'AtomGit') return;
    const context = Number(section.fields.context_window);
    models.push({
      id: clientModelID(upstream), upstream,
      name: section.name.replace(/^models\./, '').replace(/^["']|["']$/g, ''),
      context: Number.isFinite(context) && context > 0 ? context : null,
      images: String(section.fields.supports_vision).toLowerCase() === 'true',
      levels: [],
    });
  };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[+([^\]]+)\]+$/);
    if (header) { flush(); section = { name: header[1].trim(), fields: {} }; continue; }
    if (!section || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const pair = trimmed.match(/^([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/);
    if (!pair) continue;
    let value = pair[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    section.fields[pair[1]] = value;
  }
  flush();
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

export function clearCatalogCache() { cache.clear(); }

/** force=true 穿透缓存，供页面「刷新模型」使用。 */
export async function loadCatalog(
  token: string | null,
  { force = false, clientVersion = '5.2.6', home, fetchImpl = globalThis.fetch as typeof fetch } = {},
): Promise<CatalogResult> {
  if (!token) return { models: [], source: 'none', plan: null, fetchedAt: null, error: '未登录' };
  const key = token.slice(-24);
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const status = await getJSON(`${planAPI()}/coding-plan/status-v2`, token, clientVersion, fetchImpl);
    const planRaw = (status.codingplan_free || status.plan || {}) as Record<string, unknown>;
    const remaining = Number(planRaw.remaining_days);
    const plan: AtomcodePlan = {
      planName: String(planRaw.plan_name || status.plan_type || '—'),
      planType: String(planRaw.plan_type || status.plan_type || '—'),
      tier: planTier(planRaw.plan_name || status.plan_type),
      expiresAt: (planRaw.expires_at || status.expires_at || null) as string | null,
      remainingDays: Number.isFinite(remaining) ? remaining : null,
      quotaExhausted: status.window_quota_exhausted === true,
    };
    const rows = await getJSON(`${planAPI()}/coding-plan/models-v2?plan_type=${encodeURIComponent(plan.tier)}`, token, clientVersion, fetchImpl);
    const list = Array.isArray(rows) ? rows : [];
    const models = list
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && (row as Record<string, unknown>).plan_available !== false && (row as Record<string, unknown>).status !== 'deprecated')
      .map(normalizeLive).filter((model): model is AtomcodeModel => model !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!models.length) throw new Error('实时目录为空');
    const value: CatalogResult = { models, source: 'live', plan, fetchedAt: new Date().toISOString(), error: null };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    const offline = await readOfflineModels(home);
    return { models: offline, source: offline.length ? 'offline' : 'none', plan: null, fetchedAt: null, error: (error as Error).message };
  }
}

// ── 上游直连（转发口用）─────────────────────────────────────────────────
export async function upstreamChat(gateway: string, token: string, body: unknown, signal?: AbortSignal) {
  // 动态 import 让「网关地址由设置决定」这件事只有一个来源，不在两个文件里各写一份默认值。
  const { gatewayHeaders } = await import('../config/atomcode.ts');
  return fetch(`${gateway || DEFAULT_GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: gatewayHeaders(token),
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(300000),
  });
}

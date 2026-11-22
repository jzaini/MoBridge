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

// 上游网关有个坑：请求被拒时不回 4xx，而是回 200 + 一条伪装成助手回复的错误文本
// （实测 "参数错误"、"三方请求失败: 404 …Invalid model."，2026-11-18 CodingPlan Lite-beta
// 的两个模型都被这样拒过）。识别这些特征文本，把"上游的谎话"翻译成真实失败，
// 探测和转发口都靠这一份判定，避免两处口径不一致。
const WRAPPED_ERROR_PATTERNS = [/^参数错误$/, /^三方请求失败/];

export function wrappedUpstreamError(content: unknown): string | null {
  const text = String(content ?? '').trim();
  if (!text) return null;
  return WRAPPED_ERROR_PATTERNS.some(pattern => pattern.test(text)) ? text : null;
}

export interface ModelProbeResult {
  /** true = 网关真的路由到了模型并正常作答。 */
  ok: boolean;
  /** rejected = 上游明确拒绝（套餐未启用/已下线）；inconclusive = 网络/接口故障，不做结论。 */
  reason: 'ok' | 'rejected' | 'inconclusive';
  /** 拒绝时的上游原话（错误文本），给界面和通知用。 */
  detail: string | null;
}

/**
 * 模型真跑一遍：目录说"可用"不等于网关真路由（目录与权益可能不同步，
 * 2026-11-18 起目录还在推 glm5.3-flash/qwen3.8-27b，但 Lite-beta 权益已不含它们）。
 * 用一句让模型复述哨兵词的探测请求：答出哨兵词 = 真的可用；
 * 答出包装错误特征 = 上游明确拒绝；网络故障 = 不下结论，宁可放行也不误杀。
 */
export async function probePlanModels(
  gateway: string,
  token: string,
  models: Array<{ upstream: string }>,
  { timeoutMs = 30000, signal = null as AbortSignal | null, fetchImpl = globalThis.fetch as typeof fetch } = {},
): Promise<Record<string, ModelProbeResult>> {
  const results: Record<string, ModelProbeResult> = {};
  await Promise.all(models.map(async model => {
    const result = await probeOne(model.upstream);
    // 手动停止掐断的请求不算结论（保留该模型上一次的判定）
    if (result) results[model.upstream] = result;
  }));
  return results;

  async function probeOne(upstream: string): Promise<ModelProbeResult | null> {
    try {
      const response = await fetchImpl(`${gateway}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'X-AtomCode-Sig': 'atomcode-open-api',
          'X-AtomCode-Ts': String(Math.floor(Date.now() / 1000)),
          'X-AtomCode-Nonce': 'mobridge-probe-' + Math.random().toString(16).slice(2),
          'X-AtomCode-Alg': 'atomcode-signing-v1',
          'X-AtomCode-Ver': 'v1',
        },
        body: JSON.stringify({
          model: upstream,
          messages: [{ role: 'user', content: '请只回复两个字符：OK，不要任何其他内容。' }],
          stream: false,
          max_tokens: 16,
        }),
        // 外部 signal（「停止检测」）与单请求超时组合：任一触发都掐断请求。
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        // 非 200 是网关自己报错（鉴权/限流），拿不到模型层面的结论。
        return { ok: false, reason: 'inconclusive', detail: `HTTP ${response.status}：${text.slice(0, 200)}` };
      }
      let content = '';
      try {
        const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
        content = String(payload.choices?.[0]?.message?.content ?? '').trim();
      } catch { return { ok: false, reason: 'inconclusive', detail: '网关返回的不是 JSON：' + text.slice(0, 120) }; }
      const wrapped = wrappedUpstreamError(content);
      if (wrapped) return { ok: false, reason: 'rejected', detail: wrapped };
      // 哨兵词没出现但也不是已知错误文本：拿不准（模型可能换了措辞），不下结论。
      if (!/OK/i.test(content)) return { ok: false, reason: 'inconclusive', detail: content.slice(0, 120) || '（空回复）' };
      return { ok: true, reason: 'ok', detail: null };
    } catch (error) {
      // 手动停止：不留结论，调用方按 null 过滤
      if ((error as Error)?.name === 'AbortError') return null;
      return { ok: false, reason: 'inconclusive', detail: (error as Error).message };
    }
  }
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

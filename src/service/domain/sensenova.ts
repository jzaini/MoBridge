import { chatModels, DEFAULT_PROBE_MODEL, normalizeBase, type SensenovaModel } from '../config/sensenova.ts';

// 日日新的可用性判定：发一个极小的真实请求，量它本身的往返耗时。
// 这里不做工具调用、不做信封——上游原生 OpenAI 兼容，客户端拿到的就是直连上游的地址。
const PROBE_TIMEOUT = 20000;

export interface SensenovaProbeResult {
  model: string;
  ok: boolean;
  latencyMs: number | null;
  status: number | null;
  error: string | null;
  code: string | null;
  chatOnly: boolean;
  time: string;
}

function classify(status: number, text: string): { code: string, error: string } {
  const brief = text.replace(/\s+/g, ' ').slice(0, 240);
  if (status === 401 || status === 403) return { code: 'auth', error: `鉴权失败（HTTP ${status}）：Key 无效或已失效${brief ? ' · ' + brief : ''}` };
  if (status === 429) return { code: 'rate_limited', error: `额度或频率超限（HTTP 429）${brief ? ' · ' + brief : ''}` };
  if (status === 404) return { code: 'model_missing', error: `模型不存在或未开通（HTTP 404）${brief ? ' · ' + brief : ''}` };
  if (status === 400) return { code: 'bad_request', error: `请求被拒绝（HTTP 400）${brief ? ' · ' + brief : ''}` };
  if (status >= 500) return { code: 'upstream_error', error: `上游故障（HTTP ${status}）${brief ? ' · ' + brief : ''}` };
  return { code: 'http_error', error: `HTTP ${status}${brief ? '：' + brief : ''}` };
}

export async function probeModel(
  key: string,
  upstream: string,
  { baseUrl = undefined as string | undefined, timeoutMs = PROBE_TIMEOUT, fetchImpl = globalThis.fetch } = {},
): Promise<SensenovaProbeResult> {
  const base = normalizeBase(baseUrl ?? '');
  const started = performance.now();
  const fail = (code: string, error: string, status: number | null = null): SensenovaProbeResult => ({
    model: upstream, ok: false, latencyMs: Math.round(performance.now() - started),
    status, error, code, chatOnly: false, time: new Date().toISOString(),
  });
  try {
    const response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      // 只问一个字：这是可用性判定，不是能力评测，越省额度越好。
      body: JSON.stringify({ model: upstream, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const { code, error } = classify(response.status, text);
      return fail(code, error, response.status);
    }
    let payload: { choices?: unknown[] };
    try { payload = JSON.parse(text) as { choices?: unknown[] }; }
    catch { return fail('bad_response', '上游返回的不是 JSON（可能被中间层改写）', response.status); }
    if (!Array.isArray(payload.choices) || !payload.choices.length)
      return fail('empty_choices', '上游返回了空结果（模型未产出任何候选）', response.status);
    return {
      model: upstream, ok: true, latencyMs: Math.round(performance.now() - started),
      status: response.status, error: null, code: null, chatOnly: false, time: new Date().toISOString(),
    };
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === 'TimeoutError') return fail('timeout', `超过 ${Math.round(timeoutMs / 1000)} 秒没有响应`);
    const message = (error as Error & { cause?: { code?: string } })?.cause?.code || (error as Error)?.message || '请求失败';
    return fail('network', `网络不可达：${message}`);
  }
}

// 鉴权是账号级的一次性判断：先用偏好的探活模型，失败就退到清单里其它对话模型。
// 单个模型挂掉不该让整页显示「Key 无效」。
export async function validateKey(
  key: string,
  { baseUrl, preferred = DEFAULT_PROBE_MODEL, timeoutMs }: { baseUrl?: string, preferred?: string, timeoutMs?: number } = {},
) {
  const order = [preferred, ...chatModels().map(model => model.upstream)].filter((id, index, all) => id && all.indexOf(id) === index);
  const attempts: SensenovaProbeResult[] = [];
  for (const upstream of order) {
    const result = await probeModel(key, upstream, { baseUrl, timeoutMs });
    attempts.push(result);
    if (result.ok) return { ok: true, model: upstream, latencyMs: result.latencyMs, fallback: upstream !== preferred, preferred, attempts };
    // 鉴权类失败换模型也没意义，立刻停：省时间也让错误原因更准。
    if (result.code === 'auth') return { ok: false, model: upstream, error: result.error, code: result.code, attempts };
  }
  return { ok: false, model: order[0] ?? null, error: attempts.at(-1)?.error || '所有探活模型均失败', code: attempts.at(-1)?.code || 'unknown', attempts };
}

// 逐模型探测：图像生成模型明确标成「不适用」，而不是「不可用」。
export async function probeAll(
  key: string,
  models: SensenovaModel[],
  { baseUrl, only = null as string[] | null, timeoutMs } = {},
) {
  const wanted = only && only.length ? new Set(only) : null;
  const results: Record<string, SensenovaProbeResult> = {};
  for (const model of models) {
    if (wanted && !wanted.has(model.upstream)) continue;
    if (model.chatProbe === false) {
      results[model.upstream] = {
        model: model.upstream, ok: false, latencyMs: null, status: null, code: 'not_applicable', chatOnly: false,
        error: '图像生成模型走 /images/generations，不走 /chat/completions，未纳入文本可用性检测',
        time: new Date().toISOString(),
      };
      continue;
    }
    results[model.upstream] = await probeModel(key, model.upstream, { baseUrl, timeoutMs });
  }
  return results;
}

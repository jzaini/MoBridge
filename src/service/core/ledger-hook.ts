// 账本上报钩子（墨镜 MoLens 的数据源，T1.4）：把转发口每次真实调用追加成一行
// CallEvent JSONL，落盘到墨镜的 inbound 缓冲目录（<MoFamily>\molens\inbound\bridge\<日期>.jsonl），
// 由墨镜按字节游标采集。三条纪律（与设计文档 T1.4 一致）：
//   1) fire-and-forget：记账绝不阻塞转发、绝不抛错——失败静默；
//   2) 单行 JSON + \n：墨镜只消费完整行，写坏/写半行都会被墨镜安全跳过；
//   3) 幂等键在墨镜侧（software|model|upstream|time），这里不查重，重复落盘也不会重复计数。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 一次上报的原始信息：category/status/error 用墨桥自己的词表，由 ledgerCategoryOf 统一翻译。 */
export interface LedgerCallInfo {
  software?: string;
  /** 上游真实模型 id（不是客户端展示名）。 */
  model: string;
  /** 渠道名：主转发口 opencode、AtomCode 口 atomcode。 */
  upstream: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
  status?: number;
  /** 墨桥 modelResult 的原始分类（quota/rate_limit/access/timeout/error/available）。 */
  category?: string;
  /** 上游 usage 原样透传（prompt_tokens 或 input_tokens 两套词表都认）。 */
  usage?: Record<string, unknown> | null;
}

/** 墨桥失败分类 → 墨镜账本分类（timeout/ratelimit/rejected/network/other；成功一律 null）。 */
export function ledgerCategoryOf(ok, category, status, error = '') {
  if (ok) return null;
  const mapped = { timeout: 'timeout', rate_limit: 'ratelimit', quota: 'rejected', access: 'rejected' }[category];
  if (mapped) return mapped;
  if (status === 429) return 'ratelimit';
  if (Number(status) >= 500) return 'network';
  if (/timeout|timed out|超时/i.test(String(error))) return 'timeout';
  return 'other';
}

/** usage 归一：两套词表都认，缺字段记 null——缺失让墨镜单列计数，绝不猜数。 */
function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return { tokensIn: null, tokensOut: null };
  const pick = (...keys) => {
    for (const k of keys) if (Number.isFinite(usage[k])) return Math.round(usage[k]);
    return null;
  };
  return { tokensIn: pick('prompt_tokens', 'input_tokens'), tokensOut: pick('completion_tokens', 'output_tokens') };
}

/** 落盘文件按本地自然日切（与墨镜按文件游标采集的契约一致）。 */
function localDateFile(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.jsonl`;
}

/**
 * 创建上报器。isEnabled 是活回调而不是布尔：设置面板改 ledgerEnabled 后立刻生效，
 * 不用重启服务。MOLENS_DATA_DIR 可把落盘指到别处（测试隔离用）。
 */
export function createLedgerHook({ isEnabled = () => true } = {}) {
  let dir;
  function inboundDir() {
    if (!dir) {
      const root = process.env.MOLENS_DATA_DIR
        || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MoFamily', 'molens');
      dir = path.join(root, 'inbound', 'bridge');
    }
    return dir;
  }
  function report(call) {
    if (!isEnabled() || !call || !call.model || !call.upstream) return;
    const { tokensIn, tokensOut } = usageTokens(call.usage);
    const event = {
      software: call.software || 'unknown',
      model: String(call.model),
      upstream: String(call.upstream),
      tokensIn,
      tokensOut,
      latencyMs: Number.isFinite(call.latencyMs) ? Math.max(0, Math.round(call.latencyMs)) : null,
      ok: !!call.ok,
      category: ledgerCategoryOf(call.ok, call.category, call.status, call.error),
      time: new Date().toISOString(),
      source: 'bridge',
      schema_version: 1,
    };
    // 串行追加：并发请求各自 open('a') 在 Windows 上可能交错出坏行，排队写保证单行完整；
    // 整条链路任何失败都吞掉——记账是旁路，不能影响转发（fire-and-forget）。
    queue = queue
      .then(() => fs.mkdir(inboundDir(), { recursive: true }))
      .then(() => fs.appendFile(path.join(inboundDir(), localDateFile()), JSON.stringify(event) + '\n'))
      .catch(() => {});
    return queue;
  }
  let queue = Promise.resolve();
  return { report };
}

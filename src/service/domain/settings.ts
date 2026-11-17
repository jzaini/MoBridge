// 服务侧可配置项的「唯一真源」：默认值、合法区间、归一化。
//
// 这些值原先各自硬编码在使用处（probe.ts 的 60 秒、main.ts 的并发 3、
// probe-cache.ts 的 360/60/10 分钟、sensenova.ts 的 20 秒），用户想调只能改代码。
// 收敛到一处之后有两个好处：
//   1. 面板给出什么区间，服务就按什么区间收——两边不会各写一套。
//   2. 旧版本留下的 settings.json 缺字段、多字段、写进字符串，读进来都能用。

/** 默认值：与 README / 面板展示保持一致，改这里就是改产品默认行为。 */
export const SETTINGS_DEFAULTS = {
  /** 单个模型检测的总预算（毫秒）。 */
  probeTimeoutMs: 60000,
  /** 同时探测几个模型。上游对并发敏感，默认保守。 */
  probeConcurrency: 3,
  /** 可用判定的复用时长（分钟），0 = 不复用。 */
  probeCacheMinutes: 360,
  /** 失败判定的复用时长（分钟）。 */
  rejectTtlMinutes: 60,
  /** 超时/限流这类瞬时故障的复用时长（分钟）。 */
  transientTtlMinutes: 10,
  /** 启动后是否自动跑一轮完整检测。 */
  autoProbeOnStart: true,
  /** 日日新单模型检测超时（毫秒）。它只发一个极小请求，用不上 60 秒。 */
  sensenovaTimeoutMs: 20000,
  /**
   * 本机主转发口。默认 31280 是墨桥自己的号段——不沿用上一代产品的 41980/41982，
   * 免得"两个产品还连着"的错觉，也避开了旧实例可能占着的端口。
   */
  port: 31280,
  /** AtomCode 转发口。与主端口分开监听（它要注入自己的请求头）。 */
  atomcodePort: 31282,
} as const;

/**
 * 合法区间。下限都不是 0：把检测超时调到 1 秒只会让每个模型都"超时"，
 * 那不是设置，那是让人怀疑软件坏了。上限用来挡住手滑多打一个零。
 */
export const SETTINGS_LIMITS = {
  probeTimeoutMs: { min: 10000, max: 300000 },
  probeConcurrency: { min: 1, max: 6 },
  probeCacheMinutes: { min: 0, max: 10080 },
  rejectTtlMinutes: { min: 1, max: 1440 },
  transientTtlMinutes: { min: 1, max: 1440 },
  sensenovaTimeoutMs: { min: 5000, max: 120000 },
  // 1024 以下要 root/管理员权限，Windows 上还可能被 Hyper-V 预留段占用；
  // 65535 是上限。区间卡死一点，用户手滑多打一位时会被夹回来，而不是启动失败。
  port: { min: 1024, max: 65535 },
  atomcodePort: { min: 1024, max: 65535 },
} as const;

// 面板上可以直接照着这个顺序渲染：键序 = 展示顺序。
const NUMERIC_KEYS = ['probeTimeoutMs', 'probeConcurrency', 'probeCacheMinutes', 'rejectTtlMinutes', 'transientTtlMinutes', 'sensenovaTimeoutMs', 'port', 'atomcodePort'] as const;
const BOOLEAN_KEYS = ['autoProbeOnStart'] as const;

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 只接受有限数字或"看起来像数字的字符串"：面板的输入框偶尔会送来字符串。 */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return null;
}

/**
 * 把任意输入归一成一份完整、合法的设置。
 * 未知键一律丢弃（免得把面板的临时字段写进 settings.json），
 * 缺失或非法的字段回落到默认值——而不是抛错让用户卡在无法启动的状态。
 */
export function normalizeSettings(input: unknown = {}) {
  const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, unknown> : {};
  const next: Record<string, number | boolean> = {};
  for (const key of NUMERIC_KEYS) {
    const limit = SETTINGS_LIMITS[key];
    const parsed = toNumber(source[key]);
    next[key] = parsed === null ? SETTINGS_DEFAULTS[key] : clampNumber(parsed, limit.min, limit.max);
  }
  for (const key of BOOLEAN_KEYS) {
    const parsed = toBoolean(source[key]);
    next[key] = parsed === null ? SETTINGS_DEFAULTS[key] : parsed;
  }
  return next as {
    probeTimeoutMs: number
    probeConcurrency: number
    probeCacheMinutes: number
    rejectTtlMinutes: number
    transientTtlMinutes: number
    sensenovaTimeoutMs: number
    autoProbeOnStart: boolean
    port: number
    atomcodePort: number
  };
}

/** 只保留用户真的改了的字段：面板每次只发一个 patch，不整份覆盖。 */
export function pickKnownKeys(patch: unknown) {
  const source = (patch && typeof patch === 'object' && !Array.isArray(patch)) ? patch as Record<string, unknown> : {};
  const picked: Record<string, unknown> = {};
  for (const key of [...NUMERIC_KEYS, ...BOOLEAN_KEYS]) if (key in source) picked[key] = source[key];
  return picked;
}

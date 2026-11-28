// 墨桥全项目接口契约的「单一真源」。
// 主进程（main/index.ts 的广播状态）、预加载（contextBridge 暴露的 Bridge）、
// 渲染层（useService 订阅的状态）三方共用同一份类型，避免三处重复定义彼此漂移。
//
// 注意：本文件只写「可擦除」的 TS 语法（interface / type / 类型注解），
// 不使用 enum / namespace / 装饰器——因为服务层与测试会在 Node 下以
// --experimental-strip-types 直接加载，strip-types 只支持可擦除语法。

/**
 * 写入目标：WorkBuddy、DSH，或墨坊（jzWorkBuddy / ai-coding-tool-ts）。
 * 三者写入形态不同——前两者是「一整份清单」，DSH 是 profile patch，
 * 墨坊是 config.json 里 providers 数组中的一条。
 */
export type TargetKind = 'workbuddy' | 'dsh' | 'mofang' | 'qoder' | 'trae'

/**
 * 后台服务生命周期阶段。
 * `reading` 是「进程活着、正在重读模型目录」——它不是"未连接"，
 * 页面判断"服务是否可用"时必须把它算进来，否则用户点一次「刷新目录」
 * 就会被瞬间打回第 1 步（服务其实一直是好的）。
 */
export type ServicePhase = 'starting' | 'reading' | 'ready' | 'error' | 'stopped'

/** 主进程接受的动作名（白名单，见 main/index.ts 的 ACTIONS）。 */
export type ServiceAction =
  | 'refresh'
  | 'probe'
  | 'import'
  | 'remove'
  | 'system-proxy'
  | 'restart'
  | 'choose-config'
  | 'find-config'
  | 'selection'
  | 'target'

/** 主进程经 ipcMain.handle('action') 返回的双层信封。 */
export interface ActionEnvelope {
  ok: boolean
  result?: unknown
  error?: string
}

/** 单个免费模型的描述（来自 OpenCode 官方目录静态快照）。 */
export interface ModelInfo {
  id: string
  name?: string
  context?: number
  [key: string]: unknown
}

/** 探测状态：运行中的模型列表与当前正在探测的模型。 */
export interface ProbeState {
  running?: boolean
  active?: string[]
  current?: string
  pending?: string[]
  /** 本轮计划检测的模型总数；与 done 一起给页面算进度条。 */
  total?: number
  /** 本轮已出结论的模型数（含命中缓存的）。 */
  done?: number
  [key: string]: unknown
}

/** 配置自动查找状态（Windows 上先尝试自动定位 WorkBuddy 的 models.json）。 */
export interface ConfigSearchState {
  running?: boolean
  candidates?: string[]
  errors?: string[]
}

/** 写入/移除后回传的同步结果。 */
export interface SyncState {
  changed?: boolean
  count?: number
  target?: TargetKind
  time?: string
  [key: string]: unknown
}

/**
 * 一个写入目标的体检结果。
 * 页面用它决定「移除配置」能不能点：能不能移除取决于条目此刻在不在，
 * 而不取决于我们这一轮有没有写过。
 */
export interface TargetInspection {
  available: boolean
  /** 这个目标里属于墨桥的条目总数（三条接入线合计）。 */
  owned: number
  /**
   * 按接入线拆开的条目：opencode / atomcode / sensenova → { count, ids }。
   * WorkBuddy 的 models.json 是三路共写一份，只看总数会让人在 OpenCode 页
   * 把日日新写进去的条目当成自己的——所以面板必须按线取数、按线列清单。
   * 老配置里认不出归属的条目不会出现在这个表里，此时渲染层退回用 owned / ids。
   */
  sources?: Record<string, { count: number, ids: string[] }>
  /** 我们写进去的条目标识（模型名/provider id）。面板用它展示"到底写了哪几个"，不用再猜。 */
  ids?: string[]
  file?: string | null
  profiles?: string[]
  note?: string | null
}

/**
 * 服务侧可配置项：检测超时、并发、判定缓存时长、启动是否自动检测。
 * 与服务进程 `domain/settings.ts` 的 SETTINGS_DEFAULTS 一一对应——
 * 那边是唯一真源，这里只声明形状给渲染层用。
 */
export interface ServiceSettings {
  /** 单个模型检测的总预算（毫秒）。 */
  probeTimeoutMs: number
  /** 同时探测几个模型。 */
  probeConcurrency: number
  /** 可用判定的缓存有效期（分钟），0 = 不复用。 */
  probeCacheMinutes: number
  /** 失败判定的缓存有效期（分钟）。 */
  rejectTtlMinutes: number
  /** 超时/限流这类瞬时故障的缓存有效期（分钟）。 */
  transientTtlMinutes: number
  /** 启动后是否自动跑一轮完整检测（关掉后只用上次的判定结果）。 */
  autoProbeOnStart: boolean
  /** 切换写入目标时是否自动"搬走"：摘旧目标里墨桥的条目 + 把勾选写进新目标。默认关。 */
  migrateOnTargetSwitch: boolean
  /** 日日新单模型检测超时（毫秒）。 */
  sensenovaTimeoutMs: number
  /**
   * 本机主转发口：OpenCode 走它，三个写入目标写进客户端的也是它。
   * 默认值与任何旧项目无关（旧项目用 41980/41982），见 constants.ts。
   */
  port: number
  /** AtomCode 独立转发口（它要注入自己的头，语义与主转发口不同，必须分开监听）。 */
  atomcodePort: number
  /**
   * AtomCode daemon 的授权档位（approval_mode），随每次对话下发给 daemon。
   * bypass 被刻意排除：那会让 daemon 原生工具不经询问直接执行。
   */
  atomcodeApprovalMode: 'build' | 'plan' | 'accept_edits'
}

/** 单个写入目标的路径现状：改动前先看清楚「写到哪、找不找得到」。 */
export interface TargetPathInfo {
  /** 用户在设置里手动指定的路径；null = 走内置默认规则。 */
  configured?: string | null
  /** 当前实际解析出来的路径（文件：WorkBuddy / 墨坊；目录：DSH）。 */
  resolved?: string | null
  /** 该路径此刻是否可用（文件存在 / DSH 有 profile）。 */
  exists: boolean
  /** 未定位时的一句人话说明。 */
  note?: string | null
}

/** 主进程侧的应用行为设置（写在 app-settings.json，与服务设置分开存）。 */
export interface AppSettings {
  /** 开机自动启动。 */
  autoLaunch: boolean
  /** 由开机启动拉起时不显示窗口（只留托盘）。 */
  startHidden: boolean
}

/** 渲染层读到的应用设置：实际值 + 系统层面的真实状态与能力。 */
export interface AppSettingsInfo extends AppSettings {
  /** 注册表 / 系统里此刻真实的开机自启状态（用户可能在任务管理器里改过）。 */
  autoLaunchActive: boolean
  /** 开发模式下不写注册表，页面据此说明"为什么打开没生效"。 */
  supported: boolean
  /** 数据目录、日志文件、版本，设置面板的"关于"要用。 */
  dataDir?: string
  logFile?: string
  appVersion?: string
}

/** 一条实时活动（探测/写入的进行中条目）。 */
export interface ActivityItem {
  model?: string
  [key: string]: unknown
}

/** 单个来源（日日新）里一个模型的真实可用性判定。 */
export interface SourceProbeResult {
  model: string
  ok: boolean
  latencyMs: number | null
  status: number | null
  error: string | null
  code: string | null
  time: string
}

/** 日日新接入状态：清单是静态快照，可用性靠真实请求量出来。 */
export interface SensenovaState {
  keyPresent?: boolean
  keyMask?: string | null
  validated?: boolean
  validation?: SourceProbeResult & { preferred?: string, fallback?: boolean, attempts?: SourceProbeResult[], time?: string } | null
  models?: Array<{ id: string; upstream: string; name: string; kind: string; context: number | null; images: boolean; caps: string[]; note: string; chatProbe?: boolean }>
  probeResults?: Record<string, SourceProbeResult>
  /** 逐模型检测的实时进度(检测期间推送,完成后清 null——浮层显示「N/M · 并行 6」)。 */
  probeProgress?: { done: number; total: number; concurrency: number } | null
  selection?: string[]
  apiBase?: string
  apiBaseCustom?: boolean
  apiBaseDefault?: string
  probeModel?: string
  contextUnknown?: string
  keysUrl?: string
  docsUrl?: string
  write?: { time: string; target: string; count: number; changed: boolean } | null
}

/** AtomCode 接入状态：本机客户端状态 + CodingPlan 目录 + 独立转发口。 */
export interface AtomcodeState {
  installed?: boolean
  version?: string | null
  binary?: string | null
  loggedIn?: boolean
  account?: { username: string; email: string; expiresAt: string | null; tokenPresent: boolean }
  models?: Array<{ id: string; upstream: string; name: string; context: number | null; images: boolean; levels: string[] }>
  /** 逐模型检测的实时进度(检测期间推送,完成后清 null)。 */
  probeProgress?: { done: number; total: number; concurrency: number } | null
  selection?: string[]
  catalogSource?: 'live' | 'offline' | 'none'
  plan?: { planName: string; planType: string; tier: string; expiresAt: string | null; remainingDays: number | null; quotaExhausted: boolean } | null
  fetchedAt?: string | null
  catalogError?: string | null
  planAPI?: string
  gateway?: string
  gatewayCustom?: boolean
  bridgeRunning?: boolean
  endpoint?: string | null
  bridgeError?: string
  install?: { command: string; official: string }
  loginCommand?: string
  docsUrl?: string
  siteUrl?: string
}

/** 渲染层订阅的全局服务状态——三方共用同一份形状。 */
export interface ServiceState {
  phase: ServicePhase
  message?: string
  target?: TargetKind
  models?: ModelInfo[]
  availableModels?: string[]
  excludedModels?: string[]
  modelResults?: Record<string, Record<string, unknown>>
  probe?: ProbeState
  configSearch?: ConfigSearchState
  activity?: ActivityItem[]
  modelsFile?: string
  sync?: SyncState
  endpoint?: string
  pid?: number
  version?: string
  opencodeVersion?: string
  useSystemProxy?: boolean
  updatedAt?: string
  dsh?: { home?: string; profiles?: string[]; [key: string]: unknown }
  /** 墨坊侧挂载情况：配置文件位置、已有 provider 清单、当前激活项。 */
  mofang?: { home?: string; file?: string | null; providers?: string[]; active?: string | null; [key: string]: unknown }
  /** Qoder 侧挂载情况：settings.json 位置、里面非墨桥的 provider 键。 */
  qoder?: { home?: string; file?: string | null; exists?: boolean; providers?: string[]; userProviders?: string[]; [key: string]: unknown }
  /** Trae 侧挂载情况：state.vscdb 位置、是否有我们的条目、Trae 是否在运行。 */
  trae?: { home?: string; file?: string | null; exists?: boolean; running?: boolean; owned?: number; [key: string]: unknown }
  /** 日日新（直连上游，无需本机转发口）：密钥、真实可用性、勾选与写入记录。 */
  sensenova?: SensenovaState
  /** AtomCode：本机安装/登录状态、CodingPlan 目录、独立转发口。 */
  atomcode?: AtomcodeState
  /** 三个写入目标的体检快照：客户端配置在不在、里面有没有墨桥写的条目。 */
  targets?: Partial<Record<TargetKind, TargetInspection>>
  /** 写入位置：设置里指定的值 / 实际解析到的路径 / 是否真的存在。 */
  targetPaths?: Partial<Record<TargetKind, TargetPathInfo>>
  /** 服务侧的可配置项（检测/缓存），设置在页面里改，服务里生效。 */
  settings?: ServiceSettings
  /** 判定缓存里现在有多少条结论。 */
  cacheEntries?: number
  /** 更新日志全文(服务层启动时从 CHANGELOG.md 读入,设置面板直接展示)。 */
  changelog?: string
  /** 启动阶段（boot 页真实步骤清单由它驱动：service/config/runtime/bridge/atomcode/catalog/probe）。 */
  bootStep?: string
  actionBusy?: string | false
  /** 主进程正在收摊（停服务、可选摘条目、释放端口）：渲染层据此盖退出遮罩。 */
  shuttingDown?: boolean
}

/** 选择动作的单模型载荷。 */
export interface SelectionValue {
  model: string
  selected: boolean
}

/** 托盘 / 面板使用的轻量状态抽象（与 ServiceState 字段兼容的子集）。 */
export interface TraySummary {
  phase: ServicePhase
  message?: string
  target?: TargetKind
  useSystemProxy?: boolean
}

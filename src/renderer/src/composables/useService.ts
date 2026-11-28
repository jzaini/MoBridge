import { ref, computed } from 'vue'
import type { ServiceState } from '@shared/types'

// 服务状态订阅 + 动作调用：单例订阅 onState 广播（主进程约 500ms 一推），
// 动作走 bridge.action（主进程白名单 + actionBusy 互斥），带超时与双层解包。
const state = ref<ServiceState>({
  phase: 'starting',
  message: '正在启动隔离模型服务',
  models: [],
  modelResults: {},
  availableModels: [],
  excludedModels: [],
  probe: {},
  activity: [],
  target: 'workbuddy',
  useSystemProxy: false,
  sync: {},
  targets: {},
  actionBusy: false,
})

let started = false
const pendingLocal = ref<string | null>(null)

// ── 浮层通知 ────────────────────────────────────────────────────────────
// 原先的提示条插在页面顶部，一出现就把下面的内容整体顶下去：结果类反馈
// 不该改动布局。这里改成右上角浮层：自己消失、可手动关、叠加上限 4 条，
// 循环类进度（检测选中 / 批量勾选）用 stream 键复用同一条，不刷屏。
export type ToastKind = 'ok' | 'error' | 'info'
export interface Toast { id: number, text: string, kind: ToastKind, stream?: string }

const MAX_TOASTS = 4
const TTL: Record<ToastKind, number> = { ok: 4200, info: 4200, error: 8000 }
const toasts = ref<Toast[]>([])
const toastTimers = new Map<number, number>()
let toastSeq = 0

// ── 通知历史 ────────────────────────────────────────────────────────────
// 浮层 4 秒就消失，用户一低头就再也找不回来——"刚才那句报错到底写了什么"因此成了
// 反复出现的需求。这里把每条通知都留档：标题一句话、完整原文（CLI 输出）另存，
// 点开通知中心能回看。
//
// 不记的两类：带 stream 的循环进度（一轮检测几十条，纯噪音）和空文案（清提示用）。
export interface NoticeItem {
  id: number
  text: string
  kind: ToastKind
  /** epoch ms */
  at: number
  /** 来源标识：哪条接入线（日日新 / AtomCode）产生的通知。系统级通知不标。 */
  source?: string
  /** 原文/细节：CLI 原始输出、接口返回体等。 */
  detail?: string
  read: boolean
}

const HISTORY_KEY = 'mobridge-notices'
const HISTORY_MAX = 200
let noticeSeq = Date.now()

function loadNotices(): NoticeItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter(item => item && typeof item.text === 'string')
      .map(item => ({
        id: Number(item.id) || ++noticeSeq,
        text: String(item.text),
        kind: (item.kind === 'ok' || item.kind === 'error' ? item.kind : 'info') as ToastKind,
        at: Number(item.at) || Date.now(),
        source: typeof item.source === 'string' && item.source ? item.source : undefined,
        detail: typeof item.detail === 'string' ? item.detail : undefined,
        read: item.read === true,
      }))
      .slice(-HISTORY_MAX)
  } catch { return [] }
}

const notices = ref<NoticeItem[]>(loadNotices())

function persistNotices() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(notices.value.slice(-HISTORY_MAX))) } catch { /* 隐私模式忽略 */ }
}

function recordNotice(text: string, kind: ToastKind, detail?: string, source?: string) {
  // 详情和正文一样时不算"含详情"：一条「已经是当前写入目标。」点开还是同一句话，纯噪音。
  const raw = String(detail || '').trim()
  notices.value = [...notices.value, { id: ++noticeSeq, text, kind, at: Date.now(), source, detail: raw && raw !== text ? raw : undefined, read: false }].slice(-HISTORY_MAX)
  persistNotices()
}

export const unreadCount = computed(() => notices.value.reduce((sum, item) => sum + (item.read ? 0 : 1), 0))

/** 时间倒序：最新的在最上面。 */
export const noticeFeed = computed(() => [...notices.value].reverse())

export function markNoticeRead(id: number) {
  if (!notices.value.some(item => item.id === id && !item.read)) return
  notices.value = notices.value.map(item => (item.id === id ? { ...item, read: true } : item))
  persistNotices()
}

export function markAllNoticesRead() {
  if (!notices.value.some(item => !item.read)) return
  notices.value = notices.value.map(item => (item.read ? item : { ...item, read: true }))
  persistNotices()
}

export function clearNotices() {
  notices.value = []
  persistNotices()
}

export function useNotices() {
  return { notices: noticeFeed, unreadCount, markNoticeRead, markAllNoticesRead, clearNotices }
}

export function note(text: string, kind: '' | 'ok' | 'error' = '', opts?: { stream?: string, detail?: string, source?: string }) {
  const body = String(text || '').trim()
  // note('') 是「清掉旧提示」的老语义（callAction 每次默认调用它），不该弹出空通知。
  if (!body) return
  const level: ToastKind = kind === 'ok' ? 'ok' : kind === 'error' ? 'error' : 'info'
  const reused = opts?.stream ? toasts.value.find(item => item.stream === opts.stream) : undefined
  const id = reused ? reused.id : ++toastSeq
  const entry: Toast = { id, text: body, kind: level, stream: opts?.stream }
  toasts.value = [...toasts.value.filter(item => item.id !== id), entry].slice(-MAX_TOASTS)
  const timer = toastTimers.get(id)
  if (timer) window.clearTimeout(timer)
  toastTimers.set(id, window.setTimeout(() => dismissToast(id), TTL[level]))
  if (!opts?.stream) recordNotice(body, level, opts?.detail, opts?.source)
}

export function dismissToast(id: number) {
  const timer = toastTimers.get(id)
  if (timer) { window.clearTimeout(timer); toastTimers.delete(id) }
  toasts.value = toasts.value.filter(item => item.id !== id)
}

export function useToasts() {
  return { toasts, dismissToast }
}

/** 只读体检：切页签 / 写完配置后重新确认「当前目标里到底有没有我们的条目」。 */
export async function inspectTargets() {
  return await callAction('inspect-targets', undefined, 20000, { keepNote: true })
}

// 循环流程（检测选中 / 批量勾选）用：整个循环期间压住本地忙碌位，
// 让工具条与表格控件保持禁用，避免逐条调用之间控件闪烁。
export function pushBusy(label: string | null) { pendingLocal.value = label }

function friendly(error: unknown): string {
  return (error as Error)?.message || String(error || '未知错误')
}

// 有副作用的动作超时后不自动重试，避免重复写入。
const NO_RETRY = new Set(['import', 'restart', 'remove'])

// 底层调用：不做闸门、不碰本地忙碌位（闸门与忙碌位由 run / pushBusy 负责）。
// keepNote=true 时不清空提示条（循环里每次推进都由调用方更新进度文案）。
export async function callAction(
  name: string,
  value?: unknown,
  timeoutMs?: number,
  opts?: { keepNote?: boolean },
): Promise<{ ok: boolean, result?: unknown, error?: string }> {
  const limit = timeoutMs ?? (['probe', 'import'].includes(name) ? 150000 : 20000)
  if (!opts?.keepNote) note('')
  try {
    const attempt = async (): Promise<{ ok: boolean, result?: unknown, error?: string }> => {
      const envelope = await Promise.race([
        window.bridge.action(name, value),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('请求超时，请稍候重试')), limit)),
      ])
      return envelope as { ok: boolean, result?: unknown, error?: string }
    }
    let envelope = await attempt()
    if (!envelope.ok && /超时|timeout/i.test(envelope.error || '') && !NO_RETRY.has(name)) envelope = await attempt()
    return envelope
  } catch (error) {
    return { ok: false, error: friendly(error) }
  }
}

export async function run(name: string, value?: unknown, timeoutMs?: number): Promise<{ ok: boolean, result?: unknown, error?: string }> {
  // 被拦下时把原因当错误返回，而不是静默 false：
  // 调用方的 catch 会把这句话弹出来，用户就不再是"点了没反应"。
  const blocked = blockedReason(name, value)
  if (blocked) return { ok: false, error: blocked }
  pendingLocal.value = name
  try {
    return await callAction(name, value, timeoutMs)
  } finally {
    pendingLocal.value = null
  }
}

export function useService() {
  if (!started) {
    started = true
    try { window.bridge.onState(next => { state.value = next }) } catch { /* 独立浏览器预览无桥 */ }
  }
  return { state }
}

export function operationBusy(): boolean {
  return !!(pendingLocal.value || state.value.actionBusy || (state.value.probe as { running?: boolean } | undefined)?.running || (state.value.configSearch as { running?: boolean } | undefined)?.running)
}
export function controlsBusy(): boolean {
  return operationBusy() || state.value.phase !== 'ready'
}

// 服务阶段的中文说法。拦下一个操作时，得告诉用户"现在到底在干什么"，
// 只说"请稍候"等于什么都没说。
// reading（重读模型目录）算可用状态：服务活着，只是目录在换。
export function serviceUsable(): boolean {
  return state.value.phase === 'ready' || state.value.phase === 'reading'
}
function phaseText(): string {
  const phase = state.value.phase
  if (phase === 'reading') return '服务正在重读模型目录'
  if (phase === 'starting') return '隔离模型服务正在启动'
  if (phase === 'error') return '隔离模型服务出错'
  if (phase === 'stopped') return '本地服务已停止：右上「⋯ 更多」→「启动本地服务」可重新打开'
  return '服务未就绪'
}

// ── 动作名 → 人话 ────────────────────────────────────────────────────────
// 进度条与"被拦住"的提示都读这一份，避免同一个动作在两个地方有两种叫法。
const OP_LABEL: Record<string, string> = {
  import: '写入配置', 'ac-import': '写入配置', 'sn-import': '写入配置',
  remove: '移除配置', 'ac-remove': '移除配置', 'sn-remove': '移除配置',
  probe: '检测模型', 'sn-probe': '检测模型', 'ac-probe': '检测模型', 'oc-probe-selected': '检测选中的模型',
  'probe-stop': '停止检测',
  refresh: '读取模型目录', 'ac-refresh': '读取免费模型目录',
  restart: '重启隔离模型服务',
  'service-stop': '停止本地服务', 'service-start': '启动本地服务',
  target: '切换写入目标',
  selection: '更新勾选', 'ac-selection': '更新勾选', 'sn-selection': '更新勾选',
  'ac-install': '安装 AtomCode', 'ac-login': '等待 AtomCode 登录授权', 'ac-detect': '检测 AtomCode 安装情况',
  'sn-validate': '验证 API Key 并检测模型', 'sn-save-key': '保存 API Key',
  'sn-clear-key': '清除 API Key', 'sn-save-base': '保存接口地址', 'sn-reset-base': '恢复默认接口地址',
  'ac-save-gateway': '保存网关地址', 'ac-reset-gateway': '恢复默认网关',
  'inspect-targets': '体检写入目标', settings: '保存设置', 'clear-cache': '清理判定缓存',
  'pick-target-path': '选择写入位置', 'auto-locate-path': '自动查找写入位置',
}
export function opLabel(key?: string | null): string {
  if (!key) return '处理中'
  return OP_LABEL[key] || '处理中'
}

/**
 * 这个动作现在为什么不能做；能做就返回 null。
 * 这是「点了没反应」的根治手段：所有按钮的门控都走这里，
 * 页面拿到原因就能显示出来（提示条 / 卡片里的说明），而不是静默 return。
 */
export function blockedReason(name: string, value?: unknown): string | null {
  const s = state.value
  // 同名不算拦路：页面习惯先 pushBusy('remove')/run('remove') 这样压住控件，
  // 那是"同一个动作在跑"，不是"别的动作占着位置"。
  if (pendingLocal.value && pendingLocal.value !== name) return '正在' + opLabel(pendingLocal.value) + '，等它结束再操作。'
  if (s.actionBusy && s.actionBusy !== name) return '服务正在' + opLabel(String(s.actionBusy)) + '，请稍候。'
  if ((s.probe as { running?: boolean } | undefined)?.running) return '模型检测正在进行，结束后才能继续。'
  if ((s.configSearch as { running?: boolean } | undefined)?.running) return '正在查找配置文件，请稍候。'
  if (name === 'restart') return s.phase === 'error' || s.phase === 'stopped' ? null : '只有服务出错或已停止时才需要重启。'
  // 服务启停不受「是否 ready」门禁：停止要在运行时才谈得上，启动要在停止后才谈得上。
  if (name === 'service-stop') {
    if (s.phase === 'stopped') return '本地服务已经停止了。'
    if (s.phase === 'reading') return '正在重读模型目录，结束后再停。'
    return null
  }
  if (name === 'service-start') return s.phase === 'stopped' ? null : '本地服务正在运行，不需要再启动。'
  if (name === 'system-proxy') return ['ready', 'reading', 'error'].includes(s.phase) ? null : phaseText() + '，请稍候。'
  // 选路径只是唤起系统对话框，服务没起来也该能先改好位置（主进程同样放在 ready 门禁之前）。
  if (name === 'pick-target-path') return null
  if (s.phase !== 'ready') return phaseText() + '，请稍候。'
  if (name === 'target') {
    if (!['workbuddy', 'dsh', 'mofang', 'qoder', 'trae'].includes(value as string)) return '无效的写入目标。'
    // 这里**不**比较「是不是当前目标」：页面会先做乐观更新把 state.target 改成新值，
    // 再调用 run()，此刻 s.target 已经是新值了——一比就永远相等，切换被自己拦下。
    // 幂等本来就由服务端负责（同值直接返回 changed:false）。
    return null
  }
  if (name === 'selection') {
    const id = (value as { model?: string })?.model
    return id && (s.availableModels || []).includes(id) ? null : '只有检测为可用的模型才能勾选。'
  }
  return null
}

export function canRun(name: string, value?: unknown): boolean {
  return blockedReason(name, value) === null
}

// ── 全局进度：弹窗一关就什么都看不见，是这次返工里最刺眼的一条 ─────────────
// 这里把"谁在忙"收敛成一个对象，由 App 底部的进度条常驻展示。
export interface OpInfo {
  label: string
  /** 具体到几个/哪一个，例如「3/12 · gpt-5」 */
  detail?: string
  /** 0~1，只有能算出比例的（整轮检测）才给 */
  ratio?: number
}

function shortModel(id?: string): string {
  return String(id || '').replace(/^opencode\//, '')
}

export const currentOp = computed<OpInfo | null>(() => {
  const s = state.value
  const probe = (s.probe || {}) as { running?: boolean, current?: string, total?: number, done?: number, concurrency?: number }
  if (probe.running) {
    const total = Number(probe.total) || 0
    const done = Number(probe.done) || 0
    const current = shortModel(probe.current)
    const parts = []
    if (total) parts.push(done + '/' + total)
    if (probe.concurrency) parts.push('并行 ' + probe.concurrency)
    if (current) parts.push(current)
    const detail = parts.length ? parts.join(' · ') : undefined
    return { label: '检测模型', detail, ratio: total ? Math.min(1, done / total) : undefined }
  }
  if (pendingLocal.value) {
    // SN/AC 逐模型检测也推实时进度(state 里 probeProgress),浮层与 OC 同款显示「N/M · 并行 N」
    const name = pendingLocal.value
    const prog = name === 'sn-probe' || name === 'sn-validate'
      ? (s.sensenova as { probeProgress?: { done: number, total: number, concurrency: number } | null } | undefined)?.probeProgress
      : name === 'ac-probe'
        ? (s.atomcode as { probeProgress?: { done: number, total: number, concurrency: number } | null } | undefined)?.probeProgress
        : null
    if (prog && prog.total > 0) return { label: opLabel(name), detail: `${prog.done}/${prog.total} · 并行 ${prog.concurrency}` }
    return { label: opLabel(name) }
  }
  if (s.actionBusy) return { label: opLabel(String(s.actionBusy)) }
  if ((s.configSearch as { running?: boolean } | undefined)?.running) return { label: '查找配置文件' }
  return null
})

<script setup lang="ts">
// 设置面板：把原先散落在代码里的可调项集中到一处。
//
// 分两套设置、两个真实来源：
//   · 检测与缓存（超时 / 并发 / 判定有效期 / 启动自动检测）住在服务进程的 settings.json，
//     走 bridge.action('settings')，改完下一轮检测就按新值跑。
//   · 应用行为（开机自启 / 启动是否露面 / 关窗去向）住在主进程的 app-settings.json，
//     走 getAppSettings/setAppSettings——服务进程不需要知道窗口怎么显示。
// 数字输入用 500ms 防抖提交：边打字边发请求会把服务打满，也不该每敲一个键就写盘。
import { computed, ref, watch, nextTick } from 'vue'
import { NModal, NInputNumber, NSwitch, NButton } from 'naive-ui'
import type { AppSettingsInfo, ServiceSettings, TargetPathInfo } from '@shared/types'
import {
  TARGET_PATH_KEY, TARGET_PATH_LABEL, type TargetKey,
} from '@shared/target-path-keys'
import { callAction, note, useService } from '../composables/useService'
import { notifyFailure } from '../utils/errors'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// ── 左侧分组导航 ─────────────────────────────────────────────────────────
// 设置项一多，右侧就变成一条要滚很久的长卷；给个目录，用户能直接跳到想看的那一节。
// 这里不用锚点（弹窗内滚动容器另算），而是按 offsetTop 程序化滚动：稳、不闪、不用改路由。
const SECTIONS = [
  { key: 'probe', label: '检测与缓存' },
  { key: 'ports', label: '本地端口' },
  { key: 'paths', label: '写入位置' },
  { key: 'app', label: '应用行为' },
  { key: 'maint', label: '维护' },
  { key: 'about', label: '关于' },
] as const
type SectionKey = typeof SECTIONS[number]['key']
const activeSec = ref<SectionKey>('probe')
const panes = ref<HTMLElement | null>(null)

function goto(key: SectionKey) {
  const host = panes.value
  const el = host?.querySelector(`[data-sec="${key}"]`) as HTMLElement | null
  activeSec.value = key
  if (!host || !el) return
  host.scrollTo({ top: Math.max(0, el.offsetTop - 6), behavior: 'smooth' })
}

/** 滚到哪一节就把哪一节标亮：目录与内容不会互相打脸。 */
function onPanesScroll() {
  const host = panes.value
  if (!host) return
  const y = host.scrollTop + 16
  let current: SectionKey = SECTIONS[0].key
  for (const section of SECTIONS) {
    const el = host.querySelector(`[data-sec="${section.key}"]`) as HTMLElement | null
    if (el && el.offsetTop <= y) current = section.key
  }
  // 滚到底时最后一节可能因为高度不够永远顶不到 y，这里直接判到底。
  if (host.scrollTop + host.clientHeight >= host.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1].key
  if (current !== activeSec.value) activeSec.value = current
}

// 每次打开都回到顶部，避免上次滚到"关于"、这次一进来就找不到检测项。
watch(() => props.show, async open => {
  if (!open) return
  await nextTick()
  if (panes.value) panes.value.scrollTop = 0
  activeSec.value = SECTIONS[0].key
})

const { state } = useService()

// 服务里读不到（服务还没起 / 旧版 status.json）时的兜底：与服务层 SETTINGS_DEFAULTS 一致。
const DEFAULTS: ServiceSettings = {
  probeTimeoutMs: 60000,
  probeConcurrency: 3,
  probeCacheMinutes: 360,
  rejectTtlMinutes: 60,
  transientTtlMinutes: 10,
  autoProbeOnStart: true,
  sensenovaTimeoutMs: 20000,
  port: 31280,
  atomcodePort: 31282,
}

interface NumField {
  key: 'probeTimeoutMs' | 'probeConcurrency' | 'probeCacheMinutes' | 'rejectTtlMinutes' | 'transientTtlMinutes' | 'sensenovaTimeoutMs' | 'port' | 'atomcodePort'
  label: string
  unit: string
  min: number
  max: number
  step: number
  /** 展示值 = 存储值 ÷ scale（毫秒按秒给人看）。 */
  scale: number
  hint: string
}

const FIELDS: NumField[] = [
  { key: 'probeTimeoutMs', label: '单模型检测超时', unit: '秒', min: 10, max: 300, step: 5, scale: 1000, hint: '一个模型最多等多久。免费模型排队时响应会慢，调太小会把「慢」误判成「不可用」。' },
  { key: 'probeConcurrency', label: '同时检测的模型数', unit: '个', min: 1, max: 6, step: 1, scale: 1, hint: '并发越高一轮越快，但上游对并发敏感，调太高容易招来限流。' },
  { key: 'probeCacheMinutes', label: '可用判定的有效期', unit: '分钟', min: 0, max: 10080, step: 30, scale: 1, hint: '这段时间内重启不再重复探测可用模型，直接沿用结论。0 = 每次启动都重测。' },
  { key: 'rejectTtlMinutes', label: '失败判定的有效期', unit: '分钟', min: 1, max: 1440, step: 10, scale: 1, hint: '已下线 / 无权限 / 额度用尽这类「关于模型的结论」缓存多久。' },
  { key: 'transientTtlMinutes', label: '瞬时故障的有效期', unit: '分钟', min: 1, max: 1440, step: 5, scale: 1, hint: '超时、限流属于当时的负载，过期时间该比「失败判定」短得多。' },
  { key: 'sensenovaTimeoutMs', label: '日日新检测超时', unit: '秒', min: 5, max: 120, step: 5, scale: 1000, hint: '日日新只发一个「hi」，正常一两秒就回；这里给的是兜底上限。' },
]

// 端口单独一组：它不是检测参数，改了要重启本地服务，说明文字也得不一样。
// 默认 31280 / 31282 是墨桥自己的号段，不沿用上一代产品的 41980 / 41982。
const PORTS: NumField[] = [
  { key: 'port', label: '主转发口', unit: '端口', min: 1024, max: 65535, step: 1, scale: 1,
    hint: '写进 WorkBuddy / DSH / 墨坊的就是这个地址（127.0.0.1 上的本机口）。改完会自动重启本地服务。' },
  { key: 'atomcodePort', label: 'AtomCode 转发口', unit: '端口', min: 1024, max: 65535, step: 1, scale: 1,
    hint: 'AtomCode 那条链路要注入自己的请求头，必须单独监听一个口。默认是主端口 + 2，一般不用改。' },
]

const draft = ref<Record<string, number | null>>({})
// 开关要做乐观更新：绑定到服务状态的话，用户拨一下得等一个来回（500ms 防抖 + IPC + 500ms 广播）
// 才看到变化，手感就是"点了没反应"。这里先本地生效，落盘成功后回到跟随状态。
const autoProbe = ref<boolean | null>(null)
const app = ref<AppSettingsInfo | null>(null)
const appBusy = ref(false)
const cacheBusy = ref(false)
const pending = new Map<string, number | boolean>()
let flushTimer: number | undefined

const serviceReady = computed(() => state.value.phase === 'ready' && !state.value.probe?.running)
const cacheEntries = computed(() => state.value.cacheEntries ?? 0)
const autoProbeShown = computed(() => autoProbe.value ?? serviceValue('autoProbeOnStart') === true)

function serviceValue(key: keyof ServiceSettings): number | boolean {
  const live = state.value.settings as ServiceSettings | undefined
  return (live?.[key] ?? DEFAULTS[key]) as number | boolean
}

function displayOf(field: NumField): number {
  return Math.round(Number(serviceValue(field.key)) / field.scale)
}

// 只在面板打开、且该字段没有待提交的改动时同步：否则用户正敲的字会被状态广播盖掉。
function syncDraft() {
  const next: Record<string, number | null> = {}
  for (const field of [...FIELDS, ...PORTS]) next[field.key] = pending.has(field.key) ? draft.value[field.key] ?? displayOf(field) : displayOf(field)
  draft.value = next
  if (!pending.has('autoProbeOnStart')) autoProbe.value = null
}

async function loadApp() {
  try { app.value = await window.bridge.getAppSettings() }
  catch (error) { note((error as Error)?.message || '读取应用设置失败', 'error') }
}

watch(() => props.show, (open) => {
  if (!open) return
  syncDraft()
  void loadApp()
}, { immediate: true })

// 用序列化后的设置当监听源：state 每 500ms 换一次新对象，直接 watch 对象会每轮都重建草稿。
const settingsKey = computed(() => JSON.stringify(state.value.settings || {}))
watch(settingsKey, () => { if (props.show) syncDraft() })

function queue(patch: Record<string, number | boolean>) {
  for (const [key, value] of Object.entries(patch)) pending.set(key, value)
  if (flushTimer) window.clearTimeout(flushTimer)
  flushTimer = window.setTimeout(flush, 500)
}

async function flush() {
  flushTimer = undefined
  if (!pending.size) return
  const patch = Object.fromEntries(pending)
  pending.clear()
  const envelope = await callAction('settings', patch, 20000, { keepNote: true })
  if (!envelope.ok) {
    notifyFailure(envelope.error, { fallback: '设置保存失败', prefix: '设置保存失败：' })
    syncDraft()
    return
  }
  // 端口是监听参数，改完主进程会顺手重启服务——这件事得说出来，
  // 否则用户看到"服务 启动中"会以为出了问题。
  const result = (envelope.result || {}) as { restarted?: boolean, port?: number }
  if (result.restarted) note(`端口已改为 ${result.port}，本地服务正在重启；已写入客户端的地址需重新写一次。`, 'ok', { stream: 'settings' })
  else note('设置已保存', 'ok', { stream: 'settings' })
}

function onNumber(field: NumField, value: number | null) {
  draft.value = { ...draft.value, [field.key]: value }
  // 清空输入框不该被当成"改成 0"：等用户真的填了数字再提交。
  if (value === null || !Number.isFinite(value)) return
  const bounded = Math.min(field.max, Math.max(field.min, Math.round(value)))
  draft.value = { ...draft.value, [field.key]: bounded }
  queue({ [field.key]: bounded * field.scale })
}

function onAutoProbe(value: boolean) {
  autoProbe.value = value
  queue({ autoProbeOnStart: value })
}

async function patchApp(patch: { autoLaunch?: boolean, startHidden?: boolean }) {
  if (appBusy.value) return
  appBusy.value = true
  try {
    app.value = await window.bridge.setAppSettings(patch)
    note('设置已保存', 'ok', { stream: 'settings' })
  } catch (error) {
    note((error as Error)?.message || '应用设置保存失败', 'error')
    void loadApp()
  } finally { appBusy.value = false }
}

async function clearCache() {
  if (cacheBusy.value) return
  cacheBusy.value = true
  try {
    const envelope = await callAction('clear-cache', undefined, 20000, { keepNote: true })
    if (!envelope.ok) note(envelope.error || '清空判定缓存失败', 'error')
    else note('判定缓存已清空，下次检测会重新发请求', 'ok', { stream: 'settings' })
  } finally { cacheBusy.value = false }
}

// ── 写入位置 ───────────────────────────────────────────────────────────
// 三个客户端的数据目录是「可以搬家」的：只按固定目录找，用户搬完就写不进去。
// 这里先让人看清当前实际写到哪，再允许自动查找 / 手动指定 / 恢复默认。
// 换位置属于破坏性动作（会先从旧位置摘掉墨桥自己写的条目），所以先内联确认一次。
const PATH_TARGETS: TargetKey[] = ['workbuddy', 'dsh', 'mofang']
const PATH_HINT: Record<TargetKey, string> = {
  workbuddy: 'WorkBuddy 的模型清单 models.json。默认在 ~/.workbuddy/；「自动查找」只扫常见位置，放得偏就用「更改…」。',
  dsh: 'DSH 的数据目录（下面应有 profiles/），不是某一个文件。默认 ~/.dsh。',
  mofang: '墨坊的 config.json（providers 数组在这份文件里）。默认 ~/.mofang/，老版本在 ~/.ai-coding-tool/。',
}
type PathMode = 'auto' | 'pick' | 'reset'
const pendingPath = ref<{ target: TargetKey, mode: PathMode } | null>(null)
const pathBusy = ref(false)
const pathInfo = computed(() => (state.value.targetPaths || {}) as Partial<Record<TargetKey, TargetPathInfo>>)

function askPath(target: TargetKey, mode: PathMode) {
  if (pathBusy.value) return
  pendingPath.value = { target, mode }
}

async function confirmPath() {
  const pending = pendingPath.value
  if (!pending || pathBusy.value) return
  pendingPath.value = null
  pathBusy.value = true
  try {
    const { target, mode } = pending
    let next = ''
    if (mode === 'pick' || mode === 'auto') {
      const envelope = await callAction(
        mode === 'pick' ? 'pick-target-path' : 'auto-locate-path',
        mode === 'pick' ? { target } : target,
        mode === 'auto' ? 90000 : 30000,
        { keepNote: true },
      )
      if (!envelope.ok) {
        notifyFailure(envelope.error, { fallback: '定位写入位置失败', prefix: '定位写入位置失败：' })
        return
      }
      const result = (envelope.result || {}) as { canceled?: boolean, path?: string }
      if (result.canceled || !result.path) return
      next = result.path
    }
    // 空串 = 恢复默认；路径的校验、旧位置清理、重新体检都在服务层一次做完。
    const envelope = await callAction('settings', { [TARGET_PATH_KEY[target]]: next }, 30000, { keepNote: true })
    if (!envelope.ok) {
      notifyFailure(envelope.error, { fallback: '写入位置保存失败', prefix: '写入位置保存失败：' })
      return
    }
    note(next
      ? `${TARGET_PATH_LABEL[target]} 的写入位置已更新，已重新体检并按新位置写入。`
      : `${TARGET_PATH_LABEL[target]} 已恢复默认位置。`, 'ok', { stream: 'settings' })
  } finally { pathBusy.value = false }
}
</script>

<template>
  <NModal :show="show" @update:show="(v: boolean) => !v && emit('close')">
    <div class="settings" role="dialog" aria-modal="true" aria-label="设置">
      <header class="settings-head">
        <h3>设置</h3>
        <button class="settings-x" type="button" aria-label="关闭" @click="emit('close')">×</button>
      </header>

      <div class="settings-body">
        <nav class="settings-nav" aria-label="设置分组">
          <button v-for="sec in SECTIONS" :key="sec.key" type="button"
            class="settings-nav-item" :class="{ active: activeSec === sec.key }"
            :aria-current="activeSec === sec.key ? 'true' : undefined"
            @click="goto(sec.key)">{{ sec.label }}</button>
        </nav>

        <div ref="panes" class="settings-panes" @scroll.passive="onPanesScroll">
        <!-- 检测与缓存：服务侧旋钮 -->
        <section class="settings-sec" data-sec="probe">
          <h4>检测与缓存</h4>
          <div v-for="f in FIELDS" :key="f.key" class="settings-row">
            <div class="settings-label">
              <span>{{ f.label }}</span>
              <small>{{ f.hint }}</small>
            </div>
            <div class="settings-control">
              <NInputNumber size="small" :value="draft[f.key]" :min="f.min" :max="f.max" :step="f.step"
                :show-button="false" :disabled="!serviceReady" style="width: 92px"
                @update:value="(v: number | null) => onNumber(f, v)" />
              <span class="settings-unit">{{ f.unit }}</span>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-label">
              <span>启动后自动检测</span>
              <small>打开后每次启动跑一轮完整检测；关掉则只用上次的判定结果，省时间也省上游额度。</small>
            </div>
            <div class="settings-control">
              <NSwitch size="small" :value="autoProbeShown" :disabled="!serviceReady"
                @update:value="onAutoProbe" />
            </div>
          </div>
        </section>

        <!-- 本地端口：写进客户端的就是这两个口，改动会自动重启本地服务 -->
        <section class="settings-sec" data-sec="ports">
          <h4>本地端口</h4>
          <div v-for="f in PORTS" :key="f.key" class="settings-row">
            <div class="settings-label">
              <span>{{ f.label }}</span>
              <small>{{ f.hint }}</small>
            </div>
            <div class="settings-control">
              <NInputNumber size="small" :value="draft[f.key]" :min="f.min" :max="f.max" :step="f.step"
                :show-button="false" :disabled="!serviceReady" style="width: 92px"
                @update:value="(v: number | null) => onNumber(f, v)" />
              <span class="settings-unit">{{ f.unit }}</span>
            </div>
          </div>
          <p class="settings-tip">
            默认 {{ DEFAULTS.port }} / {{ DEFAULTS.atomcodePort }}（墨桥自己的号段）。改端口会重启本地服务，
            期间检测与写入短暂不可用；已写入客户端的地址要重新写一次才会指向新端口。
          </p>
        </section>

        <!-- 写入位置：三个目标的配置都可能被用户搬走，必须能看见、能改 -->
        <section class="settings-sec" data-sec="paths">
          <h4>写入位置</h4>
          <p class="settings-tip">
            墨桥默认按固定目录找这三个客户端的配置。如果你把数据目录搬过家，请在这里指定实际位置——
            否则模型会写进一份客户端根本不读的文件。改完会重新体检，并把当前可用模型写到新位置。
          </p>
          <div v-for="t in PATH_TARGETS" :key="t" class="path-row">
            <div class="path-head">
              <strong>{{ TARGET_PATH_LABEL[t] }}</strong>
              <span class="path-badge" :class="pathInfo[t]?.exists ? 'ok' : 'na'">{{ pathInfo[t]?.exists ? '已定位' : '未定位' }}</span>
              <span v-if="pathInfo[t]?.configured" class="path-badge custom">手动指定</span>
            </div>
            <div class="path-value mono" :title="pathInfo[t]?.resolved || ''">{{ pathInfo[t]?.resolved || '—' }}</div>
            <small class="path-hint">{{ pathInfo[t]?.note || PATH_HINT[t] }}</small>
            <div class="path-actions">
              <NButton v-if="t === 'workbuddy'" size="tiny" :disabled="pathBusy || !serviceReady" @click="askPath(t, 'auto')">自动查找</NButton>
              <NButton size="tiny" :disabled="pathBusy" @click="askPath(t, 'pick')">更改…</NButton>
              <NButton size="tiny" :disabled="pathBusy || !pathInfo[t]?.configured" @click="askPath(t, 'reset')">恢复默认</NButton>
            </div>
          </div>
          <div v-if="pendingPath" class="path-confirm">
            <p>
              {{ pendingPath.mode === 'reset' ? '恢复' : '更换' }} {{ TARGET_PATH_LABEL[pendingPath.target] }} 的写入位置前，
              会先从旧位置摘掉墨桥写过的条目（其它工具的配置不受影响），再按新位置重新写入。确认继续？
            </p>
            <div class="path-confirm-actions">
              <NButton size="tiny" type="primary" :disabled="pathBusy" @click="confirmPath">确认</NButton>
              <NButton size="tiny" :disabled="pathBusy" @click="pendingPath = null">取消</NButton>
            </div>
          </div>
        </section>

        <!-- 应用行为：主进程侧旋钮 -->
        <section class="settings-sec" data-sec="app">
          <h4>应用行为</h4>
          <div class="settings-row">
            <div class="settings-label">
              <span>关闭窗口时</span>
              <small>退出应用并停止本机服务，不在后台留常驻进程。已写入客户端的配置不会被动，下次启动时按当时的可用模型刷新。</small>
            </div>
            <div class="settings-control settings-mono">退出</div>
          </div>
          <div class="settings-row">
            <div class="settings-label">
              <span>开机自动启动</span>
              <small v-if="app && !app.supported">开发模式下不注册开机项（注册的会是临时路径）。装好之后这里才生效。</small>
              <small v-else-if="app && app.autoLaunch && !app.autoLaunchActive">已保存为开启，但系统里当前没有这一项——可能被任务管理器或安全软件清掉了，重新打开一次会重新注册。</small>
              <small v-else>登录 Windows 后自动在后台跑起来，客户端随时能用模型。</small>
            </div>
            <div class="settings-control">
              <NSwitch size="small" :value="app?.autoLaunch === true" :disabled="appBusy || !app?.supported"
                @update:value="(v: boolean) => patchApp({ autoLaunch: v })" />
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-label">
              <span>启动时不弹窗口</span>
              <small>开机拉起时只留托盘，不抢屏幕。手动打开不受影响。</small>
            </div>
            <div class="settings-control">
              <NSwitch size="small" :value="app?.startHidden !== false" :disabled="appBusy || !app?.supported"
                @update:value="(v: boolean) => patchApp({ startHidden: v })" />
            </div>
          </div>
        </section>

        <!-- 维护 -->
        <section class="settings-sec" data-sec="maint">
          <h4>维护</h4>
          <div class="settings-row">
            <div class="settings-label">
              <span>判定缓存</span>
              <small>现有 {{ cacheEntries }} 条结论。清空后下次检测会对每个模型真的发一次请求。</small>
            </div>
            <div class="settings-control">
              <NButton size="tiny" :disabled="cacheBusy || !serviceReady" :loading="cacheBusy" @click="clearCache">清空</NButton>
            </div>
          </div>
        </section>

        <!-- 关于 -->
        <section class="settings-sec" data-sec="about">
          <h4>关于</h4>
          <div class="settings-row">
            <div class="settings-label"><span>版本</span></div>
            <div class="settings-control settings-mono">{{ app?.appVersion || '—' }}</div>
          </div>
          <div class="settings-row">
            <div class="settings-label"><span>数据目录</span><small>配置、日志与判定缓存都在这里。</small></div>
            <div class="settings-control settings-mono" :title="app?.dataDir">{{ app?.dataDir || '—' }}</div>
          </div>
          <div class="settings-row">
            <div class="settings-label"><span>日志文件</span></div>
            <div class="settings-control settings-mono" :title="app?.logFile">{{ app?.logFile || '—' }}</div>
          </div>
        </section>
        </div>
      </div>

      <footer class="settings-foot">
        <span class="settings-note">除端口外，其余改动即时生效，不需要重启。</span>
        <NButton size="small" @click="emit('close')">关闭</NButton>
      </footer>
    </div>
  </NModal>
</template>

<style scoped>
.settings {
  width: min(600px, calc(100vw - 48px)); max-height: min(78vh, 720px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface); color: var(--text);
  border: 1px solid var(--line); border-radius: 12px;
}
.settings-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px 8px; }
.settings-head h3 { margin: 0; font-size: 15px; }
.settings-x { border: 0; background: transparent; color: var(--muted); font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
.settings-x:hover { background: var(--hover); color: var(--text); }
/* 左目录 + 右内容：目录固定不动，只有右侧这一列滚，用户始终知道自己在哪一节。 */
.settings-body {
  flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 4px 18px 10px;
  display: grid; grid-template-columns: 118px minmax(0, 1fr); gap: 16px;
}
.settings-nav {
  display: flex; flex-direction: column; gap: 2px; padding-top: 8px;
  border-right: 1px solid var(--subtle-line); padding-right: 10px; margin-right: -6px;
}
.settings-nav-item {
  text-align: left; border: 0; background: transparent; color: var(--muted);
  font-size: 12px; padding: 6px 8px; border-radius: 7px; cursor: pointer; white-space: nowrap;
}
.settings-nav-item:hover { background: var(--hover); color: var(--text); }
.settings-nav-item.active { background: var(--selected); color: var(--accent-text); font-weight: 650; }
.settings-panes { min-height: 0; overflow: auto; padding-right: 2px; }
.settings-body { scrollbar-width: thin; }
.settings-sec { padding: 6px 0 10px; }
.settings-sec + .settings-sec { border-top: 1px solid var(--subtle-line); }
.settings-sec h4 { margin: 6px 0 2px; font-size: 12px; font-weight: 700; color: var(--accent-text); letter-spacing: .02em; }
.settings-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 9px 0; }
.settings-row + .settings-row { border-top: 1px dashed var(--subtle-line); }
.settings-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.settings-label span { font-size: 12.5px; font-weight: 600; }
.settings-label small { font-size: 11.5px; color: var(--muted); line-height: 1.45; }
.settings-control { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; max-width: 240px; }
.settings-unit { font-size: 11.5px; color: var(--muted); width: 30px; }
.settings-mono {
  display: block; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--mono); font-size: 11.5px; color: var(--muted); text-align: right;
}
.settings-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 18px; border-top: 1px solid var(--subtle-line); }
.settings-note { font-size: 11.5px; color: var(--muted); }
.settings-tip { margin: 2px 0 4px; font-size: 11px; line-height: 1.6; color: var(--disabled-text); }

/* ── 写入位置 ───────────────────────────────────────────────────────── */
.path-row { padding: 9px 0; }
.path-row + .path-row { border-top: 1px dashed var(--subtle-line); }
.path-head { display: flex; align-items: center; gap: 7px; }
.path-head strong { font-size: 12.5px; }
.path-badge {
  font-size: 10.5px; line-height: 16px; padding: 0 6px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--muted);
}
.path-badge.ok { color: var(--success-text); border-color: var(--success-text); }
.path-badge.na { color: var(--disabled-text); }
.path-badge.custom { color: var(--accent-text); border-color: var(--accent-text); }
.path-value {
  margin: 5px 0 2px; font-size: 11.5px; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.path-hint { display: block; font-size: 11px; line-height: 1.5; color: var(--muted); }
.path-actions { display: flex; gap: 6px; margin-top: 7px; }
.path-confirm {
  margin-top: 8px; padding: 10px; border-radius: 8px;
  border: 1px solid var(--warning-dot); background: var(--warning-background);
}
.path-confirm p { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--warning-text); }
.path-confirm-actions { display: flex; gap: 6px; margin-top: 8px; }
</style>

<template>
  <NConfigProvider :theme="isDark ? darkTheme : null" :theme-overrides="overrides" class="app-root">
    <!-- 启动页与主界面是「页面切换」而不是「遮罩叠加」：整页不透明背景 + mode="out-in"
       （旧页面先淡出、新页面再淡入，两层不同时存在），从根上消除遮罩式方案的闪烁。 -->
  <Transition name="page-fade" mode="out-in">
    <!-- 启动页：只列墨桥自身的启动项（OpenCode 运行时与模型检测是功能级动作，
         懒加载各自负责）；失败时步骤变红、给出原因，可关闭引导回主页面重试。 -->
    <div v-if="bootOverlay" key="boot" class="boot-page" role="status">
      <div class="quit-card boot-card">
        <i class="boot-spinner big" :class="{ fail: bootFailed }" aria-hidden="true" />
        <b>{{ bootFailed ? '启动失败' : '墨桥正在启动' }}</b>
        <ul class="boot-steps">
          <li v-for="st in bootSteps" :key="st.key" :class="st.status">
            <span class="bs-icon" aria-hidden="true">
              <svg v-if="st.status === 'done'" viewBox="0 0 16 16" width="10" height="10"><path d="M3.5 8.5 L7 12 L12.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
              <template v-else-if="st.status === 'failed'">!</template>
            </span>
            <span class="bs-label">{{ st.label }}</span>
            <span class="bs-detail">{{ st.detail }}</span>
          </li>
        </ul>
        <div v-if="!bootFailed" class="boot-track wide indeterminate" aria-hidden="true"><i class="boot-fill" /></div>
        <span v-if="!bootFailed" class="boot-time">{{ bootTimeHint }}</span>
        <span v-if="!bootFailed" class="boot-hint">全部就绪后自动进入主页面</span>
        <div v-else class="wc-actions">
          <NButton size="small" @click="dismissBoot">关闭引导</NButton>
          <NButton size="small" type="primary" @click="restartFromBoot">重试启动</NButton>
        </div>
      </div>
    </div>
    <div v-else key="main" class="app-shell">
      <header class="app-header">
        <div class="app-brand" title="墨桥 MoBridge · 墨坊家族">
          <svg class="brand-mark" viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <!-- 墨桥：水墨双拱桥 + 桥下数据流 -->
            <path d="M3 20 Q10 8 16 13 Q22 8 29 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
            <path d="M6 24 h20" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".85" />
            <circle cx="11" cy="27.5" r="1.6" fill="currentColor" opacity=".7" />
            <circle cx="16" cy="27.5" r="1.6" fill="currentColor" opacity=".5" />
            <circle cx="21" cy="27.5" r="1.6" fill="currentColor" opacity=".7" />
          </svg>
          <span class="brand-copy">
            <span class="brand-name">墨桥</span>
            <span class="brand-en">MoBridge</span>
          </span>
        </div>
        <nav class="app-tabs" role="tablist" aria-label="接入视图">
          <NButton v-for="v in views" :key="v.key" size="small" role="tab"
            class="app-tab" :class="{ active: active === v.key }" :quaternary="active !== v.key"
            :aria-pressed="active === v.key"
            @click="active = v.key">{{ v.label }}</NButton>
        </nav>
        <div class="header-right">
          <dl class="status-cluster" aria-label="当前状态">
            <div class="sc-item">
              <dt>服务</dt>
              <dd :class="phaseInfo.kind">
                <!-- 状态即操作：显示什么状态，这里就能做什么。
                     运行中点「停止」（弹确认）；已停止点「启动」；其余状态只读。 -->
                <NButton v-if="phaseInfo.kind !== 'error'" size="tiny" quaternary class="svc-toggle"
                  :disabled="serviceStarting || (phaseInfo.kind as string) === 'warn'"
                  :title="serviceStopped ? '启动本地服务：重新监听端口并检测模型' : '停止本地服务：转发口不再响应，配置保留'"
                  @click="serviceStopped ? doServiceStart() : (stopConfirm = true)">
                  <i class="sc-dot" :class="phaseInfo.kind" />{{ phaseInfo.text }}
                  <span class="svc-action">{{ svcAction }}</span>
                </NButton>
                <template v-else>
                  <i class="sc-dot" :class="phaseInfo.kind" />{{ phaseInfo.text }}
                </template>
              </dd>
            </div>
            <div class="sc-item">
              <dt>目标</dt>
              <dd>{{ targetInfo }}</dd>
            </div>
            <div class="sc-item">
              <dt>已写入</dt>
              <dd :class="ownedCount ? 'ok' : 'na'">{{ ownedCount ? ownedCount + ' 条' : '无' }}</dd>
            </div>
          </dl>
          <NotificationCenter />
          <NButton size="small" class="settings-btn" title="打开设置" @click="settingsOpen = true">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none"
              stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M4 7h16M4 17h16" />
              <circle cx="9.5" cy="7" r="2.3" fill="var(--surface)" />
              <circle cx="15" cy="17" r="2.3" fill="var(--surface)" />
            </svg>
            <span>设置</span>
          </NButton>
          <div class="theme-control" role="group" aria-label="界面主题">
            <NButton v-for="t in themeOptions" :key="t.key" size="tiny"
              class="theme-btn" :quaternary="choice !== t.key" :type="choice === t.key ? 'primary' : 'default'"
              :aria-pressed="choice === t.key"
              :title="t.key === 'system' ? '跟随系统设置' : t.key === 'light' ? '始终使用浅色界面' : '始终使用深色界面'"
              @click="set(t.key)">{{ t.label }}</NButton>
          </div>
        </div>
      </header>
      <main class="app-body">
        <div class="app-ambient" aria-hidden="true" />
        <component :is="activeComp" />
      </main>
      <SettingsModal :show="settingsOpen" @close="settingsOpen = false" />
      <ConfirmModal :show="stopConfirm" title="确认停止本地服务" ok-text="停止服务" danger
        @close="stopConfirm = false" @ok="doServiceStop">
        <p class="stop-note">停止后：<b>127.0.0.1 的转发口不再响应</b>，已写入 WorkBuddy / DSH / 墨坊 的模型会连接失败，直到重新启动服务。</p>
        <p class="stop-note">配置<b>不会</b>被移除——客户端里的条目原样保留，重新启动即恢复。确实想清掉条目，请用各接入页的「移除配置」。</p>
      </ConfirmModal>
    </div>
    </Transition>
    <!-- 退出遮罩：点关闭后主进程要停服务、摘条目（可选）、释放端口，
         至少亮 3 秒，让"退出发生了"这件事被看见。放在页面切换层之外：
         退出时主界面仍在渲染，遮罩只是盖在上面。 -->
    <Transition name="overlay-fade">
      <div v-if="shuttingDown" class="quit-overlay" role="alert">
        <div class="quit-card">
          <i class="boot-spinner" aria-hidden="true" />
          <b>正在退出墨桥…</b>
          <span>停止后台服务、释放本机转发口端口，马上就好。</span>
        </div>
      </div>
    </Transition>
    <!-- 退出确认：每次退出都问一次。转发口一关，客户端里指向它的模型就失联，
         这个后果必须让用户在退出前看到；勾选框决定是否顺手摘掉墨桥条目。 -->
    <NModal v-model:show="quitDialogShow" :auto-focus="false" transform-origin="center" class="quit-modal-wrap">
      <div class="quit-modal">
        <b class="qm-title">退出墨桥</b>
        <p class="qm-body">退出后本机转发口将关闭、端口释放。
          <template v-if="quitDialog?.bridgeCount"><b>{{ targetLabel(quitDialog.target) }}里墨桥写入的 {{ quitDialog.bridgeCount }} 个模型将无法使用</b>（日日新直连的不受影响）。</template>
          <template v-else>当前目标里没有墨桥写入的条目，退出不影响任何客户端配置。</template>
        </p>
        <NCheckbox v-if="quitDialog?.bridgeCount" v-model:checked="quitRemove" class="quit-remove">
          同时移除墨桥写入的 {{ quitDialog.bridgeCount }} 个条目（只摘墨桥的，你自己的配置不动）
        </NCheckbox>
        <div class="qm-actions">
          <NButton size="small" @click="quitCancel">取消</NButton>
          <NButton size="small" :type="quitRemove ? 'error' : 'primary'" @click="quitOk">{{ quitRemove ? '移除配置并退出' : '退出' }}</NButton>
        </div>
      </div>
    </NModal>
    <OpProgress />
    <ToastHost />
  </NConfigProvider>
</template>

<script setup lang="ts">
import { ref, computed, watch, type Component } from 'vue'
import { NConfigProvider, NButton, NCheckbox, NModal, darkTheme, type GlobalThemeOverrides } from 'naive-ui'
import { useTheme } from './composables/useTheme'
import { useService, inspectTargets, run, note, callAction } from './composables/useService'
import { notifyFailure } from './utils/errors'
import { targetLabel, inspectionOf } from './utils/target'
import ToastHost from './components/ToastHost.vue'
import OpProgress from './components/OpProgress.vue'
import NotificationCenter from './components/NotificationCenter.vue'
import ConfirmModal from './components/ConfirmModal.vue'
import SettingsModal from './components/SettingsModal.vue'
import OpenCodeView from './views/OpenCodeView.vue'
import AtomCodeView from './views/AtomCodeView.vue'
import SensenovaView from './views/SensenovaView.vue'

const { choice, isDark, set } = useTheme()
const { state } = useService()

// 标题栏右侧的状态簇：服务在不在、往哪儿写、写进去几条。
// 这条以前只有一个光秃秃的「设置」按钮，顶栏看着空；而这三个数字本来就是
// 用户每次打开窗口想第一眼确认的事，放这儿比藏在某一页里合适。
const phaseInfo = computed(() => {
  const phase = state.value.phase
  if (phase === 'ready') return { text: '运行中', kind: 'ok' as const }
  if (phase === 'reading') return { text: '读取目录中', kind: 'ok' as const }
  if (phase === 'starting') return { text: '启动中', kind: 'warn' as const }
  if (phase === 'error') return { text: '服务出错', kind: 'error' as const }
  return { text: '已停止', kind: 'na' as const }
})
const targetInfo = computed(() => targetLabel(state.value.target))
const ownedCount = computed(() => inspectionOf(state.value)?.owned ?? 0)

// 墨青主色：墨坊家族视觉（水墨 + 现代几何），亮暗两态都由 Naive 接管对比度。
// 按钮规则只有三条，全应用通用：每屏最多一个实心 primary；其余用描边 default；
// 危险操作（移除）用 error 描边（ghost），不再出现「蓝实心 + 粉实心」并排的两种气质。
const overrides = computed<GlobalThemeOverrides>(() => ({
  common: {
    primaryColor: isDark.value ? '#64adff' : '#3d6b8e',
    primaryColorHover: isDark.value ? '#82baff' : '#4d7ba0',
    primaryColorPressed: isDark.value ? '#4f9cf0' : '#325c7c',
    primaryColorSuppl: isDark.value ? '#82baff' : '#4d7ba0',
    // 错误色收敛成一套：按钮、圆点、提示条用同一个红，不再一处玫红一处橘红。
    errorColor: isDark.value ? '#ff6666' : '#d03050',
    errorColorHover: isDark.value ? '#ff8585' : '#de5786',
    errorColorPressed: isDark.value ? '#e35555' : '#c73b63',
    errorColorSuppl: isDark.value ? '#ff8585' : '#de5786',
    borderRadius: '8px',
  },
  Button: {
    // 同一排按钮的高度与圆角必须完全一致，肉眼才会把它们当一组。
    heightSmall: '28px',
    fontWeight: '500',
    // Naive 默认的水平 padding（small≈14px/tiny≈10px）比顶栏原来的原生按钮宽不少，
    // 顶栏右侧一排换 NButton 后总宽溢出、主题切换被挤出窗口（已实测）。压回紧凑值。
    paddingLeftSmall: '12px', paddingRightSmall: '12px',
    paddingLeftTiny: '8px', paddingRightTiny: '8px',
    // 默认按钮（深浅两套主题统一）：透明底 + 描边，与顶栏「设置」按钮同族。
    // Naive 自带的底色——深色是半透明白、浅色是浅灰实心——叠在页面上都读成
    // 「灰色实心块」，跟顶栏描边按钮完全是两种气质，用户反馈的"突兀"就是它。
    //
    // 浅色的字色/边框必须够深：tiny 描边按钮叠在白底上，灰字浅边会被读成
    // "整排都是禁用"，只有实心主按钮醒目（用户反馈的"按钮样式很奇怪"就是它）。
    ...(isDark.value ? {
      color: 'transparent',
      colorHover: 'rgba(255, 255, 255, .06)',
      colorPressed: 'rgba(255, 255, 255, .10)',
      colorFocus: 'transparent',
      border: '1px solid rgba(255, 255, 255, .30)',
      borderHover: '1px solid rgba(255, 255, 255, .50)',
      borderPressed: '1px solid rgba(255, 255, 255, .50)',
      borderFocus: '1px solid rgba(255, 255, 255, .30)',
      // 深色的 45% 白禁用字在 11px 按钮上确实看不清（用户反馈）——提到 58%。
      textColorDisabled: 'rgba(255, 255, 255, .58)',
    } : {
      color: 'transparent',
      colorHover: '#eef3fa',
      colorPressed: '#e2eaf5',
      colorFocus: 'transparent',
      border: '1px solid #b6bac3',
      borderHover: '1px solid #55555f',
      borderPressed: '1px solid #55555f',
      borderFocus: '1px solid #b6bac3',
      textColor: '#33333b',
      textColorHover: '#17171c',
      textColorPressed: '#17171c',
      textColorFocus: '#33333b',
      textColorDisabled: '#82828c',
    }),
  },
}))

const views: Array<{ key: string, label: string, comp: Component }> = [
  { key: 'opencode', label: 'OpenCode', comp: OpenCodeView },
  { key: 'atomcode', label: 'AtomCode', comp: AtomCodeView },
  { key: 'sensenova', label: '日日新', comp: SensenovaView },
]
const active = ref('opencode')
const activeComp = computed(() => views.find(v => v.key === active.value)?.comp ?? OpenCodeView)

// 换页签就重新体检一次写入目标：用户可能刚在别的工具里改过配置，
// 「移除配置」能不能点必须按此刻的事实算，不能沿用上一次的结论。
watch(active, () => { void inspectTargets() }, { immediate: true })

const themeOptions: Array<{ key: 'system' | 'light' | 'dark', label: string }> = [
  { key: 'system', label: '系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
]

// 设置面板：标题栏是最短的入口，托盘菜单里还有一份（主进程发 open-settings 过来）。
const settingsOpen = ref(false)
try { window.bridge.onOpenSettings(() => { settingsOpen.value = true }) } catch { /* 独立浏览器预览无桥 */ }

// ── 服务启停：直接住在顶栏「服务」状态位上 ─────────────────────────────────
// 用户的口径是"这里显示什么状态，这里就能操作"：运行中 → 点「停止」；已停止 → 点「启动」。
// 不再单独挂一个「更多」菜单——低频动作只有启停这一件，「更多」是给 ≥3 件低频动作准备的。
// 停止有确认弹窗（转发口会断，客户端模型连不上）；启动直接执行，无需确认。
const stopConfirm = ref(false)
const serviceStopped = computed(() => state.value.phase === 'stopped')
const serviceStarting = computed(() => state.value.phase === 'starting')
// 主进程广播的退出中标记（publish() 在 quitting 时带上）：遮罩的开关。
const shuttingDown = computed(() => (state.value as { shuttingDown?: boolean }).shuttingDown === true)
// ── 启动全屏遮罩：把"软件此刻在干什么"逐项列出来 ──
// bootProbing 标记"这次检测属于启动自动检测"：从 starting/reading 进入 ready 后置位，
// 检测结束即清掉——用户之后手动点「检测全部」不该再弹启动遮罩（那个有 OpProgress）。
const bootProbing = ref(false)
watch(() => state.value.phase, (phase, old) => {
  if (phase === 'ready' && (old === 'starting' || old === 'reading')) bootProbing.value = true
})
watch(() => (state.value.probe as { running?: boolean } | undefined)?.running, running => {
  if (running === false) bootProbing.value = false
})
// 启动遮罩只列墨桥自身的启动项：OpenCode 运行时与模型检测是"功能级"动作
// （懒加载 + OpProgress 各自负责），不属于"软件能不能用"的启动闸门。
const bootDismissed = ref(false)
const bootFailed = computed(() => state.value.phase === 'error')
// 服务是否曾经就绪过：就绪过之后再进入 reading（点刷新目录、切目标体检）或 error，
// 不再上全屏启动遮罩——否则运行中每次重读目录都会"闪一下全屏"（用户已指出）。
// 运行中的重读进度走底部浮层（OpProgress），错误走页面内状态面板与通知。
const everReady = ref(false)
watch(() => state.value.phase, phase => { if (phase === 'ready') everReady.value = true }, { immediate: true })
const bootOverlay = computed(() => {
  if (bootDismissed.value || everReady.value) return false
  const phase = state.value.phase
  return phase === 'starting' || phase === 'reading' || phase === 'error'
})
// 启动页真实步骤清单：由服务层推送的 state.bootStep 驱动（main readState 整包透传）——
// 此前只有两步占位（用户实锤「启动具体做什么没展示」），现在服务层每个真实阶段都推。
const BOOT_STAGES: Array<{ key: string, label: string, hint?: string, show?: (s: { autoProbeOnStart?: boolean }) => boolean }> = [
  { key: 'service', label: '启动后台服务进程（隔离 Node，免装依赖）' },
  { key: 'config', label: '加载本地配置与判定缓存' },
  { key: 'atomcode', label: 'AtomCode 检测与目录加载' },
  { key: 'runtime', label: '准备 OpenCode 运行时', hint: '未安装时用到才自动下载（约 76MB）' },
  { key: 'bridge', label: '启动转发口（127.0.0.1:31280 / 31282）' },
  { key: 'catalog', label: '读取免费模型目录' },
  { key: 'probe', label: '检测模型可用性', show: s => s.autoProbeOnStart !== false },
]
const bootSteps = computed(() => {
  const s = state.value as { phase: string, message?: string, bootStep?: string, settings?: { autoProbeOnStart?: boolean }, autoProbeOnStart?: boolean }
  const failed = s.phase === 'error'
  const stageKeys = BOOT_STAGES.filter(st => !st.show || st.show({ autoProbeOnStart: (s.settings as { autoProbeOnStart?: boolean } | undefined)?.autoProbeOnStart }))
  const currentIdx = s.bootStep ? stageKeys.findIndex(st => st.key === s.bootStep) : -1
  const statusText = (status: string) => (status === 'done' ? '完成' : status === 'active' ? '进行中' : '待开始')
  const steps = stageKeys.map((st, idx) => ({
    key: st.key,
    label: st.label,
    status: (failed && idx === Math.max(currentIdx, 0) ? 'failed'
      : currentIdx === -1 ? (idx === 0 ? 'active' : 'pending')
      : idx < currentIdx ? 'done'
      : idx === currentIdx ? 'active'
      : s.phase === 'ready' ? 'done' : 'pending') as 'pending' | 'active' | 'done' | 'failed',
    detail: failed && idx === Math.max(currentIdx, 0) ? (s.message || '启动失败') : '',
  }))
  // 兼容旧 status.json（无 bootStep 字段）：保留原两步行为
  if (currentIdx === -1 && !s.bootStep) {
    const legacy: Array<{ key: string, label: string, status: 'pending' | 'active' | 'done' | 'failed', detail: string }> = [
      { key: 'service', label: '启动后台服务与转发口（127.0.0.1:31280 / 31282）', status: failed ? 'failed' : s.phase === 'starting' ? 'active' : 'done', detail: failed ? (s.message || '启动失败') : '' },
      { key: 'config', label: '加载墨桥本地配置与写入目标', status: failed ? 'pending' : s.phase === 'starting' ? 'active' : 'done', detail: '' },
    ]
    for (const st of legacy) if (st.status !== 'active') st.detail = st.detail || statusText(st.status === 'failed' ? 'active' : st.status)
    return legacy
  }
  for (const st of steps) if (st.status !== 'active') st.detail = st.detail || statusText(st.status === 'failed' ? 'active' : st.status)
  return steps
})
// ── 启动耗时与预计 ────────────────────────────────────────────────────────
// 干等最糟心：已耗时实时走秒；预计耗时用「上次启动的真实总耗时」自动校准
// （存 localStorage），首次没有记录时给保守默认 12 秒。
const BOOT_MS_KEY = 'mobridge-boot-ms'
const bootElapsedSec = ref(0)
const bootExpectedSec = ref(12)
let bootHasRecord = false
let bootTimer: number | undefined
try {
  const saved = Number(localStorage.getItem(BOOT_MS_KEY))
  if (Number.isFinite(saved) && saved > 0) { bootHasRecord = true; bootExpectedSec.value = Math.max(1, Math.round(saved / 1000)) }
} catch { /* 隐私模式忽略 */ }
watch(bootOverlay, show => {
  if (show) {
    // 冷启动时页面加载那一刻遮罩可能已经是显示状态——没有"变化"就不会触发
    // 非 immediate 的 watch，计时器永远不启动，耗时停在 0.0（已实测）。
    // 1 秒整秒：0.5 秒步进配一位小数显示会跳出 0.5/1.5 这种奇怪数值（用户指出）。
    bootElapsedSec.value = 0
    clearInterval(bootTimer)
    bootTimer = window.setInterval(() => { bootElapsedSec.value += 1 }, 1000)
    return
  }
  // 遮罩消失（成功就绪）：把本次总耗时写回，下次的"预计"就用真实值。
  clearInterval(bootTimer)
  if (!bootFailed.value && bootElapsedSec.value >= 1) {
    const ms = Math.round(bootElapsedSec.value * 1000)
    try { localStorage.setItem(BOOT_MS_KEY, String(ms)) } catch { /* 隐私模式忽略 */ }
    bootExpectedSec.value = Math.max(1, Math.round(ms / 1000))
    bootHasRecord = true
  }
}, { immediate: true })
const bootTimeHint = computed(() => {
  // 超过预计时间的窗口期（探测/目录收尾）：文案切换为宽慰语气，不再报一个已经失效的预计值。
  const over = bootHasRecord && bootElapsedSec.value > bootExpectedSec.value
  return over
    ? `已耗时 ${bootElapsedSec.value} 秒 · 比上次启动慢一些，仍在工作中`
    : `已耗时 ${bootElapsedSec.value} 秒 · 预计约 ${bootExpectedSec.value} 秒${bootHasRecord ? '（按上次启动）' : ''}`
})
// 启动失败三件事：步骤变红说明原因、铃铛发一条通知、提供"关闭引导"让用户回到主页面
// （主页面本身就有错误状态与重试入口，遮罩不该把用户锁死）。
let bootErrorNotified = false
watch(bootFailed, failed => {
  if (!failed || bootErrorNotified) return
  bootErrorNotified = true
  note('启动失败：' + (state.value.message || '原因未知，详见数据目录 app.log'), 'error')
}, { immediate: true })
function dismissBoot() { bootDismissed.value = true }
function restartFromBoot() { bootDismissed.value = false; void run('restart') }
// ── 退出确认（渲染层组件弹窗）：主进程 before-quit 发 quit-request 过来 ──
const quitDialog = ref<{ bridgeCount: number, target: string } | null>(null)
const quitRemove = ref(false)
const quitDialogShow = computed({ get: () => quitDialog.value != null, set: v => { if (!v) quitDialog.value = null } })
let quitRequestSeen = false
window.bridge?.onQuitRequest?.(payload => {
  quitDialog.value = payload
  quitRemove.value = payload.bridgeCount > 0
  quitRequestSeen = true
})
async function quitOk() {
  const payload = quitRemove.value ? { remove: true } : { remove: false }
  quitDialog.value = null
  await callAction('quit-confirm', payload)
}
async function quitCancel() {
  quitDialog.value = null
  if (quitRequestSeen) await callAction('quit-cancel')
}
/** 状态位上动作词的措辞：启动中过程本身也是一种状态，不能和动作词打架。 */
const svcAction = computed(() => {
  if (serviceStarting.value) return '启动中…'
  return serviceStopped.value ? '启动' : '停止'
})
async function doServiceStop() {
  stopConfirm.value = false
  const envelope = await run('service-stop')
  if (!envelope.ok) { notifyFailure(envelope.error, { fallback: '停止失败' }); return }
  note('本地服务已停止。已写入客户端的配置保留，但转发口不再响应，重新启动后即恢复。', 'ok')
}
async function doServiceStart() {
  const envelope = await run('service-start')
  if (!envelope.ok) { notifyFailure(envelope.error, { fallback: '启动失败' }); return }
  note('本地服务正在启动，就绪后会自动检测模型。', 'ok')
}
</script>

<style scoped>
.app-root { height: 100%; }
.app-shell { height: 100%; display: flex; flex-direction: column; background: var(--background); color: var(--text); }
.app-header {
  flex: 0 0 auto; display: flex; align-items: center; gap: 18px;
  padding: 0 18px; height: 52px; border-bottom: 1px solid var(--subtle-line);
  background: var(--surface);
}
.app-brand { display: flex; align-items: center; gap: 7px; color: var(--accent-text); min-width: 0; }
/* 品牌名上下两行：中文在上、英文小字在下，横向占宽比"墨桥 MoBridge"一行省一半多。 */
.brand-copy { display: flex; flex-direction: column; line-height: 1.15; }
.brand-name { font-size: 14px; font-weight: 700; color: var(--text); }
.brand-en { font-size: 9.5px; color: var(--muted); letter-spacing: .02em; }
.app-tabs { display: flex; align-items: center; gap: 4px; flex: 1 1 auto; min-width: 0; }
/* tab 换成 NButton（quaternary）：尺寸与字重在此统一，选中态底色交给 .active。 */
.app-tab { font-size: 13px; padding: 6px 13px; border-radius: 7px; white-space: nowrap; }
.app-tab.active { background: var(--selected); color: var(--accent-text); font-weight: 650; }
.theme-control { display: inline-flex; align-items: center; gap: 1px; padding: 2px; border: 1px solid var(--line); border-radius: 8px; flex: 0 0 auto; }
.theme-btn { padding: 3px 10px; border-radius: 6px; }
.header-right { display: inline-flex; align-items: center; gap: 10px; flex: 0 0 auto; }
/* 状态簇：不用分组框，只用竖线分隔——顶栏上已经有主题切换那个带框的分段控件，
   再来一个框就太吵了。竖向一律 center 对齐：dt「服务」、状态点、状态词、动作胶囊
   四种高度混排，baseline 对齐会让胶囊看起来"沉"下去（用户已指出不对齐）。 */
.status-cluster { display: flex; align-items: center; gap: 0; margin: 0; }
.sc-item { display: flex; align-items: center; gap: 5px; padding: 0 10px; font-size: 11.5px; }
.sc-item + .sc-item { border-left: 1px solid var(--subtle-line); }
.sc-item dt { color: var(--disabled-text); font-size: 11px; }
.sc-item dd { margin: 0; display: inline-flex; align-items: center; gap: 5px; color: var(--text); font-weight: 550; }
.sc-item dd.ok { color: var(--success-text); }
.sc-item dd.warn { color: var(--warning-text); }
.sc-item dd.error { color: var(--error-text); }
.sc-item dd.na { color: var(--disabled-text); }
.sc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success-dot); }
.sc-dot.warn { background: var(--warning-dot); }
.sc-dot.error { background: var(--error-dot); }
.sc-dot.na { background: var(--disabled-text); }
@media (max-width: 1080px) {
  /* 窗口再窄就先让状态簇让位：设置与主题是必须点得到的。 */
  .status-cluster { display: none; }
}
.settings-btn {
  border-radius: 8px;
}
.settings-btn:hover { background: var(--hover); color: var(--text); border-color: var(--muted); }
.stop-note { margin: 0 0 8px; font-size: 12px; line-height: 1.65; color: var(--text); }

/* ── 标题栏并入接入行 ─────────────────────────────────────────────────────
   titleBarStyle: 'hidden' + titleBarOverlay 之后，原生窗口按钮画在右上角。
   整条 header 是拖拽区（app-region: drag），可点元素逐个声明 no-drag；
   右侧用 titlebar-area 环境变量给原生按钮让位：WCO 不可用时 env 全部取
   回退值，算出来是 0，不留白。

   注意 no-drag 只声明到「具体控件」，绝不能盖住 flex:1 撑满头部中段的
   .app-tabs 容器——那正是用户眼里的"标题栏空白处"，盖住了拖动和双击
   最大化就全废了（曾把 .app-tabs 整个标成 no-drag，被用户抓到）。
   app-region 的区域算法是：drag 的矩形整块生效，只有显式 no-drag 的
   后代才会从中挖洞，所以容器不声明即整块可拖。 */
/* 标题栏并入接入行：titleBarStyle hidden + 原生 overlay 按钮画在右上角，
   整条 header 是拖拽区（app-region: drag），可点元素逐个声明 no-drag。
   右侧让位用固定值：env(titlebar-area-*) 在 DPI 缩放下返回物理像素，
   与 100vw（CSS 像素）混算会错位，主题切换整个被窗口控制按钮盖住（已实测）。
   Windows 11 三枚按钮约 138px，留 150px。
   注意 no-drag 只声明到「具体控件」，绝不能盖住 flex:1 撑满头部中段的
   .app-tabs 容器——那正是用户眼里的"标题栏空白处"，盖住了拖动和双击
   最大化就全废了（曾把 .app-tabs 整个标成 no-drag，被用户抓到）。
   app-region 的区域算法是：drag 的矩形整块生效，只有显式 no-drag 的
   后代才会从中挖洞，所以容器不声明即整块可拖。 */
.app-header { -webkit-app-region: drag; padding-right: 150px; }
.app-tab, .theme-control, .notice-root, .svc-toggle, .settings-btn, .status-cluster { -webkit-app-region: no-drag; }

/* 服务状态即操作：状态词是展示，尾部动作词才是可点的部分。 */
.svc-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  border: 0; background: transparent; padding: 2px 4px; border-radius: 6px;
  font-size: 12px; color: var(--text); cursor: pointer;
}
.svc-toggle:hover:not(:disabled) { background: var(--hover); }
.svc-toggle:disabled { cursor: default; opacity: .8; }
.svc-action {
  font-size: 11px; font-weight: 650; color: var(--accent-text);
  border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; line-height: 18px;
}
.svc-toggle:disabled .svc-action { color: var(--disabled-text); }
.app-body {
  flex: 1 1 auto; min-height: 0; overflow: auto; position: relative;
}
/* 氛围层：三团错开的冷色光斑，铺满整个工作区。
   它就是给 .glass 的 backdrop-filter 提供"可折射的东西"——没有它，
   blur(18px) 作用在纯平底色上等于什么都没做，玻璃看上去就只是一张白卡。 */
.app-ambient {
  position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background-image:
    radial-gradient(760px 460px at 6% -6%, var(--ambient-1), transparent 70%),
    radial-gradient(680px 460px at 100% 6%, var(--ambient-2), transparent 72%),
    radial-gradient(560px 480px at 102% 44%, var(--ambient-2), transparent 74%),
    radial-gradient(820px 560px at 74% 96%, var(--ambient-3), transparent 72%);
  background-repeat: no-repeat;
}
/* 氛围层之上才是真正的内容：玻璃卡既能 blur 到光斑，又不会盖住可点元素。 */
.app-body > *:not(.app-ambient) { position: relative; z-index: 1; }

/* ── 启动遮罩步骤清单 + 转圈 ── */
.boot-spinner {
  flex: 0 0 auto; width: 15px; height: 15px; border-radius: 50%;
  border: 2px solid var(--line); border-top-color: var(--accent-text);
  animation: boot-spin .8s linear infinite;
}
.boot-spinner.big { width: 26px; height: 26px; border-width: 3px; }
@keyframes boot-spin { to { transform: rotate(360deg); } }
.boot-card { gap: 12px; min-width: 380px; }
.boot-steps { list-style: none; margin: 0; padding: 0; width: 100%; display: grid; gap: 7px; }
.boot-steps li { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); }
.boot-steps li.active { color: var(--text); font-weight: 600; }
.boot-steps li.done { color: var(--text); }
.boot-steps li.pending { opacity: .6; }
.boot-steps li.failed { color: var(--error-text, #d03050); font-weight: 600; }
.boot-steps li.failed .bs-icon { border-color: var(--error-text, #d03050); color: var(--error-text, #d03050); }
.boot-spinner.fail { border-top-color: var(--error-text, #d03050); }
.bs-icon {
  flex: 0 0 16px; width: 16px; height: 16px; border-radius: 50%; text-align: center; line-height: 16px;
  font-size: 11px; border: 1px solid var(--line); color: var(--success-text);
  display: inline-flex; align-items: center; justify-content: center;
}
.boot-steps li.done .bs-icon { border-color: transparent; background: var(--success-text); color: #fff; }
.boot-steps li.active .bs-icon { border-color: var(--accent-text); background: var(--hover); }
.bs-label { flex: 0 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bs-detail { flex: 1 1 auto; text-align: right; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.boot-track { width: 100%; height: 4px; border-radius: 999px; background: var(--line); overflow: hidden; }
.boot-track.wide { width: 100%; }
.boot-fill { display: block; height: 100%; border-radius: 999px; background: var(--accent-text); transition: width .5s ease; }
/* 启动页进度条统一为不定态流动条纹（与底部浮层 OpProgress 同款——U-18：用户要的是
   「仍在工作」的动感，不是假精确的百分比；启动步骤只有粗粒度两步，百分比会跳变误导）。 */
.boot-track.indeterminate .boot-fill {
  width: 100%;
  background: repeating-linear-gradient(45deg,
    var(--accent-text) 0 10px,
    color-mix(in srgb, var(--accent-text) 55%, transparent) 10px 20px);
  animation: boot-stripes .8s linear infinite;
}
@keyframes boot-stripes { to { background-position: 28px 0; } }
.boot-time { font-size: 12px; font-weight: 650; color: var(--accent-text); font-variant-numeric: tabular-nums; }
.boot-hint { font-size: 11px; color: var(--muted); }
.quit-remove { margin-top: 4px; }
.quit-modal {
  display: flex; flex-direction: column; gap: 10px; max-width: 480px;
  background: var(--surface); border-radius: 14px; padding: 20px 22px;
  border: 1px solid var(--line); box-shadow: 0 18px 48px rgba(0, 0, 0, .18);
}
.qm-title { font-size: 14px; color: var(--text); }
.qm-body { margin: 0; font-size: 12px; line-height: 1.7; color: var(--muted); }
.qm-body b { color: var(--text); }
.qm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

/* ── 退出遮罩：收摊过程可见，而不是"点了没反应" ── */
/* ── 启动页(页面化):与主界面是页面切换,不再是遮罩 ── */
.boot-page {
  position: fixed; inset: 0; z-index: 90;
  /* 不透明底:盖住主界面,页面切换期间不存在两层透明度叠加,闪烁无从产生 */
  background: var(--background);
  display: flex; align-items: center; justify-content: center;
}
/* 页面切换:旧页淡出完、新页再淡入(mode="out-in"),两层永不同时存在 */
.page-fade-enter-active, .page-fade-leave-active { transition: opacity .24s ease; }
.page-fade-enter-from, .page-fade-leave-to { opacity: 0; }
/* 遮罩的淡入淡出：<Transition name="overlay-fade"> 驱动，出现与消失都 0.28s，
   消除遮罩与主界面之间的硬切闪烁。 */
.overlay-fade-enter-active, .overlay-fade-leave-active { transition: opacity .28s ease; }
.overlay-fade-enter-from, .overlay-fade-leave-to { opacity: 0; }
.quit-overlay {
  position: fixed; inset: 0; z-index: 90;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--background) 72%, transparent);
  backdrop-filter: blur(4px);
}
.quit-card {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  padding: 26px 34px; border-radius: 16px; text-align: center;
  border: 1px solid var(--line); background: var(--surface);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .18);
}
.quit-card b { font-size: 14px; color: var(--text); }
.quit-card span { font-size: 12px; color: var(--muted); max-width: 340px; line-height: 1.6; }
</style>

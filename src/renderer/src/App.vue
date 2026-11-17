<template>
  <NConfigProvider :theme="isDark ? darkTheme : null" :theme-overrides="overrides" class="app-root">
    <div class="app-shell">
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
          <span class="brand-name">墨桥</span>
          <span class="brand-en">MoBridge</span>
        </div>
        <nav class="app-tabs" role="tablist" aria-label="接入视图">
          <button v-for="v in views" :key="v.key" type="button" role="tab"
            class="app-tab" :class="{ active: active === v.key }" :aria-pressed="active === v.key"
            @click="active = v.key">{{ v.label }}</button>
        </nav>
        <div class="header-right">
          <dl class="status-cluster" aria-label="当前状态">
            <div class="sc-item">
              <dt>服务</dt>
              <dd :class="phaseInfo.kind">
                <!-- 状态即操作：显示什么状态，这里就能做什么。
                     运行中点「停止」（弹确认）；已停止点「启动」；其余状态只读。 -->
                <button v-if="phaseInfo.kind !== 'error'" class="svc-toggle" type="button"
                  :disabled="serviceStarting || (phaseInfo.kind as string) === 'warn'"
                  :title="serviceStopped ? '启动本地服务：重新监听端口并检测模型' : '停止本地服务：转发口不再响应，配置保留'"
                  @click="serviceStopped ? doServiceStart() : (stopConfirm = true)">
                  <i class="sc-dot" :class="phaseInfo.kind" />{{ phaseInfo.text }}
                  <span class="svc-action">{{ svcAction }}</span>
                </button>
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
          <button class="settings-btn" type="button" title="打开设置" @click="settingsOpen = true">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none"
              stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M4 7h16M4 17h16" />
              <circle cx="9.5" cy="7" r="2.3" fill="var(--surface)" />
              <circle cx="15" cy="17" r="2.3" fill="var(--surface)" />
            </svg>
            <span>设置</span>
          </button>
          <div class="theme-control" role="group" aria-label="界面主题">
            <button v-for="t in themeOptions" :key="t.key" type="button"
              class="theme-btn" :class="{ active: choice === t.key }" :aria-pressed="choice === t.key"
              :title="t.key === 'system' ? '跟随系统设置' : t.key === 'light' ? '始终使用浅色界面' : '始终使用深色界面'"
              @click="set(t.key)">{{ t.label }}</button>
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
      <OpProgress />
      <ToastHost />
    </div>
  </NConfigProvider>
</template>

<script setup lang="ts">
import { ref, computed, watch, type Component } from 'vue'
import { NConfigProvider, NButton, darkTheme, type GlobalThemeOverrides } from 'naive-ui'
import { useTheme } from './composables/useTheme'
import { useService, inspectTargets, run, note } from './composables/useService'
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
    // 默认按钮（深浅两套主题统一）：透明底 + 描边，与顶栏「设置」按钮同族。
    // Naive 自带的底色——深色是半透明白、浅色是浅灰实心——叠在页面上都读成
    // 「灰色实心块」，跟顶栏描边按钮完全是两种气质，用户反馈的"突兀"就是它。
    // 浅色的取值直接抄 CSS 变量（--hover / --line / --muted / --text / --disabled-text），
    // 连 hover 行为（浅蓝底 + 深描边 + 字变深）都和 .settings-btn 一致。
    ...(isDark.value ? {
      color: 'transparent',
      colorHover: 'rgba(255, 255, 255, .06)',
      colorPressed: 'rgba(255, 255, 255, .10)',
      colorFocus: 'transparent',
      border: '1px solid rgba(255, 255, 255, .30)',
      borderHover: '1px solid rgba(255, 255, 255, .50)',
      borderPressed: '1px solid rgba(255, 255, 255, .50)',
      borderFocus: '1px solid rgba(255, 255, 255, .30)',
    } : {
      color: 'transparent',
      colorHover: '#f0f4fa',
      colorPressed: '#e6ecf6',
      colorFocus: 'transparent',
      border: '1px solid #d8d8dd',
      borderHover: '1px solid #61616a',
      borderPressed: '1px solid #61616a',
      borderFocus: '1px solid #d8d8dd',
      textColor: '#61616a',
      textColorHover: '#242426',
      textColorPressed: '#242426',
      textColorFocus: '#61616a',
      textColorDisabled: '#9a9aa2',
    }),
  },
}))

const views: Array<{ key: string, label: string, comp: Component }> = [
  { key: 'opencode', label: 'OpenCode 接入', comp: OpenCodeView },
  { key: 'atomcode', label: 'AtomCode 接入', comp: AtomCodeView },
  { key: 'sensenova', label: '日日新接入', comp: SensenovaView },
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
.brand-name { font-size: 15px; font-weight: 700; color: var(--text); }
.brand-en { font-size: 11px; color: var(--muted); }
.app-tabs { display: flex; align-items: center; gap: 4px; flex: 1 1 auto; min-width: 0; }
.app-tab {
  border: 0; background: transparent; color: var(--muted); font-size: 13px;
  padding: 6px 13px; border-radius: 7px; cursor: pointer; white-space: nowrap;
}
.app-tab:hover { background: var(--hover); color: var(--text); }
.app-tab.active { background: var(--selected); color: var(--accent-text); font-weight: 650; }
.theme-control { display: inline-flex; align-items: center; gap: 1px; padding: 2px; border: 1px solid var(--line); border-radius: 8px; flex: 0 0 auto; }
.theme-btn { border: 0; background: transparent; color: var(--muted); font-size: 12px; padding: 3px 10px; border-radius: 6px; cursor: pointer; }
.theme-btn.active { background: var(--selected); color: var(--accent-text); font-weight: 600; }
.header-right { display: inline-flex; align-items: center; gap: 10px; flex: 0 0 auto; }
/* 状态簇：不用分组框，只用竖线分隔——顶栏上已经有主题切换那个带框的分段控件，
   再来一个框就太吵了。 */
.status-cluster { display: flex; align-items: center; gap: 0; margin: 0; }
.sc-item { display: flex; align-items: baseline; gap: 5px; padding: 0 10px; font-size: 11.5px; }
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
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--line); background: transparent; color: var(--muted);
  font-size: 12px; padding: 4px 10px; border-radius: 8px; cursor: pointer;
}
.settings-btn:hover, .settings-btn.active { background: var(--hover); color: var(--text); border-color: var(--muted); }
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
.app-header { -webkit-app-region: drag; }
.app-header { padding-right: calc(100vw - (env(titlebar-area-x, 0px) + env(titlebar-area-width, 100vw))); }
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
</style>

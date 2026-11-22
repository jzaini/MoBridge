<template>
  <div class="plan" :class="{ 'rail-collapsed': railCollapsed }">
    <!-- 左：步骤栏（放回左侧：上方横条占首屏黄金区。展示力度已增强——节点显示序号、
         当前步骤高亮环、绿底=完成） -->
    <div class="plan-rail">
      <StepRail v-model:active="active" :steps="rail" :collapsed="railCollapsed" @toggle="toggleRail">
        <template #foot>
          检测只发极小请求，不消耗对话额度。
        </template>
      </StepRail>
    </div>

    <!-- 中：当前步骤 -->
    <div class="plan-main">
      <!-- 页头只在第 1 步显示：第 2 步的标题并入卡片、按钮并入表格工具行，
           去掉重复展示，内容区整体上移。 -->
      <header v-if="active === 'connect'" class="stage-head">
        <div class="stage-title">
          <h2>连接模型服务</h2>
          <p class="stage-sub">{{ caption }}</p>
        </div>
        <div class="stage-actions">
          <NButton size="small" :disabled="busy" title="查看连接、写入记录与说明等环境明细" @click="envShow = true">环境信息</NButton>
          <NButton v-if="st.phase === 'error' || st.phase === 'stopped'" size="small" type="warning" :disabled="opBusy" title="服务出错或停止时重新启动隔离模型服务" @click="runAction('restart')">重启服务</NButton>
        </div>
      </header>

      <!-- 第 1 步：连接服务 -->
      <section v-if="active === 'connect'" class="pane" aria-label="连接服务">
        <div class="pane-head">
          <h3>隔离模型服务</h3>
          <p>墨桥在本机启动一个独立的模型服务，这里看它有没有起来、地址是多少。</p>
        </div>
        <div class="pane-body">
          <StatusPanel :state="st" @open-env="envShow = true" />
          <h4 class="sec-title">这一步在看什么</h4>
          <ul class="review-list guide">
            <li><b>阶段/版本</b>：服务有没有起来、是什么版本。</li>
            <li><b>转发口</b>：客户端要填的本机地址。</li>
            <li><b>上次同步</b>：最近一次写入的记录。</li>
          </ul>
          <p class="legend">
            服务没就绪时不能检测和写入；一直停在「启动中」就点「重启服务」。
          </p>
        </div>
      </section>

      <!-- 第 2 步：检测并挑选模型 -->
      <section v-else class="pane table-pane" aria-label="检测并挑选模型">
        <div class="pane-head with-stats">
          <div>
            <h3>检测并挑选模型</h3>
            <p>把 <span class="desc-tag">OpenCode</span> 的免费模型接进 <span class="desc-tag">{{ targetName() }}</span>。<br>{{ tableHint }}</p>
          </div>
          <!-- 三个数字挤成一条：原来是大号指标单起一行，把表格往下压了一整行。 -->
          <div class="stat-strip" role="group" aria-label="模型统计">
            <div class="stat"><span class="stat-v">{{ metricModels }}</span><span class="stat-k">模型</span></div>
            <div class="stat"><span class="stat-v" :class="metricAvailable ? 'ok' : 'na'">{{ metricAvailable }}</span><span class="stat-k">可用</span></div>
          </div>
        </div>

        <div v-if="showFailureDiag" class="diag">
          <b>{{ allModels.length }} 个模型全部不可用</b>
          <p>向每个模型发了测试请求，相同原因已合并：</p>
          <ul class="diag-list">
            <li v-for="group in failureGroups" :key="group.reason">{{ group.count }} 个 · <code>{{ group.reason }}</code></li>
          </ul>
          <p class="diag-foot">
            「Free usage exceeded / quota」是免费额度用完了，不是配置问题，过段时间再检测即可。
          </p>
        </div>

        <!-- 未安装 OpenCode 运行时的引导：安装是首次检测时自动完成的，这里只负责说清楚。 -->
        <p v-if="active === 'probe' && !runtimeInstalled" class="runtime-note">
          尚未安装 OpenCode 运行时，首次检测时会自动下载（可能需要几分钟）。
        </p>
        <TableToolbar :checked="allChecked" :indeterminate="allIndeterminate"
          :check-all-disabled="opBusy || !visibleEnabled.length"
          :usable-count="availableModels.length" :usable-disabled="opBusy || !availableModels.length"
          :image-usable-count="imageUsable.length"
          :cancel-disabled="opBusy || !checkedIds.length"
          v-model:only-usable="onlyUsable"
          :selected-count="checkedIds.length"
          @check-all="onSelectAll" @select-usable="bulkSelect('available')" @select-image="bulkSelect('image')" @select-none="bulkSelect('none')">
          <template #actions>
            <NButton size="tiny" :disabled="busy" title="重新读取免费模型目录" @click="runAction('refresh')">刷新 OC 目录</NButton>
            <NButton size="tiny" type="primary" :disabled="busy" title="逐个测试模型可用性" @click="runAction('probe')">检测 OC 全部</NButton>
            <NButton size="tiny" :disabled="busy" title="只检测勾选的模型" @click="doProbeSelected">检测 OC 选中</NButton>
          </template>
        </TableToolbar>
        <div class="table-scroll" tabindex="0" role="region" aria-label="OpenCode 免费模型清单">
          <ModelTable :models="modelRows" source-prefix="OC · " :model-results="modelResults" :available-models="availableModels"
            :excluded-models="excludedModels" :probe="probe" :activity="activity" :busy="opBusy" :empty-text="emptyText"
            @select="onSelect" @probe-one="onProbeOne" @detail="onDetail" />
        </div>
        <p class="legend">勾选 = 要写入；「—」表示官方未公开该数值。选好后点右侧「写入配置」。</p>
      </section>

      <footer class="page-foot">
        <span>配置仅存本机 · 耗时为完整请求用时</span>
      </footer>
    </div>

    <!-- 右：目标信息 + 写入配置 -->
    <div class="plan-aside">
      <!-- 配置信息在最上面：选模型时想确认"现在客户端里是什么配置"，
           一眼就能看到，不用翻弹窗。 -->
      <ConfigCard route="opencode" :rows="infoRows" :inspection="inspection" />

      <TargetCard :target="st.target || 'workbuddy'" :path="targetPath()"
        :summary="summary" :inspection="inspection" :busy="busy"
        @switch="switchTarget" @recheck="recheck">
        <template #extra>
          <label class="proxy-toggle" title="让隔离模型服务走系统代理">
            <NCheckbox size="small" :checked="st.useSystemProxy === true"
              :disabled="opBusy || (st.phase !== 'ready' && st.phase !== 'error')"
              @update:checked="onProxyToggle" />
            <span>系统代理</span>
          </label>
          <p class="tc-extra-hint">{{ selectedCountText }}</p>
        </template>
      </TargetCard>

      <!-- 写入只在"检测并挑选模型"这一步出现：第 1 步还没模型可写，
           摆一个全是禁用原因的按钮只是噪音。 -->
      <!-- 切到 Trae 时引导卡不受步骤限制：guide 是 Trae 接入的唯一出口，第 1 步也要能看到 -->
      <WriteCard v-if="active === 'probe' || state.target === 'trae'" :target-name="targetName()" :write-label="writeLabel" :count="checkedIds.length"
        :write-disabled="busy || !canWrite" :write-reason="writeReason"
        :remove-disabled="busy || !canRemove" :remove-reason="removeReason" :preview="previewNames"
        :guide="state.target === 'trae' ? { address: (state.endpoint || '') + '/chat/completions', keyAction: 'copy-bridge-key', models: checkedIds } : null"
        :meta="Object.fromEntries((state.models || []).map((m: any) => [m.id, { context: m.context ?? null, images: m.images === true, levels: m.levels || [] }]))"
        @write="writeConfirm = true" @remove="removeConfirm = true" />
    </div>

    <ConfirmModal :show="writeConfirm" title="确认写入配置" ok-text="确认写入" @close="writeConfirm = false" @ok="doWrite">
      <section class="confirm-sec">
        <h4>写入内容</h4>
        <dl class="confirm-grid">
          <dt>写入目标</dt><dd>{{ targetName() }}</dd>
          <dt>目标文件</dt><dd class="mono">{{ targetPath() }}</dd>
          <dt>将写入模型</dt><dd>{{ checkedIds.length }} 个（已勾选）</dd>
          <dt>写入方式</dt><dd>只替换墨桥写入的条目</dd>
        </dl>
        <p class="confirm-note">{{ checkedIds.length
          ? '确认后把 ' + checkedIds.length + ' 个模型写入 ' + targetName() + '。'
          : '没有勾选任何模型，写入将清空墨桥在 ' + targetName() + ' 的条目。' }}</p>
      </section>
    </ConfirmModal>

    <ConfirmModal :show="removeConfirm" title="确认移除配置" ok-text="确认移除" danger @close="removeConfirm = false" @ok="doRemove">
      <section class="confirm-sec">
        <h4>移除内容</h4>
        <dl class="confirm-grid">
          <dt>写入目标</dt><dd>{{ targetName() }}</dd>
          <dt>目标文件</dt><dd class="mono">{{ targetPath() }}</dd>
          <dt>将移除条目</dt><dd>{{ owned }} 个 · 只移除墨桥写入的条目，你的配置不受影响</dd>
          <dt>本机数据</dt><dd>Key 与勾选记录保留，随时可重新写入</dd>
        </dl>
        <p class="confirm-note">移除后这些模型在 {{ targetName() }} 里不可用，重新写入即可恢复。</p>
      </section>
    </ConfirmModal>

    <EnvModal :show="envShow" :state="st" @close="envShow = false" />
    <DetailModal :show="!!detailModel" :model="detailModel" :model-results="modelResults"
      :available-models="availableModels" :probe="probe" :activity="activity" @close="detailModel = null" />
  </div>
</template>

<script setup lang="ts">
// OpenCode 接入视图：免费模型目录读取、真实探测、勾选写入。
// 页面结构是「左步骤栏 + 中间当前步骤 + 右列（目标信息 / 写入配置）」：
// 已完成的步骤只留在左侧当导航，中间永远只回答"现在这一步要做什么"。
//
// 为什么只有两步：原来「检测模型」和「写入配置」是分开的第三步，可那一步
// 除了一句话和一个按钮什么都没有，用户每次都得再点一下才知道要干什么。
// 写配置这件事本身只依赖"选好了哪些模型"，它跟右边那张目标卡是同一件事，
// 所以并进右列，步骤只留"连上"和"检测并挑选"。
import { ref, computed, watch } from 'vue'
import { NButton, NCheckbox } from 'naive-ui'
import {
  useService, note, run, callAction, pushBusy, operationBusy, controlsBusy, serviceUsable, inspectTargets,
} from '../composables/useService'
import StepRail from '../components/StepRail.vue'
import type { RailStep } from '../utils/steps'
import { railCollapsed, toggleRail } from '../composables/useRail'
import TargetCard from '../components/TargetCard.vue'
import ConfigCard, { type InfoRow } from '../components/ConfigCard.vue'
import WriteCard from '../components/WriteCard.vue'
import StatusPanel from '../components/StatusPanel.vue'
import ModelTable from '../components/ModelTable.vue'
import TableToolbar from '../components/TableToolbar.vue'
import EnvModal from '../components/EnvModal.vue'
import DetailModal from '../components/DetailModal.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { targetLabel, targetPathOf, writeLabelOf, inspectionOf, sourceSliceOf } from '../utils/target'
import { clientName } from '../utils/naming'
import { notifyFailure } from '../utils/errors'

type ModelRow = { id: string } & Record<string, any>

const { state } = useService()

// 模板里的快捷别名：state 是强类型 ServiceState，页面里按宽松字典读字段。
const st = computed(() => state.value as unknown as Record<string, any>)

// ── 基础派生 ───────────────────────────────────────────────────────────
function formatContext(v?: number): string {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n >= 1024 ? Math.round(n / 1024) + 'K' : String(n)
}
function targetName(v?: string): string { return targetLabel(v === undefined ? state.value.target : v) }
function targetPath(): string { return targetPathOf(state.value) }

function probing(id: string): boolean {
  const p = (state.value.probe || {}) as { running?: boolean, active?: string[], current?: string, pending?: string[] }
  if (!p.running) return false
  return (p.active || []).includes(id) || p.current === id || (p.pending || []).includes(id)
}
function requesting(id: string): boolean {
  return (state.value.activity || []).some(a => (a as { model?: string }).model === id)
}
// 排序权重：可用 0 < 检测/请求中 1 < 失败 2，再按名称稳定排序。
function rank(model: { id: string }): number {
  const id = model.id
  if (probing(id)) return 1
  if ((state.value.availableModels || []).includes(id)) return 0
  if (requesting(id)) return 1
  return (state.value.modelResults as Record<string, { ok?: boolean }> | undefined)?.[id]?.ok === false ? 2 : 1
}

// ── 「只看可用」：localStorage 持久化，切页签不丢 ──────────────────────────
const ONLY_KEY = 'mobridge-oc-only-usable'
function loadOnlyUsable(): boolean {
  try { const saved = localStorage.getItem(ONLY_KEY); return saved === null ? true : saved !== '0' } catch { return true }
}
const onlyUsable = ref(loadOnlyUsable())
// 「只看可用」的开关现在由共用工具栏 v-model 直改 ref；持久化交给 watch。
watch(onlyUsable, v => { try { localStorage.setItem(ONLY_KEY, v ? '1' : '0') } catch { /* 隐私模式忽略 */ } })

const allModels = computed(() => (state.value.models || []) as unknown as Array<{ id: string, name?: string, context?: number, images?: boolean }>)
// 识图能力来自 OpenCode 目录（capabilities.input.image），与表格能力列的「识图」标签同一来源；
// chatOnly 是探测时的"仅对话"降级标志，跟识图无关——之前误用它当过滤条件，
// 导致「只勾选识图」永远等于「只勾选可用」（chatOnly 绝大多数为 false），勾上一堆纯文本模型。
const imageCapable = computed(() => new Set(allModels.value.filter(m => m.images === true).map(m => m.id)))
const imageUsable = computed(() => availableModels.value.filter(id => imageCapable.value.has(id)))
const visibleInfo = computed(() => {
  const models = [...allModels.value]
    .sort((a, b) => rank(a) - rank(b) || String(a.name || '').localeCompare(String(b.name || '')))
  const available = state.value.availableModels || []
  const active = onlyUsable.value && available.length > 0
  return { models: active ? models.filter(m => available.includes(m.id)) : models, active, total: models.length }
})
const availableModels = computed(() => state.value.availableModels || [])
const excludedModels = computed(() => state.value.excludedModels || [])
const checkedIds = computed(() => availableModels.value.filter(id => !excludedModels.value.includes(id)))

// 表格数据（ModelTable / DetailModal 的 props 形状）
const modelRows = computed(() => visibleInfo.value.models as unknown as ModelRow[])
const modelResults = computed(() => (state.value.modelResults || {}) as Record<string, Record<string, any>>)
const probe = computed(() => (state.value.probe || {}) as Record<string, any>)
const activity = computed(() => (state.value.activity || []) as Array<Record<string, any>>)

// ── 写入目标体检 / 按钮门控 ───────────────────────────────────────────────
const inspection = computed(() => inspectionOf(state.value))
// OpenCode 运行时是否已安装：boot 只做本地探测（懒加载），没装也能就绪——
// 但要在页面上说清楚"没装 + 检测时会自动下载"，否则用户不知道差这一步（对齐 AtomCode 的安装引导）。
const runtimeInstalled = computed(() => !!st.value.opencodeVersion)
// 同一个目标里三条接入线共写一份配置，条目数要按线取，不能拿合计值当自己的账。
const slice = computed(() => sourceSliceOf(inspection.value, 'opencode'))
const owned = computed(() => slice.value.count)

// 「接入信息」卡的行：这条线自身的版本/目录/端口/代理，而不是'写到哪、写了几次'。
const infoRows = computed<InfoRow[]>(() => {
  const cur = state.value
  const version = String(st.value.opencodeVersion || '')
  const total = (cur.models || []).length
  const usable = (cur.availableModels || []).length
  return [
    { label: 'OpenCode', value: version || '未检测到', kind: version ? 'ok' : 'na', title: version ? '本机 opencode 版本' : '未在 PATH 或常见安装位置找到 opencode' },
    { label: '模型目录', value: total ? total + ' 个 · 可用 ' + usable : '尚未读取', kind: total ? undefined : 'na' },
    { label: '本机转发口', value: cur.endpoint || '未启动', mono: true, kind: cur.endpoint ? undefined : 'na' },
    { label: '系统代理', value: cur.useSystemProxy ? '开启' : '关闭' },
  ]
})
const canWrite = computed(() => checkedIds.value.length > 0 && inspection.value?.available !== false && !controlsBusy())
const canRemove = computed(() => owned.value > 0 && !controlsBusy())
const writeReason = computed(() => {
  if (controlsBusy()) return '有操作正在进行，请稍候（进度见窗口底部）。'
  if (inspection.value?.available === false) return '尚未定位写入目标的配置文件；' + (inspection.value?.note || '请先启动一次对应客户端。')
  return '还没有可用模型可写：先在第 2 步检测出可用模型并勾选。'
})
const removeReason = computed(() => (controlsBusy() ? '有操作正在进行，请稍候（进度见窗口底部）。' : '本页还没有在这个目标里写入过条目，无需移除。'))
const summary = computed(() => checkedIds.value.length
  ? checkedIds.value.length + ' 个可用模型'
  : (availableModels.value.length ? '可用模型均未勾选' : '暂无可用模型'))
// 写入后客户端里实际显示的名字：让用户在按下去之前就看见自己会得到什么。
const previewNames = computed(() => checkedIds.value.map(id => {
  const model = allModels.value.find(item => item.id === id)
  return clientName('OC · ', model?.name || id.replace(/^opencode\//, ''))
}))
const selectedCountText = computed(() => '已选 ' + checkedIds.value.length + ' 个可用模型 → ' + targetName())

// ── 步骤栏：两步。reading（重读目录）算"已连接"，否则点一次「刷新目录」  ─────
// 就会被瞬间打回第 1 步——服务其实一直是好的。
const connectDone = computed(() => serviceUsable())
const currentStep = computed<string>(() => (connectDone.value ? 'probe' : 'connect'))
const rail = computed<RailStep[]>(() => [
  {
    key: 'connect',
    label: '连接服务',
    hint: connectDone.value
      ? (state.value.phase === 'reading' ? '正在重读模型目录' : '隔离模型服务已就绪')
      : (state.value.phase === 'error' ? '服务出错' : state.value.phase === 'stopped' ? '服务已停止' : '启动中'),
    state: state.value.phase === 'error' ? 'error' : connectDone.value ? 'done' : 'current',
  },
  {
    key: 'probe',
    label: '检测并挑选模型',
    hint: state.value.target === 'trae'
      ? '引导式接入：按右侧参数在 Trae 里添加'
      : (availableModels.value.length
        ? availableModels.value.length + ' / ' + allModels.value.length + ' 个可用'
        : (allModels.value.length ? allModels.value.length + ' 个模型待检测' : '向每个模型发一次极小请求')),
    state: availableModels.value.length ? 'done' : connectDone.value ? 'current' : 'todo',
  },
])
const active = ref<string>(currentStep.value)
// 状态推进时自动跟到新步骤；但用户手动回看旧步骤时不要把他拽回去。
watch(currentStep, (next, prev) => { if (active.value === prev) active.value = next })

// ── 指标 / 提示文案 ─────────────────────────────────────────────────────
const busy = computed(() => controlsBusy())
const opBusy = computed(() => operationBusy())
const metricModels = computed(() => allModels.value.length)
const metricAvailable = computed(() => availableModels.value.length)
const caption = computed(() => '把 OpenCode 的免费模型接进 ' + targetName())
const writeLabel = computed(() => writeLabelOf(state.value))
const tableHint = computed(() => (state.value.phase === 'reading'
  ? '正在重读模型目录，读完这一栏会自动更新。'
  : state.value.phase === 'ready'
    ? '勾选要写入的模型；点「详情」看完整信息，状态列的圆形 info 图标可看失败原因。'
    : '等待服务就绪后，勾选要写入的模型。'))

const visibleEnabled = computed(() => visibleInfo.value.models.filter(m => availableModels.value.includes(m.id)))
const visibleChosen = computed(() => visibleEnabled.value.filter(m => !excludedModels.value.includes(m.id)).length)
const allChecked = computed(() => visibleEnabled.value.length > 0 && visibleChosen.value === visibleEnabled.value.length)
const allIndeterminate = computed(() => visibleChosen.value > 0 && visibleChosen.value < visibleEnabled.value.length)
const emptyText = computed(() => {
  const s = state.value
  if (s.phase === 'error') return '模型服务暂不可用，请点「重启服务」。'
  if (s.phase === 'stopped') return '模型服务已停止。'
  if (s.phase === 'ready' && (s.models || []).length) return '没有符合当前筛选的模型，关闭「只看可用」查看全部。'
  return '正在读取免费模型…'
})

// ── 全部不可用时的原因分组 ──────────────────────────────────────────────
// "为什么一个都用不了"必须当场回答。检测结论来自上游真实返回，
// 把相同原因合并成几行，用户才分得清"额度用尽"和"自己配错了"。
const failureGroups = computed(() => {
  if (!allModels.value.length || availableModels.value.length) return []
  const groups = new Map<string, number>()
  for (const model of allModels.value) {
    const result = modelResults.value[model.id]
    if (!result || result.ok !== false) continue
    const reason = String(result.error || '没有拿到可用性结论')
    groups.set(reason, (groups.get(reason) || 0) + 1)
  }
  return [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, count]) => ({ reason, count }))
})
const showFailureDiag = computed(() => state.value.phase === 'ready'
  && !probe.value.running
  && allModels.value.length > 0
  && availableModels.value.length === 0
  && failureGroups.value.length > 0)

// ── 弹窗开关 ───────────────────────────────────────────────────────────
const writeConfirm = ref(false)
const removeConfirm = ref(false)
const envShow = ref(false)
const detailModel = ref<ModelRow | null>(null)

// ── 动作执行：乐观更新 + 失败回滚 + 结果反馈 ────────────────────────────────
function feedbackFor(name: string, result: Record<string, any>, value?: unknown) {
  if (name === 'import') {
    if (result.canceled) note('已取消写入，配置未更改。', '')
    else if (result.changed === false) note(targetName(result.target) + ' 配置已是最新，共 ' + (result.count ?? 0) + ' 个模型。', 'ok')
    else note('写入完成，已将 ' + (result.count ?? 0) + ' 个可用模型写入 ' + targetName(result.target) + '。', 'ok')
  } else if (name === 'target') {
    note('已切换到 ' + targetName(result.target) + (result.migrated === false
      ? '（未改动旧目标配置；要写入请点「写入配置」，要摘除旧目标条目请用「移除配置」）。'
      : result.count ? '，写入 ' + result.count + ' 个可用模型。' : '，当前没有勾选可用模型。'), 'ok')
  } else if (name === 'refresh') note('已重新读取 OpenCode 免费模型目录。', 'ok')
  else if (name === 'probe') note('检测完成，结果已更新。', 'ok')
  else if (name === 'restart') note('已重新启动隔离模型服务。', 'ok')
  else if (name === 'system-proxy') note(value === true ? '已开启系统代理。' : '已关闭系统代理。', 'ok')
  // selection 不提示，避免每次勾选都刷屏
}

async function runAction(name: string, value?: unknown) {
  const prev = { target: state.value.target, useSystemProxy: state.value.useSystemProxy, excludedModels: state.value.excludedModels }
  // 乐观更新：先让控件即时反映，再等动作结果与下一次 state 推送校正
  if (name === 'system-proxy') state.value.useSystemProxy = value === true
  if (name === 'target') state.value.target = value as 'workbuddy' | 'dsh' | 'mofang' | 'qoder' | 'trae'
  try {
    // run() 现在会把"为什么不能做"当错误返回（而不是静默 return），
    // 于是下面的 catch 一定能把原因弹出来——点下去不再毫无反应。
    const envelope = await run(name, value)
    if (!envelope.ok) throw new Error(envelope.error || '操作失败')
    const result = (envelope.result || {}) as Record<string, any>
    if (name === 'selection' && Array.isArray(result.excludedModels)) state.value.excludedModels = result.excludedModels
    else if (name === 'target' && result.target) state.value.target = result.target
    else if (name === 'system-proxy' && typeof result.enabled === 'boolean') state.value.useSystemProxy = result.enabled
    feedbackFor(name, result, value)
  } catch (error) {
    state.value.target = prev.target
    state.value.useSystemProxy = prev.useSystemProxy
    state.value.excludedModels = prev.excludedModels
    notifyFailure(error)
  }
}

function switchTarget(v: 'workbuddy' | 'dsh' | 'mofang' | 'qoder' | 'trae') {
  // 点当前目标是无意义操作：不调服务、不弹提示（原来会弹一句「已经是当前写入目标」，纯噪音）。
  if (v === state.value.target) return
  void runAction('target', v)
}
function onProxyToggle(v: boolean) { void runAction('system-proxy', v) }
async function recheck() {
  const envelope = await inspectTargets()
  if (envelope.ok) note('已重新体检 ' + targetName() + ' 里的墨桥条目。', 'ok')
  else notifyFailure(envelope.error, { fallback: '体检失败', prefix: '体检失败：' })
}

// ── 检测选中：逐个顺序重测已勾选模型（probe 只接受 无值=全部 / string=单模型） ────
async function doProbeSelected() {
  if (operationBusy()) { note('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  if (state.value.phase !== 'ready') { note('服务未就绪，请稍候或点「重启服务」。', 'error'); return }
  const ids = checkedIds.value
  if (!ids.length) { note('请先勾选要检测的可用模型。', 'error'); return }
  pushBusy('probe')
  note('正在检测选中的 ' + ids.length + ' 个模型…', 'ok', { stream: 'oc-probe-selected' })
  let failed = 0
  try {
    for (let i = 0; i < ids.length; i++) {
      note('正在检测选中的模型 (' + (i + 1) + '/' + ids.length + ')…', 'ok', { stream: 'oc-probe-selected' })
      const envelope = await callAction('probe', ids[i], 150000, { keepNote: true })
      if (!envelope.ok) failed++
    }
    note(failed ? ('检测结束：' + failed + ' 个模型失败，其余结果已更新。') : ('检测完成，共 ' + ids.length + ' 个模型。'), failed ? 'error' : 'ok')
  } finally {
    pushBusy(null)
  }
}

// ── 全选 / 只勾选可用 / 只勾选识图 / 全部取消：selection 动作是单模型 {model, selected}，按需逐条 reconcile ──
async function bulkSelect(mode: 'all' | 'available' | 'image' | 'none') {
  if (operationBusy()) { note('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  const available = availableModels.value
  const checkedNow = new Set(checkedIds.value)
  let desired: Set<string>
  if (mode === 'available') {
    desired = new Set(available)                       // 只勾选可用 = 全部可用都勾上
  } else if (mode === 'image') {
    // 只勾选识图：可用且目录声明支持图片输入（capabilities.input.image）——
    // 与表格能力列的「识图」标签同一口径；chatOnly 是探测降级标志，与识图无关。
    desired = new Set(available.filter(id => imageCapable.value.has(id)))
  } else if (mode === 'none') {
    desired = new Set()                                // 全部取消 = 清空所有勾选
  } else {
    const visible = visibleInfo.value.models.filter(m => available.includes(m.id)).map(m => m.id)
    const everythingChecked = visible.length > 0 && visible.every(id => checkedNow.has(id))
    desired = new Set(checkedNow)
    if (everythingChecked) visible.forEach(id => desired.delete(id))
    else visible.forEach(id => desired.add(id))
  }
  const toCheck = [...desired].filter(id => available.includes(id) && !checkedNow.has(id))
  const toUncheck = [...checkedNow].filter(id => !desired.has(id))
  if (!toCheck.length && !toUncheck.length) { note('勾选无需变更。', ''); return }
  pushBusy('selection')
  note('正在更新勾选…', 'ok', { stream: 'oc-bulk' })
  try {
    const ops = [...toUncheck.map(id => [id, false] as const), ...toCheck.map(id => [id, true] as const)]
    let done = 0
    for (const [id, selected] of ops) {
      const envelope = await callAction('selection', { model: id, selected }, 20000, { keepNote: true })
      if (!envelope.ok) throw new Error(envelope.error || '勾选更新失败')
      const r = (envelope.result || {}) as { excludedModels?: string[] }
      if (Array.isArray(r.excludedModels)) state.value.excludedModels = r.excludedModels
      done++
      note('正在更新勾选 (' + done + '/' + ops.length + ')…', 'ok', { stream: 'oc-bulk' })
    }
    note('勾选已更新：已选 ' + checkedIds.value.length + ' 个可用模型。', 'ok')
  } catch (e) {
    notifyFailure(e, { prefix: '勾选更新失败：' })
  } finally {
    pushBusy(null)
  }
}
function onSelectAll() { void bulkSelect('all') }

// ── 写入 / 移除（破坏性操作先过确认弹窗） ─────────────────────────────────
function doWrite() {
  writeConfirm.value = false
  void runAction('import')
}
async function doRemove() {
  removeConfirm.value = false
  if (operationBusy()) { note('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('remove')
  try {
    const envelope = await run('remove')
    if (!envelope.ok) throw new Error(envelope.error || '移除失败')
    const r = (envelope.result || {}) as { changed?: boolean }
    note(r.changed === false
      ? targetName() + ' 中没有本插件写入的条目，配置未改动。'
      : '已移除本插件写入的条目，配置已更新。', 'ok')
    await inspectTargets()
  } catch (e) {
    notifyFailure(e, { prefix: '移除失败：' })
  } finally {
    pushBusy(null)
  }
}

// ── 表格事件 ───────────────────────────────────────────────────────────
function onSelect(id: string, checked: boolean) { void runAction('selection', { model: id, selected: checked }) }
function onProbeOne(id: string) { void runAction('probe', id) }
function onDetail(m: ModelRow) { detailModel.value = m }
</script>

<style scoped>
.proxy-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); cursor: pointer; }
.tc-extra-hint { margin: 0; font-size: 10.5px; color: var(--disabled-text); }
</style>

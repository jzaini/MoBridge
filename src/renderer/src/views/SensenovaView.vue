<script setup lang="ts">
// 日日新接入：Key 管理与真实可用性检测 + 勾选写入。
// 与 OpenCode 那页的关键区别是这条链路「没有本机转发口」——写进客户端的就是上游地址，
// 用的是用户自己的 Key。所以这一页不涉及信封协议，只关心 Key 是否有效、哪些模型真的能用。
//
// 两步：填 Key 并验证 / 检测并挑选模型。
// 验证被放进第 1 步且保存后自动跑：Key 存下去的那一刻就该知道它对不对，
// 让用户再点一次「验证」、甚至跑到第 2 步才发现鉴权失败，是上一版最别扭的地方。
import { ref, computed, onMounted, watch } from 'vue'
import { NButton, NInput, NModal } from 'naive-ui'
import {
  useService, note as baseNote, run, callAction, pushBusy, operationBusy, controlsBusy, inspectTargets,
} from '../composables/useService'
import StepRail from '../components/StepRail.vue'
import type { RailStep } from '../utils/steps'
import { railCollapsed, toggleRail } from '../composables/useRail'
import TargetCard from '../components/TargetCard.vue'
import ConfigCard, { type InfoRow } from '../components/ConfigCard.vue'
import WriteCard from '../components/WriteCard.vue'
import ConfirmModal from '../components/ConfirmModal.vue'
import { targetLabel, targetPathOf, writeLabelOf, inspectionOf, sourceSliceOf } from '../utils/target'
import { clientName } from '../utils/naming'
import { notifyFailure } from '../utils/errors'

type SnModel = { id: string, upstream: string, name: string, kind: string, context: number | null, images: boolean, caps: string[], note: string, chatProbe?: boolean }
type SnResult = { model: string, ok: boolean, latencyMs: number | null, status: number | null, error: string | null, code: string | null, time: string }

// 本页产生的通知统一标日日新来源：通知中心里跟 AtomCode 的消息一眼分开
// （之前两边通知挤在同一列，"鉴权通过"容易被误读成 AtomCode 登录成功）。
function snNote(text: string, kind: '' | 'ok' | 'error' = '', opts: { stream?: string, detail?: string } = {}) {
  baseNote(text, kind, { ...opts, source: '日日新' })
}
function snFailure(raw: unknown, opts: { fallback?: string, prefix?: string } = {}) {
  notifyFailure(raw, { ...opts, source: '日日新' })
}

const { state } = useService()
const sn = computed(() => (state.value.sensenova || {}) as Record<string, any>)

const models = computed<SnModel[]>(() => (sn.value.models || []) as SnModel[])
const probeResults = computed<Record<string, SnResult>>(() => (sn.value.probeResults || {}) as Record<string, SnResult>)
const selection = computed<string[]>(() => (sn.value.selection || []) as string[])
const validation = computed(() => (sn.value.validation || null) as (SnResult & { preferred?: string }) | null)
const keyPresent = computed(() => sn.value.keyPresent === true)
const validated = computed(() => sn.value.validated === true)

// 图像生成模型走 /images/generations，不纳入文本可用性判定。
const chatModels = computed(() => models.value.filter(model => model.chatProbe !== false))
const availableCount = computed(() => Object.values(probeResults.value).filter(item => item?.ok === true).length)

// ── 写入目标：与 OpenCode 页共用同一个全局目标 ──────────────────────────
const busy = computed(() => controlsBusy())
const opBusy = computed(() => operationBusy())
const targetName = computed(() => targetLabel(state.value.target))
const targetPath = computed(() => targetPathOf(state.value))
const writeLabel = computed(() => writeLabelOf(state.value))

const inspection = computed(() => inspectionOf(state.value))
// 同一个目标里三条接入线共写一份配置，条目数要按线取，不能拿合计值当自己的账。
const slice = computed(() => sourceSliceOf(inspection.value, 'sensenova'))
const owned = computed(() => slice.value.count)

// 「接入信息」卡：用的哪把 Key（打码）、走哪个接口（是不是被改过）、鉴权过没过。
const infoRows = computed<InfoRow[]>(() => {
  const cur = sn.value as Record<string, any>
  const keyMask = String(cur.keyMask || '')
  return [
    { label: 'API Key', value: keyPresent.value ? (keyMask || '已保存') : '未配置', mono: true, kind: keyPresent.value ? 'ok' : 'na', title: keyPresent.value ? '只显示首尾，完整 Key 只留在本机数据目录' : undefined },
    { label: '接口地址', value: String(cur.apiBase || '—'), mono: true, title: cur.apiBaseCustom ? '已改成自定义地址' : '使用官方默认地址' },
    { label: '鉴权', value: validated.value ? '已通过' : '未验证', kind: validated.value ? 'ok' : 'na' },
    { label: '模型清单', value: models.value.length ? models.value.length + ' 个 · 当前可用 ' + availableCount.value : '尚未读取', kind: models.value.length ? undefined : 'na' },
  ]
})
const canWrite = computed(() => keyPresent.value && selection.value.length > 0 && inspection.value?.available !== false && !controlsBusy())
const canRemove = computed(() => owned.value > 0 && !controlsBusy())
const writeReason = computed(() => {
  if (controlsBusy()) return '有操作正在进行，请稍候（进度见窗口底部）。'
  if (!keyPresent.value) return '还没有保存 API Key，先在第 1 步填一个。'
  if (inspection.value?.available === false) return '尚未定位写入目标的配置文件；' + (inspection.value?.note || '请先启动一次对应客户端。')
  return '还没有勾选任何模型：先在第 2 步勾选可用模型。'
})
const removeReason = computed(() => (controlsBusy() ? '有操作正在进行，请稍候（进度见窗口底部）。' : '本页还没有在这个目标里写入过条目，无需移除。'))
// 没存 Key 时勾选记录是上一轮留下的残留，别在卡片上显示成"待写入"。
const summary = computed(() => (!keyPresent.value ? '' : selection.value.length ? selection.value.length + ' 个已勾选模型' : '暂无勾选'))
// 写入后客户端里实际显示的名字（SN · 模型名）。
const previewNames = computed(() => selection.value.map(upstream => {
  const model = models.value.find(item => item.upstream === upstream)
  return clientName('SN · ', model?.id || upstream)
}))

// ── 步骤栏 ─────────────────────────────────────────────────────────────
// 没验证通过之前一直停在第 1 步：Key、验证按钮、失败原因都在这屏，
// 用户不用来回跳；自动验证通过后 currentStep 变成第 2 步，页面自己跟过去。
const currentStep = computed<string>(() => (keyPresent.value && validated.value ? 'select' : 'key'))
const rail = computed<RailStep[]>(() => [
  {
    key: 'key',
    label: '填写并验证 Key',
    hint: keyPresent.value
      ? (validated.value ? '鉴权通过' : (validation.value?.ok === false ? '鉴权未通过' : '已保存，等待验证'))
      : '未配置',
    state: validated.value ? 'done' : 'current',
  },
  {
    key: 'select',
    label: '检测并挑选模型',
    hint: availableCount.value ? availableCount.value + ' / ' + chatModels.value.length + ' 个可用' : '逐个发真实请求量可用性',
    state: availableCount.value ? 'done' : (keyPresent.value && validated.value) ? 'current' : 'todo',
  },
])
const active = ref<string>(currentStep.value)
watch(currentStep, (next, prev) => { if (active.value === prev) active.value = next })

async function switchTarget(value: 'workbuddy' | 'dsh' | 'mofang' | 'qoder' | 'trae') {
  if (value === state.value.target) return
  pushBusy('target')
  try {
    const envelope = await run('target', value)
    if (!envelope.ok) throw new Error(envelope.error || '切换失败')
    snNote(`已切换到 ${targetLabel(value)}。`, 'ok')
  } catch (error) {
    snFailure(error)
  } finally { pushBusy(null) }
}
async function recheck() {
  const envelope = await inspectTargets()
  if (envelope.ok) snNote(`已重新体检 ${targetName.value} 里的墨桥条目。`, 'ok')
  else snFailure(envelope.error, { fallback: '体检失败', prefix: '体检失败：' })
}

// ── 勾选 ───────────────────────────────────────────────────────────────
const checked = computed(() => new Set(selection.value))
function isChecked(model: SnModel) { return checked.value.has(model.upstream) }
const checkable = computed(() => chatModels.value.map(model => model.upstream).filter(id => probeResults.value[id]?.ok === true))

async function toggle(model: SnModel, next: boolean) {
  if (opBusy.value) return
  const ids = new Set(selection.value)
  if (next) ids.add(model.upstream); else ids.delete(model.upstream)
  const envelope = await callAction('sn-selection', Array.from(ids), 20000, { keepNote: true })
  if (!envelope.ok) snFailure(envelope.error, { fallback: '勾选更新失败' })
}
// 只看可用开关：过滤表格行（勾选记录不受影响，关掉开关全部回来）。
const showUsable = ref(false)
const tableModels = computed(() => (showUsable.value ? chatModels.value.filter(model => probeResults.value[model.upstream]?.ok === true) : chatModels.value))
// 「只勾选识图」的候选：可用且 images=true（对话可发图）的模型。
const snImageUsable = computed(() => checkable.value.filter(id => chatModels.value.find(m => m.upstream === id)?.images === true))
async function bulk(mode: 'available' | 'image' | 'none') {
  if (opBusy.value) { snNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  const ids = mode === 'available' ? checkable.value : mode === 'image' ? snImageUsable.value : []
  pushBusy('sn-selection')
  try {
    const envelope = await callAction('sn-selection', ids, 20000)
    if (!envelope.ok) throw new Error(envelope.error || '勾选更新失败')
    snNote(mode === 'available' ? `已勾选 ${ids.length} 个可用模型。` : mode === 'image' ? `已勾选 ${ids.length} 个支持识图的可用模型。` : '已取消全部勾选。', 'ok')
  } catch (error) {
    snFailure(error)
  } finally { pushBusy(null) }
}

// 全选 checkbox 的口径与另两页一致：当前可见的模型。勾=并入 selection，取消=从 selection 移除；
// 只动可见的，未显示的勾选记录不动。
const snCheckableVisible = computed(() => tableModels.value.map(m => m.upstream))
const snCheckedVisible = computed(() => snCheckableVisible.value.filter(id => selection.value.includes(id)).length)
const snAllChecked = computed(() => snCheckableVisible.value.length > 0 && snCheckedVisible.value === snCheckableVisible.value.length)
const snAllIndeterminate = computed(() => snCheckedVisible.value > 0 && snCheckedVisible.value < snCheckableVisible.value.length)
async function onSnCheckAll(next: boolean) {
  if (opBusy.value) { snNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  const ids = new Set(selection.value)
  if (next) snCheckableVisible.value.forEach(id => ids.add(id))
  else snCheckableVisible.value.forEach(id => ids.delete(id))
  const envelope = await callAction('sn-selection', Array.from(ids), 20000, { keepNote: true })
  if (!envelope.ok) snFailure(envelope.error, { fallback: '勾选更新失败' })
}

// 单模型重测：与「检测选中」同一探测链路，只发这一条的请求（省额度）。
const retesting = ref<string | null>('')
async function retest(model: SnModel) {
  if (opBusy.value) { snNote('有操作正在进行，请稍候。', 'error'); return }
  retesting.value = model.upstream
  pushBusy('sn-probe')
  try {
    await callAction('sn-probe', [model.upstream], 60000)
    const r = probeResults.value[model.upstream]
    snNote(r?.ok
      ? `${model.id} 重测通过（${r.latencyMs != null ? (r.latencyMs < 1000 ? r.latencyMs + ' ms' : (r.latencyMs / 1000).toFixed(1) + ' 秒') : '耗时未知'}）。`
      : `${model.id} 重测失败：${r?.error || '原因未知'}`, r?.ok ? 'ok' : 'error')
  } catch (error) { snFailure(error) } finally { retesting.value = null; pushBusy(null) }
}

// ── 统一表格适配：把 SnModel 映射成 ModelTable 的通用行模型 ──────────────
import ModelTable from '../components/ModelTable.vue'
import TableToolbar from '../components/TableToolbar.vue'
const snRows = computed(() => tableModels.value.map(m => ({
  id: m.upstream,
  name: m.id.replace(/^SN · /, ''),
  contextText: contextText(m.context),
  imagesText: imgCell(m).label,
  caps: m.caps,
})))
const snStatusMap = computed(() => {
  const map: Record<string, { label: string, kind: 'ok' | 'error' | 'checking' | 'na', reason?: string | null }> = {}
  for (const m of tableModels.value) {
    const r = probeResults.value[m.upstream]
    if (retesting.value === m.upstream) { map[m.upstream] = { label: '检测中', kind: 'checking' }; continue }
    if (m.chatProbe === false) { map[m.upstream] = { label: '不适用', kind: 'na' }; continue }
    if (r?.ok === true) map[m.upstream] = { label: '可用', kind: 'ok' }
    else if (r?.ok === false) map[m.upstream] = { label: '不可用', kind: 'error', reason: r.error || '请求失败' }
    else map[m.upstream] = { label: '未检测', kind: 'na' }
  }
  return map
})
const snLatency = computed(() => {
  const map: Record<string, string> = {}
  for (const m of tableModels.value) {
    const ms = probeResults.value[m.upstream]?.latencyMs
    // 与 OpenCode 页同一套格式化（<1s 显示 ms，否则显示秒）——同一屏不能有两种单位。
    if (ms != null) map[m.upstream] = ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' 秒'
  }
  return map
})
function onSnSelect(id: string, checked: boolean) {
  const model = tableModels.value.find(x => x.upstream === id)
  if (model) void toggle(model, checked)
}
function onSnRetest(id: string) {
  const model = tableModels.value.find(x => x.upstream === id)
  if (model) void retest(model)
}
function onSnDetail(row: { id: string }) {
  const model = tableModels.value.find(x => x.upstream === row.id)
  if (model) detail.value = model
}

// ── Key 与接口地址 ──────────────────────────────────────────────────────
const keyInput = ref('')
const showKey = ref(false)
const showBase = ref(false)
const baseInput = ref('')
// 本次会话是否已经自动验证过：一次就够，反复失败时不该每切一次页签就打一轮上游。
let autoValidated = false

// 存完 Key 直接验证：这就是「有 key 之后为什么不能自动鉴权」的答案。
async function saveKey() {
  const value = keyInput.value.trim()
  if (!value) { snNote('请先填入 API Key。', 'error'); return }
  if (opBusy.value) { snNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('sn-save-key')
  try {
    const envelope = await callAction('sn-save-key', value)
    if (!envelope.ok) throw new Error(envelope.error || '保存失败')
    keyInput.value = ''
    snNote('Key 已保存到本机（0600），正在自动鉴权…', 'ok', { stream: 'sn-save-key' })
  } catch (error) {
    snFailure(error)
    return
  } finally { pushBusy(null) }
  autoValidated = true
  await validate()
}
async function clearKey() {
  const envelope = await callAction('sn-clear-key')
  if (envelope.ok) snNote('已清除本机保存的 API Key。', 'ok')
  else snFailure(envelope.error, { fallback: '清除失败', prefix: '清除失败：' })
}
async function saveBase() {
  const envelope = await callAction('sn-save-base', baseInput.value.trim())
  if (!envelope.ok) { snFailure(envelope.error, { fallback: '保存失败' }); return }
  snNote('接口地址已保存；这次改动会让已有验证结果失效。', 'ok')
}
async function resetBase() {
  const envelope = await callAction('sn-reset-base')
  if (envelope.ok) { baseInput.value = String(sn.value.apiBaseDefault || ''); snNote('已恢复官方默认接口地址。', 'ok') }
  else snFailure(envelope.error, { fallback: '恢复失败' })
}

// ── 验证 / 探测 ─────────────────────────────────────────────────────────
async function validate() {
  if (opBusy.value) { snNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  if (!keyPresent.value) { snNote('请先保存 API Key。', 'error'); return }
  pushBusy('sn-validate')
  snNote('正在向日日新发真实请求，确认 Key 与逐模型可用性…', 'ok', { stream: 'sn-validate' })
  try {
    const envelope = await run('sn-validate', undefined, 180000)
    if (!envelope.ok) throw new Error(envelope.error || '验证失败')
    const result = (envelope.result || {}) as { ok?: boolean, model?: string, latencyMs?: number, available?: number, error?: string }
    snNote(result.ok
      ? `鉴权通过（${result.model}，${result.latencyMs ?? '—'} ms）；逐模型检测完成，${result.available ?? 0} 个可用。`
      : `验证失败：${result.error || '未知原因'}`, result.ok ? 'ok' : 'error')
  } catch (error) {
    snFailure(error)
  } finally { pushBusy(null) }
}
async function probe(ids?: string[]) {
  if (opBusy.value) { snNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  if (ids && !ids.length) { snNote('没有可检测的已勾选模型。', 'error'); return }
  pushBusy('sn-probe')
  snNote(ids ? `正在重新检测 ${ids.length} 个模型…` : '正在逐个检测全部对话模型…', 'ok', { stream: 'sn-probe' })
  try {
    const envelope = await run('sn-probe', ids, 180000)
    if (!envelope.ok) throw new Error(envelope.error || '检测失败')
    snNote('检测完成，结果已更新。', 'ok')
  } catch (error) {
    snFailure(error)
  } finally { pushBusy(null) }
}
function probeSelected() {
  // 只重测「已勾选」的：数量少、省额度，符合「检测选中」的语义。
  void probe(selection.value.slice())
}

// ── 写入 / 移除 ─────────────────────────────────────────────────────────
const writeConfirm = ref(false)
const removeConfirm = ref(false)
async function doWrite() {
  writeConfirm.value = false
  if (opBusy.value) { snNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('sn-import')
  snNote(`正在把 ${selection.value.length} 个模型写入 ${targetName.value}…`, 'ok', { stream: 'sn-import' })
  try {
    const envelope = await run('sn-import', undefined, 150000)
    if (!envelope.ok) throw new Error(envelope.error || '写入失败')
    const result = (envelope.result || {}) as { changed?: boolean, count?: number }
    snNote(result.changed === false
      ? `${targetName.value} 配置已是最新，共 ${result.count ?? 0} 个日日新模型。`
      : `写入完成：${result.count ?? 0} 个模型已写入 ${targetName.value}。`, 'ok')
    await inspectTargets()
  } catch (error) {
    snFailure(error)
  } finally { pushBusy(null) }
}
async function doRemove() {
  removeConfirm.value = false
  if (opBusy.value) { snNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('sn-remove')
  try {
    const envelope = await run('sn-remove')
    if (!envelope.ok) throw new Error(envelope.error || '移除失败')
    const result = (envelope.result || {}) as { changed?: boolean }
    snNote(result.changed === false
      ? `没有找到墨桥写入 ${targetName.value} 的日日新条目，配置未改动。`
      : `已移除墨桥写入的日日新条目，${targetName.value} 里其它配置原样保留。`, 'ok')
    await inspectTargets()
  } catch (error) {
    snFailure(error)
  } finally { pushBusy(null) }
}

// ── 详情 ───────────────────────────────────────────────────────────────
const detail = ref<SnModel | null>(null)
function resultOf(model: SnModel) { return probeResults.value[model.upstream] || null }
function statusOf(model: SnModel) {
  if (model.chatProbe === false) return { label: '不适用', kind: 'na' as const }
  const result = resultOf(model)
  if (!result) return { label: '未检测', kind: 'na' as const }
  if (result.ok) return { label: '可用', kind: 'ok' as const }
  return { label: result.code === 'not_applicable' ? '不适用' : '不可用', kind: 'error' as const }
}

// 图像能力的三个取值：生图（图像生成模型）/ 识图（对话可发图）/ —（官方未标注）。
// 数据里的 images 布尔混着两种含义——kind='image' 是"能生成图片"，chat 模型上是
// "能读图片"——能力标签里都用一个「支持」的话，跟脚注里"生图模型标不适用"会对不上
// （6.8 Flash 也显示支持，却是可用状态）。展示层必须把这两种含义拆开。
function imgCell(model: SnModel) {
  if (model.kind === 'image') return { label: '生图', title: '图像生成模型：走 /images/generations，不做文本探测，状态标「不适用」' }
  if (model.images) return { label: '识图', title: '多模态对话：可以把图片发给它' }
  return { label: '—', title: '官方未标注支持图片，按纯文本接入更稳' }
}
function contextText(value: number | null) {
  if (!value || value <= 0) return '—'
  return value >= 1024 ? Math.round(value / 1024) + 'K' : String(value)
}
function openDoc(url?: string) { if (url) void window.bridge.openExternal(url) }

// 打开页面时若已存了 Key 却从没验证成功过，自动补一次鉴权。
// 否则用户每次进来都要自己找按钮点一下，而"有没有 Key"本来就是页面自己知道的。
onMounted(() => {
  baseInput.value = String(sn.value.apiBase || '')
  if (keyPresent.value && !validated.value && !autoValidated) {
    autoValidated = true
    void validate()
  }
})
</script>

<template>
  <div class="plan" :class="{ 'rail-collapsed': railCollapsed }">
    <!-- 左：步骤栏（放回左侧：上方横条占首屏黄金区） -->
    <div class="plan-rail">
      <StepRail v-model:active="active" :steps="rail" :collapsed="railCollapsed" @toggle="toggleRail">
        <template #foot>
          Key 只存本机；检测和写入都用你自己的额度。
        </template>
      </StepRail>
    </div>

    <div class="plan-main">
      <!-- 页头只在第 1 步显示：第 2 步的标题并入卡片、按钮并入表格工具行。 -->
      <header v-if="active === 'key'" class="stage-head">
        <div class="stage-title">
          <h2>填写并验证 API Key</h2>
          <p class="stage-sub">用你的 API Key 直连日日新</p>
        </div>
        <div class="stage-actions">
          <NButton size="small" type="primary" :disabled="!keyPresent || busy" title="验证 Key，并把每个对话模型真跑一遍" @click="validate">重新验证并检测</NButton>
        </div>
      </header>

      <!-- 第 1 步：Key + 验证 -->
      <section v-if="active === 'key'" class="pane" aria-label="填写并验证 API Key">
        <div class="pane-head">
          <h3>API Key</h3>
          <p>在日日新控制台创建 API Key，粘贴到这里即可。Key 只保存在本机，保存后会自动验证。</p>
        </div>
        <div class="pane-body">
          <div class="field-row">
            <NInput v-model:value="keyInput" :type="showKey ? 'text' : 'password'" size="small" clearable
              placeholder="粘贴 platform.sensenova.cn 创建的 API Key" :disabled="busy" @keyup.enter="saveKey" />
            <NButton size="small" type="primary" :disabled="busy || !keyInput.trim()" title="保存后立刻验证 Key" @click="saveKey">保存并验证</NButton>
            <NButton size="small" :disabled="busy" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</NButton>
            <NButton size="small" :disabled="busy || !keyPresent" @click="clearKey">清除</NButton>
          </div>

          <dl class="kv key-kv">
            <div><dt>当前 Key</dt><dd :class="keyPresent ? 'ok' : 'na'">{{ keyPresent ? sn.keyMask : '未配置' }}</dd></div>
            <div>
              <dt>鉴权</dt>
              <dd :class="validated ? 'ok' : (validation?.ok === false ? 'error' : 'na')">
                {{ validated ? '通过' : (validation?.ok === false ? '未通过' : '未验证') }}
              </dd>
            </div>
            <div><dt>接口地址</dt><dd class="mono">{{ sn.apiBase }}</dd></div>
          </dl>

          <!-- 验证结果就地展示：失败原因不藏到第 2 步。 -->
          <p v-if="validation && validation.ok === false" class="inline-error">鉴权失败：{{ validation.error || '未知原因' }}</p>
          <p v-else-if="validated && availableCount" class="inline-ok">
            鉴权通过，{{ availableCount }} / {{ chatModels.length }} 个模型可用，已进入下一步。
          </p>

          <div class="field-row">
            <NButton size="tiny" text class="link-btn" @click="openDoc(sn.keysUrl as string)">打开日日新控制台 ↗</NButton>
            <NButton size="tiny" text class="link-btn" @click="openDoc(sn.docsUrl as string)">官方文档 ↗</NButton>
            <NButton size="tiny" text class="link-btn" @click="showBase = !showBase">
              {{ showBase ? '收起接口地址' : '改接口地址' }}
            </NButton>
          </div>
          <div v-if="showBase" class="field-row">
            <NInput v-model:value="baseInput" size="small" placeholder="https://token.sensenova.cn/v1" :disabled="busy" />
            <NButton size="small" :disabled="busy" @click="saveBase">保存</NButton>
            <NButton size="small" :disabled="busy || !sn.apiBaseCustom" @click="resetBase">恢复默认</NButton>
            <span class="field-hint">需要走自己的代理时才改这里。</span>
          </div>

          <h4 class="sec-title">怎么拿到 Key</h4>
          <ol class="review-list guide">
            <li>点上方的「打开日日新控制台」，用你的账号登录。</li>
            <li>在控制台里新建一个 API Key，复制出来。</li>
            <li>粘贴到本页输入框，点「保存并验证」——保存后自动鉴权，通过就进第 2 步挑模型。</li>
          </ol>
        </div>
      </section>

      <!-- 第 2 步：检测结果 + 挑选 -->
      <section v-else class="pane table-pane" aria-label="检测并挑选模型">
        <div class="pane-head with-stats">
          <div>
            <h3>检测并挑选模型</h3>
            <p>用你的 API Key 直连 <span class="desc-tag">日日新</span>，写入 <span class="desc-tag">{{ targetName }}</span>。<br>「可用」= 实测通过。</p>
          </div>
          <div class="stat-strip" role="group" aria-label="模型统计">
            <!-- 只放清单事实（模型/可用）；勾选是交互状态，统一在下方工具栏右侧显示，
                 表头再放一个「已勾选」就跟工具栏的「已勾选 N 个」重复了（用户已指出的重复提示）。 -->
            <div class="stat"><span class="stat-v">{{ models.length }}</span><span class="stat-k">模型</span></div>
            <div class="stat"><span class="stat-v" :class="availableCount ? 'ok' : 'na'">{{ availableCount }}</span><span class="stat-k">可用</span></div>
          </div>
        </div>
        <TableToolbar :checked="snAllChecked" :indeterminate="snAllIndeterminate"
          :check-all-disabled="busy || !chatModels.length"
          :usable-count="checkable.length" :usable-disabled="busy || !checkable.length"
          :image-usable-count="snImageUsable.length"
          :cancel-disabled="busy || !selection.length"
          v-model:only-usable="showUsable"
          :selected-count="selection.length"
          @check-all="onSnCheckAll" @select-usable="bulk('available')" @select-image="bulk('image')" @select-none="bulk('none')">
          <template #actions>
            <NButton size="tiny" :disabled="!keyPresent || busy" title="重新验证 Key 并逐个测试模型" @click="validate">刷新 SN 目录</NButton>
            <NButton size="tiny" :disabled="!keyPresent || busy" title="逐个测试模型可用性" @click="probe()">检测 SN 全部</NButton>
            <NButton size="tiny" :disabled="!keyPresent || busy || !selection.length" title="只检测勾选的模型" @click="probeSelected">检测 SN 选中</NButton>
          </template>
        </TableToolbar>
        <div class="table-scroll" tabindex="0" role="region" aria-label="日日新模型清单">
          <ModelTable :models="snRows" source-prefix="SN · " aria-label="日日新模型清单"
            :model-results="{}" :available-models="[]" :excluded-models="[]" :probe="{}" :activity="[]"
            :busy="opBusy" :empty-text="models.length ? '没有符合当前筛选的模型' : '验证 Key 后会自动读取模型清单。'"
            :status-map="snStatusMap" :checked-ids="selection" :latency-text="snLatency"
            :checking-ids="retesting ? [retesting] : []"
            @select="onSnSelect" @probe-one="onSnRetest" @detail="onSnDetail" />
        </div>
        <p class="legend">「识图」= 可以发图片；「生图」= 图像生成，不参与检测，标「不适用」；「—」= 官方未公开。勾选 = 要写入。</p>
      </section>

      <footer class="page-foot">
        <span>Key 只存本机 · 耗时为完整请求用时</span>
      </footer>
    </div>

    <div class="plan-aside">
      <ConfigCard route="sensenova" :rows="infoRows" :inspection="inspection" />

      <TargetCard :target="state.target || 'workbuddy'" :path="targetPath"
        :summary="summary" :inspection="inspection" :busy="busy"
        @switch="switchTarget" @recheck="recheck">
        <template #extra>
          <dl class="kv aside-kv">
            <div><dt>API Key</dt><dd :class="keyPresent ? 'ok' : 'na'">{{ keyPresent ? sn.keyMask : '未配置' }}</dd></div>
            <div><dt>可用模型</dt><dd :class="availableCount ? 'ok' : 'na'">{{ availableCount }} / {{ chatModels.length }}</dd></div>
          </dl>
        </template>
      </TargetCard>

      <WriteCard v-if="active === 'select' || state.target === 'trae'" :target-name="targetName" :write-label="writeLabel" :count="selection.length"
        :write-disabled="busy || !canWrite" :write-reason="writeReason"
        :remove-disabled="busy || !canRemove" :remove-reason="removeReason" :preview="previewNames"
        :guide="state.target === 'trae' ? { address: (sn.apiBase || '') + '/chat/completions', keyAction: 'copy-sensenova-key', models: selection } : null"
        :meta="Object.fromEntries((sn.models || []).map((m: any) => [m.upstream, { context: m.context ?? null, images: m.images === true, levels: m.levels || [] }]))"
        @write="writeConfirm = true" @remove="removeConfirm = true" />
    </div>

    <ConfirmModal :show="writeConfirm" title="确认写入配置" ok-text="确认写入" @close="writeConfirm = false" @ok="doWrite">
      <section class="confirm-sec">
        <h4>写入内容</h4>
        <dl class="confirm-grid">
          <dt>写入目标</dt><dd>{{ targetName }}</dd>
          <dt>目标文件</dt><dd class="mono">{{ targetPath }}</dd>
          <dt>将写入模型</dt><dd>{{ selection.length }} 个（已勾选）</dd>
          <dt>写入方式</dt><dd>只替换墨桥写入的条目</dd>
        </dl>
        <p v-if="!selection.length" class="confirm-note">没有勾选任何模型；确认后会清空墨桥在 {{ targetName }} 的条目。</p>
      </section>
    </ConfirmModal>

    <ConfirmModal :show="removeConfirm" title="确认移除配置" ok-text="确认移除" danger
      @close="removeConfirm = false" @ok="doRemove">
      <section class="confirm-sec">
        <h4>移除内容</h4>
        <dl class="confirm-grid">
          <dt>写入目标</dt><dd>{{ targetName }}</dd>
          <dt>目标文件</dt><dd class="mono">{{ targetPath }}</dd>
          <dt>将移除条目</dt><dd>只移除墨桥写入的条目，你的配置不受影响</dd>
        </dl>
      </section>
    </ConfirmModal>

    <NModal :show="!!detail" @update:show="(v: boolean) => { if (!v) detail = null }">
      <div v-if="detail" class="sn-detail" role="dialog" aria-modal="true" aria-label="模型详情">
        <header class="sn-detail-head">
          <div>
            <h3>{{ detail.name }}</h3>
            <p class="mono">{{ detail.upstream }}</p>
          </div>
          <NButton size="tiny" quaternary circle class="sn-detail-x" aria-label="关闭" @click="detail = null">×</NButton>
        </header>
        <dl class="sn-detail-grid">
          <dt>能力</dt><dd>{{ detail.caps.join('、') || '—' }}</dd>
          <dt>上下文</dt><dd>{{ detail.context ? contextText(detail.context) + '（' + detail.context + ' tokens）' : '—' }}</dd>
          <dt>图像能力</dt><dd>{{ imgCell(detail).label }}</dd>
          <dt>写入客户端名</dt><dd class="mono">{{ detail.id }}</dd>
          <dt>检测状态</dt><dd>{{ statusOf(detail).label }}<template v-if="resultOf(detail)?.latencyMs != null"> · {{ resultOf(detail)?.latencyMs }} ms</template></dd>
          <dt>说明</dt><dd>{{ detail.note }}</dd>
          <template v-if="resultOf(detail)?.error">
            <dt>失败原因</dt><dd class="sn-detail-error">{{ resultOf(detail)?.error }}</dd>
          </template>
        </dl>
        <p class="sn-detail-foot">发给上游的模型名是 <code>{{ detail.upstream }}</code>；写入客户端后展示为 <code>{{ detail.id }}</code>。</p>
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.sn-state { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.sn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--disabled-text); }
.sn-dot.ok { background: var(--success-dot); }
.sn-dot.error { background: var(--error-dot); }
.sn-state.ok { color: var(--success-text); }
.sn-state.error { color: var(--error-text); }
.sn-state.na { color: var(--disabled-text); }
.key-kv { margin-top: 12px; max-width: 460px; }
.aside-kv { gap: 4px; }
.aside-kv > div { font-size: 11.5px; }

.sn-detail { width: min(560px, 92vw); background: var(--surface); border-radius: 12px; padding: 16px 18px;
  border: 1px solid var(--subtle-line); box-shadow: 0 18px 48px rgba(0, 0, 0, .28); }
.sn-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.sn-detail-head h3 { margin: 0; font-size: 15px; }
.sn-detail-head p { margin: 4px 0 0; font-size: 11px; color: var(--muted); }
.sn-detail-x { color: var(--muted); font-size: 15px; }
.sn-detail-grid { display: grid; grid-template-columns: 84px 1fr; gap: 8px 12px; margin: 14px 0 0; font-size: 12px; }
.sn-detail-grid dt { color: var(--muted); }
.sn-detail-grid dd { margin: 0; }
.sn-detail-error { color: var(--error-text); }
.sn-detail-foot { margin: 14px 0 0; font-size: 11px; color: var(--disabled-text); }
.sn-detail-foot code { font-family: var(--mono); }
</style>

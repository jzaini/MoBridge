<script setup lang="ts">
// AtomCode 接入：安装 → 登录 → 免费模型目录 → 勾选写入。
// 面向用户一律叫「免费模型」；CodingPlan 是 AtomGit 给这套免费额度起的套餐名，
// 只出现在「套餐/档位」这类官方信息里，不拿来当模型类别叫法。
// 与日日新最大的区别是这条链路「必须经过本机转发口」：上游要注入 X-AtomCode-* 头，
// 客户端做不到，所以写进目标的是墨桥的本机地址，上游凭据只留在服务进程里。
//
// 两步：安装登录 / 选择模型。写入跟目标绑定，放在右列「写入配置」卡里——
// 切 WorkBuddy、DSH、墨坊，按钮措辞与写入内容一起变。
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

// 本页产生的通知统一标 AtomCode 来源：通知中心里跟日日新的消息一眼分开。
function acNote(text: string, kind: '' | 'ok' | 'error' = '', opts: { stream?: string, detail?: string } = {}) {
  baseNote(text, kind, { ...opts, source: 'AtomCode' })
}
function acFailure(raw: unknown, opts: { fallback?: string, prefix?: string } = {}) {
  notifyFailure(raw, { ...opts, source: 'AtomCode' })
}

type AcModel = { id: string, upstream: string, name: string, context: number | null, images: boolean, levels: string[] }

const { state } = useService()
const ac = computed(() => (state.value.atomcode || {}) as Record<string, any>)

const models = computed<AcModel[]>(() => (ac.value.models || []) as AcModel[])
const selection = computed<string[]>(() => (ac.value.selection || []) as string[])
const installed = computed(() => ac.value.installed === true)
const loggedIn = computed(() => ac.value.loggedIn === true)
const plan = computed(() => (ac.value.plan || null) as { planName: string, tier: string, remainingDays: number | null, expiresAt: string | null, quotaExhausted: boolean } | null)
const catalogSource = computed(() => String(ac.value.catalogSource || 'none'))

const busy = computed(() => controlsBusy())
const opBusy = computed(() => operationBusy())
const targetName = computed(() => targetLabel(state.value.target))
const targetPath = computed(() => targetPathOf(state.value))
const writeLabel = computed(() => writeLabelOf(state.value))

// ── 写入目标体检 / 按钮门控 ───────────────────────────────────────────────
const inspection = computed(() => inspectionOf(state.value))
// 同一个目标里三条接入线共写一份配置，条目数要按线取，不能拿合计值当自己的账。
const slice = computed(() => sourceSliceOf(inspection.value, 'atomcode'))
const owned = computed(() => slice.value.count)

// 「接入信息」卡：装没装、登录了谁、什么套餐、走哪个口——这些原来只能靠步骤栏的短提示猜。
const infoRows = computed<InfoRow[]>(() => {
  const a = ac.value as Record<string, any>
  const account = (a.account || null) as { username?: string, email?: string, expiresAt?: string | null } | null
  const p = plan.value
  const planText = p
    ? p.planName + (p.tier ? ' · ' + p.tier : '') + (p.remainingDays != null ? ' · 剩 ' + p.remainingDays + ' 天' : '')
    : (loggedIn.value ? '未读到套餐信息' : '—')
  return [
    { label: '客户端', value: installed.value ? ('已安装 ' + String(a.version || '')).trim() : '未安装', kind: installed.value ? 'ok' : 'na', title: a.binary || undefined },
    { label: '登录账号', value: loggedIn.value ? (account?.username || account?.email || '已登录') : '未登录', kind: loggedIn.value ? 'ok' : 'na', title: account?.email || undefined },
    { label: '套餐', value: planText, kind: p?.quotaExhausted ? 'warn' : undefined, title: p?.quotaExhausted ? '本轮额度已用尽' : 'CodingPlan 是 AtomGit 的免费额度套餐；这里显示你账号当前的档位' },
    { label: '免费模型', value: models.value.length ? models.value.length + ' 个' : '尚未读取', kind: models.value.length ? undefined : 'na' },
    { label: 'AtomCode 转发口', value: a.endpoint || '未启动', mono: true, kind: a.endpoint ? undefined : 'na' },
  ]
})
const canWrite = computed(() => loggedIn.value && selection.value.length > 0 && inspection.value?.available !== false && !controlsBusy())
const canRemove = computed(() => owned.value > 0 && !controlsBusy())
const writeReason = computed(() => {
  if (controlsBusy()) return '有操作正在进行，请稍候（进度见窗口底部）。'
  if (!installed.value) return '本机还没有 AtomCode，先在第 1 步安装。'
  if (!loggedIn.value) return '尚未登录 AtomCode，登录后才能取到免费模型。'
  if (inspection.value?.available === false) return '尚未定位写入目标的配置文件；' + (inspection.value?.note || '请先启动一次对应客户端。')
  return '还没有勾选任何模型：先在第 2 步勾选要写入的模型。'
})
const removeReason = computed(() => (controlsBusy() ? '有操作正在进行，请稍候（进度见窗口底部）。' : '本页还没有在这个目标里写入过条目，无需移除。'))
// 未登录时的勾选是残留数据，不当作待写入展示。
const summary = computed(() => (!loggedIn.value ? '' : selection.value.length ? selection.value.length + ' 个已勾选模型' : '暂无勾选'))
// 写入后客户端里实际显示的名字（AC · 模型名），写下去之前先给用户看一眼。
const previewNames = computed(() => selection.value.map(upstream => {
  const model = models.value.find(item => item.upstream === upstream)
  return clientName('AC · ', model?.id || upstream)
}))

// ── 步骤栏 ─────────────────────────────────────────────────────────────
const signedIn = computed(() => installed.value && loggedIn.value)
const currentStep = computed<string>(() => (signedIn.value ? 'models' : 'install'))
const rail = computed<RailStep[]>(() => [
  {
    key: 'install',
    label: '安装与登录',
    hint: installed.value ? (loggedIn.value ? '已登录 ' + (ac.value.account?.username || '') : '已安装，未登录') : '未检测到 AtomCode',
    state: signedIn.value ? 'done' : 'current',
  },
  {
    key: 'models',
    label: '选择模型',
    hint: models.value.length
      ? models.value.length + ' 个模型 · ' + (catalogSource.value === 'live' ? '实时目录' : '离线快照')
      : '登录后读取免费模型目录',
    state: models.value.length ? 'done' : signedIn.value ? 'current' : 'todo',
  },
])
const active = ref<string>(currentStep.value)
watch(currentStep, (next, prev) => { if (active.value === prev) active.value = next })

// 切换目标：被拦住时把原因说出来（原来静默 return，用户以为按钮坏了）。
async function switchTarget(value: 'workbuddy' | 'dsh' | 'mofang' | 'qoder' | 'trae') {
  if (value === state.value.target) return
  pushBusy('target')
  try {
    const envelope = await run('target', value)
    if (!envelope.ok) throw new Error(envelope.error || '切换失败')
    acNote(`已切换到 ${targetLabel(value)}。`, 'ok')
  } catch (error) {
    acFailure(error)
  } finally { pushBusy(null) }
}
async function recheck() {
  const envelope = await inspectTargets()
  if (envelope.ok) acNote(`已重新体检 ${targetName.value} 里的墨桥条目。`, 'ok')
  else acFailure(envelope.error, { fallback: '体检失败', prefix: '体检失败：' })
}

// ── 安装 / 登录 ─────────────────────────────────────────────────────────
async function detect() {
  if (opBusy.value) { acNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-detect')
  try {
    const envelope = await run('ac-detect', undefined, 60000)
    if (!envelope.ok) throw new Error(envelope.error || '检测失败')
    acNote(installed.value ? `已检测到 AtomCode ${ac.value.version || ''}。` : '本机未安装 AtomCode。', installed.value ? 'ok' : 'error')
  } catch (error) { acFailure(error) } finally { pushBusy(null) }
}
async function install() {
  if (opBusy.value) { acNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-install')
  acNote('正在调用系统包管理器安装 AtomCode，这一步可能几分钟…', 'ok', { stream: 'ac-install' })
  try {
    const envelope = await run('ac-install', undefined, 320000)
    if (!envelope.ok) throw new Error(envelope.error || '安装失败')
    const result = (envelope.result || {}) as { ok?: boolean, output?: string }
    if (result.ok) acNote('安装命令执行完成；若仍显示未安装，请重启本页或检查包管理器输出。', 'ok')
    // 失败时不要把整段英文 CLI 输出塞进浮层：翻译成结论，原文进通知中心。
    else acFailure(result.output, { fallback: '安装未成功', prefix: '安装未成功：' })
  } catch (error) { acFailure(error) } finally { pushBusy(null) }
}
const reloginConfirm = ref(false)
async function login() {
  if (opBusy.value) { acNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  // 已有凭据时先确认：重新登录会覆盖现有授权，也避免「失败通知」和「已登录」在通知中心里打架。
  if (loggedIn.value) { reloginConfirm.value = true; return }
  await doLogin()
}
async function doLogin() {
  pushBusy('ac-login')
  acNote('已弹出「AtomCode 登录」终端窗口；请在窗口里完成登录，浏览器授权后本页会自动刷新目录。', 'ok', { stream: 'ac-login' })
  try {
    const envelope = await run('ac-login', undefined, 200000)
    if (!envelope.ok) throw new Error(envelope.error || '登录失败')
    const result = (envelope.result || {}) as { ok?: boolean, output?: string }
    if (result.ok) acNote(`登录完成，已读取到 ${models.value.length} 个免费模型。`, 'ok')
    // 弹窗链路失败通常是"等待授权超时"或终端没弹出来（兜底原文里仍有 PowerShell 手动方案）。
    else acFailure(result.output, { fallback: '登录未完成', prefix: '登录未完成：' })
  } catch (error) { acFailure(error) } finally { pushBusy(null) }
}
async function refreshCatalog() {
  if (opBusy.value) { acNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-refresh')
  try {
    const envelope = await run('ac-refresh', undefined, 120000)
    if (!envelope.ok) throw new Error(envelope.error || '刷新失败')
    const rejected = rejectedModels.value.map(model => model.id)
    const head = catalogSource.value === 'live' ? `已从 AtomCode 实时目录刷新到 ${models.value.length} 个免费模型。`
      : '实时目录不可用，当前显示 config.toml 的离线快照。'
    acNote(rejected.length ? `${head}可用性校验：${rejected.join('、')} 被上游拒绝，不可写入。` : head,
      rejected.length ? 'error' : catalogSource.value === 'live' ? 'ok' : 'error')
  } catch (error) { acFailure(error) } finally { pushBusy(null) }
}

// ── 网关 ───────────────────────────────────────────────────────────────
const showGateway = ref(false)
const gatewayInput = ref('')
async function saveGateway() {
  const envelope = await callAction('ac-save-gateway', gatewayInput.value.trim())
  if (!envelope.ok) { acFailure(envelope.error, { fallback: '保存失败' }); return }
  acNote('网关地址已保存，转发口会立刻改用它。', 'ok')
}
async function resetGateway() {
  const envelope = await callAction('ac-reset-gateway')
  if (envelope.ok) { gatewayInput.value = ''; acNote('已恢复官方默认网关。', 'ok') }
  else acFailure(envelope.error, { fallback: '恢复失败' })
}

// ── 勾选 ───────────────────────────────────────────────────────────────
const checked = computed(() => new Set(selection.value))
// 探测结果来自服务的 ac-refresh（真跑一遍可用性），拿不到时按"可用"对待。
type AcProbe = { ok: boolean, reason: 'ok' | 'rejected' | 'inconclusive', detail: string | null }
const probeMap = computed<Record<string, AcProbe>>(() => (ac.value.probe || {}) as Record<string, AcProbe>)
function probeOf(model: AcModel) { return probeMap.value[model.upstream] }
const rejectedModels = computed(() => models.value.filter(model => probeOf(model)?.reason === 'rejected'))
const rejectedDetail = computed(() => (rejectedModels.value[0] ? probeOf(rejectedModels.value[0])?.detail || '未知原因' : ''))
function isChecked(model: AcModel) { return checked.value.has(model.upstream) }
async function toggle(model: AcModel, next: boolean) {
  if (opBusy.value) return
  if (next && probeOf(model)?.reason === 'rejected') {
    acNote(`上游拒绝了 ${model.id}（${probeOf(model)?.detail || '未知原因'}），不可写入。`, 'error'); return
  }
  const ids = new Set(selection.value)
  if (next) ids.add(model.upstream); else ids.delete(model.upstream)
  const envelope = await callAction('ac-selection', Array.from(ids), 20000, { keepNote: true })
  if (!envelope.ok) acFailure(envelope.error, { fallback: '勾选更新失败' })
}
// 只看可用开关：过滤表格行（勾选记录不受影响，关掉开关全部回来）。
const showUsable = ref(false)
// 探测判定为「可用」的模型（目录说可用 ≠ 网关真路由，判定来自哨兵词探测）。
const usableModels = computed(() => models.value.filter(model => ac.value.probe?.[model.upstream]?.ok === true))
const tableModels = computed(() => (showUsable.value ? usableModels.value : models.value))
async function bulk(mode: 'available' | 'image' | 'none') {
  if (opBusy.value) { acNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  const ids = mode === 'available' ? usableModels.value.map(model => model.upstream)
    : mode === 'image' ? acImageUsable.value
    : []
  pushBusy('ac-selection')
  try {
    const envelope = await callAction('ac-selection', ids, 20000)
    if (!envelope.ok) throw new Error(envelope.error || '勾选更新失败')
    acNote(mode === 'available' ? `已勾选 ${ids.length} 个可用模型。` : mode === 'image' ? `已勾选 ${ids.length} 个支持识图的可用模型。` : '已取消全部勾选。', 'ok')
  } catch (error) { acFailure(error) } finally { pushBusy(null) }
}

// 「只勾选识图」的候选：可用且 images=true（对话可发图）的模型。
const acImageUsable = computed(() => usableModels.value.filter(model => model.images).map(model => model.upstream))

// 批量检测：与单模型重测同一条 ac-probe 链路——空数组=全部，ids=只测勾选的。
async function probeAll() {
  if (opBusy.value) { acNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-probe')
  acNote(`正在检测全部 ${models.value.length} 个模型的可用性…`, 'ok', { stream: 'ac-probe' })
  try {
    const envelope = await callAction('ac-probe', [], 180000)
    if (!envelope.ok) throw new Error(envelope.error || '检测失败')
    acNote(`检测完成：${usableModels.value.length} / ${models.value.length} 个可用。`, 'ok')
  } catch (error) { acFailure(error) } finally { pushBusy(null) }
}
async function probeSelected() {
  if (opBusy.value) { acNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  if (!selection.value.length) { acNote('请先勾选要检测的模型。', 'error'); return }
  pushBusy('ac-probe')
  acNote(`正在检测选中的 ${selection.value.length} 个模型…`, 'ok', { stream: 'ac-probe' })
  try {
    const envelope = await callAction('ac-probe', selection.value.slice(), 180000)
    if (!envelope.ok) throw new Error(envelope.error || '检测失败')
    acNote('检测完成，结果已更新。', 'ok')
  } catch (error) { acFailure(error) } finally { pushBusy(null) }
}

// 全选 checkbox 的口径与另两页一致：当前可见且未被上游拒绝的模型。
// 勾=并入 selection，取消=从 selection 移除；只动可见的，未显示的勾选记录不动。
const acCheckableVisible = computed(() => tableModels.value.filter(m => probeOf(m)?.reason !== 'rejected').map(m => m.upstream))
const acCheckedVisible = computed(() => acCheckableVisible.value.filter(id => selection.value.includes(id)).length)
const acAllChecked = computed(() => acCheckableVisible.value.length > 0 && acCheckedVisible.value === acCheckableVisible.value.length)
const acAllIndeterminate = computed(() => acCheckedVisible.value > 0 && acCheckedVisible.value < acCheckableVisible.value.length)
async function onAcCheckAll(next: boolean) {
  if (opBusy.value) { acNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  const ids = new Set(selection.value)
  if (next) acCheckableVisible.value.forEach(id => ids.add(id))
  else acCheckableVisible.value.forEach(id => ids.delete(id))
  const envelope = await callAction('ac-selection', Array.from(ids), 20000, { keepNote: true })
  if (!envelope.ok) acFailure(envelope.error, { fallback: '勾选更新失败' })
}

// 单模型重测：只重跑这一条的哨兵词探测（省额度），结论并入缓存表。
const retesting = ref<string | null>('')
async function retest(model: AcModel) {
  if (opBusy.value) { acNote('有操作正在进行，请稍候。', 'error'); return }
  retesting.value = model.upstream
  pushBusy('ac-probe')
  try {
    const envelope = await callAction('ac-probe', [model.upstream], 120000)
    if (!envelope.ok) throw new Error(envelope.error || '重测失败')
    const r = (envelope.result || {}) as { probe?: Record<string, { reason?: string, detail?: string | null }> }
    const verdict = r.probe?.[model.upstream]
    acNote(verdict?.reason === 'ok'
      ? `${model.id} 重测通过。`
      : verdict?.reason === 'rejected' ? `${model.id} 被上游拒绝：${verdict.detail || '未知原因'}`
      : `${model.id} 重测未得出结论：${verdict?.detail || '网络或接口故障'}`, verdict?.reason === 'ok' ? 'ok' : 'error')
  } catch (error) { acFailure(error) } finally { retesting.value = null; pushBusy(null) }
}

// ── 统一表格适配：把 AcModel 映射成 ModelTable 的通用行模型 ──────────────
import ModelTable from '../components/ModelTable.vue'
import TableToolbar from '../components/TableToolbar.vue'
const acRows = computed(() => tableModels.value.map(m => ({
  id: m.upstream,
  name: m.id.replace(/^AC · /, ''),
  contextText: contextText(m.context),
  images: m.images,
  levels: m.levels,
})))
const acStatusMap = computed(() => {
  const map: Record<string, { label: string, kind: 'ok' | 'error' | 'checking' | 'na', reason?: string | null }> = {}
  for (const m of tableModels.value) {
    const p = probeOf(m)
    if (retesting.value === m.upstream) map[m.upstream] = { label: '检测中', kind: 'checking' }
    else if (p?.reason === 'ok') map[m.upstream] = { label: '可用', kind: 'ok' }
    else if (p?.reason === 'rejected') map[m.upstream] = { label: '不可用', kind: 'error', reason: p?.detail || '套餐未启用或模型已下线' }
    else map[m.upstream] = { label: '未检测', kind: 'na' }
  }
  return map
})
const rejectedIds = computed(() => tableModels.value.filter(m => probeOf(m)?.reason === 'rejected').map(m => m.upstream))
function onAcSelect(id: string, checked: boolean) {
  const model = tableModels.value.find(x => x.upstream === id)
  if (model) void toggle(model, checked)
}
function onAcRetest(id: string) {
  const model = tableModels.value.find(x => x.upstream === id)
  if (model) void retest(model)
}
function onAcDetail(row: { id: string }) {
  const model = tableModels.value.find(x => x.upstream === row.id)
  if (model) detail.value = model
}

// ── 写入 / 移除 ─────────────────────────────────────────────────────────
const writeConfirm = ref(false)
const removeConfirm = ref(false)
async function doWrite() {
  writeConfirm.value = false
  if (opBusy.value) { acNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-import')
  acNote(`正在把 ${selection.value.length} 个模型写入 ${targetName.value}…`, 'ok', { stream: 'ac-import' })
  try {
    const envelope = await run('ac-import', undefined, 150000)
    if (!envelope.ok) throw new Error(envelope.error || '写入失败')
    const result = (envelope.result || {}) as { changed?: boolean, count?: number, blocked?: number }
    const blockedNote = result.blocked ? `另有 ${result.blocked} 个被上游拒绝的模型未写入。` : ''
    acNote(result.changed === false
      ? `${targetName.value} 配置已是最新，共 ${result.count ?? 0} 个 AtomCode 模型。${blockedNote}`
      : `写入完成：${result.count ?? 0} 个模型已写入 ${targetName.value}。${blockedNote}`, 'ok')
    await inspectTargets()
  } catch (error) { acFailure(error) } finally { pushBusy(null) }
}
async function doRemove() {
  removeConfirm.value = false
  if (opBusy.value) { acNote('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-remove')
  try {
    const envelope = await run('ac-remove')
    if (!envelope.ok) throw new Error(envelope.error || '移除失败')
    const result = (envelope.result || {}) as { changed?: boolean }
    acNote(result.changed === false
      ? `没有找到墨桥写入 ${targetName.value} 的 AtomCode 条目，配置未改动。`
      : `已移除墨桥写入的 AtomCode 条目，${targetName.value} 里其它配置原样保留。`, 'ok')
    await inspectTargets()
  } catch (error) { acFailure(error) } finally { pushBusy(null) }
}

const detail = ref<AcModel | null>(null)
function contextText(value: number | null) {
  if (!value || value <= 0) return '—'
  return value >= 1024 ? Math.round(value / 1024) + 'K' : String(value)
}
function openDoc(url?: string) { if (url) void window.bridge.openExternal(url) }

onMounted(() => { gatewayInput.value = String(ac.value.gateway || '') })
</script>

<template>
  <div class="plan" :class="{ 'rail-collapsed': railCollapsed }">
    <!-- 左：步骤栏（放回左侧：上方横条占首屏黄金区） -->
    <div class="plan-rail">
      <StepRail v-model:active="active" :steps="rail" :collapsed="railCollapsed" @toggle="toggleRail">
        <template #foot>
          凭据只留在本机，客户端里只有转发口地址。
        </template>
      </StepRail>
    </div>

    <div class="plan-main">
      <!-- 页头只在第 1 步显示：第 2 步的标题并入卡片、按钮并入表格工具行。 -->
      <header v-if="active === 'install'" class="stage-head">
        <div class="stage-title">
          <h2>安装与登录 AtomCode</h2>
          <p class="stage-sub">把 AtomCode 的免费模型接进 {{ targetName }}</p>
        </div>
        <div class="stage-actions">
          <NButton size="small" :disabled="busy" title="重新检测本机是否已安装 AtomCode" @click="detect">重新检测</NButton>
          <NButton size="small" type="primary" :disabled="busy || installed" @click="install">一键安装</NButton>
          <NButton size="small" :disabled="busy || !installed" :title="loggedIn ? '已有登录凭据，重新登录会覆盖现有授权' : '弹出终端窗口执行 atomcode login，在窗口里完成登录授权'" @click="login">登录 AtomCode</NButton>
        </div>
      </header>

      <!-- 第 1 步：安装与登录 -->
      <section v-if="active === 'install'" class="pane" aria-label="安装与登录">
        <div class="pane-head">
          <h3>本机客户端</h3>
          <p>先安装 AtomCode 并登录。点「登录」会弹出终端完成授权，完成后自动刷新目录；终端没弹出就在 PowerShell 里手动执行 <code>atomcode login</code>。</p>
        </div>
        <div class="pane-body">
          <div class="field-row">
            <span class="chip" :class="installed ? 'ok' : 'na'">{{ installed ? '已安装 · ' + (ac.version || '版本未知') : '未检测到 AtomCode' }}</span>
            <span class="chip" :class="loggedIn ? 'ok' : 'na'">{{ loggedIn ? '已登录 · ' + (ac.account?.username || '—') : '未登录' }}</span>
          <NButton size="tiny" text class="link-btn" @click="openDoc(ac.siteUrl as string)">AtomCode 官网 ↗</NButton>
          <NButton size="tiny" text class="link-btn" @click="openDoc(ac.docsUrl as string)">官方文档 ↗</NButton>
          </div>

          <dl class="kv gateway-kv">
            <div><dt>套餐</dt><dd :class="plan ? 'ok' : 'na'">{{ plan ? (plan.planName + (plan.remainingDays != null ? ' · 剩 ' + plan.remainingDays + ' 天' : '')) : '—' }}</dd></div>
            <div><dt>目录来源</dt><dd :class="catalogSource === 'live' ? 'ok' : 'na'">{{ catalogSource === 'live' ? 'AtomCode 实时' : catalogSource === 'offline' ? '离线快照' : '—' }}</dd></div>
            <div><dt>转发口</dt><dd class="mono" :class="ac.bridgeRunning ? 'ok' : 'na'">{{ ac.bridgeRunning ? ac.endpoint : '未启动' }}</dd></div>
            <div v-if="ac.binary"><dt>二进制</dt><dd class="mono">{{ ac.binary }}</dd></div>
          </dl>

          <p class="install-cmd">安装命令：<code>{{ ac.install?.command }}</code></p>
          <p v-if="ac.catalogError && catalogSource !== 'live'" class="inline-warn">实时目录不可用：{{ ac.catalogError }}</p>

          <h4 class="sec-title">上游网关</h4>
          <div class="field-row">
            <NButton size="tiny" text class="link-btn" @click="showGateway = !showGateway">
              {{ showGateway ? '收起' : '当前 ' + (ac.gateway || '官方默认') + '，点此修改' }}
            </NButton>
          </div>
          <div v-if="showGateway" class="field-row">
            <NInput v-model:value="gatewayInput" size="small" placeholder="https://api-ai.gitcode.com" :disabled="busy" />
            <NButton size="small" :disabled="busy" @click="saveGateway">保存</NButton>
            <NButton size="small" :disabled="busy || !ac.gatewayCustom" @click="resetGateway">恢复默认</NButton>
            <span class="field-hint">需要走自己的代理时才改这里。</span>
          </div>
        </div>
      </section>

      <!-- 第 2 步：选择模型 -->
      <section v-else class="pane table-pane" aria-label="选择模型">
        <div class="pane-head with-stats">
          <div>
            <h3>检测并挑选模型</h3>
            <p>把 <span class="desc-tag">AtomCode</span> 的免费模型接进 <span class="desc-tag">{{ targetName }}</span>。<br>「可用」= 实测通过。</p>
          </div>
          <div class="stat-strip" role="group" aria-label="模型统计">
            <div class="stat"><span class="stat-v">{{ models.length }}</span><span class="stat-k">模型</span></div>
            <div class="stat"><span class="stat-v" :class="usableModels.length ? 'ok' : 'na'">{{ usableModels.length }}</span><span class="stat-k">可用</span></div>
          </div>
        </div>
        <TableToolbar :checked="acAllChecked" :indeterminate="acAllIndeterminate"
          :check-all-disabled="busy || !acCheckableVisible.length"
          :usable-count="usableModels.length" :usable-disabled="busy || !usableModels.length"
          :image-usable-count="acImageUsable.length"
          :cancel-disabled="busy || !selection.length"
          v-model:only-usable="showUsable"
          :selected-count="selection.length"
          @check-all="onAcCheckAll" @select-usable="bulk('available')" @select-image="bulk('image')" @select-none="bulk('none')">
          <template #actions>
            <NButton size="tiny" :disabled="busy || !installed" title="重新读取免费模型" @click="refreshCatalog">刷新 AC 目录</NButton>
            <NButton size="tiny" :disabled="busy || !models.length" title="逐个测试模型可用性" @click="probeAll">检测 AC 全部</NButton>
            <NButton size="tiny" :disabled="busy || !selection.length" title="只检测勾选的模型" @click="probeSelected">检测 AC 选中</NButton>
          </template>
        </TableToolbar>
        <!-- daemon 挂了会降级网关探测：结论口径一致，但要告诉用户原因与出路。
             不自动重登——atomcode login 必须弹终端走浏览器 OAuth，静默重试只会再弹一个黑窗。 -->
        <p v-if="loggedIn && ac.probeVia === 'gateway'" class="probe-note">
          本机 daemon 未就绪，已改走网关检测。持续出现时点
          <NButton size="tiny" text type="primary" @click="login">重新登录</NButton>
          恢复。
        </p>
        <div class="table-scroll" tabindex="0" role="region" aria-label="AtomCode 模型清单">
          <ModelTable :models="acRows" source-prefix="AC · " aria-label="AtomCode 模型清单"
            :model-results="{}" :available-models="[]" :excluded-models="[]" :probe="{}" :activity="[]"
            :busy="busy" :empty-text="installed ? '登录后会自动读取模型清单。' : '先安装 AtomCode，再登录。'"
            :status-map="acStatusMap" :checked-ids="selection" :disabled-ids="rejectedIds"
            :checking-ids="retesting ? [retesting] : []"
            @select="onAcSelect" @probe-one="onAcRetest" @detail="onAcDetail" />
        </div>
        <p v-if="rejectedModels.length" class="probe-note">
          {{ rejectedModels.map(m => m.id).join('、') }} 被上游拒绝（{{ rejectedDetail }}），已禁止勾选。
        </p>
        <p class="legend">勾选 = 要写入。</p>
      </section>

      <footer class="page-foot">
        <span>凭据只留在本机服务 · {{ ac.bridgeRunning ? '转发口 ' + ac.endpoint : '转发口未启动' }}</span>
      </footer>
    </div>

    <div class="plan-aside">
      <ConfigCard route="atomcode" :rows="infoRows" :inspection="inspection" />

      <TargetCard :target="state.target || 'workbuddy'" :path="targetPath"
        :summary="summary" :inspection="inspection" :busy="busy"
        @switch="switchTarget" @recheck="recheck">
        <template #extra>
          <dl class="kv aside-kv">
            <div><dt>登录态</dt><dd :class="loggedIn ? 'ok' : 'na'">{{ loggedIn ? (ac.account?.username || '已登录') : '未登录' }}</dd></div>
            <div><dt>转发口</dt><dd class="mono" :class="ac.bridgeRunning ? 'ok' : 'na'">{{ ac.bridgeRunning ? '运行中' : '未启动' }}</dd></div>
          </dl>
        </template>
      </TargetCard>

      <WriteCard v-if="active === 'models' || state.target === 'trae'" :target-name="targetName" :write-label="writeLabel" :count="selection.length"
        :write-disabled="busy || !canWrite" :write-reason="writeReason"
        :remove-disabled="busy || !canRemove" :remove-reason="removeReason" :preview="previewNames"
        :guide="state.target === 'trae' ? { address: (ac.endpoint || '') + '/v1/chat/completions', keyAction: 'copy-atomcode-key', models: selection } : null"
        :meta="Object.fromEntries(models.map((m: any) => [m.id, { context: m.context ?? null, images: m.images === true, levels: m.levels || [] }]))"
        @write="writeConfirm = true" @remove="removeConfirm = true" />
    </div>

    <ConfirmModal :show="writeConfirm" title="确认写入配置" ok-text="确认写入" @close="writeConfirm = false" @ok="doWrite">
      <section class="confirm-sec">
        <h4>写入内容</h4>
        <dl class="confirm-grid">
          <dt>写入目标</dt><dd>{{ targetName }}</dd>
          <dt>目标文件</dt><dd class="mono">{{ targetPath }}</dd>
          <dt>将写入模型</dt><dd>{{ selection.length }} 个（已勾选）</dd>
          <dt>接入地址</dt><dd class="mono">{{ ac.endpoint }}</dd>
          <dt>写入方式</dt><dd>只替换墨桥写入的条目</dd>
        </dl>
      </section>
    </ConfirmModal>

    <ConfirmModal :show="reloginConfirm" title="重新登录 AtomCode" ok-text="重新登录"
      @close="reloginConfirm = false" @ok="doLogin">
      <section class="confirm-sec">
        <h4>已有登录凭据</h4>
        <p>本机已登录{{ ac.account?.username ? '（' + ac.account.username + '）' : '' }}，重新登录会弹出终端窗口并覆盖现有授权。只想刷新目录的话，请用「刷新目录」。</p>
        <p>浏览器授权完成后<b>请保持终端窗口打开</b>——墨桥靠它把新凭据写进配置；中途关掉窗口，墨桥会一直等到超时。</p>
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
      <div v-if="detail" class="ac-detail" role="dialog" aria-modal="true" aria-label="模型详情">
        <header class="ac-detail-head">
          <div>
            <h3>{{ detail.id }}</h3>
            <p class="mono">{{ detail.upstream }}</p>
          </div>
          <NButton size="tiny" quaternary circle class="ac-detail-x" aria-label="关闭" @click="detail = null">×</NButton>
        </header>
        <dl class="ac-detail-grid">
          <dt>上下文</dt><dd>{{ detail.context ? contextText(detail.context) + '（' + detail.context + ' tokens）' : '—' }}</dd>
          <dt>推理档位</dt><dd>{{ detail.levels.join('、') || '—' }}</dd>
          <dt>支持图像</dt><dd>{{ detail.images ? '是' : '否' }}</dd>
          <dt>目录来源</dt><dd>{{ catalogSource === 'live' ? 'AtomCode 实时目录' : 'config.toml 离线快照' }}</dd>
        </dl>
        <p class="ac-detail-foot">客户端用 <code>{{ detail.id }}</code> 称呼它；转发口发出的模型名是 <code>{{ detail.upstream }}</code>。</p>
      </div>
    </NModal>
  </div>
</template>

<style scoped>
code { font-family: var(--mono); font-size: 11px; }
.install-cmd { margin: 12px 0 0; font-size: 11px; color: var(--muted); word-break: break-all; }
.gateway-kv { margin-top: 12px; }
.aside-kv { gap: 4px; }
.aside-kv > div { font-size: 11.5px; }

.ac-detail { width: min(560px, 92vw); background: var(--surface); border-radius: 12px; padding: 16px 18px;
  border: 1px solid var(--subtle-line); box-shadow: 0 18px 48px rgba(0, 0, 0, .28); }
.ac-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ac-detail-head h3 { margin: 0; font-size: 15px; }
.ac-detail-head p { margin: 4px 0 0; font-size: 11px; color: var(--muted); }
.ac-detail-x { color: var(--muted); font-size: 15px; }
.ac-detail-grid { display: grid; grid-template-columns: 84px 1fr; gap: 8px 12px; margin: 14px 0 0; font-size: 12px; }
.ac-detail-grid dt { color: var(--muted); }
.ac-detail-grid dd { margin: 0; }
.ac-detail-foot { margin: 14px 0 0; font-size: 11px; color: var(--disabled-text); }

/* 可用性校验：被上游拒绝的模型整行压暗并贴"不可用"签，勾选框一并禁用。 */
.probe-note { margin: 10px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--muted); }
.cell-reason { margin: 3px 0 0; font-size: 10.5px; line-height: 1.5; color: var(--error-dot); overflow-wrap: anywhere; }
.tag-bad {
  margin-left: 6px; padding: 0 5px; border-radius: 4px; vertical-align: 1px;
  font-size: 10px; font-weight: 650; line-height: 15px; display: inline-block;
  background: var(--error-dot); color: #fff;
}
tr.rejected .cell-name, tr.rejected .cell-sub { opacity: .55; }
</style>

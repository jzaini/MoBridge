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
import { NButton, NCheckbox, NInput, NModal } from 'naive-ui'
import {
  useService, note, run, callAction, pushBusy, operationBusy, controlsBusy, inspectTargets,
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
async function switchTarget(value: 'workbuddy' | 'dsh' | 'mofang') {
  if (value === state.value.target) return
  pushBusy('target')
  try {
    const envelope = await run('target', value)
    if (!envelope.ok) throw new Error(envelope.error || '切换失败')
    note(`已切换到 ${targetLabel(value)}。`, 'ok')
  } catch (error) {
    notifyFailure(error)
  } finally { pushBusy(null) }
}
async function recheck() {
  const envelope = await inspectTargets()
  if (envelope.ok) note(`已重新体检 ${targetName.value} 里的墨桥条目。`, 'ok')
  else notifyFailure(envelope.error, { fallback: '体检失败', prefix: '体检失败：' })
}

// ── 安装 / 登录 ─────────────────────────────────────────────────────────
async function detect() {
  if (opBusy.value) { note('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-detect')
  try {
    const envelope = await run('ac-detect', undefined, 60000)
    if (!envelope.ok) throw new Error(envelope.error || '检测失败')
    note(installed.value ? `已检测到 AtomCode ${ac.value.version || ''}。` : '本机未安装 AtomCode。', installed.value ? 'ok' : 'error')
  } catch (error) { notifyFailure(error) } finally { pushBusy(null) }
}
async function install() {
  if (opBusy.value) { note('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-install')
  note('正在调用系统包管理器安装 AtomCode，这一步可能几分钟…', 'ok', { stream: 'ac-install' })
  try {
    const envelope = await run('ac-install', undefined, 320000)
    if (!envelope.ok) throw new Error(envelope.error || '安装失败')
    const result = (envelope.result || {}) as { ok?: boolean, output?: string }
    if (result.ok) note('安装命令执行完成；若仍显示未安装，请重启本页或检查包管理器输出。', 'ok')
    // 失败时不要把整段英文 CLI 输出塞进浮层：翻译成结论，原文进通知中心。
    else notifyFailure(result.output, { fallback: '安装未成功', prefix: '安装未成功：' })
  } catch (error) { notifyFailure(error) } finally { pushBusy(null) }
}
async function login() {
  if (opBusy.value) { note('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-login')
  note('已调起 atomcode login；请在浏览器完成授权，完成后本页会自动刷新目录。', 'ok', { stream: 'ac-login' })
  try {
    const envelope = await run('ac-login', undefined, 200000)
    if (!envelope.ok) throw new Error(envelope.error || '登录失败')
    const result = (envelope.result || {}) as { ok?: boolean, output?: string }
    if (result.ok) note(`登录完成，已读取到 ${models.value.length} 个免费模型。`, 'ok')
    // 登录失败最常见的原文是「Windows interactive mode requires console input…」，
    // 中文结论会告诉用户"去 PowerShell 手动跑 atomcode login"。
    else notifyFailure(result.output, { fallback: '登录未完成', prefix: '登录未完成：' })
  } catch (error) { notifyFailure(error) } finally { pushBusy(null) }
}
async function refreshCatalog() {
  if (opBusy.value) { note('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-refresh')
  try {
    const envelope = await run('ac-refresh', undefined, 60000)
    if (!envelope.ok) throw new Error(envelope.error || '刷新失败')
    note(catalogSource.value === 'live' ? `已从 AtomCode 实时目录刷新到 ${models.value.length} 个免费模型。`
      : '实时目录不可用，当前显示 config.toml 的离线快照。', catalogSource.value === 'live' ? 'ok' : 'error')
  } catch (error) { notifyFailure(error) } finally { pushBusy(null) }
}

// ── 网关 ───────────────────────────────────────────────────────────────
const showGateway = ref(false)
const gatewayInput = ref('')
async function saveGateway() {
  const envelope = await callAction('ac-save-gateway', gatewayInput.value.trim())
  if (!envelope.ok) { notifyFailure(envelope.error, { fallback: '保存失败' }); return }
  note('网关地址已保存，转发口会立刻改用它。', 'ok')
}
async function resetGateway() {
  const envelope = await callAction('ac-reset-gateway')
  if (envelope.ok) { gatewayInput.value = ''; note('已恢复官方默认网关。', 'ok') }
  else notifyFailure(envelope.error, { fallback: '恢复失败' })
}

// ── 勾选 ───────────────────────────────────────────────────────────────
const checked = computed(() => new Set(selection.value))
function isChecked(model: AcModel) { return checked.value.has(model.upstream) }
async function toggle(model: AcModel, next: boolean) {
  if (opBusy.value) return
  const ids = new Set(selection.value)
  if (next) ids.add(model.upstream); else ids.delete(model.upstream)
  const envelope = await callAction('ac-selection', Array.from(ids), 20000, { keepNote: true })
  if (!envelope.ok) notifyFailure(envelope.error, { fallback: '勾选更新失败' })
}
async function bulk(mode: 'all' | 'none') {
  if (opBusy.value) { note('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  const ids = mode === 'all' ? models.value.map(model => model.upstream) : []
  pushBusy('ac-selection')
  try {
    const envelope = await callAction('ac-selection', ids, 20000)
    if (!envelope.ok) throw new Error(envelope.error || '勾选更新失败')
    note(mode === 'all' ? `已勾选全部 ${ids.length} 个模型。` : '已取消全部勾选。', 'ok')
  } catch (error) { notifyFailure(error) } finally { pushBusy(null) }
}

// ── 写入 / 移除 ─────────────────────────────────────────────────────────
const writeConfirm = ref(false)
const removeConfirm = ref(false)
async function doWrite() {
  writeConfirm.value = false
  if (opBusy.value) { note('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-import')
  note(`正在把 ${selection.value.length} 个模型写入 ${targetName.value}…`, 'ok', { stream: 'ac-import' })
  try {
    const envelope = await run('ac-import', undefined, 150000)
    if (!envelope.ok) throw new Error(envelope.error || '写入失败')
    const result = (envelope.result || {}) as { changed?: boolean, count?: number }
    note(result.changed === false
      ? `${targetName.value} 配置已是最新，共 ${result.count ?? 0} 个 AtomCode 模型。`
      : `写入完成：${result.count ?? 0} 个模型已写入 ${targetName.value}。`, 'ok')
    await inspectTargets()
  } catch (error) { notifyFailure(error) } finally { pushBusy(null) }
}
async function doRemove() {
  removeConfirm.value = false
  if (opBusy.value) { note('有操作正在进行，请稍候（进度见窗口底部）。', 'error'); return }
  pushBusy('ac-remove')
  try {
    const envelope = await run('ac-remove')
    if (!envelope.ok) throw new Error(envelope.error || '移除失败')
    const result = (envelope.result || {}) as { changed?: boolean }
    note(result.changed === false
      ? `没有找到墨桥写入 ${targetName.value} 的 AtomCode 条目，配置未改动。`
      : `已移除墨桥写入的 AtomCode 条目，${targetName.value} 里其它配置原样保留。`, 'ok')
    await inspectTargets()
  } catch (error) { notifyFailure(error) } finally { pushBusy(null) }
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
    <div class="plan-rail">
      <StepRail v-model:active="active" :steps="rail" :collapsed="railCollapsed" @toggle="toggleRail">
        <template #foot>
          AtomCode 的凭据只留在服务进程；写进客户端的是墨桥本机转发口 + 本机口令。
        </template>
      </StepRail>
    </div>

    <div class="plan-main">
      <header class="stage-head">
        <div class="stage-title">
          <h2>{{ active === 'install' ? '安装与登录 AtomCode' : '选择免费模型' }}</h2>
          <p class="stage-sub">把 AtomCode 的免费模型经墨桥转发口接进 {{ targetName }}</p>
        </div>
        <div class="stage-actions">
          <template v-if="active === 'install'">
            <NButton size="small" :disabled="busy" title="重新检测本机是否已安装 AtomCode" @click="detect">重新检测</NButton>
            <NButton size="small" type="primary" :disabled="busy || installed" @click="install">一键安装</NButton>
            <NButton size="small" :disabled="busy || !installed" @click="login">登录 AtomCode</NButton>
          </template>
          <template v-else>
            <NButton size="small" :disabled="busy || !installed" title="从 AtomCode 实时接口重新读取免费模型（只刷新清单，不影响当前步骤）" @click="refreshCatalog">刷新目录</NButton>
            <NButton size="small" :disabled="busy || !models.length" @click="bulk('all')">全选</NButton>
            <NButton size="small" :disabled="busy || !selection.length" @click="bulk('none')">全部取消</NButton>
          </template>
        </div>
      </header>

      <!-- 第 1 步：安装与登录 -->
      <section v-if="active === 'install'" class="pane" aria-label="安装与登录">
        <div class="pane-head">
          <h3>本机客户端</h3>
          <p>AtomCode 是桌面客户端，必须先装在本机；登录走它自己的浏览器 OAuth，墨桥只负责调起并把登录态读出来。</p>
        </div>
        <div class="pane-body">
          <div class="field-row">
            <span class="chip" :class="installed ? 'ok' : 'na'">{{ installed ? '已安装 · ' + (ac.version || '版本未知') : '未检测到 AtomCode' }}</span>
            <span class="chip" :class="loggedIn ? 'ok' : 'na'">{{ loggedIn ? '已登录 · ' + (ac.account?.username || '—') : '未登录' }}</span>
            <button type="button" class="link-btn" @click="openDoc(ac.siteUrl as string)">AtomCode 官网 ↗</button>
          <button type="button" class="link-btn" @click="openDoc(ac.docsUrl as string)">官方文档 ↗</button>
          </div>

          <dl class="kv gateway-kv">
            <div><dt>套餐</dt><dd :class="plan ? 'ok' : 'na'">{{ plan ? (plan.planName + (plan.remainingDays != null ? ' · 剩 ' + plan.remainingDays + ' 天' : '')) : '—' }}</dd></div>
            <div><dt>目录来源</dt><dd :class="catalogSource === 'live' ? 'ok' : 'na'">{{ catalogSource === 'live' ? 'AtomCode 实时' : catalogSource === 'offline' ? '离线快照' : '—' }}</dd></div>
            <div><dt>转发口</dt><dd class="mono" :class="ac.bridgeRunning ? 'ok' : 'na'">{{ ac.bridgeRunning ? ac.endpoint : '未启动' }}</dd></div>
            <div v-if="ac.binary"><dt>二进制</dt><dd class="mono">{{ ac.binary }}</dd></div>
          </dl>

          <p class="install-cmd">安装命令（固定白名单，不拼接任何输入）：<code>{{ ac.install?.command }}</code></p>
          <p v-if="ac.catalogError && catalogSource !== 'live'" class="inline-warn">实时目录不可用：{{ ac.catalogError }}</p>

          <h4 class="sec-title">上游网关</h4>
          <div class="field-row">
            <button type="button" class="link-btn" @click="showGateway = !showGateway">
              {{ showGateway ? '收起' : '当前 ' + (ac.gateway || '官方默认') + '，点此修改' }}
            </button>
          </div>
          <div v-if="showGateway" class="field-row">
            <NInput v-model:value="gatewayInput" size="small" placeholder="https://api-ai.gitcode.com" :disabled="busy" />
            <NButton size="small" :disabled="busy" @click="saveGateway">保存</NButton>
            <NButton size="small" :disabled="busy || !ac.gatewayCustom" @click="resetGateway">恢复默认</NButton>
            <span class="field-hint">改成自己的代理时，转发口会立刻改用它。</span>
          </div>
        </div>
      </section>

      <!-- 第 2 步：选择模型 -->
      <section v-else class="pane table-pane" aria-label="选择模型">
        <div class="pane-head with-stats">
          <div>
            <h3>免费模型清单</h3>
            <p>目录按你的账号档位实时返回；接口不可用时回落到 <code>~/.atomcode/config.toml</code> 里登录时写下的快照。</p>
          </div>
          <div class="stat-strip" role="group" aria-label="模型统计">
            <div class="stat"><span class="stat-v">{{ models.length }}</span><span class="stat-k">模型</span></div>
            <div class="stat"><span class="stat-v" :class="selection.length ? 'ok' : 'na'">{{ selection.length }}</span><span class="stat-k">已勾选</span></div>
          </div>
        </div>
        <div class="table-scroll" tabindex="0" role="region" aria-label="AtomCode 模型清单">
          <table class="mo-table">
            <thead>
              <tr>
                <th class="col-check"><span class="sr-only">勾选</span></th>
                <th title="主行是写入客户端后的名字（AC · 前缀标来源），副行是上游真名">模型</th>
                <th class="col-num">上下文</th>
                <th>推理档位</th>
                <th class="col-img" title="识图 = 对话可发图（来自 supports_vision）">图像</th>
                <th class="col-act"><span class="sr-only">详情</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="model in models" :key="model.upstream" :class="{ chosen: isChecked(model) }">
                <td class="col-check">
                  <NCheckbox size="small" :checked="isChecked(model)" :disabled="opBusy"
                    @update:checked="(v: boolean) => toggle(model, v)" />
                </td>
                <td>
                  <div class="cell-name">{{ model.id }}</div>
                  <div class="cell-sub mono">{{ model.upstream }}</div>
                </td>
                <td class="col-num mono">{{ contextText(model.context) }}</td>
                <td><span v-for="level in model.levels" :key="level" class="tag">{{ level }}</span><span v-if="!model.levels.length" class="dash">—</span></td>
                <td class="col-img" :title="model.images ? '多模态对话：可以把图片发给它' : '官方未标注支持图片'">
                  <span :class="model.images ? 'sn-yes' : 'sn-no'">{{ model.images ? '识图' : '—' }}</span>
                </td>
                <td class="col-act"><NButton size="tiny" quaternary @click="detail = model">详情</NButton></td>
              </tr>
              <tr v-if="!models.length">
                <td colspan="6" class="empty-cell">{{ installed ? '尚未登录或目录为空；回第 1 步登录后会自动刷新。' : '先安装 AtomCode，再登录。' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="legend">主行是写入客户端后的名字；<code>OC · / AC · / SN ·</code> 是三路来源前缀，防止同名模型在同一份配置里互相覆盖。转发口会把 <code>AC · 模型名</code> 换回上游真名再发出去。勾选后在右侧「写入配置」里写入。</p>
      </section>

      <footer class="page-foot">
        <span>上游凭据只留在服务进程；写入目标里只有本机转发口地址与本机口令</span>
        <span>{{ ac.bridgeRunning ? '转发口 ' + ac.endpoint : '转发口未启动' }}</span>
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

      <WriteCard v-if="active === 'models'" :target-name="targetName" :write-label="writeLabel" :count="selection.length"
        :write-disabled="busy || !canWrite" :write-reason="writeReason"
        :remove-disabled="busy || !canRemove" :remove-reason="removeReason" :preview="previewNames"
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
          <dt>写入方式</dt><dd>带 owner 标记的覆盖式同步，只替换墨桥写入的 AtomCode 条目</dd>
        </dl>
      </section>
    </ConfirmModal>

    <ConfirmModal :show="removeConfirm" title="确认移除配置" ok-text="确认移除" danger
      @close="removeConfirm = false" @ok="doRemove">
      <section class="confirm-sec">
        <h4>移除内容</h4>
        <dl class="confirm-grid">
          <dt>写入目标</dt><dd>{{ targetName }}</dd>
          <dt>目标文件</dt><dd class="mono">{{ targetPath }}</dd>
          <dt>将移除条目</dt><dd>墨桥写入的 AtomCode 条目（OpenCode、日日新与你自己写的配置原样保留）</dd>
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
          <button class="ac-detail-x" type="button" aria-label="关闭" @click="detail = null">×</button>
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
.ac-detail-x { border: 0; background: none; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; }
.ac-detail-grid { display: grid; grid-template-columns: 84px 1fr; gap: 8px 12px; margin: 14px 0 0; font-size: 12px; }
.ac-detail-grid dt { color: var(--muted); }
.ac-detail-grid dd { margin: 0; }
.ac-detail-foot { margin: 14px 0 0; font-size: 11px; color: var(--disabled-text); }
</style>

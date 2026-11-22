<template>
  <table class="mo-model-table" :aria-label="ariaLabel">
    <thead>
      <tr>
        <th class="mo-col-check">写入</th>
        <th class="mo-col-name" title="主行是写入客户端后的名字（来源前缀标三路归属），副行是上游真名/官方名">模型</th>
        <th class="mo-col-cap" title="能力与图像支持标签；识图 = 对话可发图，生图 = 图像生成">能力</th><th class="mo-col-ctx">上下文</th>
        <th title="官方未公开推理档位时显示 —（口径三页一致）">推理档位</th>
        <th class="mo-col-state" title="上行是可用性状态，下行是真实请求耗时">状态</th><th class="mo-col-act">操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="m in models" :key="m.id"
        :class="['mo-row', isChecked(m) ? '' : 'mo-unselected']">
        <td class="mo-col-check">
          <NCheckbox size="small"
            :checked="isChecked(m)"
            :disabled="checkDisabled(m)"
            :aria-label="'写入 ' + (m.name || shortId(m.id))"
            @update:checked="(v: boolean) => emit('select', m.id, v)" />
        </td>
        <td class="mo-col-name">
          <!-- 主名统一为「写入客户端名」：来源前缀与 service/sync/sync.ts 的 SOURCE_OWNERS
               口径一致（OC · / AC · / SN ·），副名才是上游真名。三页由 sourcePrefix 区分。 -->
          <span class="mo-model-name">{{ sourcePrefix }}{{ m.name || shortId(m.id) }}</span>
          <span class="mo-model-id mono">{{ shortId(m.id) }}</span>
        </td>
        <td class="mo-col-cap">
          <span v-for="c in capabilityTags(m)" :key="c"
            :class="IMAGE_TAGS.includes(c) ? 'mo-cap mo-cap-img' : 'mo-cap'">{{ c }}</span>
        </td>
        <td class="mo-col-ctx mono" :title="m.context ? m.context + ' tokens' : '来源未公开该模型的上下文窗口数值'">
          <span :class="contextText(m) === '—' ? 'mo-ctx-unknown' : ''">{{ contextText(m) }}</span>
        </td>
        <td class="mono" :title="levelsOf(m).length ? levelsOf(m).join(' / ') : '来源未公开推理档位'">
          <span v-for="level in levelsOf(m)" :key="level" class="mo-cap">{{ level }}</span>
          <span v-if="!levelsOf(m).length" class="mo-ctx-unknown">—</span>
        </td>
        <td class="mo-col-state">
          <div class="mo-state-wrap">
            <span class="mo-state" :style="{ color: STATE_COLOR[status(m.id).cls] }">
              <i class="mo-dot" :class="status(m.id).dot"></i>{{ status(m.id).label }}
            </span>
            <NTooltip v-if="status(m.id).reason" trigger="hover" placement="top">
              <template #trigger>
                <NButton size="tiny" quaternary circle class="mo-state-info" :class="{ error: status(m.id).bad }"
                  :aria-label="(m.name || m.id) + ' 的失败原因'"
                  @click.stop="emit('detail', m)">
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.4" />
                    <path d="M8 7.2v4" stroke-linecap="round" />
                    <circle cx="8" cy="4.6" r=".85" fill="currentColor" stroke="none" />
                  </svg>
                </NButton>
              </template>
              {{ status(m.id).reason }}
            </NTooltip>
          </div>
          <!-- 耗时并入状态列：上行状态、下行耗时，省出的整列宽度让给推理档位。 -->
          <div class="mo-state-time mono" :title="timingTitle(m.id)">{{ timingText(m.id) }}</div>
        </td>
        <td class="mo-col-act">
          <NButton size="tiny" quaternary @click.stop="emit('detail', m)">详情</NButton>
          <NButton size="tiny" quaternary :disabled="busy || !retestable(m)" title="只重测这一条模型（真实调用，消耗少量额度）"
            @click.stop="emit('probe-one', m.id)">重测</NButton>
        </td>
      </tr>
      <tr v-if="!models.length">
        <td colspan="7" class="mo-table-empty">{{ emptyText || '没有符合当前筛选的模型' }}</td>
      </tr>
    </tbody>
  </table>
</template>

<script setup lang="ts">
// 模型清单表：写入勾选 / 模型 / 能力（含识图）/ 上下文 / 推理档位 / 状态（含耗时）/ 操作（详情+重测）。
// 状态派生：探测中/请求中/可用/仅对话/不可用/待检测。
import { NCheckbox, NButton, NTooltip } from 'naive-ui'

interface ModelRow {
  id: string
  name?: string
  context?: number
  /** 预格式化的上下文显示文本（AtomCode/日日新有自己的 K 换算口径时传入）；缺省用通用换算。 */
  contextText?: string
  reasoning?: boolean
  images?: boolean
  toolcall?: boolean
  /** 推理档位（AtomCode 有、其余来源未公开时传空数组 → 显示 —）。 */
  levels?: string[]
  chatOnly?: boolean
  /** 能力标签覆盖（日日新的 caps 词汇更丰富：多模态/智能体/开源…）。 */
  caps?: string[]
  /** 图像列显示文本覆盖（日日新三态：识图/生图/—）。 */
  imagesText?: string
}
const props = defineProps<{
  models: ModelRow[]
  modelResults: Record<string, Record<string, any>>
  availableModels: string[]
  excludedModels: string[]
  probe: Record<string, any>
  activity: Array<Record<string, any>>
  busy: boolean
  emptyText?: string
  /** 来源前缀：OC · / AC · / SN ·（与 service/sync/sync.ts 的 SOURCE_OWNERS 口径一致）。 */
  sourcePrefix?: string
  ariaLabel?: string
  /** 状态覆盖表：AtomCode/日日新的可用性判定来源不同，直接给最终状态（键 = 行 id）。 */
  statusMap?: Record<string, { label: string, kind: 'ok' | 'error' | 'checking' | 'na', reason?: string | null }> | null
  /** 勾选覆盖表：AtomCode/日日新的勾选模型来自 selection（键 = 行 id）。 */
  checkedIds?: string[] | null
  /** 勾选禁用覆盖：这些行的勾选框置灰（如上游明确拒绝的模型）。 */
  disabledIds?: string[] | null
  /** 正在重测的行 id：状态显示「检测中」。 */
  checkingIds?: string[] | null
  /** 耗时覆盖表（日日新的 latencyMs 口径与 OpenCode 的 durationMs 不同）。 */
  latencyText?: Record<string, string> | null
}>()
const emit = defineEmits<{
  (e: 'select', modelId: string, checked: boolean): void
  (e: 'probe-one', modelId: string): void
  (e: 'detail', model: ModelRow): void
}>()

const PHASE: Record<string, string> = { timeout: '检测超时', quota: '额度不足', rate_limit: '请求受限', access: '访问受限' }
function probing(id: string): boolean {
  const p = props.probe
  if (!p?.running) return false
  return (p.active || []).includes(id) || p.current === id || (p.pending || []).includes(id)
}
function requesting(id: string): boolean {
  return (props.activity || []).some((a) => a.model === id)
}
function status(id: string): { label: string, cls: string, dot: string, bad?: boolean, reason?: string } {
  // 来源覆盖优先：AtomCode/日日新的判定来自各自的探测结果，不走 OpenCode 的 modelResults。
  const override = props.statusMap?.[id]
  if (override) {
    if (override.kind === 'ok') return { label: override.label, cls: 'available', dot: 'ok' }
    if (override.kind === 'checking') return { label: override.label, cls: 'checking', dot: '' }
    if (override.kind === 'na') return { label: override.label, cls: 'waiting', dot: 'na' }
    return { label: override.label, cls: 'unavailable', dot: 'error', bad: true, reason: override.reason || override.label }
  }
  const r = props.modelResults?.[id] || {}
  if (probing(id)) return { label: '检测中', cls: 'checking', dot: '' }
  if (requesting(id)) return { label: '请求中', cls: 'requesting', dot: '' }
  if ((props.availableModels || []).includes(id))
    return { label: r.chatOnly ? '可用 · 仅对话' : '可用', cls: r.chatOnly ? 'chat-only' : 'available', dot: 'ok' }
  if (PHASE[r.category]) return { label: PHASE[r.category], cls: 'unavailable', dot: 'error', bad: true, reason: r.error || PHASE[r.category] }
  if (r.ok === false) return { label: '不可用', cls: 'unavailable', dot: 'error', bad: true, reason: r.error || '请求失败' }
  return { label: '待检测', cls: 'waiting', dot: 'na' }
}
const STATE_COLOR: Record<string, string> = {
  available: 'var(--success-text)', 'chat-only': 'var(--success-text)',
  checking: 'var(--accent-text)', requesting: 'var(--accent-text)',
  unavailable: 'var(--error-text)', waiting: 'var(--muted)',
}
// 图像类能力标签：绿色高亮显示（原「图像」列并入能力列后的残留语义）。
const IMAGE_TAGS = ['识图', '生图']
function capabilityTags(m: ModelRow): string[] {
  const base = m.caps?.length ? [...m.caps] : (() => {
    const out: string[] = []
    if (m.reasoning) out.push('推理')
    if (m.toolcall) out.push('工具调用')
    return out
  })()
  // 图像并入能力列：imagesText 有三态（识图/生图/—），通用口径看 images 布尔。
  const imageTag = m.imagesText && m.imagesText !== '—' ? m.imagesText : (m.images ? '识图' : '')
  if (imageTag) base.push(imageTag)
  return base.length ? base : ['—']
}
function contextText(m: ModelRow): string {
  if (m.contextText) return m.contextText
  return formatContext(m.context)
}
function levelsOf(m: ModelRow): string[] {
  return m.levels || []
}
function retestable(m: ModelRow): boolean {
  return !(props.disabledIds || []).includes(m.id)
}
function isChecked(m: ModelRow): boolean {
  if (props.checkedIds) return props.checkedIds.includes(m.id)
  return (props.availableModels || []).includes(m.id) && !(props.excludedModels || []).includes(m.id)
}
function checkDisabled(m: ModelRow): boolean {
  if (props.busy) return true
  if (props.disabledIds) return props.disabledIds.includes(m.id)
  return !(props.availableModels || []).includes(m.id)
}
function formatContext(value?: number): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n >= 1024 ? Math.round(n / 1024) + 'K' : String(n)
}
function timingTitle(id: string): string {
  if (props.latencyText?.[id]) return '真实请求完整往返用时'
  return props.modelResults?.[id]?.source === 'cache'
    ? '缓存判定（非本次实发请求）'
    : (props.modelResults?.[id]?.durationMs != null ? '真实请求完整耗时' : '尚未检测，点「检测全部」或操作列「重测」得到')
}
function timingText(id: string): string {
  if (props.latencyText?.[id]) return props.latencyText[id]
  const d = Number(props.modelResults?.[id]?.durationMs)
  if (!Number.isFinite(d)) return '—'
  return d < 1000 ? d + ' ms' : (d / 1000).toFixed(1) + ' 秒'
}
function shortId(id: string): string {
  return String(id || '').replace(/^opencode\//, '')
}
</script>

<style scoped>
.mo-model-table { width: 100%; border-spacing: 0; table-layout: fixed; text-align: center; }
.mo-model-table th {
  position: sticky; z-index: 1; top: 0; height: 30px; padding: 5px 8px;
  background: var(--table-heading, #2c2c30); color: var(--muted);
  font-size: 11px; font-weight: 600; border-bottom: 1px solid var(--line); white-space: nowrap;
}
.mo-model-table td { padding: 6px 8px; border-bottom: 1px solid var(--subtle-line); vertical-align: middle; font-size: 12px; }
.mo-row:hover > td { background: var(--hover); }
.mo-row.mo-unselected > td:first-child { opacity: .55; }
.mo-row:last-child > td { border-bottom: 0; }
.mo-col-check { width: 7%; }
.mo-col-name { width: 24%; }
.mo-col-cap { width: 16%; }
.mo-col-ctx { width: 9%; }
/* 状态列两行（上行状态、下行耗时）：省掉了原「图像」「耗时」两列，
    推理档位（无固定宽度）拿到释放出来的空间，多档位不再挤成窄条。 */
.mo-col-state { width: 14%; }
/* 操作列要放下「详情 / 重测」两个按钮：给足宽度并且不换行，
    否则两个按钮会上下叠成两行，把行高撑起来。 */
.mo-col-act { width: 15%; white-space: nowrap; padding-left: 4px !important; padding-right: 4px !important; }
.mo-col-name { text-align: left !important; }
.mo-cap-img { color: var(--success-text); }
.mo-model-name { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mo-model-id { display: block; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mo-cap {
  display: inline-block; font-size: 11px; padding: 1px 7px; margin: 0 2px; border-radius: 5px;
  border: 1px solid var(--subtle-line); background: var(--detail-background); color: var(--text);
}
.mo-ctx-unknown { color: var(--muted); }
.mo-state-wrap { display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
.mo-state-time { font-size: 11px; color: var(--muted); margin-top: 2px; line-height: 1.3; }
.mo-state { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.mo-state-info {
  display: inline-grid; place-items: center; flex: 0 0 18px; width: 18px; height: 18px; padding: 0;
  border-radius: 50%;
  color: var(--muted);
}
.mo-state-info:hover { color: var(--accent-text); }
.mo-state-info.error { color: var(--error-text); }
.mo-table-empty { padding: 26px 0 !important; color: var(--muted); text-align: center; }
</style>

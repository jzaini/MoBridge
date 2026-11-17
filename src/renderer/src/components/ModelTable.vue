<script setup lang="ts">
// 模型清单表：写入勾选 / 模型 / 能力 / 上下文 / 状态 / 耗时 / 操作（详情+重测）。
// 状态派生：探测中/请求中/可用/仅对话/不可用/待检测。
import { NCheckbox, NButton, NTooltip } from 'naive-ui'

interface ModelRow {
  id: string
  name?: string
  context?: number
  reasoning?: boolean
  images?: boolean
  toolcall?: boolean
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
function capabilities(m: ModelRow): string[] {
  const out: string[] = []
  if (m.reasoning) out.push('推理')
  if (m.images) out.push('图片')
  if (m.toolcall) out.push('工具调用')
  return out.length ? out : ['—']
}
function formatContext(value?: number): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n >= 1024 ? Math.round(n / 1024) + 'K' : String(n)
}
function timingText(id: string): string {
  const d = Number(props.modelResults?.[id]?.durationMs)
  if (!Number.isFinite(d)) return '—'
  return d < 1000 ? d + ' ms' : (d / 1000).toFixed(1) + ' 秒'
}
function shortId(id: string): string {
  return String(id || '').replace(/^opencode\//, '')
}
</script>

<template>
  <table class="mo-model-table" aria-label="OpenCode 免费模型清单">
    <thead>
      <tr>
        <th class="mo-col-check">写入</th>
        <th class="mo-col-name" title="主行是写入客户端后的名字（OC · 前缀标来源），副行是上游真名">模型</th><th class="mo-col-cap">能力</th><th class="mo-col-ctx">上下文</th>
        <th class="mo-col-state">状态</th><th class="mo-col-time">耗时</th><th class="mo-col-act">操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="m in models" :key="m.id"
        :class="['mo-row', (availableModels.includes(m.id) && !excludedModels.includes(m.id)) ? '' : 'mo-unselected']">
        <td class="mo-col-check">
          <NCheckbox size="small"
            :checked="availableModels.includes(m.id) && !excludedModels.includes(m.id)"
            :disabled="busy || !availableModels.includes(m.id)"
            :aria-label="'写入 ' + (m.name || shortId(m.id))"
            @update:checked="(v: boolean) => emit('select', m.id, v)" />
        </td>
        <td class="mo-col-name">
          <!-- 主名统一为「写入客户端名」：OC · 是来源前缀（与 service/domain/model-status.ts
               的 clientModelID 一致），副名才是上游真名。三页口径一致，用户一眼能看到标识。 -->
          <span class="mo-model-name">OC · {{ m.name || shortId(m.id) }}</span>
          <span class="mo-model-id mono">{{ shortId(m.id) }}</span>
        </td>
        <td class="mo-col-cap">
          <span v-for="c in capabilities(m)" :key="c" class="mo-cap">{{ c }}</span>
        </td>
        <td class="mo-col-ctx mono" :title="m.context ? m.context + ' tokens（OpenCode 声明值，非实测）' : 'OpenCode 未公开该模型的上下文窗口数值'">
          <span :class="formatContext(m.context) === '—' ? 'mo-ctx-unknown' : ''">{{ formatContext(m.context) }}</span>
        </td>
        <td class="mo-col-state">
          <div class="mo-state-wrap">
            <span class="mo-state" :style="{ color: STATE_COLOR[status(m.id).cls] }">
              <i class="mo-dot" :class="status(m.id).dot"></i>{{ status(m.id).label }}
            </span>
            <NTooltip v-if="status(m.id).reason" trigger="hover" placement="top">
              <template #trigger>
                <button class="mo-state-info" :class="{ error: status(m.id).bad }" type="button"
                  :aria-label="(m.name || m.id) + ' 的失败原因'"
                  @click.stop="emit('detail', m)">
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.4" />
                    <path d="M8 7.2v4" stroke-linecap="round" />
                    <circle cx="8" cy="4.6" r=".85" fill="currentColor" stroke="none" />
                  </svg>
                </button>
              </template>
              {{ status(m.id).reason }}
            </NTooltip>
          </div>
        </td>
        <td class="mo-col-time mono" :title="modelResults[m.id]?.source === 'cache' ? '缓存判定（非本次实发请求）' : (modelResults[m.id]?.durationMs != null ? '真实请求完整耗时' : '尚未检测，点「检测全部」或操作列「重测」得到')">
          {{ timingText(m.id) }}
        </td>
        <td class="mo-col-act">
          <NButton size="tiny" quaternary @click.stop="emit('detail', m)">详情</NButton>
          <NButton size="tiny" quaternary :disabled="busy" title="只重测这一条模型（真实调用，消耗少量额度）"
            @click.stop="emit('probe-one', m.id)">重测</NButton>
        </td>
      </tr>
      <tr v-if="!models.length">
        <td colspan="7" class="mo-table-empty">{{ emptyText || '没有符合当前筛选的模型' }}</td>
      </tr>
    </tbody>
  </table>
</template>

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
.mo-col-name { width: 23%; }
.mo-col-cap { width: 20%; }
.mo-col-ctx { width: 10%; }
.mo-col-state { width: 16%; }
.mo-col-time { width: 9%; }
/* 操作列要放下「详情 / 重测」两个按钮：给足宽度并且不换行，
   否则两个按钮会上下叠成两行，把行高撑起来。 */
.mo-col-act { width: 15%; white-space: nowrap; padding-left: 4px !important; padding-right: 4px !important; }
.mo-col-name { text-align: left !important; }
.mo-model-name { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mo-model-id { display: block; font-size: 10.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mo-cap {
  display: inline-block; font-size: 11px; padding: 1px 7px; margin: 0 2px; border-radius: 5px;
  border: 1px solid var(--subtle-line); background: var(--detail-background); color: var(--text);
}
.mo-ctx-unknown { color: var(--muted); }
.mo-state-wrap { display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
.mo-state { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.mo-state-info {
  display: inline-grid; place-items: center; flex: 0 0 16px; min-width: 16px; height: 16px; padding: 0;
  border: 1px solid var(--line); border-radius: 50%; background: var(--surface);
  color: var(--muted); cursor: pointer;
}
.mo-state-info:hover { border-color: var(--accent); color: var(--accent-text); }
.mo-state-info.error { border-color: var(--error-dot); color: var(--error-text); background: var(--error-background); }
.mo-table-empty { padding: 26px 0 !important; color: var(--muted); text-align: center; }
</style>

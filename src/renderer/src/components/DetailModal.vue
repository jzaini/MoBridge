<script setup lang="ts">
// 模型详情弹窗：模型信息 + 检测结果（失败原因/耗时/判定来源）+ 口径说明。
import { computed } from 'vue'
import { NModal, NButton } from 'naive-ui'

interface ModelRow { id: string, name?: string, context?: number, input?: number, output?: number, images?: boolean, toolcall?: boolean, reasoning?: boolean, variants?: Record<string, unknown> }
const props = defineProps<{
  show: boolean
  model: ModelRow | null
  modelResults: Record<string, Record<string, any>>
  availableModels: string[]
  probe: Record<string, any>
  activity: Array<Record<string, any>>
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const CAT_LABEL: Record<string, string> = { timeout: '检测超时', quota: '额度不足', rate_limit: '请求受限', access: '访问受限' }
const fmt = (iso?: string) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}
function shortId(id?: string): string { return String(id || '').replace(/^opencode\//, '') }

const result = computed(() => {
  const m = props.model
  if (!m) return { cls: 'na', title: '待检测', lines: ['尚未对该模型单独发请求。'] as string[] }
  const r = props.modelResults?.[m.id] || {}
  const probing = props.probe?.running && ((props.probe.active || []).includes(m.id) || props.probe.current === m.id)
  const requesting = (props.activity || []).some((a) => a.model === m.id)
  if (probing) return { cls: 'na', title: '检测中', lines: ['正在向该模型发极小请求，请稍候。'] }
  if (requesting) return { cls: 'na', title: '请求中', lines: ['该模型有进行中的调用。'] }
  if ((props.availableModels || []).includes(m.id)) {
    const lines = ['真实请求成功，该模型当前可调用。']
    if (r.chatOnly) lines.push('已自动关闭工具调用；写入客户端后仅支持普通对话。')
    return { cls: 'good', title: r.chatOnly ? '可用 · 仅对话' : '可用', lines }
  }
  if (CAT_LABEL[r.category]) {
    const lines = [r.error || CAT_LABEL[r.category]]
    if (r.status) lines.push('HTTP 状态：' + r.status)
    lines.push(r.source === 'cache' ? '该结论来自缓存判定，可点「重测」重新验证。' : '可点操作列「重测」重新发一次真实请求。')
    return { cls: 'bad', title: CAT_LABEL[r.category], lines }
  }
  if (r.ok === false) {
    const lines = [r.error || '请求失败']
    if (r.status) lines.push('HTTP 状态：' + r.status)
    lines.push(r.source === 'cache' ? '该结论来自缓存判定，可点「重测」重新验证。' : '可点操作列「重测」重新发一次真实请求。')
    return { cls: 'bad', title: '不可用', lines }
  }
  return { cls: 'na', title: '待检测', lines: ['尚未对该模型单独发请求。点「检测全部」或操作列「重测」得到真实可用性与耗时。'] }
})
const timing = computed(() => {
  const d = Number(props.model?.id && props.modelResults?.[props.model.id]?.durationMs)
  if (!Number.isFinite(d)) return '—'
  return d < 1000 ? d + ' ms' : (d / 1000).toFixed(1) + ' 秒'
})
const meta = computed(() => {
  const r = (props.model?.id && props.modelResults?.[props.model.id]) || {}
  return [
    ['真实耗时', timing.value],
    ['判定来源', r.source === 'cache' ? '缓存判定' : r.source === 'probe' ? '实发检测' : (r.source || '—')],
    ['检测时间', r.time ? fmt(r.time) : '—'],
    ['动作数', Number.isInteger(r.calls) ? String(r.calls) : '—'],
  ] as Array<[string, string]>
})
const info = computed(() => {
  const m = props.model
  if (!m) return []
  return [
    ['写入客户端名', 'OC · ' + (m.name || shortId(m.id))],
    ['模型 ID', m.id || '—'],
    ['名称', m.name || '—'],
    ['上下文', m.context ? m.context + ' tokens（OpenCode 声明值）' : '未公开'],
    ['输入上限', m.input ? String(m.input) : '未单独声明'],
    ['输出上限', m.output ? String(m.output) : '未声明'],
    ['图片输入', m.images ? '支持' : '不支持'],
    ['工具调用', m.toolcall ? '支持' : '不支持'],
    ['推理', m.reasoning ? '支持' : 'OpenCode 未声明支持'],
  ] as Array<[string, string]>
})
const variants = computed(() => Object.keys(props.model?.variants || {}).join(' / '))
</script>

<template>
  <NModal :show="show && !!model" @update:show="(v: boolean) => !v && emit('close')">
    <div class="mo-modal mo-detail-modal" role="dialog" aria-modal="true" :aria-label="model?.name || '模型详情'">
      <div class="mo-modal-head">
        <h3>{{ model?.name || shortId(model?.id) }}</h3>
        <button class="mo-modal-x" type="button" aria-label="关闭" @click="emit('close')">×</button>
      </div>
      <div class="mo-modal-body">
        <section class="mo-d-section">
          <h4>模型信息</h4>
          <dl class="mo-d-grid">
            <template v-for="([label, value]) in info" :key="label">
              <dt>{{ label }}</dt><dd>{{ value }}</dd>
            </template>
            <template v-if="variants">
              <dt>推理档位</dt><dd>{{ variants }}</dd>
            </template>
          </dl>
        </section>
        <section class="mo-d-section">
          <h4>检测结果</h4>
          <div class="mo-reason" :class="result.cls">
            <strong>{{ result.title }}</strong>
            <p v-for="(line, i) in result.lines" :key="i">{{ line }}</p>
          </div>
          <dl class="mo-d-grid">
            <template v-for="([label, value]) in meta" :key="label">
              <dt>{{ label }}</dt><dd>{{ value }}</dd>
            </template>
          </dl>
        </section>
        <section class="mo-d-section">
          <h4>口径说明</h4>
          <p class="mo-d-note">「—」表示 OpenCode 未公开该模型的上下文窗口数值；页面不编造，写入客户端时使用保守默认值。</p>
          <p class="mo-d-note">上下文与能力来自 OpenCode 官方目录静态快照（非实时接口），是声明值而非实测；耗时来自真实请求，为完整请求用时而非首字延迟。不可用模型仅在本窗口保留，不供客户端使用。</p>
        </section>
      </div>
      <div class="mo-modal-foot">
        <NButton size="small" @click="emit('close')">关闭</NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.mo-detail-modal { width: min(600px, calc(100vw - 48px)); }
.mo-d-section { margin-bottom: 14px; }
.mo-d-section h4 { margin: 0 0 7px; font-size: 12px; color: var(--text); }
.mo-d-grid { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 4px 12px; margin: 0; }
.mo-d-grid dt { color: var(--muted); font-size: 11.5px; }
.mo-d-grid dd { margin: 0; word-break: break-all; font-size: 11.5px; }
.mo-reason { border-radius: 7px; padding: 9px 12px; margin-bottom: 9px; }
.mo-reason strong { display: block; font-size: 12.5px; margin-bottom: 3px; }
.mo-reason p { margin: 2px 0 0; font-size: 11.5px; }
.mo-reason.good { background: var(--detail-background); color: var(--success-text); }
.mo-reason.bad { background: var(--error-background); color: var(--error-text); }
.mo-reason.na { background: var(--detail-background); color: var(--muted); }
.mo-d-note { margin: 4px 0 0; font-size: 11px; color: var(--muted); line-height: 1.7; }
</style>

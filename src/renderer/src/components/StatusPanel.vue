<template>
  <section class="mo-status-panel" aria-label="接入状态">
    <div class="mo-sp-head">
      <span class="mo-sp-title">接入状态</span>
      <button class="mo-sp-more" type="button" @click="emit('open-env')">环境信息 ↗</button>
    </div>
    <div class="mo-sp-grid">
      <div v-for="[label, value] in items" :key="label" class="mo-sp-item">
        <span class="mo-sp-label" :title="label">{{ label }}</span>
        <span class="mo-sp-value" :title="String(value)">{{ value }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
// 接入状态面板：步骤条右侧的 8 项概览（系统代理唯一开关在写入目标区，这里不重复展示）。
import { computed } from 'vue'
import { targetLabel, syncCountText } from '../utils/target'

const props = defineProps<{ state: Record<string, any> }>()
const emit = defineEmits<{ (e: 'open-env'): void }>()

const PHASE_LABEL: Record<string, string> = { starting: '启动中', reading: '读取中', ready: '就绪', error: '出错', stopped: '已停止' }
const phaseLabel = computed(() => PHASE_LABEL[props.state.phase] || props.state.phase || '—')
const checkedCount = computed(() => {
  const available = props.state.availableModels || []
  const excluded = props.state.excludedModels || []
  return available.filter((id: string) => !excluded.includes(id)).length
})
const fmt = (iso?: string) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}
const items = computed(() => {
  const s = props.state
  const sync = s.sync || {}
  return [
    ['阶段/版本', phaseLabel.value + (s.version ? ' · ' + s.version : '')],
    ['OpenCode', s.opencodeVersion || '—'],
    ['转发口', s.endpoint || '尚未启动'],
    ['已选', `${checkedCount.value} / ${(s.availableModels || []).length}`],
    ['可用模型', String((s.availableModels || []).length)],
    ['目标', targetLabel(s.target)],
    ['上次同步', sync.time ? fmt(sync.time) + ' · ' + syncCountText(sync) : '尚未写入'],
    ['更新时间', fmt(s.updatedAt)],
  ] as Array<[string, string]>
})
</script>

<style scoped>
.mo-status-panel {
  width: 100%; border: 1px solid var(--subtle-line); border-radius: 8px;
  background: var(--surface); padding: 7px 11px; font-size: 11px; color: var(--muted);
  flex: 0 0 auto;
}
.mo-sp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
.mo-sp-title { font-size: 11px; font-weight: 650; color: var(--text); }
.mo-sp-more { border: 0; background: transparent; color: var(--accent-text); font-size: 11px; cursor: pointer; padding: 0; }
.mo-sp-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px 14px; }
.mo-sp-item { display: flex; align-items: center; gap: 6px; min-width: 0; }
.mo-sp-label { flex: 0 0 66px; color: var(--muted); }
.mo-sp-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-family: var(--mono, ui-monospace, Consolas, monospace); }
@media (max-height: 740px) {
  .mo-sp-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>

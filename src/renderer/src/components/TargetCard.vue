<template>
  <section class="glass target-card" aria-label="目标信息">
    <header class="tc-head">
      <span class="tc-title">目标信息</span>
      <button class="tc-recheck" type="button" title="重新体检当前目标里的墨桥条目" @click="emit('recheck')">重新体检</button>
    </header>

    <div class="tc-switch" role="group" aria-label="选择写入目标">
      <button type="button" :disabled="busy" :aria-pressed="(target || 'workbuddy') === 'workbuddy'" @click="emit('switch', 'workbuddy')">WorkBuddy</button>
      <button type="button" :disabled="busy" :aria-pressed="target === 'dsh'" @click="emit('switch', 'dsh')">DSH</button>
      <button type="button" :disabled="busy" :aria-pressed="target === 'mofang'" title="墨坊（jzWorkBuddy）· 写入其 config.json 的 providers" @click="emit('switch', 'mofang')">墨坊</button>
    </div>

    <p class="tc-path mono" :title="path">{{ path }}</p>

    <dl class="tc-facts">
      <div>
        <dt>客户端</dt>
        <dd :class="clientState.kind">{{ clientState.text }}</dd>
      </div>
      <div>
        <!-- 这里是三路合计：同一个文件里 opencode/atomcode/日日新 的条目都算。
             本页自己写了几条，看上方「配置信息」——两个数不一样是正常的。 -->
        <dt>墨桥条目（合计）</dt>
        <dd :class="owned ? 'ok' : 'na'">{{ owned ? owned + ' 条已写入' : '尚无条目' }}</dd>
      </div>
      <div v-if="summary">
        <dt>待写入</dt>
        <dd class="ok-soft">{{ summary }}</dd>
      </div>
    </dl>

    <p v-if="inspection?.note" class="tc-note">{{ inspection.note }}</p>

    <slot name="extra" />
  </section>
</template>

<script setup lang="ts">
// 右侧「目标信息」卡片（液态玻璃）：只回答"写到哪个文件、那里此刻是什么状态"。
//
// 叫「目标信息」而不是「写入目标」，是因为写入动作已经挪到它下面的独立卡片里
// （见 WriteCard）：这张卡负责"给事实"，那张卡负责"动手"。两者上下相邻，
// 切换目标时按钮措辞与路径同时变，不会出现"步骤让我写入、按钮却在别处"的割裂。
import { computed } from 'vue'
import type { TargetInspection } from '@shared/types'

const props = defineProps<{
  target: string
  path: string
  summary?: string
  inspection?: TargetInspection
  busy: boolean
}>()
const emit = defineEmits<{
  (e: 'switch', value: 'workbuddy' | 'dsh' | 'mofang'): void
  (e: 'recheck'): void
}>()

const owned = computed(() => props.inspection?.owned ?? 0)
const clientState = computed(() => {
  const info = props.inspection
  if (!info) return { text: '正在体检…', kind: 'na' as const }
  if (!info.available) return { text: '未检测到客户端配置', kind: 'na' as const }
  return { text: '配置已就位', kind: 'ok' as const }
})
</script>

<style scoped>
.target-card { display: flex; flex-direction: column; gap: 9px; padding: 13px 14px 14px; min-width: 0; }
.tc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.tc-title { font-size: 11px; font-weight: 650; letter-spacing: .04em; color: var(--muted); text-transform: uppercase; }
.tc-recheck { border: 0; background: transparent; color: var(--accent-text); font-size: 11px; padding: 0; cursor: pointer; }
.tc-recheck:hover { text-decoration: underline; }

.tc-switch {
  display: flex; align-items: center; gap: 2px; padding: 2px;
  border: 1px solid var(--glass-line, var(--line)); border-radius: 9px;
  background: var(--glass-inset, var(--surface));
}
.tc-switch button {
  flex: 1 1 auto; min-height: 24px; border: 0; border-radius: 7px; background: transparent;
  color: var(--muted); font-size: 11.5px; cursor: pointer; white-space: nowrap;
}
.tc-switch button:disabled { opacity: .55; cursor: default; }
.tc-switch button[aria-pressed="true"] { background: var(--selected); color: var(--accent-text); font-weight: 650; }

.tc-path {
  margin: 0; font-size: 10.5px; line-height: 1.5; color: var(--muted); overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}

.tc-facts { margin: 0; display: grid; gap: 4px; }
.tc-facts > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 11.5px; }
.tc-facts dt { color: var(--muted); flex: 0 0 auto; }
.tc-facts dd { margin: 0; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-facts dd.ok { color: var(--success-text); }
.tc-facts dd.na { color: var(--disabled-text); }
.tc-facts dd.ok-soft { color: var(--accent-text); }
.tc-note { margin: 0; font-size: 10.5px; line-height: 1.55; color: var(--disabled-text); }
</style>

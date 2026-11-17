<template>
  <nav class="rail" :data-collapsed="collapsed === true" aria-label="接入步骤">
    <div class="rail-head">
      <template v-if="!collapsed">
        <span class="rail-title">接入步骤</span>
        <span class="rail-pos">{{ positionText() }}</span>
      </template>
      <button class="rail-toggle" type="button" :title="collapsed ? '展开接入步骤' : '收起接入步骤'"
        :aria-expanded="collapsed !== true" @click="emit('toggle')">{{ collapsed ? '»' : '«' }}</button>
    </div>
    <ol class="rail-list">
      <li v-for="(step, i) in steps" :key="step.key" class="rail-item" :data-state="step.state" :data-active="step.key === active">
        <button type="button" class="rail-btn" :disabled="!reachable(step)"
          :aria-current="step.key === active ? 'step' : undefined"
          :title="step.label + (step.hint ? ' · ' + step.hint : '')"
          @click="emit('update:active', step.key)">
          <span class="rail-no" aria-hidden="true">{{ step.state === 'done' ? '✓' : step.state === 'error' ? '!' : i + 1 }}</span>
          <span v-if="!collapsed" class="rail-copy">
            <b>{{ step.label }}</b>
            <small v-if="step.hint">{{ step.hint }}</small>
          </span>
        </button>
      </li>
    </ol>
    <div v-if="!collapsed" class="rail-foot">
      <slot name="foot" />
    </div>
  </nav>
</template>

<script setup lang="ts">
// 竖向步骤栏：左侧占满整列。
// 「已完成的步骤」可以回看，未到达的步骤点不动——避免用户跳过前置条件直接看后面的空页面。
//
// 可收起：收起后只剩一列序号（44px 宽），把横向空间让给模型表。
// 收起状态由页面持有并持久化（见 composables/useRail），切页签也保持一致。
import type { RailStep } from '../utils/steps'

const props = defineProps<{ steps: RailStep[], active: string, collapsed?: boolean }>()
const emit = defineEmits<{
  (e: 'update:active', key: string): void
  (e: 'toggle'): void
}>()

function reachable(step: RailStep): boolean { return step.state !== 'todo' }
const index = () => props.steps.findIndex(step => step.key === props.active)
const positionText = () => `第 ${Math.max(1, index() + 1)} / ${props.steps.length} 步`
</script>

<style scoped>
.rail { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 10px; }
.rail-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 0 2px; min-height: 18px; }
.rail-title { font-size: 11px; font-weight: 650; letter-spacing: .04em; color: var(--muted); text-transform: uppercase; }
.rail-pos { font-size: 11px; color: var(--disabled-text); }
.rail-toggle {
  margin-left: auto; border: 0; background: transparent; color: var(--disabled-text);
  font-size: 13px; line-height: 1; padding: 2px 4px; border-radius: 5px; cursor: pointer;
}
.rail-toggle:hover { background: var(--hover); color: var(--text); }
.rail-list { list-style: none; margin: 0; padding: 0; flex: 1 1 auto; min-height: 0; }

.rail-item { position: relative; padding-bottom: 10px; }
.rail-item:last-child { padding-bottom: 0; }
/* 连接线：从本项的圆点下沿连到下一项的圆点上沿 */
.rail-item:not(:last-child)::after {
  content: ''; position: absolute; left: 12px; top: 30px; bottom: 2px; width: 1px;
  background: var(--line);
}
.rail-item[data-state="done"]:not(:last-child)::after { background: color-mix(in srgb, var(--success-dot) 55%, var(--line)); }

.rail-btn {
  display: flex; align-items: flex-start; gap: 9px; width: 100%;
  padding: 5px 8px 5px 4px; border: 1px solid transparent; border-radius: 10px;
  background: transparent; color: var(--text); text-align: left; cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
.rail-btn:hover:not(:disabled) { background: var(--hover); }
.rail-btn:disabled { cursor: default; }
.rail-btn:disabled .rail-copy b { color: var(--disabled-text); font-weight: 500; }

.rail-no {
  position: relative; z-index: 1; flex: 0 0 25px; width: 25px; height: 25px; border-radius: 50%;
  display: grid; place-items: center; font-size: 11px; font-weight: 700;
  background: var(--surface); border: 1px solid var(--line); color: var(--muted);
}
.rail-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding-top: 3px; }
.rail-copy b { font-size: 12.5px; font-weight: 600; line-height: 1.35; }
.rail-copy small { font-size: 11px; color: var(--muted); line-height: 1.4; overflow-wrap: anywhere; }

.rail-item[data-state="done"] .rail-no { background: var(--success-dot); border-color: transparent; color: #fff; }
.rail-item[data-state="error"] .rail-no { background: var(--error-dot); border-color: transparent; color: #fff; }
.rail-item[data-state="error"] .rail-copy b { color: var(--error-text); }
.rail-item[data-state="current"] .rail-no { background: var(--accent); border-color: transparent; color: #fff; }

.rail-item[data-active="true"] .rail-btn { background: var(--selected); border-color: color-mix(in srgb, var(--accent) 32%, transparent); }
.rail-item[data-active="true"] .rail-copy b { color: var(--accent-text); }

.rail-foot {
  flex: 0 0 auto; margin-top: auto; padding-top: 9px;
  border-top: 1px solid var(--subtle-line);
  font-size: 11px; color: var(--disabled-text); line-height: 1.6;
}

/* 收起态：只剩序号列，圆点居中，连接线跟着居中 */
.rail[data-collapsed="true"] .rail-btn { justify-content: center; padding: 3px 0; }
.rail[data-collapsed="true"] .rail-item:not(:last-child)::after { left: 50%; transform: translateX(-50%); }
.rail[data-collapsed="true"] .rail-head { justify-content: center; padding: 0; }
</style>

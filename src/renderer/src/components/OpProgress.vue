<template>
  <Transition name="op">
    <div v-if="op" class="op-bar glass" role="status" aria-live="polite">
      <span class="op-spin" aria-hidden="true" />
      <span class="op-label">{{ op.label }}</span>
      <span v-if="op.detail" class="op-detail">{{ op.detail }}</span>
      <span class="op-time">{{ seconds }}s</span>
      <span v-if="percent != null" class="op-track" aria-hidden="true"><i :style="{ width: percent + '%' }" /></span>
    </div>
  </Transition>
</template>

<script setup lang="ts">
// 常驻进度条：底部居中，只要服务在忙就一直挂着。
//
// 为什么需要它：写入/检测都要弹确认框，用户点完就回到页面，而这一轮操作
// 可能还在跑几十秒——之前只有"浮层通知"，4 秒后自己消失，于是页面看起来
// 什么都没发生。这条进度条不属于某一次提示，它跟着"服务此刻在忙什么"走，
// 弹窗关掉、切页签、切步骤都不影响它。
import { computed, onUnmounted, ref, watch } from 'vue'
import { currentOp } from '../composables/useService'

const op = computed(() => currentOp.value)

// 耗时从"这一轮操作开始"算：op 的身份会随 500ms 状态推送不断变新，
// 所以只在 label 变化时重置计时，不能盯着对象本身。
const seconds = ref(0)
let startedAt = Date.now()
let timer: number | null = null

function stop() {
  if (timer !== null) { window.clearInterval(timer); timer = null }
}

watch(() => op.value?.label, label => {
  stop()
  if (!label) { seconds.value = 0; return }
  startedAt = Date.now()
  seconds.value = 0
  timer = window.setInterval(() => { seconds.value = Math.round((Date.now() - startedAt) / 1000) }, 500)
}, { immediate: true })

onUnmounted(stop)

const percent = computed(() => {
  const ratio = op.value?.ratio
  return ratio == null ? null : Math.max(3, Math.min(100, Math.round(ratio * 100)))
})
</script>

<style scoped>
.op-bar {
  position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
  z-index: 2400; display: flex; align-items: center; gap: 9px;
  max-width: calc(100vw - 380px); padding: 7px 13px 7px 11px;
  border-radius: 999px; font-size: 12px; color: var(--text);
  pointer-events: none;
}
.op-spin {
  flex: 0 0 12px; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 28%, transparent);
  border-top-color: var(--accent);
  animation: op-rotate .9s linear infinite;
}
@keyframes op-rotate { to { transform: rotate(360deg); } }
.op-label { font-weight: 600; white-space: nowrap; }
.op-detail {
  min-width: 0; color: var(--muted); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.op-time { flex: 0 0 auto; color: var(--disabled-text); font-size: 11px; font-variant-numeric: tabular-nums; }
.op-track {
  flex: 0 0 96px; width: 96px; height: 3px; border-radius: 999px;
  background: var(--hover); overflow: hidden;
}
.op-track i { display: block; height: 100%; border-radius: 999px; background: var(--accent); transition: width .3s ease; }

.op-enter-active, .op-leave-active { transition: opacity .18s ease, transform .18s ease; }
.op-enter-from, .op-leave-to { opacity: 0; transform: translate(-50%, 8px); }
</style>

<template>
  <Transition name="op">
    <div v-if="op" class="op-bar glass" role="status" aria-live="polite">
      <span class="op-spin" aria-hidden="true" />
      <span class="op-label">{{ op.label }}</span>
      <span v-if="op.detail || stopping" class="op-detail">{{ stopping ? '已请求停止，等在跑的请求收尾…' : op.detail }}</span>
      <span class="op-time">{{ seconds }}s</span>
      <NButton v-if="stoppable" size="tiny" quaternary class="op-stop" :loading="stopping"
        :title="stopping ? '停止请求已受理，等在跑的请求收尾' : '停止本轮模型检测（已出的结论保留，未检测的标记为待检测）'"
        @click="stopProbe">{{ stopping ? '停止中' : '停止' }}</NButton>
      <span class="op-track" aria-hidden="true"><i /></span>
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
import { NButton } from 'naive-ui'
import { callAction, currentOp } from '../composables/useService'

const op = computed(() => currentOp.value)

// 「停止检测」只在检测类操作时出现（label 来自 useService 的 OP_LABEL，探测统一叫「检测模型」）。
const stoppable = computed(() => op.value?.label === '检测模型')
// 停止是协作式中断：probe-stop 只设标志位、立即返回，服务层要等在跑的探测请求收尾才退出。
// 「停止中」必须持续到浮层真正消失（op 清空），而不是 callAction 返回的那一刻——
// 否则按钮闪一下就恢复原样，用户以为点了没反应（已实锤的反馈）。
const stopping = ref(false)
async function stopProbe() {
  if (stopping.value) return
  stopping.value = true
  try { await callAction('probe-stop') } catch { stopping.value = false }
}
// 操作结束（浮层收起）或换成别的操作时，复位停止态，允许下一次点停。
watch(() => op.value?.label, label => { if (label !== '检测模型') stopping.value = false })

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
</script>

<style scoped>
.op-bar {
  position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%);
  z-index: 2400; display: flex; align-items: center; gap: 9px;
  max-width: calc(100vw - 380px); padding: 7px 13px 7px 11px;
  border-radius: 999px; font-size: 12px; color: var(--text);
  pointer-events: none;
}
/* 进度条本体不接鼠标（避免挡住下面的内容），但停止按钮必须可点。 */
.op-stop { pointer-events: auto; flex: 0 0 auto; color: var(--error-text); }
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
/* 不定态加载条：与启动页 .boot-track.indeterminate 完全同款的流动条纹。
   用户要的就是「动态感知」——从头到尾一直在动，不表百分比（百分比路线试过三轮：
   手绘细条、NProgress+缓动估算，感知都太弱，收尾还闪一个满格，全部废弃）。 */
.op-track {
  flex: 0 0 110px; height: 6px; border-radius: 999px;
  background: var(--hover); overflow: hidden;
}
.op-track i {
  display: block; width: 100%; height: 100%; border-radius: 999px;
  background: repeating-linear-gradient(45deg,
    var(--accent) 0 10px,
    color-mix(in srgb, var(--accent) 55%, transparent) 10px 20px);
  animation: op-stripes .8s linear infinite;
}
@keyframes op-stripes { to { background-position: 28px 0; } }

.op-enter-active, .op-leave-active { transition: opacity .18s ease, transform .18s ease; }
.op-enter-from, .op-leave-to { opacity: 0; transform: translate(-50%, 8px); }
</style>

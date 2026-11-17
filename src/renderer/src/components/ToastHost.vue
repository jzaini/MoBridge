<script setup lang="ts">
// 浮层通知：右下角叠加，不占页面高度。
// 结果类反馈（写入完成 / 检测结束 / 某步失败）走这里；破坏性操作仍然先弹确认框。
import { useToasts } from '../composables/useService'

const { toasts, dismissToast } = useToasts()
const MARK: Record<string, string> = { ok: '✓', error: '!', info: 'i' }
</script>

<template>
  <div class="toast-host" role="region" aria-label="操作结果通知">
    <TransitionGroup name="toast">
      <div v-for="item in toasts" :key="item.id" class="toast" :class="item.kind" role="status" aria-live="polite">
        <span class="toast-mark" aria-hidden="true">{{ MARK[item.kind] || 'i' }}</span>
        <p class="toast-text">{{ item.text }}</p>
        <button class="toast-x" type="button" aria-label="关闭通知" @click="dismissToast(item.id)">×</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  /* 放右下角：右上角是「写入目标」卡片的标题与重新体检入口，
     通知浮在那儿正好盖住用户下一步要点的东西。 */
  position: fixed; bottom: 16px; right: 16px; z-index: 3000;
  display: flex; flex-direction: column; gap: 8px; width: min(340px, calc(100vw - 32px));
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex; align-items: flex-start; gap: 9px;
  padding: 9px 10px 9px 11px; border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 10px 28px rgba(12, 20, 34, .18);
  font-size: 12px; line-height: 1.55; color: var(--text);
}
.toast.ok { border-color: color-mix(in srgb, var(--success-dot) 42%, var(--line)); }
.toast.error { border-color: color-mix(in srgb, var(--error-dot) 46%, var(--line)); }
.toast-mark {
  flex: 0 0 16px; width: 16px; height: 16px; margin-top: 1px; border-radius: 50%;
  display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff;
  background: var(--accent);
}
.toast.ok .toast-mark { background: var(--success-dot); }
.toast.error .toast-mark { background: var(--error-dot); }
.toast-text { margin: 0; flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.toast-x {
  flex: 0 0 auto; border: 0; background: transparent; color: var(--muted);
  font-size: 15px; line-height: 1; padding: 1px 2px; cursor: pointer;
}
.toast-x:hover { color: var(--text); }

.toast-enter-active, .toast-leave-active { transition: opacity .18s ease, transform .18s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(14px); }
</style>

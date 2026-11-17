<template>
  <NModal :show="show" @update:show="(v: boolean) => !v && emit('close')">
    <div class="mo-modal" role="dialog" aria-modal="true" :aria-label="title">
      <div class="mo-modal-head">
        <h3>{{ title }}</h3>
        <button class="mo-modal-x" type="button" aria-label="关闭" @click="emit('close')">×</button>
      </div>
      <div class="mo-modal-body"><slot /></div>
      <div class="mo-modal-foot">
        <NButton size="small" @click="emit('close')">取消</NButton>
        <NButton size="small" :type="danger ? 'error' : 'primary'" @click="emit('ok')">{{ okText || '确认' }}</NButton>
      </div>
    </div>
  </NModal>
</template>

<script setup lang="ts">
// 通用确认弹窗：写入/移除等破坏性操作执行前必须经过这里。
import { NModal, NButton } from 'naive-ui'

defineProps<{
  show: boolean
  title: string
  okText?: string
  danger?: boolean
}>()
const emit = defineEmits<{ (e: 'close'): void, (e: 'ok'): void }>()
</script>

<style scoped>
.mo-modal {
  width: min(520px, calc(100vw - 48px)); border-radius: 10px; overflow: hidden;
  background: var(--surface); color: var(--text); border: 1px solid var(--line);
}
.mo-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 13px 16px 9px; }
.mo-modal-head h3 { margin: 0; font-size: 14px; }
.mo-modal-x { border: 0; background: transparent; color: var(--muted); font-size: 17px; cursor: pointer; line-height: 1; padding: 2px 6px; border-radius: 6px; }
.mo-modal-x:hover { background: var(--hover); color: var(--text); }
.mo-modal-body { padding: 4px 16px 14px; font-size: 12.5px; }
.mo-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--subtle-line); }
</style>

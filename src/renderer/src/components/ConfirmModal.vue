<template>
  <NModal :show="show" @update:show="(v: boolean) => !v && emit('close')">
    <div class="mo-modal" role="dialog" aria-modal="true" :aria-label="title">
      <div class="mo-modal-head">
        <h3>{{ title }}</h3>
        <NButton size="tiny" quaternary circle class="mo-modal-x" aria-label="关闭" @click="emit('close')">×</NButton>
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
/* .mo-modal 骨架样式已全局化(styles/plan.css):ConfirmModal/DetailModal/EnvModal
   三处复用同一套 class,scoped 定义只命中本组件,另两个弹窗整个透明裸奔(已实锤)。 */
</style>

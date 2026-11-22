<template>
  <!-- 三页共用的表格工具行：全选 / 只勾选可用 / 全部取消 / 只看可用 / 摘要。
       「只勾选可用」是勾选动作（把可用模型标记为要写入），「只看可用」是表格筛选（只影响显示），
       两者语义不同、都保留；按钮 title 里把区别说清楚。 -->
  <div class="pane-toolbar">
    <label class="check-inline">
      <NCheckbox size="small" :checked="checked" :indeterminate="!!indeterminate" :disabled="!!checkAllDisabled"
        aria-label="全选或取消全选当前可见模型" @update:checked="(v: boolean) => emit('check-all', v)" />
      <span>全选</span>
    </label>
    <NButton size="tiny" :disabled="!!usableDisabled"
      title="把状态为「可用」的模型全部勾上——勾选=要写入，与上面的「只看可用」筛选（只影响显示）不同"
      @click="emit('select-usable')">只勾选可用（{{ usableCount }}）</NButton>
    <!-- 识图筛选：接入线有识图数据才显示（imageUsableCount 传了才渲染）。 -->
    <NButton v-if="imageUsableCount !== undefined" size="tiny"
      :disabled="!!usableDisabled || imageUsableCount === 0"
      title="把「可用且支持识图（对话可发图）」的模型全部勾上——现在的客户端调用早已不只有纯文本"
      @click="emit('select-image')">只勾选识图（{{ imageUsableCount }}）</NButton>
    <NButton size="tiny" :disabled="!!cancelDisabled" title="取消全部勾选" @click="emit('select-none')">全部取消</NButton>
    <label class="check-inline" title="只展示状态为「可用」的模型；关闭后展示全部。只影响表格显示，不改勾选">
      <NCheckbox size="small" :checked="!!onlyUsable" @update:checked="(v: boolean) => emit('update:onlyUsable', v)" />
      <span>只看可用</span>
    </label>
    <!-- 检测类按钮（刷新目录 / 检测全部 / 检测选中）由各页经 actions 插槽传入：
         它们操作的就是这张表格，放在表格工具行而不是页面右上角。 -->
    <div v-if="$slots.actions" class="toolbar-actions"><slot name="actions" /></div>
    <div class="toolbar-right">
      <span class="sel-strong">已选 {{ selectedCount }} 个</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// 三页（OpenCode / AtomCode / 日日新）的表格上方工具行，保证按钮顺序、文案与摘要口径一致。
// 全选 checkbox 语义统一为「勾选/取消当前可见的（可勾选）模型」；各页自行决定哪些行不可勾。
import { NCheckbox, NButton } from 'naive-ui'

defineProps<{
  /** 全选 checkbox 状态：可见可勾模型全部已勾 = true。 */
  checked: boolean
  /** 可见可勾模型部分已勾 = true（半选态）。 */
  indeterminate?: boolean
  checkAllDisabled?: boolean
  /** 「只勾选可用（N）」的 N：各页自己的可用模型数。 */
  usableCount: number
  usableDisabled?: boolean
  /** 「只勾选识图（N）」：传了才显示该按钮（接入线没有识图数据时不出现）。 */
  imageUsableCount?: number
  cancelDisabled?: boolean
  /** v-model:only-usable：只看可用筛选开关。 */
  onlyUsable?: boolean
  selectedCount: number
}>()
const emit = defineEmits<{
  (e: 'check-all', next: boolean): void
  (e: 'select-usable'): void
  (e: 'select-image'): void
  (e: 'select-none'): void
  (e: 'update:onlyUsable', value: boolean): void
}>()
</script>

<style scoped>
/* pane-toolbar 与 toolbar-right 的基础样式在共享 plan.css；这里只补组件私有的两处。 */
.check-inline { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); cursor: pointer; }
.toolbar-actions { display: inline-flex; align-items: center; gap: 6px; margin-left: 6px; padding-left: 10px; border-left: 1px solid var(--line); }
.sel-strong { color: var(--text); font-weight: 650; }
</style>

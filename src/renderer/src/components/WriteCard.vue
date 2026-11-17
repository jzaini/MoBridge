<template>
  <section class="glass write-card" aria-label="写入配置">
    <header class="wc-head">
      <span class="wc-title">写入配置</span>
      <span class="wc-count">{{ count }} 个模型</span>
    </header>

    <p class="wc-lead">写进 <b>{{ targetName }}</b>：只替换墨桥写入的条目，其它工具与你手写的配置原样保留。</p>

    <NButton class="wc-btn" type="primary" size="small" block :disabled="writeDisabled" @click="emit('write')">
      {{ writeLabel }}
    </NButton>
    <p v-if="writeHint" class="wc-reason warn">{{ writeHint }}</p>

    <!-- 移除是危险操作，但不用粉红实心：和主按钮并排时两种填色会互相打架。
         ghost 描边保留红色语义，同时跟整排「描边次按钮」是同一种气质。 -->
    <NButton class="wc-btn" size="small" block ghost type="error" :disabled="removeDisabled" @click="emit('remove')">
      移除配置
    </NButton>
    <p v-if="removeHint" class="wc-reason">{{ removeHint }}</p>

    <details v-if="previewList.length" class="wc-preview">
      <summary>写入后客户端里会看到</summary>
      <div class="wc-chips">
        <span v-for="name in previewList" :key="name" class="wc-chip">{{ name }}</span>
        <span v-if="(preview || []).length > previewList.length" class="wc-more">…等 {{ (preview || []).length }} 个</span>
      </div>
    </details>
  </section>
</template>

<script setup lang="ts">
// 右侧「写入配置」卡片：紧跟在「目标信息」下面。
//
// 为什么把写入放在这里、而不是流程的第三步里：三个接入页的"写"是同一个动作，
// 目标又能随时切换（WorkBuddy / DSH / 墨坊）。放在目标卡正下方，用户改完目标
// 抬头就能看到按钮措辞跟着变了（写入 WorkBuddy / 写入 DSH / 写入墨坊），
// 而不是先在第三步读一遍复核、再回右边找按钮。
//
// 按钮为什么带一行常显的说明：写不进去的原因必须一直看得见。
// 只挂 title 的话，用户点下去只会觉得"没反应"——这正是上一版被投诉的地方。
import { computed } from 'vue'
import { NButton } from 'naive-ui'

const props = defineProps<{
  targetName: string
  writeLabel: string
  count: number
  writeDisabled: boolean
  writeReason: string
  removeDisabled: boolean
  removeReason: string
  /** 写入后客户端里会看到的模型名（前几个足够说明问题）。 */
  preview?: string[]
}>()
const emit = defineEmits<{ (e: 'write'): void, (e: 'remove'): void }>()

// 说明只在"不能点"时出现；能点的时候不占版面。
const writeHint = computed(() => (props.writeDisabled ? props.writeReason : ''))
const removeHint = computed(() => (props.removeDisabled ? props.removeReason : ''))
const previewList = computed(() => (props.preview || []).slice(0, 6))
</script>

<style scoped>
.write-card { display: flex; flex-direction: column; gap: 8px; padding: 13px 14px 14px; min-width: 0; }
.wc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.wc-title { font-size: 11px; font-weight: 650; letter-spacing: .04em; color: var(--muted); text-transform: uppercase; }
.wc-count { font-size: 11px; color: var(--accent-text); font-weight: 650; }
.wc-lead { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--muted); }
.wc-lead b { color: var(--text); font-weight: 650; }
.wc-btn { margin-top: 2px; }
.wc-reason { margin: 0; font-size: 10.5px; line-height: 1.55; color: var(--disabled-text); }
.wc-reason.warn { color: var(--warning-text); }

.wc-preview { margin-top: 2px; font-size: 11px; color: var(--muted); }
.wc-preview summary { cursor: pointer; color: var(--accent-text); }
.wc-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.wc-chip {
  max-width: 100%; padding: 1px 8px; border-radius: 999px; font-size: 10.5px;
  border: 1px solid var(--subtle-line); background: var(--detail-background); color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wc-more { font-size: 10.5px; color: var(--disabled-text); }
</style>

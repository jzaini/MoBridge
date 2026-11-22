<template>
  <section class="glass write-card" aria-label="写入配置">
    <!-- Trae 引导式接入：实测直写不可行（Trae 云端重建清单 + Key 自有加密），
         改为给出逐项可复制的填写参数 + 清理残留条目按钮。 -->
    <template v-if="guide">
      <header class="wc-head">
        <span class="wc-title">Trae · 引导式接入</span>
        <span class="wc-count">{{ guide.models.length }} 个模型</span>
      </header>
      <p class="wc-lead">Trae 会用云端数据重建模型清单、并把 Key 用自有算法加密——墨桥直写必然失效。点下方按钮查看配置引导：参数逐项可复制，在 Trae 里手动添加一次即可长期使用。</p>
      <NButton class="wc-btn" type="primary" size="small" block @click="guideOpen = true">查看配置引导</NButton>
      <NButton v-if="!removeDisabled" class="wc-btn" size="small" block ghost type="error" @click="emit('remove')">
        清理墨桥残留条目（需先退出 Trae）
      </NButton>
      <NModal v-model:show="guideOpen" preset="card" title="Trae 配置引导" class="guide-modal" :style="{ maxWidth: '520px' }">
        <p class="wc-lead">在 Trae「设置 → 模型 → 添加模型 → 自定义模型」里按下表填写，添加一次长期有效。</p>
        <div class="wc-kv"><span>API 格式</span><b>OpenAI Chat Completions 格式</b></div>
        <div class="wc-kv"><span>请求地址（完整 URL）</span><b class="mono">{{ guide.address }}</b></div>
        <div class="wc-actions">
          <NButton size="tiny" @click="copyAddress">{{ copied === 'address' ? '已复制' : '复制地址' }}</NButton>
          <NButton size="tiny" @click="copyKey">{{ copied === 'key' ? '已复制到剪贴板' : '复制 API Key' }}</NButton>
        </div>
        <div class="wc-kv"><span>API Key</span><b>点上方按钮复制（不在页面显示）</b></div>
        <div class="wc-kv"><span>模型 ID（在 Trae 里逐个添加）</span></div>
        <NSelect v-model:value="selectedModel" size="small" :options="modelOptions" placeholder="选择要添加的模型" />
        <div class="wc-actions" style="margin-top: 6px">
          <NButton size="tiny" type="primary" :disabled="!selectedModel" @click="copySelected">{{ copied === 'model' ? '已复制' : '复制模型 ID' }}</NButton>
        </div>
        <div v-if="selectedMeta" class="wc-cap">
          <span class="wc-cap-title">该模型的能力（对应 Trae「高级配置」的填写建议）</span>
          <div class="wc-kv"><span>上下文窗口</span><b>{{ selectedMeta.context ? selectedMeta.context.toLocaleString() + ' tokens（高级配置里填这个值）' : '未公开，留空用默认' }}</b></div>
          <div class="wc-kv"><span>视觉 / 图片输入</span><b>{{ selectedMeta.images ? '支持 → 可打开「支持图片输入」开关' : '不支持 → 开关保持关闭，否则请求会被 400 拒绝' }}</b></div>
          <div class="wc-kv"><span>思考模式</span><b>{{ selectedMeta.levels.length ? '支持 → 参数名 reasoning_effort，可选值：' + selectedMeta.levels.join(' / ') : '不支持 → 思考模式保持关闭' }}</b></div>
        </div>
      </NModal>
    </template>
    <template v-else>
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
    </template>
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
import { computed, ref, watch } from 'vue'
import { NButton, NModal, NSelect } from 'naive-ui'
import { callAction } from '../composables/useService'

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
  /** Trae 引导模式：地址 + 复制密钥的动作名 + 逐个要填的模型 ID。 */
  guide?: { address: string, keyAction: string, models: string[] } | null
  /** 模型能力表（键 = 模型 ID）：选中后在弹窗里展示，指导 Trae 高级配置怎么填。 */
  meta?: Record<string, { context: number | null, images: boolean, levels: string[] }> | null
}>()
const emit = defineEmits<{ (e: 'write'): void, (e: 'remove'): void }>()

// 说明只在"不能点"时出现；能点的时候不占版面。
const writeHint = computed(() => (props.writeDisabled ? props.writeReason : ''))
const removeHint = computed(() => (props.removeDisabled ? props.removeReason : ''))
const previewList = computed(() => (props.preview || []).slice(0, 6))
const copied = ref('')
async function copyText(text: string, tag = 'text') {
  try { await navigator.clipboard.writeText(text); copied.value = tag } catch { copied.value = '' }
}
function copyAddress() { if (props.guide) void copyText(props.guide.address, 'address') }
async function copyKey() { if (props.guide) { await callAction(props.guide.keyAction, undefined, 15000); copied.value = 'key' } }
// 引导弹窗：勾选的模型做成下拉列表，选中即可复制。
const guideOpen = ref(false)
const selectedModel = ref('')
const modelOptions = computed(() => (props.guide?.models || []).map(name => ({ label: name, value: name })))
function copySelected() { if (selectedModel.value) void copyText(selectedModel.value, 'model') }
const selectedMeta = computed(() => (selectedModel.value ? props.meta?.[selectedModel.value] ?? null : null))
watch(guideOpen, open => { if (open && !selectedModel.value) selectedModel.value = props.guide?.models?.[0] ?? '' })
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
.wc-kv { display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; color: var(--muted); }
.wc-kv b { color: var(--text); font-weight: 600; font-size: 11px; overflow-wrap: anywhere; }
.wc-kv b.mono { font-family: var(--mono, ui-monospace, monospace); }
.wc-actions { display: flex; gap: 6px; }
.wc-cap { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; padding: 10px 12px; border-radius: 10px; background: var(--hover, rgba(0, 0, 0, .04)); }
.wc-cap-title { font-size: 11px; font-weight: 650; color: var(--accent-text); }
</style>

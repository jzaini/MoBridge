<template>
  <section class="glass config-card" aria-label="接入信息">
    <header class="cc-head">
      <span class="cc-title">接入信息</span>
      <span class="cc-badge" :class="owned ? 'ok' : 'na'">{{ owned ? '已写入 ' + owned + ' 个' : '未写入' }}</span>
    </header>

    <dl class="cc-facts">
      <div v-for="row in rows" :key="row.label">
        <dt>{{ row.label }}</dt>
        <dd :class="[{ mono: row.mono }, row.kind || '']" :title="row.title || row.value">{{ row.value }}</dd>
      </div>
    </dl>

    <div v-if="ids.length" class="cc-models">
      <span class="cc-models-label">客户端里的墨桥条目</span>
      <div class="cc-chips">
        <span v-for="id in shown" :key="id" class="cc-chip" :title="id">{{ id }}</span>
        <span v-if="restCount" class="cc-more">…等 {{ ids.length }} 个</span>
      </div>
    </div>
    <p v-else class="cc-empty">当前目标里还没有本页写入的条目；写入后这里会列出具体模型。</p>

    <p v-if="others.length" class="cc-other">同一份配置里还有 {{ others.join('、') }}，那不是本页写的。</p>
  </section>
</template>

<script setup lang="ts">
// 「接入信息」卡片：常驻在目标信息上方，回答"这条接入线此刻是什么样的"。
//
// 之前这张卡放的是「目标」和「最近写入」——那是"写到哪、写了几次"，
// 属于下方「目标信息」和通知的职责，重复且答非所问。用户要看的是：
// OpenCode 装没装、什么版本、走哪个口；AtomCode 登录了谁、什么套餐；
// 日日新 Key 是哪一把、接口地址是不是被改过。
// 这些事实原本散在三个页面的不同步骤里（有的还得点开弹窗），所以这里做成常驻冗余卡：
// 内容重复没关系，选模型的时候一眼能看全才算有用。
//
// 行由各页面自己给（rows），因为三条线的字段天然不同；卡片只负责排班与统一的视觉。
import { computed } from 'vue'
import type { TargetInspection } from '@shared/types'

export interface InfoRow {
  label: string
  value: string
  /** 等宽字体：路径、地址、Key 这类逐字符读的内容用。 */
  mono?: boolean
  kind?: 'ok' | 'warn' | 'na'
  /** 悬停补充说明：值被截断时还能看全。 */
  title?: string
}

const props = defineProps<{
  route: string
  rows: InfoRow[]
  inspection?: TargetInspection
}>()

const ROUTE_LABEL: Record<string, string> = { opencode: 'OpenCode', atomcode: 'AtomCode', sensenova: '日日新' }

/** 本线独占的条数。老配置认不出归属时 sources 缺这项，退回总数以免凭空说"未写入"。 */
const mine = computed(() => props.inspection?.sources?.[props.route] || null)
const owned = computed(() => mine.value?.count ?? props.inspection?.owned ?? 0)
/** 同目标里其它接入线留下的条目：不是我们的，但铺在用户眼皮底下，不说明白会以为写重了。 */
const others = computed(() => {
  const sources = props.inspection?.sources
  if (!sources) return []
  return Object.entries(sources)
    .filter(([key, item]) => key !== props.route && (item?.count || 0) > 0)
    .map(([key, item]) => `${ROUTE_LABEL[key] || key} 的 ${item.count} 条`)
})
const ids = computed(() => {
  const own = mine.value?.ids
  if (own) return own.filter(Boolean)
  return (props.inspection?.ids || []).filter(Boolean)
})
const shown = computed(() => ids.value.slice(0, 6))
const restCount = computed(() => Math.max(0, ids.value.length - shown.value.length))
</script>

<style scoped>
.config-card { display: flex; flex-direction: column; gap: 8px; padding: 13px 14px 14px; min-width: 0; }
.cc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.cc-title { font-size: 11px; font-weight: 650; letter-spacing: .04em; color: var(--muted); text-transform: uppercase; }
.cc-badge { font-size: 11px; font-weight: 650; color: var(--accent-text); }
.cc-badge.ok { color: var(--success-text); }
.cc-badge.na { color: var(--disabled-text); }

.cc-facts { margin: 0; display: grid; gap: 4px; }
.cc-facts > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 11.5px; }
.cc-facts dt { flex: 0 0 auto; color: var(--muted); }
.cc-facts dd { margin: 0; min-width: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-facts dd.ok { color: var(--success-text); }
.cc-facts dd.warn { color: var(--warning-text); }
.cc-facts dd.na { color: var(--disabled-text); }

.cc-models { display: flex; flex-direction: column; gap: 5px; }
.cc-models-label { font-size: 10.5px; color: var(--disabled-text); }
.cc-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.cc-chip {
  max-width: 100%; padding: 1px 8px; border-radius: 999px; font-size: 10.5px;
  border: 1px solid var(--subtle-line); background: var(--detail-background); color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cc-more { font-size: 10.5px; color: var(--disabled-text); }
.cc-empty { margin: 0; font-size: 10.5px; line-height: 1.55; color: var(--disabled-text); }
.cc-other { margin: 0; padding-top: 6px; border-top: 1px dashed var(--subtle-line); font-size: 10.5px; line-height: 1.5; color: var(--muted); }
</style>

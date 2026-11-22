<script setup lang="ts">
// 通知中心：顶栏的铃铛 + 历史列表 + 单条详情。
//
// 之前只有右下角浮层，4 秒后自动消失——用户去倒了杯水回来，就再也看不到
// 「刚才写入到底成功了没有」「那句英文报错写的什么」。通知必须留档可回看，
// 所以这里把每条通知都收进 localStorage（最多 200 条），点开能看完整原文。
import { computed, onUnmounted, ref, watch } from 'vue'
import { NModal, NButton } from 'naive-ui'
import { useNotices, type NoticeItem } from '../composables/useService'

const { notices, unreadCount, markNoticeRead, markAllNoticesRead, clearNotices } = useNotices()

const open = ref(false)
const detail = ref<NoticeItem | null>(null)
const root = ref<HTMLElement | null>(null)

function toggle() { open.value = !open.value }
function close() { open.value = false }

// 点面板外面收起来：面板是常驻在顶栏上的，不收会挡住下面的内容。
function onDocumentPointerDown(event: PointerEvent) {
  if (!open.value) return
  if (root.value && !root.value.contains(event.target as Node)) close()
}
document.addEventListener('pointerdown', onDocumentPointerDown, true)
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('keydown', onKeydown)
})

function onKeydown(event: KeyboardEvent) { if (event.key === 'Escape') { close(); detail.value = null } }
document.addEventListener('keydown', onKeydown)

// 打开面板就算"看过这一屏"：红点消失，但条目不删。
watch(open, value => { if (value) markAllNoticesRead() })

function openDetail(item: NoticeItem) {
  detail.value = item
  markNoticeRead(item.id)
}

const badge = computed(() => (unreadCount.value > 99 ? '99+' : String(unreadCount.value)))

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
function timeText(at: number): string {
  const diff = Date.now() - at
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return Math.floor(diff / MINUTE) + ' 分钟前'
  if (diff < DAY) return Math.floor(diff / HOUR) + ' 小时前'
  const d = new Date(at)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (sameYear ? '' : d.getFullYear() + '-') + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function fullTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const MARK: Record<string, string> = { ok: '✓', error: '!', info: 'i' }
</script>

<template>
  <div ref="root" class="notice-root">
    <NButton size="small" quaternary class="notice-btn" :class="{ active: open }" :aria-expanded="open"
      :title="unreadCount ? `通知中心（${unreadCount} 条未读）` : '通知中心'" @click="toggle">
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none"
        stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
        <path d="M10.3 20a2 2 0 0 0 3.4 0" />
      </svg>
      <span v-if="unreadCount" class="notice-badge">{{ badge }}</span>
    </NButton>

    <div v-if="open" class="notice-panel" role="dialog" aria-label="通知历史">
      <header class="np-head">
        <span class="np-title">通知历史</span>
        <span class="np-count">{{ notices.length }} 条</span>
        <NButton size="tiny" text class="np-link" :disabled="!notices.length" @click="clearNotices">清空</NButton>
      </header>

      <div v-if="!notices.length" class="np-empty">还没有通知。检测、写入、登录这些动作的结果都会记在这里，关掉浮层也能回看。</div>

      <ul v-else class="np-list">
        <li v-for="item in notices" :key="item.id">
          <button class="np-item" type="button" :class="[item.kind, { unread: !item.read }]" @click="openDetail(item)">
            <span class="np-mark" aria-hidden="true">{{ MARK[item.kind] || 'i' }}</span>
            <span class="np-copy">
              <span class="np-text">{{ item.text }}</span>
              <span class="np-meta">
                <span v-if="item.source" class="np-source">{{ item.source }}</span>{{ timeText(item.at) }}<template v-if="item.detail"> · 含详情</template>
              </span>
            </span>
          </button>
        </li>
      </ul>
    </div>

    <NModal :show="!!detail" @update:show="(v: boolean) => { if (!v) detail = null }">
      <div v-if="detail" class="np-detail" role="dialog" aria-modal="true" aria-label="通知详情">
        <header class="np-detail-head">
          <div>
            <h3>{{ detail.kind === 'error' ? '失败' : detail.kind === 'ok' ? '完成' : '提示' }}<span v-if="detail.source" class="np-source">{{ detail.source }}</span></h3>
            <p>{{ fullTime(detail.at) }}</p>
          </div>
          <NButton size="tiny" quaternary circle class="np-detail-x" aria-label="关闭" @click="detail = null">×</NButton>
        </header>
        <p class="np-detail-text">{{ detail.text }}</p>
        <template v-if="detail.detail">
          <h4 class="np-detail-sub">原始输出</h4>
          <pre class="np-detail-raw">{{ detail.detail }}</pre>
        </template>
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.notice-root { position: relative; display: inline-flex; }
.notice-btn {
  position: relative; display: inline-grid; place-items: center;
  width: 30px; height: 28px; border-radius: 8px; padding: 0;
}
.notice-badge {
  position: absolute; top: -5px; right: -5px; min-width: 15px; height: 15px; padding: 0 4px;
  border-radius: 999px; background: var(--error-dot); color: #fff;
  font-size: 9.5px; font-weight: 700; line-height: 15px; text-align: center;
}

.notice-panel {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 2600;
  width: min(380px, calc(100vw - 40px)); max-height: min(64vh, 520px);
  display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 18px 44px rgba(12, 20, 34, .22);
}
.np-head {
  display: flex; align-items: baseline; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid var(--subtle-line);
}
.np-title { font-size: 12px; font-weight: 650; }
.np-count { font-size: 11px; color: var(--disabled-text); }
.np-link { margin-left: auto; }
.np-empty { padding: 22px 16px; font-size: 11.5px; line-height: 1.7; color: var(--muted); }
.np-list { list-style: none; margin: 0; padding: 4px; overflow-y: auto; }

.np-item {
  display: flex; align-items: flex-start; gap: 9px; width: 100%;
  padding: 8px 9px; border: 0; border-radius: 8px; background: transparent;
  text-align: left; cursor: pointer; color: var(--text);
}
.np-item:hover { background: var(--hover); }
.np-item.unread { background: var(--selected); }
.np-mark {
  flex: 0 0 15px; width: 15px; height: 15px; margin-top: 2px; border-radius: 50%;
  display: grid; place-items: center; font-size: 9.5px; font-weight: 700; color: #fff;
  background: var(--accent);
}
.np-item.ok .np-mark { background: var(--success-dot); }
.np-item.error .np-mark { background: var(--error-dot); }
.np-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.np-text {
  font-size: 11.5px; line-height: 1.55; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.np-meta { font-size: 10.5px; color: var(--disabled-text); }
/* 来源标识：日日新 / AtomCode 各贴各的签，没标的都是系统级通知。 */
.np-source {
  display: inline-block; margin: 0 6px 0 0; padding: 0 5px; border-radius: 4px;
  font-size: 10px; font-weight: 650; line-height: 15px; vertical-align: 1px;
  background: var(--selected); color: var(--accent-text);
}

.np-detail {
  width: min(560px, 92vw); background: var(--surface); border-radius: 12px; padding: 16px 18px;
  border: 1px solid var(--subtle-line); box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
}
.np-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.np-detail-head h3 { margin: 0; font-size: 14px; }
.np-detail-head p { margin: 4px 0 0; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.np-detail-x { font-size: 16px; }
.np-detail-text { margin: 12px 0 0; font-size: 12.5px; line-height: 1.7; color: var(--text); overflow-wrap: anywhere; }
.np-detail-sub { margin: 14px 0 6px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.np-detail-raw {
  margin: 0; max-height: 240px; overflow: auto; padding: 9px 11px; border-radius: 8px;
  background: var(--detail-background); border: 1px solid var(--subtle-line);
  font-family: var(--mono); font-size: 11px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere;
}
</style>

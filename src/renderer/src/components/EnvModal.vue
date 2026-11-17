<script setup lang="ts">
// 环境信息弹窗：状态面板之外的明细（连接与鉴权 / 写入记录），关键字段带绿/灰状态点。
import { computed } from 'vue'
import { NModal, NButton } from 'naive-ui'
import { targetLabel, targetPathOf, syncCountText } from '../utils/target'

const props = defineProps<{ show: boolean, state: Record<string, any> }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const PHASE_LABEL: Record<string, string> = { starting: '启动中', reading: '读取中', ready: '就绪', error: '出错', stopped: '已停止' }
const fmt = (iso?: string) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}
function targetPath(s: Record<string, any>): string {
  return targetPathOf(s as never)
}
const groups = computed(() => {
  const s = props.state
  const sync = s.sync || {}
  const target = targetLabel(s.target)
  return [
    {
      title: '连接与鉴权',
      pairs: [
        ['服务阶段', PHASE_LABEL[s.phase] || s.phase || '—', s.phase === 'ready' ? 'ok' : s.phase === 'error' ? 'error' : 'na'],
        ['转发口', s.endpoint || '尚未启动', s.endpoint ? 'ok' : 'na'],
        ['服务进程', s.pid ? 'PID ' + s.pid : '—', ''],
        ['应用版本', s.version || '—', ''],
        ['OpenCode 版本', s.opencodeVersion || '—', ''],
        ['系统代理', (s.useSystemProxy === true ? '开启' : '关闭') + '（唯一开关在上方写入目标区）', ''],
        ['鉴权方式', '本机令牌 · 仅主进程持有，不下发页面', ''],
      ] as Array<[string, string, string]>,
    },
    {
      title: '写入记录',
      pairs: [
        ['写入目标', target, ''],
        ['目标文件', targetPath(s), ''],
        ['上次同步', sync.time ? fmt(sync.time) + ' · ' + targetLabel(sync.target) + ' · ' + syncCountText(sync) : '尚未写入', sync.time ? 'ok' : 'na'],
        ['配置查找', s.configSearch?.running ? '进行中' : (s.modelsFile ? '已定位' : '未定位'), !s.configSearch?.running && s.modelsFile ? 'ok' : 'na'],
        ['DSH profiles', (s.dsh?.profiles || []).join('、') || '未检测到', ''],
        ['墨坊 providers', (s.mofang?.providers || []).join('、') || (s.mofang?.exists ? '尚无 provider' : '未检测到配置'), ''],
        ['更新时间', fmt(s.updatedAt), ''],
      ] as Array<[string, string, string]>,
    },
  ]
})
</script>

<template>
  <NModal :show="show" @update:show="(v: boolean) => !v && emit('close')">
    <div class="mo-modal mo-env-modal" role="dialog" aria-modal="true" aria-label="环境信息">
      <div class="mo-modal-head">
        <h3>环境信息</h3>
        <button class="mo-modal-x" type="button" aria-label="关闭" @click="emit('close')">×</button>
      </div>
      <div class="mo-modal-body">
        <p class="mo-env-note">上方状态面板已显示服务概览，这里只列连接、写入记录与说明等明细。</p>
        <section v-for="g in groups" :key="g.title" class="mo-env-group">
          <h4>{{ g.title }}</h4>
          <dl class="mo-env-grid">
            <template v-for="([label, value, kind]) in g.pairs" :key="label">
              <dt>{{ label }}</dt>
              <dd :title="String(value)">
                <i v-if="kind" class="mo-dot" :class="kind" style="margin-right:6px"></i>{{ value }}
              </dd>
            </template>
          </dl>
        </section>
        <p class="mo-env-note">模型清单来自 OpenCode 官方目录静态快照（非实时接口）；接口与配置仅保存在本机。检测会向每个模型发极小请求，使用少量免费额度。</p>
      </div>
      <div class="mo-modal-foot">
        <NButton size="small" @click="emit('close')">关闭</NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.mo-env-modal { width: min(560px, calc(100vw - 48px)); }
.mo-env-note { margin: 0 0 10px; font-size: 11.5px; color: var(--muted); }
.mo-env-group { margin-bottom: 14px; }
.mo-env-group h4 { margin: 0 0 7px; font-size: 12px; color: var(--text); }
.mo-env-grid {
  display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 5px 12px; margin: 0;
}
.mo-env-grid dt { color: var(--muted); font-size: 11.5px; }
.mo-env-grid dd {
  margin: 0; word-break: break-all; font-size: 11.5px;
  font-family: var(--mono, ui-monospace, Consolas, monospace);
}
/* dd 不是 flex 容器：状态圆点要显式 inline-block 才有宽高 */
.mo-env-grid dd :deep(.mo-dot) { display: inline-block; vertical-align: -1px; }
</style>

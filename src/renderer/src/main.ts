import { createApp } from 'vue'
import naive from 'naive-ui'
import App from './App.vue'
import './styles/global.css'
import './styles/plan.css'

// 临时诊断：白屏排查——把未捕获错误带完整堆栈打出来（主进程 console-message 会转发）。
window.addEventListener('unhandledrejection', e => console.error('[diag] unhandledrejection:', (e.reason && (e.reason as Error).stack) || String(e.reason)))
window.addEventListener('error', e => console.error('[diag] error:', (e.error as Error)?.stack || e.message))

const app = createApp(App)
app.config.errorHandler = (err, instance, info) => {
  const name = (instance as unknown as { $options?: { name?: string, __name?: string } })?.$options?.__name
    || (instance as unknown as { type?: { __name?: string } })?.type?.__name || 'unknown'
  console.error(`[diag-vue] 组件=${name} 阶段=${info}`, (err as Error)?.stack || String(err))
}
app.use(naive).mount('#app')

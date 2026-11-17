import { ref, computed } from 'vue'

// 主题三态：跟随系统 / 浅色 / 深色。渲染层主导 UI 主题，
// 同时同步主进程 nativeTheme 让窗口标题栏跟随（ choice 持久化在本机）。
export type ThemeChoice = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'mobridge-theme'
const choice = ref<ThemeChoice>('system')
const systemDark = ref(false)
let started = false

function resolveDark(): boolean {
  if (choice.value === 'dark') return true
  if (choice.value === 'light') return false
  return systemDark.value
}
const isDark = computed(resolveDark)

function apply() {
  document.documentElement.classList.toggle('dark', resolveDark())
}

export function useTheme() {
  if (!started) {
    started = true
    try { choice.value = (localStorage.getItem(STORAGE_KEY) as ThemeChoice) || 'system' } catch { /* 隐私模式 */ }
    try {
      systemDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => { systemDark.value = e.matches; apply() })
    } catch { /* 非标准环境 */ }
    // 系统模式下跟随主进程 nativeTheme（Electron 的 prefers-color-scheme 由它驱动）
    window.bridge?.onNativeThemeChanged?.(dark => { systemDark.value = dark; apply() })
    apply()
  }
  function set(value: ThemeChoice) {
    choice.value = value
    try { localStorage.setItem(STORAGE_KEY, value) } catch { /* 隐私模式 */ }
    apply()
    window.bridge?.setThemeSource?.(value)
  }
  return { choice, isDark, set }
}

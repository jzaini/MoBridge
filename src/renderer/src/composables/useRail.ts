import { ref } from 'vue'

// 步骤栏收起状态：三个接入页共用一份，切页签不会又弹回来。
// 收起是用户的偏好（想看更宽的模型表），所以持久化到 localStorage。
const KEY = 'mobridge-rail-collapsed'
function load(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}
export const railCollapsed = ref(load())

export function toggleRail() {
  railCollapsed.value = !railCollapsed.value
  try { localStorage.setItem(KEY, railCollapsed.value ? '1' : '0') } catch { /* 隐私模式忽略 */ }
}

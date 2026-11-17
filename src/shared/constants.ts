// 墨桥与墨坊家族共享的常量：主进程、渲染层都可能用到。
// 外链白名单：只有这些官方域名的 https 链接允许唤起系统浏览器，
// 其余一律拒绝（Electron 窗口不承载远端内容）。
export const APP_NAME = '墨桥'
export const APP_ID = 'com.mofang.mobridge'

// ── 本地端口 ────────────────────────────────────────────────────────────
// 墨桥自己的默认端口，与任何旧项目无关：41980/41982 是上一代产品的号段，
// 沿用它会让人误以为两者还连着，也容易和旧实例撞端口。
// 31280 起、AtomCode 用 31282（主端口 + 2）：在注册端口段内、不与常见服务冲突，
// 而且一眼能认出是墨桥的。
// 两条都在设置面板里可改（settings.json 的 port / atomcodePort）。
export const DEFAULT_SERVICE_PORT = 31280
export const DEFAULT_ATOMCODE_PORT = 31282

/** AtomCode 转发口留空时的推导规则：主端口 + 2。 */
export function deriveAtomcodePort(mainPort: number): number {
  return Math.min(65535, Number(mainPort) + 2)
}

export const EXTERNAL_HOSTS = [
  // 日日新（商汤）开放平台
  'platform.sensenova.cn',
  'token.sensenova.cn',
  // AtomCode（AtomGit CodingPlan）
  'atomcode.atomgit.com',
  'atomgit.com',
]

export function isAllowedExternal(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:' && EXTERNAL_HOSTS.includes(url.hostname)) return url.toString()
  } catch { /* 非 URL 一律拒绝 */ }
  return null
}

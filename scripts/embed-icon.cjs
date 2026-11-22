// afterPack 钩子：给 win-unpacked 的 exe 嵌入应用图标。
//
// 为什么不用 electron-builder 自带的 signAndEditExecutable（rcedit）？
// 它要先解压 winCodeSign 工具包，包里带几个 macOS 符号链接文件；Windows 普通用户
// 没有「创建符号链接」特权，解压必失败（除非开开发人员模式/管理员运行）。
// 图标嵌入本身只是普通的 exe 资源写入，不需要任何特权——所以这里用项目自带的
// rcedit（scripts/bin/rcedit-x64.exe，来自 electron-builder 缓存的官方工具）直接嵌，
// build-win.mjs 继续跳过 signAndEditExecutable，两边互不干扰。
//
// ICO 用 PNG-in-ICO 格式（Vista+ 支持）：256px PNG 原样作为单条目，无需转 BMP。
// 注意：electron-builder 的钩子按 CommonJS 加载，这里必须用 require/module.exports。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

/** 从 256px PNG 构造单条目 PNG-in-ICO（6 字节头 + 16 字节目录项 + PNG 数据）。 */
function pngToIco(pngPath, icoPath) {
  const png = fs.readFileSync(pngPath)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)      // reserved
  header.writeUInt16LE(1, 2)      // type: icon
  header.writeUInt16LE(1, 4)      // count: 1
  const entry = Buffer.alloc(16)
  entry.writeUInt8(0, 0)          // 256 编码为 0
  entry.writeUInt8(0, 1)
  entry.writeUInt8(0, 2)          // 调色板
  entry.writeUInt8(0, 3)
  entry.writeUInt16LE(1, 4)       // planes
  entry.writeUInt16LE(32, 6)      // bpp
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)     // 数据偏移（6 + 16）
  fs.writeFileSync(icoPath, Buffer.concat([header, entry, png]))
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productName}.exe`)
  const rcedit = path.join(ROOT, 'scripts', 'bin', 'rcedit-x64.exe')
  const png = path.join(ROOT, 'build', 'icon-256.png')
  if (!fs.existsSync(rcedit)) throw new Error(`rcedit 不存在：${rcedit}`)
  if (!fs.existsSync(png)) throw new Error(`图标不存在：${png}（先跑 npm run icons）`)
  const ico = path.join(ROOT, 'build', 'icon.ico')
  pngToIco(png, ico)
  const result = spawnSync(rcedit, [exePath, '--set-icon', ico], { stdio: 'pipe' })
  if (result.status !== 0) {
    throw new Error(`rcedit 嵌图标失败：${result.stderr?.toString() || result.stdout?.toString() || `exit ${result.status}`}`)
  }
  console.log(`已嵌入应用图标：${exePath}`)
}

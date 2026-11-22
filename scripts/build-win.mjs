// 墨桥 Windows 打包入口。封装三个本机环境约束，保证「一条命令能稳定出包」。
//
// 1) 输出统一放在 release/ 下，每次构建一个时间戳子目录（release/20261112_170751/）。
//    为什么不是「固定输出目录」：本机有常驻扫描会长期持有上一次生成的
//    resources/app.asar（同目录其它文件都正常释放），固定目录第二次打包必定在
//    EnsureEmptyDir 阶段失败——它要先把旧的 win-unpacked 整个删掉，而这个文件删不动。
//    为什么不是「release-时间戳」并排一堆：那样项目根目录会被一堆同级目录铺满，
//    产物应该收在一个文件夹里，时间戳只是它的子目录名。
// 2) 默认 --config.win.signAndEditExecutable=false：electron-builder 自带的 rcedit
//    流程要先解压 winCodeSign 工具包，包里带 macOS 符号链接文件，Windows 普通用户
//    没有「创建符号链接」特权，解压必失败（开「开发人员模式」或管理员运行才能过）。
//    exe 图标改由 afterPack 钩子（scripts/embed-icon.cjs）用项目自带的 rcedit 直接嵌入
//    ——普通的 exe 资源写入，不需要任何特权/模式。MOBRIDGE_KEEP_ICON=1 保留为兼容
//    入口（让 electron-builder 自己跑完整 signAndEdit，需要符号链接特权）。
// 3) 构建二进制走国内镜像，避免 electron-builder 直连 GitHub 超时。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const pad = n => String(n).padStart(2, '0')
const d = new Date()
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
// 正斜杠：这条字符串会进 electron-builder 的 --config.directories.output，
// 反斜杠在部分 CLI 解析路径上会被当转义符吃掉。
const outDir = `release/${stamp}`

const cliCandidates = [
  path.join(root, 'node_modules/electron-builder/cli.js'),
  path.join(root, 'node_modules/electron-builder/out/cli/cli.js'),
]
const cli = cliCandidates.find(p => existsSync(p))
if (!cli) {
  console.error('未找到 electron-builder，请先执行 npm install')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const installerName = `${pkg.productName || pkg.name} Setup ${pkg.version}.exe`

const keepIcon = process.env.MOBRIDGE_KEEP_ICON === '1'
const args = [
  cli,
  '--win', 'nsis', '--x64', '--publish', 'never',
  `--config.directories.output=${outDir}`,
]
if (!keepIcon) args.push('--config.win.signAndEditExecutable=false')

const env = {
  ...process.env,
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}

console.log(`输出目录：${outDir}`)
console.log(keepIcon
  ? '模式：electron-builder 完整 signAndEdit（需要符号链接特权：开发人员模式或管理员）'
  : '模式：跳过 signAndEdit，exe 图标由 afterPack 钩子（embed-icon.cjs）嵌入，无需任何特权')

const result = spawnSync(process.execPath, args, { stdio: 'inherit', env })
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`\n完成：${path.join(root, outDir, installerName)}`)

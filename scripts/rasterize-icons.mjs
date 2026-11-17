// 墨桥图标栅格化管线：SVG --(Chrome headless 512px)--> PNG --(盒式缩放)--> 各尺寸资产。
// 仅依赖 Node 内置模块（zlib / child_process / os），无需安装任何包。
//
// 输出清单见文件末尾 ASSETS：路径逐条写全，不要用花括号展开批量拼路径——
// Windows 的 PowerShell / cmd 不展开花括号，会把它们变成字面的畸形目录名。
// 临时文件放系统临时目录，不写进 out/（那是构建输出目录，只放可随时重建的产物）。
//
// 产出：
//   build/icon.png              512 应用图标（electron-builder win.icon，默认形态·墨青）
//   build/icon-256.png          256 备用
//   resources/tray-day.png      32 托盘图标·日间（浅色任务栏，浓墨线条）
//   resources/tray-night.png    32 托盘图标·夜间（深色任务栏，霓青线条）
//   resources/trayTemplate.png  32 macOS 模板图标（纯黑 + 透明）
// 托盘日夜两版由主进程按 nativeTheme.shouldUseDarkColors 选取（src/main/tray.ts）。
// 用法：node scripts/rasterize-icons.mjs
import { spawnSync } from 'node:child_process'
import { inflateSync, deflateSync } from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = path.join(os.tmpdir(), `mobridge-icon-${process.pid}.png`)

function findChrome() {
  const candidates = [
    process.env.MOBRIDGE_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
  ].filter(Boolean)
  for (const p of candidates) { try { if (fs.statSync(p).isFile()) return p } catch { /* 继续 */ } }
  throw new Error('未找到 Chrome/Edge，可用 MOBRIDGE_CHROME 环境变量指定路径')
}

// ── PNG 解码（支持 Chrome 输出的 8bit RGBA 非隔行） ─────────────────────────
function decodePng(buf) {
  let off = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType))
    throw new Error(`不支持的 PNG 格式：bit=${bitDepth} color=${colorType} interlace=${interlace}`)
  const raw = inflateSync(Buffer.concat(idat))
  const srcStride = width * (colorType === 6 ? 4 : 3)
  // 先按原始通道布局 unfilter（PNG 滤波基于原始字节序），再展开为 RGBA
  const planar = Buffer.alloc(height * srcStride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const prev = y > 0 ? planar.subarray((y - 1) * srcStride, y * srcStride) : null
    const cur = planar.subarray(y * srcStride, (y + 1) * srcStride)
    raw.copy(cur, 0, pos, pos + srcStride); pos += srcStride
    for (let x = 0; x < srcStride; x++) {
      const a = x >= (srcStride / width) ? cur[x - (srcStride / width)] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= (srcStride / width) ? prev[x - (srcStride / width)] : 0
      let v = cur[x]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      cur[x] = v
    }
  }
  const stride = width * 4
  const out = Buffer.alloc(height * stride)
  for (let i = 0; i < width * height; i++) {
    if (colorType === 6) { planar.copy(out, i * 4, i * 4, i * 4 + 4) }
    else {
      out[i * 4] = planar[i * 3]; out[i * 4 + 1] = planar[i * 3 + 1]
      out[i * 4 + 2] = planar[i * 3 + 2]; out[i * 4 + 3] = 255
    }
  }
  return { width, height, data: out }
}

// ── 盒式缩放：alpha 预乘平均，避免缩小时边缘发灰 ─────────────────────────────
function downscale(src, target) {
  const k = src.width / target
  const out = Buffer.alloc(target * target * 4)
  for (let ty = 0; ty < target; ty++) {
    for (let tx = 0; tx < target; tx++) {
      const y0 = Math.floor(ty * k), y1 = Math.min(src.height, Math.ceil((ty + 1) * k))
      const x0 = Math.floor(tx * k), x1 = Math.min(src.width, Math.ceil((tx + 1) * k))
      let r = 0, g = 0, b = 0, aSum = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * src.width + x) * 4
          const al = src.data[i + 3]
          r += src.data[i] * al; g += src.data[i + 1] * al; b += src.data[i + 2] * al
          aSum += al
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const j = (ty * target + tx) * 4
      out[j + 3] = Math.round(aSum / n)
      if (aSum > 0) {
        out[j] = Math.round(r / aSum)
        out[j + 1] = Math.round(g / aSum)
        out[j + 2] = Math.round(b / aSum)
      }
    }
  }
  return { width: target, height: target, data: out }
}

// ── PNG 编码 ───────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ── 渲染：Chrome 只在 ≥512 窗口可靠，小尺寸一律由 512 缩放得到 ────────────────
function shoot(svgFile, outPng, transparent) {
  const chrome = findChrome()
  const args = ['--headless', '--disable-gpu', '--hide-scrollbars']
  if (transparent) args.push('--default-background-color=00000000')
  args.push(`--screenshot=${outPng.replace(/\\/g, '/')}`, '--window-size=512,512', `file:///${svgFile.replace(/\\/g, '/')}`)
  const r = spawnSync(chrome, args, { stdio: 'ignore', timeout: 30000 })
  if (r.status !== 0 || !fs.existsSync(outPng)) throw new Error(`渲染失败：${svgFile}`)
  return decodePng(fs.readFileSync(outPng))
}

function opaqueRatio(img) {
  let n = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 32) n++
  return n / (img.width * img.height)
}

function emit(svgRel, pngRel, target, transparent, minRatio) {
  const raw512 = shoot(path.join(ROOT, svgRel), TMP, transparent)
  if (raw512.width !== 512 || raw512.height !== 512) throw new Error(`${svgRel} 渲染尺寸异常 ${raw512.width}x${raw512.height}`)
  const ratio = opaqueRatio(raw512)
  if (ratio < minRatio) throw new Error(`${svgRel} 渲染内容疑似空白（不透明像素占比 ${(ratio * 100).toFixed(1)}%）`)
  const img = target === 512 ? raw512 : downscale(raw512, target)
  const out = path.join(ROOT, pngRel)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, encodePng(img.width, img.height, img.data))
  console.log(`✓ ${pngRel}  ${img.width}x${img.height}  (${(ratio * 100).toFixed(1)}% 覆盖)`)
}

// 资产单一真源：SVG 源 → PNG 产物 → 尺寸 → 最小不透明像素占比。
// 全部显式写全路径，不拼花括号（见文件头说明）。
const ASSETS = [
  { svg: 'resources/icon.svg',               png: 'build/icon.png',             size: 512, minRatio: 0.5 },
  { svg: 'resources/icon.svg',               png: 'build/icon-256.png',         size: 256, minRatio: 0.5 },
  { svg: 'resources/tray-icon-day.svg',      png: 'resources/tray-day.png',     size: 32,  minRatio: 0.05 },
  { svg: 'resources/tray-icon-night.svg',    png: 'resources/tray-night.png',   size: 32,  minRatio: 0.05 },
  { svg: 'resources/tray-icon-template.svg', png: 'resources/trayTemplate.png', size: 32,  minRatio: 0.05 },
]

// 统一透明底渲染：应用图标的圆角外区域保持透明，托盘本就透明。
try {
  for (const asset of ASSETS) emit(asset.svg, asset.png, asset.size, true, asset.minRatio)
} finally {
  fs.rmSync(TMP, { force: true })
}
console.log('图标资产生成完毕')

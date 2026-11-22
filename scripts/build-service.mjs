// 服务层打包（esbuild JS API）。
//
// 为什么不用原来的 CLI 一行命令：bundle 里含有 undici 这类 CJS 依赖，
// 打成纯 ESM 后 esbuild 会生成 __require shim，纯 ESM 作用域没有 require，
// 运行时抛 `Error: Dynamic require of "node:assert" is not supported`，
// 后台服务一启动就崩（界面能开、服务 error）。
//
// 顶部注入 createRequire 后，shim 的 `typeof require !== "undefined"` 分支
// 会走真实的 Node require。用 JS API 而不是 CLI --banner 参数，是为了避开
// Windows cmd.exe / npm script 的引号解析差异。
//
// 另外 ESM bundle 里没有 __dirname/__filename：sql.js 的 emscripten 运行时在
// Node 分支会读它们算 scriptDirectory，缺了直接 abort（报"数据库无法解析"）。
// 这里一并补上这两个模块级常量，供 bundle 内的 CJS 代码使用。
import { build } from 'esbuild'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

await build({
  entryPoints: ['src/service/core/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'out/service/main.mjs',
  banner: {
    js: [
      // banner 里的绑定一律用双下划线私有名：bundle 里第三方 CJS 代码
      // 可能保留 `import path from "node:path"` 这类原名，撞名就是运行时 SyntaxError。
      "import { createRequire as __createRequire } from 'node:module';",
      "import * as __nodePath from 'node:path';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __nodePath.dirname(__filename);',
    ].join(''),
  },
})

// sql.js 的 WASM 本体不在 bundle 里，运行时按 locateFile 找 out/service/sql-wasm.wasm。
// 开发态没有 out 也可以跑：trae-config 会回落到 node_modules 里的 dist 副本。
// 注意不能 resolve('sql.js/package.json')——它的 exports 映射没有放行这个子路径，
// 会直接 ERR_PACKAGE_PATH_NOT_EXPORTED；从主入口（dist/sql-wasm.js）反推 dist 目录。
const require_ = createRequire(import.meta.url)
const wasmSource = path.join(path.dirname(require_.resolve('sql.js')), 'sql-wasm.wasm')
await mkdir('out/service', { recursive: true })
await copyFile(wasmSource, path.join('out/service', 'sql-wasm.wasm'))
const copied = await stat(path.join('out/service', 'sql-wasm.wasm'))
console.log(`sql-wasm.wasm -> out/service (${copied.size} bytes)`)

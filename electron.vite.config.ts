import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    // 服务层由 esbuild 单独打包（见 package.json build:service），主进程不 bundle 它
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // 窗口开了 sandbox，而 Electron 的沙箱预加载脚本不能是 ESM；
    // 本项目 package.json 是 "type": "module"，electron-vite 默认会输出 index.mjs，
    // 结果是 preload 根本没被加载、window.bridge 整块不存在（页面永远停在初始态）。
    // 所以这里显式产出 CJS + .cjs 后缀，让 Electron 无条件按 CommonJS 加载。
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name]-[hash].cjs' },
      },
    },
  },
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
})

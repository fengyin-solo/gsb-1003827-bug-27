// 行为验证运行器：用 Vite 的 SSR 加载直接跑 TS 业务代码，不依赖浏览器。
// 用法：node run-workflow-check.mjs
import { createServer } from 'vite'
import { pathToFileURL } from 'node:url'

function createMemoryStorage() {
  let data = new Map()
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value))
    },
    removeItem: (key) => data.delete(key),
    clear: () => {
      data = new Map()
    },
  }
}

globalThis.window = { localStorage: createMemoryStorage() }

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})
try {
  const module = await server.ssrLoadModule('/verify-workflow.ts')
  await module.run()
} finally {
  await server.close()
}

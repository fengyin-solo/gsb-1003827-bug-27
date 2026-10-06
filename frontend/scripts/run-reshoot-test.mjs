// 用 esbuild 把测试（含 @ 别名依赖）打包成单个 ESM 文件再交给 node 执行。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'
import path from 'node:path'

const outfile = path.resolve('scripts/.reshoot-flow-test.bundle.mjs')
await build({
  entryPoints: ['scripts/reshoot-flow-test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  alias: { '@': path.resolve('src') },
})

try {
  await import(pathToFileURL(outfile).href)
} finally {
  rmSync(outfile, { force: true })
}

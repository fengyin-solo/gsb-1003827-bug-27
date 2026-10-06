// 重拍联动端到端验证：用 Node 直接跑数据层，覆盖状态流转、版本留痕、幂等、事务回退、对账修复。
// 运行：npm run test:reshoot（通过 esbuild 打包后由 node 执行）。
import assert from 'node:assert'

// ---- 浏览器环境桩 ----
class Storage {
  map = new Map<string, string>()
  failing = false
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) {
    if (this.failing) throw new Error('模拟存储写入失败（配额/损坏）')
    this.map.set(k, v)
  }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
}
const storage = new Storage()
;(globalThis as any).window = { localStorage: storage }
;(globalThis as any).localStorage = storage

const { SEED_ROWS } = await import('../src/data/seed.ts')
const { __resetCacheForTest } = await import('../src/data/local-store.ts')
const store = await import('../src/data/local-store.ts')
const { runAction } = await import('../src/api/local-service.ts')
const reshoot = await import('../src/data/reshoot.ts')

let passed = 0
function ok(name: string, cond: boolean, extra = '') {
  assert.ok(cond, `${name} ${extra}`)
  passed += 1
  console.log(`  ✓ ${name}`)
}
function reset() {
  storage.clear()
  storage.failing = false
  __resetCacheForTest()
}

// ---------- 1. 迁移：脏字段对齐、历史归档补录版本 ----------
reset()
{
  const photos = store.listRows('photography')
  const archived = photos.find((r) => r.id === 3)!
  ok('迁移后「影像状态」字段与 status 对齐', photos.every((r) => r['影像状态'] === r.status))
  ok('历史已归档影像补录出 v1 版本', (archived.archiveVersions ?? []).length === 1 && archived.archiveVersions![0].version === 1)
  const drawings = store.listRows('drawing')
  ok('绘图「图纸状态」字段与 status 对齐', drawings.every((r) => r['图纸状态'] === r.status))
}

// ---------- 2. 正常编号 → 归档（首版） ----------
reset()
{
  let r = runAction('photography', 1, '分配编号')
  ok('已拍摄 → 分配编号成功', r.ok)
  ok('编号后「影像状态」字段同步为已编号', store.listRows('photography')[0]['影像状态'] === '已编号')
  r = runAction('photography', 1, '提交归档')
  ok('已编号 → 提交归档成功', r.ok && r.message.includes('v1'))
  const p = store.listRows('photography')[0]
  ok('归档后 pending=false（终态修复）', p.pending === false)
}

// ---------- 3. 重拍：已归档→需重拍、保留原版本、绘图待办生成、幂等 ----------
reset()
{
  const before = store.listRows('photography').find((r) => r.id === 3)!
  assert.strictEqual(before.status, '已归档')
  const beforeVersions = JSON.parse(JSON.stringify(before.archiveVersions))

  const r1 = runAction('photography', 3, '安排重拍')
  ok('已归档影像安排重拍成功', r1.ok)
  const after = store.listRows('photography').find((r) => r.id === 3)!
  ok('重拍后状态回到「需重拍」', after.status === '需重拍' && after['影像状态'] === '需重拍')
  ok('重拍后 pending=true（不再被当成终态）', after.pending === true)
  ok('原归档版本完整保留（版本数与内容不变）', JSON.stringify(after.archiveVersions) === JSON.stringify(beforeVersions))
  const todos = reshoot.listReshootTodos().filter((t) => t.photographyId === 3)
  ok('绘图侧生成且仅生成一份补拍待办', todos.length === 1 && todos[0].status === '待补拍' && todos[0].sourceVersion === 1)

  // 重复点击：再点两次
  const r2 = runAction('photography', 3, '安排重拍')
  const r3 = runAction('photography', 3, '安排重拍')
  ok('重复安排重拍幂等返回且不报错', r2.ok && r3.ok)
  ok('重复点击后仍只有一份待办', reshoot.listReshootTodos().filter((t) => t.photographyId === 3).length === 1)

  // 非已归档状态不能重拍
  const r4 = runAction('photography', 1, '安排重拍')
  ok('非已归档影像不能安排重拍', !r4.ok && r4.message.includes('只有'))
}

// ---------- 4. 重新归档：追加 v2，历史不覆盖，待办自动关闭 ----------
reset()
{
  runAction('photography', 3, '安排重拍')
  const r = runAction('photography', 3, '提交归档')
  ok('需重拍 → 重新归档成功', r.ok)
  const p = store.listRows('photography').find((x) => x.id === 3)!
  ok('重新归档生成 v2 新版本', (p.archiveVersions ?? []).length === 2 && p.archiveVersions![1].version === 2)
  ok('v1 历史版本仍在且未被覆盖', p.archiveVersions![0].version === 1 && p.archiveVersions![0].note === '首次归档')
  ok('v2 使用新版本存储路径', String(p.archiveVersions![1].storagePath).endsWith('/v2'))
  ok('归档后状态/字段一致为已归档', p.status === '已归档' && p['影像状态'] === '已归档' && p.pending === false)
  const todo = reshoot.listReshootTodos().find((t) => t.photographyId === 3)!
  ok('补拍待办随重归档自动关闭', todo.status === '已完成' && todo.completedAt !== '')

  // 已归档不能重复归档
  const r2 = runAction('photography', 3, '提交归档')
  ok('已归档重复归档被拒绝，不产生新版本', !r2.ok && p.archiveVersions!.length === 2)

  // 已归档可再次重拍→归档生成 v3，v1/v2 都保留
  runAction('photography', 3, '安排重拍')
  runAction('photography', 3, '提交归档')
  const p3 = store.listRows('photography').find((x) => x.id === 3)!
  ok('二次重拍归档生成 v3 且 v1/v2 均保留', p3.archiveVersions!.length === 3 && p3.archiveVersions!.map((v) => v.version).join() === '1,2,3')
  ok('每轮重拍只产生一份待办（累计两份均关闭）', reshoot.listReshootTodos().filter((t) => t.photographyId === 3).length === 2 &&
    reshoot.listReshootTodos().filter((t) => t.photographyId === 3).every((t) => t.status === '已完成'))
}

// ---------- 5. 失败 / 重试 / 异常中断 ----------
reset()
{
  runAction('photography', 3, '安排重拍')
  const todo = reshoot.listReshootTodos().find((t) => t.photographyId === 3)!
  let r = reshoot.startReshootWork(todo.id)
  ok('绘图侧开始补拍 → 补拍中', r.ok)
  r = reshoot.failReshootWork(todo.id, '样片曝光失败')
  ok('登记失败 → 回到待补拍并累计失败次数', r.ok)
  const t1 = reshoot.listReshootTodos().find((t) => t.id === todo.id)!
  ok('失败次数与原因已记录', t1.status === '待补拍' && t1.failCount === 1 && t1.lastError === '样片曝光失败')
  r = reshoot.startReshootWork(todo.id)
  ok('失败后可重新发起补拍（重试）', r.ok)
  // 模拟异常中断：把 updatedAt 改到 20 分钟前
  const todos = store.listTodos().map((t) => t.id === todo.id ? { ...t, updatedAt: oldTime(20) } : t)
  store.commit({ __reshootTodos: todos })
  const c = reshoot.checkConsistency()
  ok('超时卡在补拍中被识别为异常中断', c.interrupted.some((t) => t.id === todo.id))
  r = reshoot.repairConsistency()
  ok('修复中断任务成功', r.ok)
  const t2 = reshoot.listReshootTodos().find((t) => t.id === todo.id)!
  ok('修复后中断任务解锁回待补拍', t2.status === '待补拍')
}

// ---------- 6. 事务回退：待办写入成功路径中存储失败 → 两边都不动 ----------
reset()
{
  const beforePhotos = JSON.stringify(store.listRows('photography'))
  const beforeTodos = JSON.stringify(store.listTodos())
  storage.failing = true
  const r = runAction('photography', 3, '安排重拍')
  storage.failing = false
  ok('存储失败时安排重拍返回失败', !r.ok && r.message.includes('一起退回'))
  ok('影像状态已退回（仍为已归档）', store.listRows('photography').find((x) => x.id === 3)!.status === '已归档')
  ok('绘图待办已退回（没有新增）', JSON.stringify(store.listTodos()) === beforeTodos)
  ok('存储快照完全未变', JSON.stringify(store.listRows('photography')) === beforePhotos)

  // 重归档时存储失败：同样两边退回
  reset()
  runAction('photography', 3, '安排重拍')
  const midPhotos = JSON.stringify(store.listRows('photography'))
  storage.failing = true
  const r2 = runAction('photography', 3, '提交归档')
  storage.failing = false
  ok('存储失败时重归档返回失败', !r2.ok)
  ok('重归档失败后影像仍为需重拍', store.listRows('photography').find((x) => x.id === 3)!.status === '需重拍')
  ok('重归档失败后待办仍未关闭', reshoot.listReshootTodos().find((t) => t.photographyId === 3)!.status === '待补拍')
  ok('归档版本未追加', store.listRows('photography').find((x) => x.id === 3)!.archiveVersions!.length === 1 && JSON.stringify(store.listRows('photography')) === midPhotos)
}

// ---------- 7. 对账修复：模拟半成功脏数据 ----------
reset()
{
  // 7a. 只写了待办、影像没回退（待办在但影像已归档）→ orphan
  {
    const photos = store.listRows('photography')
    const p3 = photos.find((r) => r.id === 3)!
    const time = nowText()
    store.commit({
      photography: photos,
      __reshootTodos: [{
        id: 901, photographyId: 3, 影像编号: 'PHOT-0003', 拍摄对象: '', reason: '半边写入',
        status: '待补拍', sourceVersion: 1, createdAt: time, updatedAt: time, completedAt: '', failCount: 0, lastError: '',
      }],
    })
    const c = reshoot.checkConsistency()
    ok('对账识别残留待办（影像已归档）', c.orphans.length === 1 && c.hasIssue)
    const r = reshoot.repairConsistency()
    ok('修复残留待办', r.ok)
    ok('修复后待办关闭、影像保持已归档',
      reshoot.listReshootTodos().find((t) => t.id === 901)!.status === '已完成' &&
      store.listRows('photography').find((x) => x.id === 3)!.status === '已归档')
  }

  // 7b. 待办已完成、影像反成需重拍 → reopen
  reset()
  {
    const photos = store.listRows('photography').map((r) => r.id === 3 ? { ...r, status: '需重拍', pending: true, '影像状态': '需重拍' } : r)
    const time = nowText()
    store.commit({
      photography: photos,
      __reshootTodos: [{
        id: 902, photographyId: 3, 影像编号: 'PHOT-0003', 拍摄对象: '', reason: '归档半边',
        status: '已完成', sourceVersion: 1, createdAt: time, updatedAt: time, completedAt: time, failCount: 0, lastError: '',
      }],
    })
    const c = reshoot.checkConsistency()
    ok('对账识别误关闭待办（影像仍需重拍）', c.reopened.length === 1)
    reshoot.repairConsistency()
    ok('修复后待办重新打开为待补拍', reshoot.listReshootTodos().find((t) => t.id === 902)!.status === '待补拍')
  }

  // 7c. 待办在、影像漂到其他状态（已编号）→ 影像退回需重拍
  reset()
  {
    const photos = store.listRows('photography').map((r) => r.id === 3 ? { ...r, status: '已编号', pending: true, '影像状态': '已编号' } : r)
    const time = nowText()
    store.commit({
      photography: photos,
      __reshootTodos: [{
        id: 903, photographyId: 3, 影像编号: 'PHOT-0003', 拍摄对象: '', reason: '漂移',
        status: '待补拍', sourceVersion: 1, createdAt: time, updatedAt: time, completedAt: '', failCount: 0, lastError: '',
      }],
    })
    const c = reshoot.checkConsistency()
    ok('对账识别状态漂移', c.drifting.length === 1)
    reshoot.repairConsistency()
    ok('修复后影像强制退回需重拍，待办保留',
      store.listRows('photography').find((x) => x.id === 3)!.status === '需重拍' &&
      reshoot.listReshootTodos().find((t) => t.id === 903)!.status === '待补拍')
  }

  // 7d. 影像档案被删除 → missing，不自动改，人工移除
  reset()
  {
    const photos = store.listRows('photography').filter((r) => r.id !== 3)
    const time = nowText()
    store.commit({
      photography: photos,
      __reshootTodos: [{
        id: 904, photographyId: 3, 影像编号: 'PHOT-0003', 拍摄对象: '', reason: '档案缺失',
        status: '待补拍', sourceVersion: 1, createdAt: time, updatedAt: time, completedAt: '', failCount: 0, lastError: '',
      }],
    })
    const c = reshoot.checkConsistency()
    ok('对账识别影像档案缺失', c.missing.length === 1)
    const r = reshoot.repairConsistency()
    ok('修复不自动删除缺失待办，只提示人工处理', r.ok && reshoot.listReshootTodos().some((t) => t.id === 904))
    const r2 = reshoot.removeMissingTodo(904)
    ok('人工可移除缺失待办', r2.ok && !reshoot.listReshootTodos().some((t) => t.id === 904))
  }

  // 7e. 一致时不误报
  reset()
  {
    const c = reshoot.checkConsistency()
    ok('干净数据对账无问题', !c.hasIssue)
    const r = reshoot.repairConsistency()
    ok('无问题时修复为 no-op', r.ok && r.message.includes('无需修复'))
  }
}

// ---------- 8. 其他模块终态判定不回归（绘图） ----------
reset()
{
  const r = runAction('drawing', 1, '提交校核')
  ok('绘图：绘制中→待校核', r.ok)
  const row = store.listRows('drawing')[0]
  ok('绘图待校核 pending=true', row.pending === true && row['图纸状态'] === '待校核')
  const r2 = runAction('drawing', 1, '确认校核')
  const row2 = store.listRows('drawing')[0]
  ok('绘图：已校核为终态 pending=false', r2.ok && row2.pending === false && row2['图纸状态'] === '已校核')
  const r3 = runAction('drawing', 1, '退回修改')
  const row3 = store.listRows('drawing')[0]
  ok('绘图：退回修改 pending=true 且标记 abnormal', row3.pending === true && row3.abnormal === true && row3['图纸状态'] === '需修改')
}

function oldTime(minutesAgo: number): string {
  const d = new Date(Date.now() - minutesAgo * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
function nowText(): string { return oldTime(0) }

console.log(`\n全部通过：${passed} 项断言`)
void SEED_ROWS

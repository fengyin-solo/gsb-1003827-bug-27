import {
  arrangeRetake,
  archivePhoto,
  listPhotoRetakeTodos,
  runPhotographyAction,
} from './src/data/photography-workflow'
import { listRows, resetAllState } from './src/data/local-store'
import { listEntries } from './src/api/local-service'

let failures = 0

function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}

function photo(id: number) {
  const row = listRows('photography').find((item) => Number(item.id) === id)
  if (!row) throw new Error(`影像 ${id} 不存在`)
  return row
}

function openTodos(photographyId: number) {
  return listPhotoRetakeTodos().filter((t) => t.photographyId === photographyId && t.status === '待补拍')
}

export async function run(): Promise<void> {
  // 场景一：已归档影像安排重拍（种子数据 id=3，无历史版本字段，走自愈补录）
  resetAllState()
  console.log('场景一：已归档 → 安排重拍')
  const r1 = arrangeRetake(3)
  assert(r1.ok, '安排重拍返回成功')
  const p1 = photo(3)
  assert(String(p1.status) === '需重拍', '状态从已归档回到需重拍')
  assert(String(p1['影像状态']) === '需重拍', '归档状态字段「影像状态」同步为需重拍')
  assert(p1.pending === true, '重拍后 pending=true，回到待处理')
  const versionsAfterRetake = p1.archiveVersions as { version: number }[]
  assert(Array.isArray(versionsAfterRetake) && versionsAfterRetake.length === 1, '原归档版本保留（1 个版本）')
  assert(versionsAfterRetake[0].version === 1, '保留的是 v1 历史版本')
  const todos1 = listPhotoRetakeTodos()
  assert(todos1.length === 1, '绘图侧恰好生成 1 条补拍待办')
  assert(todos1[0].status === '待补拍', '待办状态为待补拍')
  assert(todos1[0].sourceArchiveVersion === 1, '待办记录来源归档版本 v1')
  assert(todos1[0].photographyCode === 'PHOT-0003', '待办携带影像编号，跨面可对得上')
  const list1 = listEntries('photography')
  assert(list1.items.find((r) => Number(r.id) === 3 && String(r.status) === '需重拍') !== undefined, '列表页能查到需重拍状态')

  // 场景二：重复点击安排重拍，只产生一份待办
  console.log('场景二：重复安排重拍')
  const before = listPhotoRetakeTodos().length
  const r2 = arrangeRetake(3)
  const after = listPhotoRetakeTodos().length
  assert(!r2.ok && r2.message.includes('无需重复安排'), '重复安排被业务拒绝')
  assert(before === after && after === 1, '待办仍是 1 条，没有重复生成')

  // 场景三：非已归档状态安排重拍被拒绝，且不产生待办
  console.log('场景三：非法状态安排重拍')
  const r3 = arrangeRetake(1)
  assert(!r3.ok, '已拍摄影像安排重拍被拒绝')
  assert(listPhotoRetakeTodos().length === 1, '拒绝时不新增待办')
  assert(String(photo(1).status) === '已拍摄', '被拒绝影像状态不变')

  // 场景四：重新归档只追加新版本，待办自动闭环
  console.log('场景四：重新归档生成新版本')
  const r4 = archivePhoto(3)
  assert(r4.ok, '重新归档成功')
  const p4 = photo(3)
  assert(String(p4.status) === '已归档', '状态回到已归档')
  assert(String(p4['影像状态']) === '已归档', '归档字段同步为已归档')
  assert(p4.pending === false, '归档后 pending=false')
  const v4 = p4.archiveVersions as { version: number; reason?: string }[]
  assert(v4.length === 2, '归档版本为 2 个（历史未被覆盖）')
  assert(v4[0].version === 1 && v4[1].version === 2, '版本号递增 v1 → v2')
  assert(v4[1].reason === '已归档影像安排重拍', '新版本记录重拍来源')
  const t4 = listPhotoRetakeTodos().find((t) => t.photographyId === 3)
  assert(t4?.status === '已完成', '原补拍待办随重新归档自动闭环')

  // 场景五：持久化异常时两边一起退回（含「待办本应被闭环 + 状态本应变更」的整笔回滚）
  console.log('场景五：异常中断时影像状态与绘图待办一起退回')
  arrangeRetake(3) // 先把状态打到需重拍、待办打开
  assert(openTodos(3).length === 1, '重拍后存在 1 条待补拍待办')
  const photoBeforeCrash = { status: String(photo(3).status), pending: photo(3).pending }
  const versionsBeforeCrash = (photo(3).archiveVersions as unknown[]).length
  const rawSetItem = window.localStorage.setItem.bind(window.localStorage)
  let thrown = false
  window.localStorage.setItem = () => {
    throw new Error('注入失败：存储配额不足')
  }
  try {
    // 这一步同时想改影像状态和闭环绘图待办，落盘失败必须整笔回滚。
    archivePhoto(3)
  } catch (error) {
    thrown = error instanceof Error && error.message.includes('存储配额不足')
  }
  window.localStorage.setItem = rawSetItem
  assert(thrown, '保存失败向上抛出，可被页面捕获并提示重试')
  assert(String(photo(3).status) === photoBeforeCrash.status, '影像状态回滚到事务前（仍需重拍）')
  assert(photo(3).pending === photoBeforeCrash.pending, 'pending 一并回滚')
  assert((photo(3).archiveVersions as unknown[]).length === versionsBeforeCrash, '失败的归档没有产生脏版本号')
  assert(openTodos(3).length === 1, '绘图待办回滚：仍是故障前那 1 条待补拍，未被闭环')

  // 场景六：异常恢复后重试成功
  console.log('场景六：异常恢复后重试')
  const r6 = archivePhoto(3)
  assert(r6.ok, '重试归档成功')
  const v6 = photo(3).archiveVersions as { version: number }[]
  assert(String(photo(3).status) === '已归档' && v6.length === 3, '重试后归档为 v3（失败那次没有落版本）')
  const closedAgain = listPhotoRetakeTodos().filter((t) => t.photographyId === 3 && t.status === '已完成')
  assert(closedAgain.length === 2, '两轮重拍对应两条已闭环待办，历史待办不被覆盖')

  // 场景七：空态、未知动作、重复归档、不存在记录
  console.log('场景七：空态与异常输入')
  resetAllState()
  assert(listPhotoRetakeTodos().length === 0, '重置后补拍待办为空（空态）')
  assert(listEntries('photography').total === 3, '重置后列表恢复示例数据')
  const r8 = runPhotographyAction(999, '安排重拍')
  assert(!r8.ok && r8.message.includes('没有找到'), '不存在的影像返回失败而不是抛异常')
  const r8b = runPhotographyAction(1, '删除档案')
  assert(!r8b.ok && r8b.message.includes('没有登记'), '未登记动作返回失败而不是抛异常')
  const r8c = runPhotographyAction(3, '提交归档')
  assert(!r8c.ok, '已归档影像重复归档被拒绝')
  assert((photo(3).archiveVersions as unknown[] | undefined) === undefined, '拒绝重复归档不产生版本')

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`)
    throw new Error('workflow verification failed')
  }
  console.log('\n全部断言通过')
}

import { commit, listRows, listTodos, nowText } from './local-store'
import type { ActionResult, EntryRow, ReshootConsistency, ReshootTodo } from './types'

// 影像重拍 ↔ 绘图补拍待办的唯一联动入口。
// 两边共用同一份本地存储、同一个提交事务：任一环节失败都整体退回，绝不留半截状态。

const PHOTO_KEY = 'photography'
const OPEN_TODO_STATUS = ['待补拍', '补拍中'] as const
// 补拍中超过该时长仍未结束，按异常中断处理（页面刷新/进程退出后没人再推进）。
const INTERRUPT_AFTER_MS = 10 * 60 * 1000

let todoSeq = 0

function nextTodoId(todos: ReshootTodo[]): number {
  const max = todos.reduce((m, t) => Math.max(m, t.id), 0)
  todoSeq = Math.max(todoSeq, max) + 1
  return todoSeq
}

function photoOf(photos: EntryRow[], id: number): EntryRow | undefined {
  return photos.find((row) => Number(row.id) === id)
}

function isStale(todo: ReshootTodo): boolean {
  const updated = new Date(todo.updatedAt.replace(' ', 'T')).getTime()
  return Number.isFinite(updated) && Date.now() - updated > INTERRUPT_AFTER_MS
}

function openTodoFor(todos: ReshootTodo[], photographyId: number): ReshootTodo | undefined {
  return todos.find(
    (todo) => todo.photographyId === photographyId && OPEN_TODO_STATUS.includes(todo.status as (typeof OPEN_TODO_STATUS)[number]),
  )
}

function latestVersion(photo: EntryRow): number {
  const versions = photo.archiveVersions ?? []
  return versions.reduce((max, item) => Math.max(max, item.version), 0)
}

function versionedPath(photo: EntryRow, version: number): string {
  const current = String(photo['存储路径'] ?? '').trim()
  if (!current) {
    return `/archive/${photo['影像编号'] ?? 'PHOT'}/v${version}`
  }
  return /\/v\d+$/.test(current) ? current.replace(/\/v\d+$/, `/v${version}`) : `${current}/v${version}`
}

export function listReshootTodos(): ReshootTodo[] {
  return [...listTodos()].sort((a, b) => b.id - a.id)
}

/**
 * 安排重拍：仅允许对「已归档」影像发起。
 * 已归档版本整体冻结在 archiveVersions 里，状态回到「需重拍」，同时在绘图侧落一份补拍待办。
 * 重复点击：已有未关闭待办（含异常中断卡在「补拍中」的）直接返回原待办，绝不产生第二份。
 */
export function reshootPhoto(id: number, reason = '归档影像质检不通过，安排重拍'): ActionResult & { todoId?: number } {
  const photos = listRows(PHOTO_KEY)
  const index = photos.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的影像档案` }
  }
  const photo = photos[index]
  const todos = [...listTodos()]
  const existing = openTodoFor(todos, id)
  if (existing) {
    // 幂等：同一条影像在待办关闭前只能有一份补拍任务。
    if (existing.status === '补拍中') {
      return { ok: true, todoId: existing.id, message: '该影像已有补拍任务正在处理，请勿重复安排' }
    }
    return { ok: true, todoId: existing.id, message: '该影像已安排重拍，绘图侧补拍待办已存在，无需重复操作' }
  }
  if (String(photo.status) !== '已归档') {
    return { ok: false, message: `只有「已归档」影像才能安排重拍，当前状态为「${photo.status}」` }
  }

  const version = Math.max(1, latestVersion(photo))
  const time = nowText()
  const updated: EntryRow = {
    ...photo,
    status: '需重拍',
    pending: true,
    abnormal: false,
    '影像状态': '需重拍',
  }
  const todo: ReshootTodo = {
    id: nextTodoId(todos),
    photographyId: id,
    影像编号: String(photo['影像编号'] ?? `PHOT-${id}`),
    拍摄对象: String(photo['拍摄对象'] ?? ''),
    reason,
    status: '待补拍',
    sourceVersion: version,
    createdAt: time,
    updatedAt: time,
    completedAt: '',
    failCount: 0,
    lastError: '',
  }

  // 绘图待办与影像状态在同一次提交里落库；commit 失败则两边都不动。
  try {
    commit({
      [PHOTO_KEY]: photos.map((row, i) => (i === index ? updated : row)),
      __reshootTodos: [...todos, todo],
    })
  } catch (error) {
    return {
      ok: false,
      message: `安排重拍失败，影像状态与绘图待办已一起退回：${error instanceof Error ? error.message : '存储异常'}`,
    }
  }
  return { ok: true, todoId: todo.id, message: `已安排重拍，状态回到「需重拍」，原归档版本 v${version} 已保留，绘图侧已生成补拍待办` }
}

/**
 * 重新归档：只能由「已编号」首次归档、或「需重拍」重归档进入。
 * 重归档追加新版本，历史版本原样保留，不覆盖；同时关闭对应的补拍待办。
 */
export function archivePhoto(id: number, note = ''): ActionResult & { version?: number } {
  const photos = listRows(PHOTO_KEY)
  const index = photos.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的影像档案` }
  }
  const photo = photos[index]
  const status = String(photo.status)
  if (status === '已归档') {
    return { ok: false, message: '该影像已处于「已归档」，重复归档不会生成新版本' }
  }
  const isReshoot = status === '需重拍'
  if (status !== '已编号' && !isReshoot) {
    return { ok: false, message: `当前状态「${status}」不能归档，请先完成编号或重拍` }
  }

  const version = latestVersion(photo) + 1
  const time = nowText()
  const storagePath = isReshoot ? versionedPath(photo, version) : String(photo['存储路径'] ?? '')
  const versions = [
    ...(photo.archiveVersions ?? []),
    { version, archivedAt: time, storagePath, note: note || (isReshoot ? `重拍后第 ${version} 次归档` : '首次归档') },
  ]
  const updated: EntryRow = {
    ...photo,
    status: '已归档',
    pending: false,
    abnormal: false,
    '影像状态': '已归档',
    存储路径: storagePath || photo['存储路径'],
    lastArchivedAt: time,
    archiveVersions: versions,
  }

  const todos = [...listTodos()]
  let closed = 0
  const nextTodos = todos.map((todo) => {
    if (todo.photographyId !== id || !OPEN_TODO_STATUS.includes(todo.status as (typeof OPEN_TODO_STATUS)[number])) {
      return todo
    }
    closed += 1
    return { ...todo, status: '已完成' as const, updatedAt: time, completedAt: time, lastError: '' }
  })

  try {
    commit({
      [PHOTO_KEY]: photos.map((row, i) => (i === index ? updated : row)),
      __reshootTodos: nextTodos,
    })
  } catch (error) {
    return {
      ok: false,
      message: `归档失败，影像状态与绘图待办已一起退回：${error instanceof Error ? error.message : '存储异常'}`,
    }
  }
  return {
    ok: true,
    version,
    message: isReshoot
      ? `重拍影像已重新归档为新版本 v${version}，历史版本 v1${version > 2 ? `–v${version - 1}` : ''}保留${closed ? '，绘图补拍待办已关闭' : ''}`
      : `影像已归档（v${version}）`,
  }
}

/** 绘图侧：开始补拍。异常中断（页面刷新/进程退出）后重新进入仍是「补拍中」，靠修复解锁，不另开任务。 */
export function startReshootWork(todoId: number): ActionResult {
  const todos = listTodos()
  const todo = todos.find((item) => item.id === todoId)
  if (!todo) {
    return { ok: false, message: '补拍待办不存在，可能已被处理或移除' }
  }
  if (todo.status === '补拍中') {
    return { ok: true, message: '补拍任务已在处理中' }
  }
  if (todo.status === '已完成') {
    return { ok: false, message: '补拍待办已关闭，不能重复开始' }
  }
  try {
    commit({ __reshootTodos: todos.map((item): ReshootTodo => (item.id === todoId ? { ...item, status: '补拍中', updatedAt: nowText(), lastError: '' } : item)) })
  } catch (error) {
    return { ok: false, message: `开始补拍失败，请重试：${error instanceof Error ? error.message : '存储异常'}` }
  }
  return { ok: true, message: '已开始补拍，完成后请到影像记录页重新归档' }
}

/** 绘图侧：补拍失败登记，任务回到「待补拍」并累计失败次数，供重试；影像状态不受影响。 */
export function failReshootWork(todoId: number, errorMessage: string): ActionResult {
  const todos = listTodos()
  const todo = todos.find((item) => item.id === todoId)
  if (!todo) {
    return { ok: false, message: '补拍待办不存在' }
  }
  if (todo.status !== '补拍中') {
    return { ok: false, message: '只有处理中的补拍任务才能登记失败' }
  }
  const reason = errorMessage.trim() || '补拍过程中断'
  try {
    commit({
      __reshootTodos: todos.map((item): ReshootTodo =>
        item.id === todoId
          ? { ...item, status: '待补拍', updatedAt: nowText(), failCount: item.failCount + 1, lastError: reason }
          : item,
      ),
    })
  } catch (error) {
    return { ok: false, message: `失败状态登记失败，请重试：${error instanceof Error ? error.message : '存储异常'}` }
  }
  return { ok: true, message: '已登记补拍失败，任务回到待补拍，可重新发起' }
}

/** 影像档案缺失的待办无法自动修复，只能由人工确认后移除。 */
export function removeMissingTodo(todoId: number): ActionResult {
  const todos = listTodos()
  const todo = todos.find((item) => item.id === todoId)
  if (!todo) {
    return { ok: false, message: '补拍待办不存在' }
  }
  try {
    commit({ __reshootTodos: todos.filter((item) => item.id !== todoId) })
  } catch (error) {
    return { ok: false, message: `移除失败，请重试：${error instanceof Error ? error.message : '存储异常'}` }
  }
  return { ok: true, message: '已移除无法对账的补拍待办' }
}

/**
 * 对账：沿「影像状态 ↔ 绘图待办」两条线互相核对，列出所有断开情形。
 * 重拍只改一边、归档只关一边、中断卡在补拍中、影像被删除，都能在这里暴露。
 */
export function checkConsistency(): ReshootConsistency {
  const photos = listRows(PHOTO_KEY)
  const todos = listTodos()
  const result: ReshootConsistency = {
    orphans: [],
    reopened: [],
    interrupted: [],
    drifting: [],
    missing: [],
    hasIssue: false,
  }
  for (const todo of todos) {
    const photo = photoOf(photos, todo.photographyId)
    if (!photo) {
      result.missing.push(todo)
      continue
    }
    const status = String(photo.status)
    const open = OPEN_TODO_STATUS.includes(todo.status as (typeof OPEN_TODO_STATUS)[number])
    if (open && status === '已归档') {
      result.orphans.push(todo)
    } else if (todo.status === '已完成' && status === '需重拍') {
      result.reopened.push(todo)
    } else if (todo.status === '补拍中' && isStale(todo)) {
      result.interrupted.push(todo)
    } else if (open && status !== '需重拍') {
      result.drifting.push(todo)
    }
  }
  result.hasIssue =
    result.orphans.length > 0 ||
    result.reopened.length > 0 ||
    result.interrupted.length > 0 ||
    result.drifting.length > 0 ||
    result.missing.length > 0
  return result
}

/**
 * 一键修复：把能自动对齐的断开处收敛回一致状态，所有修复同一次事务提交。
 * - 影像已归档、待办还开着 → 关闭残留待办；
 * - 待办已完成、影像反成需重拍 → 待办退回重开；
 * - 卡在补拍中（异常中断）→ 解锁回待补拍；
 * - 影像状态漂移 → 影像强制退回需重拍；
 * - 影像已删除 → 不自动处理，交由人工移除。
 */
export function repairConsistency(): ActionResult {
  const issues = checkConsistency()
  if (!issues.hasIssue) {
    return { ok: true, message: '影像状态与绘图待办一致，无需修复' }
  }

  const photos = listRows(PHOTO_KEY)
  const photoPatch = new Map<number, EntryRow>()
  for (const todo of [...issues.drifting]) {
    const idx = photos.findIndex((row) => Number(row.id) === todo.photographyId)
    if (idx >= 0) {
      photoPatch.set(Number(photos[idx].id), {
        ...photos[idx],
        status: '需重拍',
        pending: true,
        '影像状态': '需重拍',
      })
    }
  }

  const orphanIds = new Set(issues.orphans.map((t) => t.id))
  const reopenIds = new Set(issues.reopened.map((t) => t.id))
  const interruptedIds = new Set(issues.interrupted.map((t) => t.id))
  const time = nowText()
  const todos = listTodos().map((todo) => {
    if (orphanIds.has(todo.id)) {
      return { ...todo, status: '已完成' as const, updatedAt: time, completedAt: todo.completedAt || time, lastError: '对账修复：影像已归档，关闭残留待办' }
    }
    if (reopenIds.has(todo.id)) {
      return { ...todo, status: '待补拍' as const, updatedAt: time, completedAt: '', lastError: '对账修复：影像退回需重拍，待办重新打开' }
    }
    if (interruptedIds.has(todo.id)) {
      return { ...todo, status: '待补拍' as const, updatedAt: time, lastError: '对账修复：异常中断后解锁，可重新发起补拍' }
    }
    return todo
  })

  try {
    commit({
      [PHOTO_KEY]: photos.map((row) => photoPatch.get(Number(row.id)) ?? row),
      __reshootTodos: todos,
    })
  } catch (error) {
    return { ok: false, message: `修复失败，已整体退回未改动：${error instanceof Error ? error.message : '存储异常'}` }
  }

  const fixed = issues.orphans.length + issues.reopened.length + issues.interrupted.length + issues.drifting.length
  const parts: string[] = []
  if (issues.orphans.length) parts.push(`关闭残留待办 ${issues.orphans.length} 条`)
  if (issues.reopened.length) parts.push(`重开待办 ${issues.reopened.length} 条`)
  if (issues.interrupted.length) parts.push(`解锁中断任务 ${issues.interrupted.length} 条`)
  if (issues.drifting.length) parts.push(`影像退回需重拍 ${issues.drifting.length} 条`)
  const manual = issues.missing.length ? `；另有 ${issues.missing.length} 条待办找不到影像档案，需人工移除` : ''
  return { ok: true, message: `已修复 ${fixed} 处断开（${parts.join('、')}）${manual}` }
}

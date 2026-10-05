import {
  commitState,
  listRetakeTodos,
  listRows,
  type PersistedState,
} from './local-store'
import { BusinessReject, type ActionResult, type ArchiveVersion, type DrawingRetakeTodo, type EntryRow } from './types'

// 影像模块的字段与动作集中在这：列页和领域流程共用，避免两边各写一份又对不上。
export const PHOTOGRAPHY_KEY = 'photography'
export const STATUS_FIELD = '影像状态'
export const ACTION_ASSIGN = '分配编号'
export const ACTION_ARCHIVE = '提交归档'
export const ACTION_RETAKE = '安排重拍'
export const STATUS_SHOT = '已拍摄'
export const STATUS_NUMBERED = '已编号'
export const STATUS_ARCHIVED = '已归档'
export const STATUS_RETAKE = '需重拍'

const CODE_FIELD = '影像编号'
const SUBJECT_FIELD = '拍摄对象'
const TYPE_FIELD = '拍摄类型'
const BEARING_FIELD = '拍摄方位'
const ARCHIVE_VERSIONS_FIELD = 'archiveVersions'

const RETAKED_FROM_ARCHIVE = '已归档影像安排重拍'

function nowText(): string {
  // 本地时间 ISO 风格串，纯前端够用，换回后端时由服务端时间替换。
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function getVersions(row: EntryRow): ArchiveVersion[] {
  const raw = row[ARCHIVE_VERSIONS_FIELD]
  return Array.isArray(raw) ? (raw as ArchiveVersion[]) : []
}

function buildSnapshot(row: EntryRow): ArchiveVersion['snapshot'] {
  const snapshot: ArchiveVersion['snapshot'] = {}
  for (const [key, value] of Object.entries(row)) {
    if (key === 'pending' || key === 'abnormal' || key === ARCHIVE_VERSIONS_FIELD) {
      continue
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      snapshot[key] = value
    } else if (value === null || value === undefined) {
      snapshot[key] = null
    }
  }
  return snapshot
}

function findPhoto(rows: EntryRow[], id: number): { index: number; row: EntryRow } {
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    throw new BusinessReject(`没有找到编号为 ${id} 的影像档案`)
  }
  return { index, row: rows[index] }
}

function openRetake(rows: DrawingRetakeTodo[], photographyId: number): DrawingRetakeTodo | undefined {
  return rows.find(
    (item) => item.photographyId === photographyId && item.status === '待补拍',
  )
}

function nextTodoId(rows: DrawingRetakeTodo[]): string {
  const seq = rows.reduce((max, item) => {
    const n = Number(String(item.id).replace(/^RETAKE-/, ''))
    return Number.isFinite(n) && n > max ? n : max
  }, 0)
  return `RETAKE-${String(seq + 1).padStart(4, '0')}`
}

function buildRetakeTodo(row: EntryRow, sourceVersion: number, operator: string): DrawingRetakeTodo {
  const text = (field: string) => {
    const value = row[field]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  }
  return {
    id: nextTodoId(listRetakeTodos()),
    photographyId: Number(row.id),
    photographyCode: text(CODE_FIELD),
    subject: text(SUBJECT_FIELD),
    shootType: text(TYPE_FIELD),
    bearing: text(BEARING_FIELD),
    createdAt: nowText(),
    createdBy: operator,
    status: '待补拍',
    sourceArchiveVersion: sourceVersion,
  }
}

/** 把事务里抛出的业务拒绝转成结果消息；系统错误继续往上抛，由页面提示重试。 */
function transact(mutate: (draft: PersistedState) => string): ActionResult {
  let message = ''
  try {
    commitState((draft) => {
      message = mutate(draft)
    })
  } catch (error) {
    if (error instanceof BusinessReject) {
      return { ok: false, message: error.message }
    }
    throw error
  }
  return { ok: true, message }
}

export type PhotographyActionOptions = {
  operator?: string
}

/**
 * 影像「安排重拍」：
 * - 仅已归档可重拍；状态回到「需重拍」，pending=true；
 * - 原归档版本原样保留（archiveVersions 不动），列表上仍可查；
 * - 同一影像只保留一份未完成补拍待办，重复点击不新增；
 * - 影像状态与绘图待办同事务落盘，任一步失败两边一起退回。
 */
export function arrangeRetake(id: number, options: PhotographyActionOptions = {}): ActionResult {
  const operator = options.operator ?? '值班管理员'
  return transact((draft) => {
    const rows = draft.entries[PHOTOGRAPHY_KEY] ?? (draft.entries[PHOTOGRAPHY_KEY] = [])
    const { index, row } = findPhoto(rows, id)
    const todos = (draft.drawingRetakeTodos ??= [])
    const current = String(row.status)

    const existing = openRetake(todos, Number(row.id))
    if (current === STATUS_RETAKE && existing) {
      throw new BusinessReject('该影像已安排重拍，绘图侧补拍待办已存在，无需重复安排')
    }
    if (current !== STATUS_ARCHIVED) {
      throw new BusinessReject(`只有「${STATUS_ARCHIVED}」的影像才能安排重拍，当前为「${current}」`)
    }

    // 脏数据自愈：状态已是需重拍但待办丢了，补一份；正常路径下版本已存在。
    let versions = getVersions(row)
    if (versions.length === 0) {
      const repaired: ArchiveVersion = {
        version: 1,
        status: STATUS_ARCHIVED,
        archivedAt: nowText(),
        operator,
        snapshot: buildSnapshot(row),
        reason: '历史数据补录归档版本',
      }
      versions = [repaired]
    }
    const todo =
      existing ?? buildRetakeTodo(row, versions[versions.length - 1].version, operator)
    if (!existing) {
      todos.push(todo)
    }

    rows[index] = {
      ...row,
      status: STATUS_RETAKE,
      [STATUS_FIELD]: STATUS_RETAKE,
      pending: true,
      abnormal: false,
      archiveVersions: versions,
    }
    return existing
      ? `影像「${row[CODE_FIELD] ?? id}」已处于需重拍，已补挂绘图补拍待办`
      : `影像「${row[CODE_FIELD] ?? id}」已安排重拍：状态回到「${STATUS_RETAKE}」，原归档版本保留，绘图侧已生成补拍待办 ${todo.id}`
  })
}

/**
 * 影像「提交归档」：
 * - 已编号或需重拍才可归档；重新归档追加新版本，绝不覆盖历史；
 * - 需重拍归档时把对应未完成补拍待办一并闭环，仍是同一事务。
 */
export function archivePhoto(id: number, options: PhotographyActionOptions = {}): ActionResult {
  const operator = options.operator ?? '值班管理员'
  return transact((draft) => {
    const rows = draft.entries[PHOTOGRAPHY_KEY] ?? (draft.entries[PHOTOGRAPHY_KEY] = [])
    const { index, row } = findPhoto(rows, id)
    const todos = (draft.drawingRetakeTodos ??= [])
    const current = String(row.status)

    if (current === STATUS_ARCHIVED) {
      throw new BusinessReject('影像已归档，请勿重复归档；如需修改请先安排重拍')
    }
    if (current !== STATUS_NUMBERED && current !== STATUS_RETAKE) {
      throw new BusinessReject(`当前状态「${current}」不能归档，请先完成编号`)
    }

    const versions = getVersions(row)
    const version: ArchiveVersion = {
      version: versions.length + 1,
      status: STATUS_ARCHIVED,
      archivedAt: nowText(),
      operator,
      snapshot: buildSnapshot(row),
      reason: current === STATUS_RETAKE ? RETAKED_FROM_ARCHIVE : undefined,
    }
    const closed: string[] = []
    for (const todo of todos) {
      if (todo.photographyId === Number(row.id) && todo.status === '待补拍') {
        todo.status = '已完成'
        todo.closedAt = nowText()
        todo.closedBy = operator
        todo.note = '影像已重新归档，补拍待办自动闭环'
        closed.push(todo.id)
      }
    }

    rows[index] = {
      ...row,
      status: STATUS_ARCHIVED,
      [STATUS_FIELD]: STATUS_ARCHIVED,
      pending: false,
      abnormal: false,
      archiveVersions: [...versions, version],
    }
    return closed.length
      ? `影像「${row[CODE_FIELD] ?? id}」已重新归档为 v${version.version}（历史 ${versions.length} 个版本保留），补拍待办 ${closed.join('、')} 已闭环`
      : `影像「${row[CODE_FIELD] ?? id}」已归档为 v${version.version}`
  })
}

/** 影像「分配编号」：已拍摄 → 已编号，同步归档状态字段。 */
export function assignNumber(id: number, options: PhotographyActionOptions = {}): ActionResult {
  const operator = options.operator ?? '值班管理员'
  return transact((draft) => {
    const rows = draft.entries[PHOTOGRAPHY_KEY] ?? (draft.entries[PHOTOGRAPHY_KEY] = [])
    const { index, row } = findPhoto(rows, id)
    const current = String(row.status)
    if (current === STATUS_NUMBERED) {
      throw new BusinessReject('影像已经完成编号，不用重复操作')
    }
    if (current !== STATUS_SHOT) {
      throw new BusinessReject(`只有「${STATUS_SHOT}」的影像才能分配编号，当前为「${current}」`)
    }
    rows[index] = {
      ...row,
      status: STATUS_NUMBERED,
      [STATUS_FIELD]: STATUS_NUMBERED,
      pending: true,
      abnormal: false,
    }
    return `影像「${row[CODE_FIELD] ?? id}」已分配编号，当前状态「${STATUS_NUMBERED}」`
  })
}

/** 影像页动作统一入口。 */
export function runPhotographyAction(
  id: number,
  action: string,
  options?: PhotographyActionOptions,
): ActionResult {
  if (action === ACTION_RETAKE) {
    return arrangeRetake(id, options)
  }
  if (action === ACTION_ARCHIVE) {
    return archivePhoto(id, options)
  }
  if (action === ACTION_ASSIGN) {
    return assignNumber(id, options)
  }
  return { ok: false, message: `影像档案没有登记「${action}」这个动作` }
}

export function photoArchiveVersions(id: number): ArchiveVersion[] {
  const row = listRows(PHOTOGRAPHY_KEY).find((item) => Number(item.id) === id)
  return row ? getVersions(row) : []
}

export type RetakeTodoView = DrawingRetakeTodo

export function listPhotoRetakeTodos(): DrawingRetakeTodo[] {
  return listRetakeTodos()
}

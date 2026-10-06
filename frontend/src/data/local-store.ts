import { SEED_ROWS } from './seed'
import type { EntryRow, ReshootTodo } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都在。
const STORAGE_KEY = 'field-archaeology-digital:entries'
// 绘图侧补拍待办与影像档案共用一个存储单元，保证两边能在一次提交里原子落库。
export const RESHOOT_TODO_KEY = '__reshootTodos'

export type EntriesBlob = Record<string, EntryRow[] | ReshootTodo[]>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// 老版本只播种了 status，业务字段里的「影像状态/图纸状态」是不回写的脏值；
// 归档版本也没有留痕。读取时一次性补齐，之后所有流转都以同一份数据为准。
function migrate(blob: EntriesBlob): EntriesBlob {
  const next: EntriesBlob = {}
  for (const [key, rows] of Object.entries(blob)) {
    if (!Array.isArray(rows)) {
      continue
    }
    if (key === RESHOOT_TODO_KEY) {
      next[key] = rows as ReshootTodo[]
      continue
    }
    next[key] = (rows as EntryRow[]).map((row) => {
      const fixed: EntryRow = { ...row }
      if (key === 'photography') {
        fixed['影像状态'] = String(row.status)
        if (row.status === '已归档' && (!row.archiveVersions || row.archiveVersions.length === 0)) {
          fixed.archiveVersions = [
            {
              version: 1,
              archivedAt: row.lastArchivedAt ?? '',
              storagePath: String(row['存储路径'] ?? ''),
              note: '历史归档补录',
            },
          ]
        }
      }
      if (key === 'drawing') {
        fixed['图纸状态'] = String(row.status)
      }
      return fixed
    })
  }
  return next
}

function seedBlob(): EntriesBlob {
  return migrate(clone(SEED_ROWS) as EntriesBlob)
}

function readStorage(): EntriesBlob {
  const fallback = seedBlob()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as EntriesBlob
    return { ...fallback, ...parsed, ...migrate(parsed) }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: EntriesBlob | null = null

export function allRows(): EntriesBlob {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return (allRows()[key] as EntryRow[] | undefined) ?? []
}

export function listTodos(): ReshootTodo[] {
  return (allRows()[RESHOOT_TODO_KEY] as ReshootTodo[] | undefined) ?? []
}

/**
 * 跨模块事务：影像状态和绘图待办必须在同一次提交里落库。
 * 先完成内存计算、最后一次性写 localStorage——任何一步构造失败都会直接抛出，
 * 存储里还是提交前的完整快照，两边一起退回，不会出现半成功。
 */
export function commit(changes: Record<string, EntryRow[] | ReshootTodo[]>): void {
  const next: EntriesBlob = { ...allRows(), ...changes }
  const serialized = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先写存储：setItem 抛错（配额满/存储损坏）时内存缓存不动，调用方按失败处理。
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = JSON.parse(serialized) as EntriesBlob
}

/** 单模块写入保留给普通流转使用，内部也走同一个提交口。 */
export function saveRows(key: string, rows: EntryRow[]): void {
  commit({ [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 仅供测试重置内存缓存使用。 */
export function __resetCacheForTest(): void {
  cache = null
}

export { timestamp as nowText }

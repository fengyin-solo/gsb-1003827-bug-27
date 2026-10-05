import { SEED_ROWS } from './seed'
import type { DrawingRetakeTodo, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
export const STORAGE_KEY = 'field-archaeology-digital:entries'
export const DRAWING_RETAKE_KEY = 'drawingRetakeTodos'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export type EntriesState = {
  [moduleKey: string]: EntryRow[]
}

export type PersistedState = {
  entries: EntriesState
  [DRAWING_RETAKE_KEY]: DrawingRetakeTodo[]
}

function seedEntries(): EntriesState {
  return clone(SEED_ROWS)
}

function freshState(): PersistedState {
  return { entries: seedEntries(), [DRAWING_RETAKE_KEY]: [] }
}

function writeStorage(raw: string): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, raw)
  }
}

function isShaped(value: unknown): value is { entries: EntriesState } & Partial<PersistedState> {
  return typeof value === 'object' && value !== null && 'entries' in value
}

function readStorage(): PersistedState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return freshState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fallback = freshState()
    writeStorage(JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    // 兼容老版本扁平存档：整对象都是模块数组，没有绘图待办集合。
    if (!isShaped(parsed)) {
      const migrated: PersistedState = {
        entries: { ...seedEntries(), ...(clone(parsed) as EntriesState) },
        [DRAWING_RETAKE_KEY]: [],
      }
      writeStorage(JSON.stringify(migrated))
      return migrated
    }
    const entries = (parsed.entries ?? {}) as EntriesState
    return {
      entries: { ...seedEntries(), ...entries },
      [DRAWING_RETAKE_KEY]: Array.isArray(parsed[DRAWING_RETAKE_KEY])
        ? (parsed[DRAWING_RETAKE_KEY] as DrawingRetakeTodo[])
        : [],
    }
  } catch {
    const fallback = freshState()
    writeStorage(JSON.stringify(fallback))
    return fallback
  }
}

let cache: PersistedState | null = null

function state(): PersistedState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): EntriesState {
  return state().entries
}

export function listRows(key: string): EntryRow[] {
  return state().entries[key] ?? []
}

/**
 * 事务式更新：一次调用里可以同时改多个面（影像状态 + 绘图待办）。
 * 改完一次性落盘；落盘抛错时内存缓存整体回滚到事务前，两边一起退回，不留半截数据。
 */
export function commitState(mutate: (draft: PersistedState) => void): void {
  const snapshot = state()
  const draft = clone(snapshot)
  mutate(draft)
  try {
    writeStorage(JSON.stringify(draft))
  } catch (error) {
    // localStorage 写失败（配额、隐私模式等）：放弃整笔改动，调用方按失败重试处理。
    cache = snapshot
    throw error instanceof Error ? error : new Error('数据保存失败，请重试')
  }
  cache = draft
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitState((draft) => {
    draft.entries[key] = rows
  })
}

export function listRetakeTodos(): DrawingRetakeTodo[] {
  return clone(state()[DRAWING_RETAKE_KEY])
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/** 测试/重置入口：恢复整库示例数据并清空绘图补拍待办。 */
export function resetAllState(): void {
  const fresh = freshState()
  writeStorage(JSON.stringify(fresh))
  cache = fresh
}

export function storageKey(): string {
  return STORAGE_KEY
}

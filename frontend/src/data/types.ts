/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/** 归档版本：只追加、不改写，重拍后重新归档会生成新版本，历史版本原样保留。 */
export type ArchiveVersion = {
  version: number
  archivedAt: string
  storagePath: string
  note: string
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  archiveVersions?: ArchiveVersion[]
  lastArchivedAt?: string
  [field: string]: string | number | boolean | ArchiveVersion[] | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 明确哪些状态是终态；不填时沿用「状态数组最后一项」。重拍/退回类状态不能被当成终态。 */
  terminalStatuses?: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 绘图侧的影像补拍待办：与影像档案一一联动。 */
export type ReshootTodoStatus = '待补拍' | '补拍中' | '已完成'

export type ReshootTodo = {
  id: number
  photographyId: number
  影像编号: string
  拍摄对象: string
  reason: string
  status: ReshootTodoStatus
  /** 触发本次重拍时所依据的归档版本，重归档后该版本仍保留。 */
  sourceVersion: number
  createdAt: string
  updatedAt: string
  completedAt: string
  /** 异常中断/状态漂移后的修复次数，用于暴露重试链路。 */
  failCount: number
  lastError: string
}

/** 影像状态与绘图补拍待办之间的对账结果。 */
export type ReshootConsistency = {
  /** 待办还挂着，影像却已归档：影像侧状态丢失/待办残留，待办应关闭。 */
  orphans: ReshootTodo[]
  /** 待办已完成，影像却仍是需重拍：归档关闭待办的提交残缺，待办应回退。 */
  reopened: ReshootTodo[]
  /** 卡在补拍中：异常中断后需要解锁重试。 */
  interrupted: ReshootTodo[]
  /** 影像存在但状态既不是需重拍也不是已归档：两边漂移，需退回重拍。 */
  drifting: ReshootTodo[]
  /** 影像档案已不存在：无法自动修复，只能人工移除待办。 */
  missing: ReshootTodo[]
  hasIssue: boolean
}

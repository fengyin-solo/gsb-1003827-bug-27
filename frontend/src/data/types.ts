/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | ArchiveVersion[] | null | undefined
}

/** 归档版本：每次提交归档都留一份不可变快照，重拍后历史版本仍可查，重新归档只追加不覆盖。 */
export type ArchiveVersion = {
  version: number
  status: string
  archivedAt: string
  operator: string
  snapshot: Record<string, string | number | boolean | null>
  reason?: string
}

/** 影像「安排重拍」在绘图侧生成的补拍待办，与影像状态在同一事务内写入或回滚。 */
export type DrawingRetakeTodo = {
  id: string
  photographyId: number
  photographyCode: string
  subject: string
  shootType: string
  bearing: string
  createdAt: string
  createdBy: string
  status: '待补拍' | '已完成' | '已取消'
  /** 待办被处理（完成/取消）的时间与操作人，便于事后追溯。 */
  closedAt?: string
  closedBy?: string
  note?: string
  /** 来源归档版本：与影像档案的 archiveVersions.version 对应。 */
  sourceArchiveVersion: number
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
  /** 终态列表：进入终态后 pending=false。不填时默认取 statuses 最后一个。 */
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

/** 业务规则拒绝（不是系统故障）：事务内抛出，由编排层转成 ok:false 结果。 */
export class BusinessReject extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BusinessReject'
  }
}

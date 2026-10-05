<template>
  <section class="page" data-module="photography">
    <header class="page-head">
      <div>
        <h2>影像记录管理</h2>
        <p class="page-desc">维护影像档案，围绕影像编号、拍摄对象、拍摄类型、拍摄方位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记影像档案</button>
        <button class="btn" type="button" @click="exportRows">导出影像记录清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>归档版本</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <button v-if="versionCount(row) > 0" class="link" type="button" @click="viewHistory(row)">
              v{{ latestVersion(row) }}（共 {{ versionCount(row) }} 版）
            </button>
            <span v-else>—</span>
          </td>
          <td>
            <span :class="{ 'status-warn': String(row.status) === '需重拍' }">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              :disabled="busy"
              @click="runAction(action, row)"
            >
              {{ busy && busyKey === actionKey(action, row) ? '处理中…' : action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">
            {{ loadFailed ? '影像记录加载失败，请点击下方「重试」' : '暂无影像记录数据，可先登记影像档案' }}
          </td>
        </tr>
      </tbody>
    </table>

    <section v-if="history" class="history-panel">
      <header class="history-head">
        <h3>归档历史 · {{ history.code }}</h3>
        <button class="btn ghost" type="button" @click="history = null">关闭</button>
      </header>
      <p class="history-tip">重拍后旧版本原样保留；重新归档只追加新版本，历史记录不可覆盖。</p>
      <table class="data-table">
        <thead>
          <tr><th>版本</th><th>归档时间</th><th>归档人</th><th>归档说明</th><th>版本快照（存储路径等）</th></tr>
        </thead>
        <tbody>
          <tr v-for="version in history.versions" :key="version.version">
            <td>v{{ version.version }}</td>
            <td>{{ version.archivedAt }}</td>
            <td>{{ version.operator }}</td>
            <td>{{ version.reason ?? '正常归档' }}</td>
            <td class="snapshot-cell">{{ describeSnapshot(version.snapshot) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条影像记录记录</span>
      <span class="foot-actions">
        <button v-if="loadFailed" class="link" type="button" @click="reload">重试加载</button>
        <span v-if="errorMessage" class="error-text">
          {{ errorMessage }}
          <button v-if="lastFailureRetryable" class="link retry-link" type="button" @click="retryLast">重试</button>
        </span>
        <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
      </span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import {
  ACTION_ARCHIVE,
  ACTION_ASSIGN,
  ACTION_RETAKE,
  PHOTOGRAPHY_KEY,
  photoArchiveVersions,
  runPhotographyAction,
  STATUS_ARCHIVED,
  STATUS_NUMBERED,
  STATUS_RETAKE,
  STATUS_SHOT,
} from '@/data/photography-workflow'
import type { ArchiveVersion, EntryRow } from '@/data/types'

const meta = moduleMeta('photography')
const columns = ["影像编号", "拍摄对象", "拍摄类型", "拍摄方位", "拍摄日期", "摄影人员", "存储路径", "影像状态"]
const statuses = ["已拍摄", "已编号", "已归档", "需重拍"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const loadFailed = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 动作执行中的防重入：事务本身保证只落一份待办，按钮层再挡掉连点。
const busy = ref(false)
const busyKey = ref('')
const lastAttempt = ref<{ id: number; action: string } | null>(null)
// 只有系统异常（已回滚、可安全重放）才给「重试」；业务规则拒绝不重试。
const lastFailureRetryable = ref(false)

const history = ref<{ code: string; versions: ArchiveVersion[] } | null>(null)

const stats = computed(() => [
  { label: '影像总数', value: rows.value.length },
  { label: '已归档数', value: rows.value.filter((row) => String(row.status) === STATUS_ARCHIVED).length },
  { label: '待重拍数', value: rows.value.filter((row) => String(row.status) === STATUS_RETAKE).length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case STATUS_SHOT:
      return [ACTION_ASSIGN]
    case STATUS_NUMBERED:
      return [ACTION_ARCHIVE]
    case STATUS_ARCHIVED:
      return [ACTION_RETAKE]
    case STATUS_RETAKE:
      return [ACTION_ARCHIVE]
    default:
      return [ACTION_ASSIGN, ACTION_ARCHIVE, ACTION_RETAKE]
  }
}

function versionList(row: EntryRow): ArchiveVersion[] {
  return photoArchiveVersions(Number(row.id))
}

function versionCount(row: EntryRow): number {
  return versionList(row).length
}

function latestVersion(row: EntryRow): number {
  const versions = versionList(row)
  return versions.length ? versions[versions.length - 1].version : 0
}

function describeSnapshot(snapshot: ArchiveVersion['snapshot']): string {
  return Object.entries(snapshot)
    .filter(([key]) => key !== 'id' && key !== 'status' && key !== '影像状态')
    .map(([key, value]) => `${key}=${value ?? ''}`)
    .join('；')
}

function viewHistory(row: EntryRow) {
  history.value = {
    code: String(row['影像编号'] ?? row.id),
    versions: versionList(row),
  }
}

function actionKey(action: string, row: EntryRow): string {
  return `${action}:${String(row.id)}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = ''
  successMessage.value = '影像档案登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  if (busy.value) {
    return
  }
  errorMessage.value = ''
  successMessage.value = ''
  const id = Number(row.id)
  lastAttempt.value = { id, action }
  lastFailureRetryable.value = false
  busy.value = true
  busyKey.value = actionKey(action, row)
  try {
    // 走影像专用工作流：重拍/归档都与绘图待办在同一事务里提交或回滚。
    const result = runPhotographyAction(id, action)
    if (!result.ok) {
      // 业务拒绝（状态不对、重复操作）：状态未改，直接看提示即可，不提供重试。
      errorMessage.value = result.message
    } else {
      successMessage.value = result.message
    }
  } catch (error) {
    // 存储层异常已把影像状态与绘图待办一起回滚，重放安全，提示用户重试。
    errorMessage.value = error instanceof Error ? `操作失败（已回滚）：${error.message}` : '操作失败（已回滚），请重试'
    lastFailureRetryable.value = true
  } finally {
    busy.value = false
    busyKey.value = ''
  }
  reload()
}

function retryLast() {
  if (!lastAttempt.value || busy.value) {
    return
  }
  const { id, action } = lastAttempt.value
  const row = listRows(PHOTOGRAPHY_KEY).find((item) => Number(item.id) === id)
  if (!row) {
    errorMessage.value = '原影像档案已不存在，无法重试'
    reload()
    return
  }
  runAction(action, row)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    loadFailed.value = false
    // 归档历史面板跟着刷新，确保看到最新版本。
    if (history.value) {
      const current = rows.value.find((row) => String(row['影像编号']) === history.value?.code)
      history.value = current
        ? { code: history.value.code, versions: versionList(current) }
        : history.value
    }
  } catch (error) {
    loadFailed.value = true
    rows.value = []
    total.value = 0
    errorMessage.value = error instanceof Error ? error.message : '影像记录列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.status-warn { color: #b42318; font-weight: 600; }
.history-panel {
  margin-top: 14px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.history-head { display: flex; justify-content: space-between; align-items: center; }
.history-head h3 { margin: 0; font-size: 14px; }
.history-tip { color: var(--muted); font-size: 12px; margin: 6px 0 10px; }
.snapshot-cell { max-width: 420px; color: var(--muted); }
.foot-actions { display: flex; gap: 10px; align-items: center; }
.success-text { color: #067647; }
.retry-link { margin-left: 6px; }
.link:disabled { color: #9aa6b2; cursor: not-allowed; }
</style>

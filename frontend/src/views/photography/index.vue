<template>
  <section class="page" data-module="photography">
    <header class="page-head">
      <div>
        <h2>影像记录管理</h2>
        <p class="page-desc">维护影像档案，围绕影像编号、拍摄对象、拍摄类型、拍摄方位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记影像档案</button>
        <button class="btn" type="button" :disabled="busy !== null" @click="exportRows">导出影像记录清单</button>
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

    <div v-if="consistency.hasIssue" class="warn-banner">
      <span>
        检测到影像状态与绘图补拍待办断开：
        残留待办 {{ consistency.orphans.length }}、
        待办误关闭 {{ consistency.reopened.length }}、
        中断任务 {{ consistency.interrupted.length }}、
        状态漂移 {{ consistency.drifting.length }}、
        档案缺失 {{ consistency.missing.length }}
      </span>
      <button class="btn" type="button" :disabled="busy !== null" @click="repair">一键修复</button>
    </div>
    <p v-if="successMessage" class="success-text">{{ successMessage }}</p>
    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="button" :disabled="busy !== null" @click="reload">查询</button>
      <button class="btn ghost" type="button" :disabled="busy !== null" @click="resetFilters">重置条件</button>
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
          <td>{{ versionText(row) }}</td>
          <td>
            {{ row.status }}
            <span v-if="linkedTodoMap[Number(row.id)]" class="badge" :class="todoBadgeClass(linkedTodoMap[Number(row.id)].status)">
              补拍{{ linkedTodoMap[Number(row.id)].status }}
            </span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action.key"
              class="link"
              type="button"
              :disabled="busy === Number(row.id)"
              @click="runAction(action.key, row)"
            >
              {{ busy === Number(row.id) ? '处理中…' : action.label }}
            </button>
            <span v-if="!availableActions(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="loading">
          <td :colspan="columns.length + 3" class="empty-state">影像记录加载中…</td>
        </tr>
        <tr v-else-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">{{ emptyText }}</td>
        </tr>
      </tbody>
    </table>

    <section v-if="todos.length" class="todo-panel">
      <h3>重拍联动状态（绘图侧补拍待办）</h3>
      <table class="data-table">
        <thead>
          <tr><th>影像编号</th><th>拍摄对象</th><th>补拍状态</th><th>依据版本</th><th>失败次数</th><th>最近异常</th><th>更新时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="todo.id">
            <td>{{ todo.影像编号 }}</td>
            <td>{{ todo.拍摄对象 || '—' }}</td>
            <td>{{ todo.status }}</td>
            <td>v{{ todo.sourceVersion }}</td>
            <td>{{ todo.failCount }}</td>
            <td>{{ todo.lastError || '—' }}</td>
            <td>{{ todo.updatedAt }}</td>
          </tr>
        </tbody>
      </table>
      <p class="panel-hint">待办的开始补拍、失败重试与中断恢复请在「实测绘图」页操作；重新归档后待办自动关闭。</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条影像记录记录</span>
      <span v-if="errorMessage" class="error-text">操作失败，请检查后重试</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { checkConsistency, listReshootTodos, repairConsistency } from '@/data/reshoot'
import type { EntryRow, ReshootConsistency, ReshootTodo } from '@/data/types'

const meta = moduleMeta('photography')
const columns = ['影像编号', '拍摄对象', '拍摄类型', '拍摄方位', '拍摄日期', '摄影人员', '存储路径', '影像状态']
const statuses = ['已拍摄', '已编号', '已归档', '需重拍']

const rows = ref<EntryRow[]>([])
const todos = ref<ReshootTodo[]>([])
const total = ref(0)
const loading = ref(false)
const busy = ref<number | null>(null)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const consistency = ref<ReshootConsistency>({
  orphans: [], reopened: [], interrupted: [], drifting: [], missing: [], hasIssue: false,
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '影像总数', value: rows.value.length },
  { label: '已归档数', value: rows.value.filter((row) => String(row.status) === '已归档').length },
  { label: '待编号数', value: rows.value.filter((row) => String(row.status) === '已拍摄').length },
  { label: '需重拍数', value: rows.value.filter((row) => String(row.status) === '需重拍').length },
])

const linkedTodoMap = computed<Record<number, ReshootTodo>>(() => {
  const map: Record<number, ReshootTodo> = {}
  for (const todo of todos.value) {
    if (todo.status !== '已完成') {
      map[todo.photographyId] = todo
    }
  }
  return map
})

const emptyText = computed(() =>
  Object.values(filters.value).some((value) => value.trim())
    ? '没有符合筛选条件的影像记录，请调整查询条件'
    : '暂无影像记录数据，可先登记影像档案',
)

// 动作按状态收敛：已归档只能安排重拍；需重拍只能重新归档；避免在错误状态上触发流转。
function availableActions(row: EntryRow): { key: string; label: string }[] {
  switch (String(row.status)) {
    case '已拍摄':
      return [{ key: '分配编号', label: '分配编号' }]
    case '已编号':
      return [{ key: '提交归档', label: '提交归档' }]
    case '已归档':
      return [{ key: '安排重拍', label: '安排重拍' }]
    case '需重拍':
      return [{ key: '提交归档', label: '重新归档' }]
    default:
      return []
  }
}

function versionCount(row: EntryRow): number {
  return (row.archiveVersions ?? []).length
}

function versionText(row: EntryRow): string {
  const count = versionCount(row)
  if (String(row.status) === '需重拍' && count > 0) {
    return `原版本 v${count} 已保留，待重新归档`
  }
  if (count > 0) {
    return `v${count}（共 ${count} 个历史版本）`
  }
  return '—'
}

function todoBadgeClass(status: string): string {
  if (status === '补拍中') return 'badge-working'
  if (status === '已完成') return 'badge-done'
  return 'badge-wait'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  try {
    downloadEntries(meta.key)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '影像记录清单导出失败'
  }
}

function openCreate() {
  errorMessage.value = '影像档案登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  // 行级锁：重复点击在同一条记录上直接忽略，幂等由服务层再兜一道。
  if (busy.value !== null) {
    return
  }
  busy.value = Number(row.id)
  errorMessage.value = ''
  successMessage.value = ''
  try {
    // 让出一帧渲染处理中状态，再执行同步落库。
    await new Promise((resolve) => setTimeout(resolve, 0))
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    successMessage.value = result.message
  } catch (error) {
    errorMessage.value = `操作异常中断，数据未改动，可重试：${error instanceof Error ? error.message : '未知错误'}`
  } finally {
    busy.value = null
    reload()
  }
}

async function repair() {
  if (busy.value !== null) {
    return
  }
  busy.value = -1
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const result = repairConsistency()
    if (result.ok) {
      successMessage.value = result.message
    } else {
      errorMessage.value = result.message
    }
  } finally {
    busy.value = null
    reload()
  }
}

function reload() {
  errorMessage.value = ''
  loading.value = true
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    todos.value = listReshootTodos()
    consistency.value = checkConsistency()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '影像记录列表读取失败，请重试'
  } finally {
    loading.value = false
  }
}

onMounted(reload)
</script>

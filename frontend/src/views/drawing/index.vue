<template>
  <section class="page" data-module="drawing">
    <header class="page-head">
      <div>
        <h2>实测绘图管理</h2>
        <p class="page-desc">维护实测图纸，围绕图纸编号、绘图对象、绘图类型、比例尺做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记实测图纸</button>
        <button class="btn" type="button" :disabled="busyKey !== ''" @click="exportRows">导出实测绘图清单</button>
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

    <p v-if="successMessage" class="success-text">{{ successMessage }}</p>
    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="button" :disabled="busyKey !== ''" @click="reload">查询</button>
      <button class="btn ghost" type="button" :disabled="busyKey !== ''" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="busyKey === `row-${row.id}`"
              @click="runAction(action, row)"
            >
              {{ busyKey === `row-${row.id}` ? '处理中…' : action }}
            </button>
          </td>
        </tr>
        <tr v-if="loading">
          <td :colspan="columns.length + 2" class="empty-state">实测绘图列表加载中…</td>
        </tr>
        <tr v-else-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">{{ emptyText }}</td>
        </tr>
      </tbody>
    </table>

    <section class="todo-panel">
      <div class="todo-head">
        <h3>影像补拍待办</h3>
        <div class="todo-tools">
          <button class="btn ghost" type="button" :disabled="busyKey !== ''" @click="reload">刷新对账</button>
          <button v-if="consistency.hasIssue" class="btn" type="button" :disabled="busyKey !== ''" @click="repair">
            一键修复（{{ issueCount }} 处断开）
          </button>
        </div>
      </div>

      <div v-if="consistency.hasIssue" class="warn-banner">
        <ul class="issue-list">
          <li v-if="consistency.orphans.length">影像已归档但待办残留 {{ consistency.orphans.length }} 条，修复将关闭待办</li>
          <li v-if="consistency.reopened.length">待办已完成但影像仍是需重拍 {{ consistency.reopened.length }} 条，修复将重开待办</li>
          <li v-if="consistency.interrupted.length">补拍异常中断 {{ consistency.interrupted.length }} 条，修复将解锁回待补拍</li>
          <li v-if="consistency.drifting.length">影像状态漂移 {{ consistency.drifting.length }} 条，修复将影像退回需重拍</li>
          <li v-if="consistency.missing.length">影像档案缺失 {{ consistency.missing.length }} 条，无法自动修复，请人工移除</li>
        </ul>
      </div>

      <table v-if="todos.length" class="data-table">
        <thead>
          <tr>
            <th>影像编号</th><th>拍摄对象</th><th>补拍事由</th><th>依据版本</th>
            <th>待办状态</th><th>失败次数</th><th>最近异常</th><th>更新时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="todo.id">
            <td>{{ todo.影像编号 }}</td>
            <td>{{ todo.拍摄对象 || '—' }}</td>
            <td>{{ todo.reason }}</td>
            <td>v{{ todo.sourceVersion }}</td>
            <td>
              <span class="badge" :class="todoBadgeClass(todo.status)">{{ todo.status }}</span>
              <span v-if="isStaleWorking(todo)" class="stale-hint">（疑似中断，可重试）</span>
            </td>
            <td>{{ todo.failCount }}</td>
            <td>{{ todo.lastError || '—' }}</td>
            <td>{{ todo.updatedAt }}</td>
            <td class="row-actions">
              <template v-if="!missingTodoIds.has(todo.id)">
                <button
                  v-if="todo.status === '待补拍'"
                  class="link"
                  type="button"
                  :disabled="busyKey !== ''"
                  @click="startWork(todo)"
                >{{ busyKey === `todo-${todo.id}` ? '处理中…' : (todo.failCount > 0 ? '重新发起补拍' : '开始补拍') }}</button>
                <button
                  v-if="todo.status === '补拍中'"
                  class="link"
                  type="button"
                  :disabled="busyKey !== ''"
                  @click="startWork(todo)"
                >继续/重试补拍</button>
                <button
                  v-if="todo.status === '补拍中'"
                  class="link link-danger"
                  type="button"
                  :disabled="busyKey !== ''"
                  @click="failWork(todo)"
                >登记失败</button>
              </template>
              <template v-else>
                <span class="muted-text">影像档案缺失</span>
                <button class="link link-danger" type="button" :disabled="busyKey !== ''" @click="removeTodo(todo)">移除待办</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state todo-empty">暂无影像补拍待办。影像档案「安排重拍」后会在此生成唯一一份补拍任务。</p>
      <p class="panel-hint">
        补拍完成后请到「影像记录」页对需重拍影像执行重新归档：系统追加新版本而不覆盖历史，待办随归档自动关闭。
      </p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条实测绘图记录 · 补拍待办 {{ openTodoCount }} 条待处理</span>
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
import {
  checkConsistency,
  failReshootWork,
  listReshootTodos,
  removeMissingTodo,
  repairConsistency,
  startReshootWork,
} from '@/data/reshoot'
import type { EntryRow, ReshootConsistency, ReshootTodo } from '@/data/types'

const meta = moduleMeta('drawing')
const columns = ['图纸编号', '绘图对象', '绘图类型', '比例尺', '绘图人', '校核人', '完成日期', '图纸状态']
const actions = ['提交校核', '确认校核', '退回修改']
const statuses = ['绘制中', '待校核', '已校核', '已数字化', '需修改']

const rows = ref<EntryRow[]>([])
const todos = ref<ReshootTodo[]>([])
const total = ref(0)
const loading = ref(false)
const busyKey = ref('')
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
  { label: '图纸总数', value: rows.value.length },
  { label: '已校核数', value: rows.value.filter((row) => row.status === '已校核' || row.status === '已数字化').length },
  { label: '待校核数', value: rows.value.filter((row) => row.status === '待校核').length },
  { label: '补拍待办', value: openTodoCount.value },
])

const openTodoCount = computed(() => todos.value.filter((todo) => todo.status !== '已完成').length)

const issueCount = computed(
  () =>
    consistency.value.orphans.length +
    consistency.value.reopened.length +
    consistency.value.interrupted.length +
    consistency.value.drifting.length +
    consistency.value.missing.length,
)

const missingTodoIds = computed(() => new Set(consistency.value.missing.map((todo) => todo.id)))

const emptyText = computed(() =>
  Object.values(filters.value).some((value) => value.trim())
    ? '没有符合筛选条件的实测绘图记录，请调整查询条件'
    : '暂无实测绘图数据，可先登记实测图纸',
)

function todoBadgeClass(status: string): string {
  if (status === '补拍中') return 'badge-working'
  if (status === '已完成') return 'badge-done'
  return 'badge-wait'
}

// 进入补拍中超过 10 分钟仍未结束，视为异常中断，页面给出重试入口（不自动改动数据）。
function isStaleWorking(todo: ReshootTodo): boolean {
  if (todo.status !== '补拍中') return false
  const updated = new Date(todo.updatedAt.replace(' ', 'T')).getTime()
  return Number.isFinite(updated) && Date.now() - updated > 10 * 60 * 1000
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  try {
    downloadEntries(meta.key)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '实测绘图清单导出失败'
  }
}

function openCreate() {
  errorMessage.value = '实测图纸登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  if (busyKey.value !== '') return
  busyKey.value = `row-${row.id}`
  setMessages('')
  await tick()
  try {
    const result = applyAction(meta.key, Number(row.id), action)
    setMessages(result.ok ? result.message : '', result.ok ? '' : result.message)
  } catch (error) {
    setMessages('', `操作异常中断，数据未改动，可重试：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    busyKey.value = ''
    reload()
  }
}

async function startWork(todo: ReshootTodo) {
  if (busyKey.value !== '') return
  busyKey.value = `todo-${todo.id}`
  setMessages('')
  await tick()
  try {
    const result = startReshootWork(todo.id)
    setMessages(result.ok ? result.message : '', result.ok ? '' : result.message)
  } catch (error) {
    setMessages('', `开始补拍异常，请重试：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    busyKey.value = ''
    reload()
  }
}

async function failWork(todo: ReshootTodo) {
  if (busyKey.value !== '') return
  busyKey.value = `todo-${todo.id}`
  setMessages('')
  await tick()
  try {
    const reason = `补拍失败，登记于 ${new Date().toLocaleString()}`
    const result = failReshootWork(todo.id, reason)
    setMessages(result.ok ? result.message : '', result.ok ? '' : result.message)
  } catch (error) {
    setMessages('', `失败登记异常，请重试：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    busyKey.value = ''
    reload()
  }
}

async function removeTodo(todo: ReshootTodo) {
  if (busyKey.value !== '') return
  busyKey.value = `todo-${todo.id}`
  setMessages('')
  await tick()
  try {
    const result = removeMissingTodo(todo.id)
    setMessages(result.ok ? result.message : '', result.ok ? '' : result.message)
  } catch (error) {
    setMessages('', `移除待办异常，请重试：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    busyKey.value = ''
    reload()
  }
}

async function repair() {
  if (busyKey.value !== '') return
  busyKey.value = 'repair'
  setMessages('')
  await tick()
  try {
    const result = repairConsistency()
    setMessages(result.ok ? result.message : '', result.ok ? '' : result.message)
  } catch (error) {
    setMessages('', `修复异常中断，未改动数据，可重试：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    busyKey.value = ''
    reload()
  }
}

function setMessages(success: string, error = '') {
  successMessage.value = success
  errorMessage.value = error
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function reload() {
  loading.value = true
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    todos.value = listReshootTodos()
    consistency.value = checkConsistency()
  } catch (error) {
    setMessages('', error instanceof Error ? error.message : '实测绘图列表读取失败，请重试')
  } finally {
    loading.value = false
  }
}

onMounted(reload)
</script>

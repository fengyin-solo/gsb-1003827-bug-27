<template>
  <section class="page" data-module="drawing">
    <header class="page-head">
      <div>
        <h2>实测绘图管理</h2>
        <p class="page-desc">维护实测图纸，围绕图纸编号、绘图对象、绘图类型、比例尺做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记实测图纸</button>
        <button class="btn" type="button" @click="exportRows">导出实测绘图清单</button>
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

    <section class="todo-panel">
      <header class="todo-head">
        <div>
          <h3>绘图待办 · 影像补拍</h3>
          <p class="page-desc">
            影像侧安排重拍后在此生成待办；重复安排不会产生第二份；影像重新归档后待办自动闭环，无需绘图侧手工处理。
          </p>
        </div>
        <button class="btn ghost" type="button" @click="reload">刷新待办</button>
      </header>

      <table v-if="todos.length" class="data-table">
        <thead>
          <tr>
            <th>待办编号</th>
            <th>影像编号</th>
            <th>拍摄对象</th>
            <th>拍摄类型/方位</th>
            <th>来源归档版本</th>
            <th>创建时间</th>
            <th>待办状态</th>
            <th>闭环说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="todo.id" :class="{ 'todo-done': todo.status !== '待补拍' }">
            <td>{{ todo.id }}</td>
            <td>{{ todo.photographyCode }}</td>
            <td>{{ todo.subject || '—' }}</td>
            <td>{{ [todo.shootType, todo.bearing].filter(Boolean).join(' / ') || '—' }}</td>
            <td>v{{ todo.sourceArchiveVersion }}</td>
            <td>{{ todo.createdAt }}</td>
            <td>
              <span :class="{ 'status-open': todo.status === '待补拍' }">{{ todo.status }}</span>
              <span v-if="todo.closedAt" class="close-meta">（{{ todo.closedAt }} · {{ todo.closedBy }}）</span>
            </td>
            <td class="muted-text">{{ todo.note ?? '等待影像重新归档' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="!todoLoadFailed" class="empty-state todo-empty">
        暂无影像补拍待办：影像档案安排重拍后会自动同步到这里
      </p>
      <p v-else class="empty-state todo-empty">
        绘图待办读取失败
        <button class="link retry-link" type="button" @click="reload">重试</button>
      </p>
    </section>

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
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">
            {{ loadFailed ? '实测绘图列表读取失败，请点击下方「重试加载」' : '暂无实测绘图数据，可先登记实测图纸' }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条实测绘图记录</span>
      <span class="foot-actions">
        <button v-if="loadFailed" class="link" type="button" @click="reload">重试加载</button>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
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
  runAction as applyAction,
} from '@/api/local-service'
import { listPhotoRetakeTodos } from '@/data/photography-workflow'
import type { DrawingRetakeTodo, EntryRow } from '@/data/types'

const meta = moduleMeta('drawing')
const columns = ["图纸编号", "绘图对象", "绘图类型", "比例尺", "绘图人", "校核人", "完成日期", "图纸状态"]
const actions = ["提交校核", "确认校核", "退回修改"]
const statuses = ["绘制中", "待校核", "已校核", "已数字化", "需修改"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const loadFailed = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const todos = ref<DrawingRetakeTodo[]>([])
const todoLoadFailed = ref(false)

const stats = computed(() => [
  { label: '图纸总数', value: rows.value.length },
  { label: '待补拍待办', value: todos.value.filter((todo) => todo.status === '待补拍').length },
  { label: '待校核数', value: rows.value.filter((row) => String(row.status) === '待校核').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = ''
  successMessage.value = '实测图纸登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  successMessage.value = result.message
  reload()
}

function loadTodos() {
  try {
    todos.value = listPhotoRetakeTodos()
    todoLoadFailed.value = false
  } catch (error) {
    todoLoadFailed.value = true
    todos.value = []
    errorMessage.value = error instanceof Error ? error.message : '绘图补拍待办读取失败'
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    loadFailed.value = false
  } catch (error) {
    loadFailed.value = true
    rows.value = []
    total.value = 0
    errorMessage.value = error instanceof Error ? error.message : '实测绘图列表读取失败'
  }
  loadTodos()
}

onMounted(reload)
</script>

<style scoped>
.todo-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
}
.todo-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.todo-head h3 { margin: 0 0 4px; font-size: 14px; }
.todo-empty { padding: 14px 0; }
.todo-done { color: var(--muted); }
.status-open { color: #b42318; font-weight: 600; }
.close-meta { font-size: 12px; color: var(--muted); }
.muted-text { color: var(--muted); font-size: 12px; }
.foot-actions { display: flex; gap: 10px; align-items: center; }
.success-text { color: #067647; }
.retry-link { margin-left: 6px; }
</style>

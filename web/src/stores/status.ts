import type { Socket } from 'socket.io-client'
import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { io } from 'socket.io-client'
import { computed, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

// Define interfaces for better type checking
interface DailyGift {
  key: string
  label: string
  enabled?: boolean
  doneToday: boolean
  lastAt?: number
  completedCount?: number
  totalCount?: number
  tasks?: any[]
}

interface DailyGiftsResponse {
  date: string
  growth: DailyGift
  gifts: DailyGift[]
}

export const useStatusStore = defineStore('status', () => {
  const status = ref<any>(null)
  const logs = ref<any[]>([])
  const accountLogs = ref<any[]>([])
  const dailyGifts = ref<DailyGiftsResponse | null>(null)
  const statusAccountId = ref('')
  const loading = ref(false)
  const error = ref('')
  const realtimeConnected = ref(false)
  const realtimeLogsEnabled = ref(true)
  const currentRealtimeAccountId = ref('')
  const tokenRef = useStorage('admin_token', '')

  let socket: Socket | null = null

  // —— 实时日志批量合并 ——
  // WS 日志洪水（务农循环时每秒多条）若逐条 push，日志列表会持续全量重渲染。
  // 这里先缓冲 200ms 再一次性合并，把重渲染频率封顶在 5 次/秒。
  const LOG_FLUSH_INTERVAL_MS = 200
  let pendingLogs: any[] = []
  let pendingAccountLogs: any[] = []
  let logFlushTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleLogFlush() {
    if (logFlushTimer !== null)
      return
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null
      flushPendingLogs()
    }, LOG_FLUSH_INTERVAL_MS)
  }

  function flushPendingLogs() {
    if (pendingLogs.length > 0) {
      const base = logs.value
      // 去重：HTTP 快照与 WS 推送可能包含同一条日志，按 ts+msg 过滤已有项
      const recent = new Set<string>()
      for (const item of base.slice(-500))
        recent.add(`${item?.ts}|${item?.msg}`)
      const fresh = pendingLogs.filter((item: any) => !recent.has(`${item?.ts}|${item?.msg}`))
      pendingLogs = []
      if (fresh.length > 0) {
        const merged = base.concat(fresh)
        logs.value = merged.length > 1000 ? merged.slice(-1000) : merged
      }
    }
    if (pendingAccountLogs.length > 0) {
      const merged = accountLogs.value.concat(pendingAccountLogs)
      accountLogs.value = merged.length > 300 ? merged.slice(-300) : merged
      pendingAccountLogs = []
    }
  }

  function dropPendingLogs() {
    pendingLogs = []
    pendingAccountLogs = []
    if (logFlushTimer !== null) {
      clearTimeout(logFlushTimer)
      logFlushTimer = null
    }
  }

  function getCurrentAccountId() {
    const accountStore = useAccountStore()
    return String((accountStore.currentAccountId as { value?: string })?.value ?? accountStore.currentAccountId ?? '')
  }

  function isCurrentAccount(accountId: string) {
    return getCurrentAccountId() === String(accountId)
  }

  const currentStatusReady = computed(() => {
    const currentId = getCurrentAccountId()
    return !!currentId && !!status.value && statusAccountId.value === currentId
  })

  function normalizeStatusPayload(input: any) {
    return (input && typeof input === 'object') ? { ...input } : {}
  }

  function clearAccountScopedData() {
    status.value = null
    statusAccountId.value = ''
    logs.value = []
    accountLogs.value = []
    dailyGifts.value = null
    error.value = ''
  }

  function normalizeLogEntry(input: any) {
    const entry = (input && typeof input === 'object') ? { ...input } : {}
    const ts = Number(entry.ts) || Date.parse(String(entry.time || '')) || Date.now()
    return {
      ...entry,
      ts,
      time: entry.time || new Date(ts).toISOString().replace('T', ' ').slice(0, 19),
    }
  }

  function shouldHideLogEntryInFrontend(entry: any) {
    const text = [
      entry?.tag,
      entry?.msg,
      entry?.reason,
      entry?.action,
      entry?.meta ? JSON.stringify(entry.meta) : '',
    ].filter(Boolean).join(' ')
    return /\b(?:ACE|TSDK)\b/i.test(text)
  }

  function pushRealtimeLog(entry: any) {
    const next = normalizeLogEntry(entry)
    if (shouldHideLogEntryInFrontend(next))
      return
    // 写入缓冲，200ms 后批量合并（避免逐条 push 触发高频全量重渲染）
    pendingLogs.push(next)
    if (pendingLogs.length > 500)
      pendingLogs = pendingLogs.slice(-500)
    scheduleLogFlush()
  }

  function pushRealtimeAccountLog(entry: any) {
    const next = (entry && typeof entry === 'object') ? entry : {}
    if (shouldHideLogEntryInFrontend(next))
      return
    pendingAccountLogs.push(next)
    if (pendingAccountLogs.length > 200)
      pendingAccountLogs = pendingAccountLogs.slice(-200)
    scheduleLogFlush()
  }

  function handleRealtimeStatus(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || '')
    if (currentRealtimeAccountId.value && accountId !== currentRealtimeAccountId.value)
      return
    if (body.status && typeof body.status === 'object') {
      status.value = normalizeStatusPayload(body.status)
      statusAccountId.value = accountId || currentRealtimeAccountId.value || getCurrentAccountId()
      error.value = ''
    }
  }

  function handleRealtimeLog(payload: any) {
    if (!realtimeLogsEnabled.value)
      return
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || body.id || '')
    if (currentRealtimeAccountId.value && accountId && accountId !== currentRealtimeAccountId.value)
      return
    pushRealtimeLog(payload)
  }

  function handleRealtimeAccountLog(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || '')
    if (currentRealtimeAccountId.value && accountId && accountId !== currentRealtimeAccountId.value)
      return
    pushRealtimeAccountLog(payload)
  }

  function handleRealtimeLogsSnapshot(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || '')
    if (currentRealtimeAccountId.value && accountId && accountId !== 'all' && accountId !== currentRealtimeAccountId.value)
      return
    const list = Array.isArray(body.logs) ? body.logs : []
    dropPendingLogs()
    logs.value = list
      .map((item: any) => normalizeLogEntry(item))
      .filter((item: any) => !shouldHideLogEntryInFrontend(item))
  }

  function handleRealtimeAccountLogsSnapshot(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const list = Array.isArray(body.logs) ? body.logs : []
    pendingAccountLogs = []
    accountLogs.value = currentRealtimeAccountId.value
      ? list
          .filter((item: any) => String(item?.accountId || item?.id || '') === currentRealtimeAccountId.value)
          .filter((item: any) => !shouldHideLogEntryInFrontend(item))
      : list.filter((item: any) => !shouldHideLogEntryInFrontend(item))
  }

  function ensureRealtimeSocket() {
    if (socket)
      return socket

    socket = io('/', {
      path: '/socket.io',
      autoConnect: false,
      transports: ['websocket', 'polling'],
      upgrade: true,
      timeout: 10000,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      auth: {
        token: tokenRef.value,
      },
    })

    socket.on('connect', () => {
      realtimeConnected.value = true
      if (currentRealtimeAccountId.value) {
        socket?.emit('subscribe', { accountId: currentRealtimeAccountId.value })
      }
      else {
        socket?.emit('subscribe', { accountId: 'all' })
      }
    })

    socket.on('disconnect', () => {
      realtimeConnected.value = false
    })

    socket.on('connect_error', (err) => {
      realtimeConnected.value = false
      console.error('[realtime] 连接失败:', err.message)
    })

    socket.on('status:update', handleRealtimeStatus)
    socket.on('log:new', handleRealtimeLog)
    socket.on('account-log:new', handleRealtimeAccountLog)
    socket.on('logs:snapshot', handleRealtimeLogsSnapshot)
    socket.on('account-logs:snapshot', handleRealtimeAccountLogsSnapshot)
    return socket
  }

  function connectRealtime(accountId: string) {
    currentRealtimeAccountId.value = String(accountId || '').trim()
    if (!tokenRef.value)
      return

    const client = ensureRealtimeSocket()
    client.auth = {
      token: tokenRef.value,
      accountId: currentRealtimeAccountId.value || 'all',
    }

    if (client.connected) {
      client.emit('subscribe', { accountId: currentRealtimeAccountId.value || 'all' })
      return
    }
    client.connect()
  }

  function disconnectRealtime() {
    if (!socket)
      return
    socket.off('connect')
    socket.off('disconnect')
    socket.off('connect_error')
    socket.off('status:update', handleRealtimeStatus)
    socket.off('log:new', handleRealtimeLog)
    socket.off('account-log:new', handleRealtimeAccountLog)
    socket.off('logs:snapshot', handleRealtimeLogsSnapshot)
    socket.off('account-logs:snapshot', handleRealtimeAccountLogsSnapshot)
    socket.disconnect()
    socket = null
    realtimeConnected.value = false
  }

  async function fetchStatus(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    loading.value = true
    try {
      const { data } = await api.get('/api/status', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (data.ok) {
        status.value = normalizeStatusPayload(data.data)
        statusAccountId.value = requestedId
        error.value = ''
      }
      else {
        error.value = data.error
      }
    }
    catch (e: any) {
      error.value = e.message
    }
    finally {
      loading.value = false
    }
  }

  async function fetchLogs(accountId: string, options: any = {}) {
    if (!accountId && options.accountId !== 'all')
      return
    const requestedId = String(accountId || options.accountId || '')
    const params: any = { limit: 100, ...options }
    const headers: any = {}
    if (accountId && accountId !== 'all') {
      headers['x-account-id'] = accountId
    }
    else {
      params.accountId = 'all'
    }

    try {
      const { data } = await api.get('/api/logs', { headers, params })
      if (requestedId && requestedId !== 'all' && !isCurrentAccount(requestedId))
        return
      if (data.ok) {
        logs.value = Array.isArray(data.data)
          ? data.data
              .map((item: any) => normalizeLogEntry(item))
              .filter((item: any) => !shouldHideLogEntryInFrontend(item))
          : []
        error.value = ''
      }
    }
    catch (e: any) {
      console.error(e)
    }
  }

  async function fetchDailyGifts(accountId: string) {
    if (!accountId)
      return
    const requestedId = String(accountId)
    try {
      const { data } = await api.get('/api/daily-gifts', {
        headers: { 'x-account-id': accountId },
      })
      if (!isCurrentAccount(requestedId))
        return
      if (data.ok) {
        dailyGifts.value = data.data
      }
    }
    catch (e) {
      console.error('获取每日奖励失败', e)
    }
  }

  async function fetchAccountLogs(accountId = '', limit = 100) {
    const requestedId = String(accountId || '')
    try {
      const headers: Record<string, string> = {}
      if (requestedId)
        headers['x-account-id'] = requestedId
      const res = await api.get(`/api/account-logs?limit=${Math.max(1, Number(limit) || 100)}`, { headers })
      if (Array.isArray(res.data)) {
        if (requestedId && !isCurrentAccount(requestedId))
          return
        accountLogs.value = requestedId
          ? res.data
              .filter((item: any) => String(item?.accountId || item?.id || '') === requestedId)
              .filter((item: any) => !shouldHideLogEntryInFrontend(item))
          : res.data.filter((item: any) => !shouldHideLogEntryInFrontend(item))
      }
    }
    catch (e) {
      console.error(e)
    }
  }

  function setRealtimeLogsEnabled(enabled: boolean) {
    realtimeLogsEnabled.value = !!enabled
  }

  return {
    status,
    statusAccountId,
    currentStatusReady,
    logs,
    accountLogs,
    dailyGifts,
    loading,
    error,
    realtimeConnected,
    realtimeLogsEnabled,
    clearAccountScopedData,
    fetchStatus,
    fetchLogs,
    fetchAccountLogs,
    fetchDailyGifts,
    setRealtimeLogsEnabled,
    connectRealtime,
    disconnectRealtime,
  }
})

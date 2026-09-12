<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'

const props = defineProps<{
  show: boolean
  editData?: any
  // 打开时默认选中的标签：capture = 直接进抓包登录（首页快捷入口用）
  defaultTab?: 'capture' | 'manual'
}>()

const emit = defineEmits(['close', 'saved'])
const CODE_QUERY_RE = /[?&]code=([^&]+)/i
const CAPTURE_SUCCESS_STORAGE_KEY = 'capture_login_succeeded'

interface CaptureFlowState {
  id: string
  platform: 'qq' | 'wx'
  deviceMode: 'pc' | 'mobile'
  pcStatus: {
    supported: boolean
    proxyActive: boolean
    caTrusted: boolean
    proxyPort: number
    proxyServer: string
    error: string
  }
  codeCaptured: boolean
  accountGid: string
  friendCount: number
  captureStatus: string
  proxy: {
    running: boolean
    status: string
    error: string
  }
  publicInfo: {
    host: string
    mitmPort: number
    remainingSec: number
    certificateUrl: string
  }
}

const activeTab = ref<'capture' | 'manual'>('manual')
const loading = ref(false)
const errorMessage = ref('')
const captureEnabled = ref(false)
const captureLoading = ref(false)
const captureChecking = ref(false)
const captureCompleting = ref(false)
const captureError = ref('')
const captureCopiedField = ref<'host' | 'port' | ''>('')
const captureAccountName = ref('')
const capturePlatform = ref<'qq' | 'wx'>('qq')
// pc = 电脑端（自动设系统代理+信任CA，无需手动操作）；mobile = 手机端（手动设 Wi-Fi 代理）
const captureDeviceMode = ref<'pc' | 'mobile'>('pc')
const captureFlow = ref<CaptureFlowState | null>(null)
const showCaptureHelp = ref(false)
const captureHelpMode = ref<'first' | 'daily'>('first')
const captureHelpDevice = ref<'ios' | 'android'>('ios')

const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

const captureHelpSteps = computed(() => {
  // 电脑端：全自动，无需手动设代理与证书
  if (captureDeviceMode.value === 'pc') {
    return [
      '点击开始抓取：自动把系统代理指向本机，并把内置证书装进信任区',
      '这一步同时适用于首次与日常使用，无需任何手动设置',
      '连续添加时，先彻底关闭上一个农场页面，避免抓错账号',
      '打开电脑 QQ 农场（小程序），即可自动捕获登录 Code',
      'Code 获取后账号会立即添加；QQ 好友 GID 将在后台继续同步',
      '抓取结束后系统代理会自动恢复原设置',
    ]
  }
  return captureHelpMode.value === 'first'
    ? [
        '点击开始抓取，获取本次代理地址和端口',
        '打开 CA 证书，并在手机系统中安装和信任',
        '连续添加时，先切换到目标 QQ 并彻底关闭上一个农场',
        '将手机 Wi-Fi 代理设置为页面显示的地址和端口',
        '彻底关闭后重新打开对应的 QQ 或微信农场',
        'Code 获取后账号会立即添加；QQ 好友 GID 将在后台继续同步',
        'QQ 农场保持打开，完整好友列表同步后会立即释放代理，最迟约 15 秒',
      ]
    : [
        '点击开始抓取，确认本次代理地址和端口',
        '连续添加时，先切换到目标 QQ 并彻底关闭上一个农场',
        '将手机 Wi-Fi 代理更新为本次显示的地址和端口',
        '重新打开对应农场，并保持页面打开',
        '账号添加后，QQ 农场继续保持打开，最迟约 15 秒完成后台同步',
        '后台同步结束后，将手机 Wi-Fi 代理改回关闭',
      ]
})

const captureDeviceSteps = computed(() => captureHelpDevice.value === 'ios'
  ? [
      '在 Safari 中点击“打开证书”并允许下载描述文件',
      '进入“设置 → 通用 → VPN 与设备管理”安装描述文件',
      '进入“设置 → 通用 → 关于本机 → 证书信任设置”启用完全信任',
    ]
  : [
      '点击“打开证书”下载 CA 文件',
      '进入系统安全设置中的“安装证书”或“凭据存储”',
      '选择 CA 证书并确认安装；不同品牌的菜单名称可能不同',
    ])

const captureCurrentStep = computed(() => {
  if (!captureFlow.value)
    return '开始新的抓取任务'
  if (!captureFlow.value.codeCaptured) {
    if (captureFlow.value.deviceMode === 'pc') {
      return `打开电脑 QQ 农场（${captureFlow.value.platform === 'qq' ? 'QQ' : '微信'}小程序），自动捕获登录`
    }
    return `设置 Wi-Fi 代理并打开${captureFlow.value.platform === 'qq' ? ' QQ' : '微信'}农场`
  }
  return '已获取 Code，正在立即完成账号操作'
})

const captureNextStep = computed(() => {
  if (!captureFlow.value)
    return captureDeviceMode.value === 'pc'
      ? '点击开始后直接打开电脑 QQ 农场即可'
      : '开始后按本次显示的代理信息设置手机 Wi-Fi'
  if (!captureFlow.value.codeCaptured) {
    return captureFlow.value.deviceMode === 'pc'
      ? '保持农场页面打开，Code 会自动捕获'
      : '重新打开小程序，并保持农场页面打开'
  }
  if (captureFlow.value.platform === 'qq')
    return `即将自动${props.editData ? '更新' : '添加'}账号，好友 GID 将在后台同步`
  return `即将自动${props.editData ? '更新' : '添加'}账号`
})

const { pause: stopCaptureCheck, resume: startCaptureCheck } = useIntervalFn(async () => {
  if (activeTab.value !== 'capture' || !captureFlow.value || captureCompleting.value || captureChecking.value)
    return
  captureChecking.value = true
  try {
    const { data } = await api.get(`/api/capture/sessions/${captureFlow.value.id}`, { timeout: 20000 })
    if (!data?.ok || !data.data)
      return
    captureFlow.value = data.data
    captureError.value = data.data.proxy?.error || ''
    if (data.data.codeCaptured)
      await completeCaptureAccount()
  }
  catch (e: any) {
    captureError.value = e.response?.data?.error || e.message || '查询抓取状态失败'
  }
  finally {
    captureChecking.value = false
  }
}, 1500, { immediate: false })

async function loadCaptureConfig() {
  try {
    const { data } = await api.get('/api/capture/config')
    captureEnabled.value = data?.ok && data.data?.enabled === true
  }
  catch {
    captureEnabled.value = false
  }
}

async function cancelCaptureSession() {
  stopCaptureCheck()
  const flowId = captureFlow.value?.id
  captureFlow.value = null
  if (flowId) {
    try {
      await api.delete(`/api/capture/sessions/${flowId}`)
    }
    catch {}
  }
}

async function startCaptureSession() {
  captureLoading.value = true
  captureError.value = ''
  await cancelCaptureSession()
  try {
    const { data } = await api.post('/api/capture/sessions', {
      platform: capturePlatform.value,
      accountId: props.editData?.id || '',
      deviceMode: captureDeviceMode.value,
    }, { timeout: 35000 })
    if (!data?.ok || !data.data)
      throw new Error(data?.error || '启动抓取失败')
    captureFlow.value = data.data
    startCaptureCheck()
  }
  catch (e: any) {
    captureError.value = e.response?.data?.error || e.message || '启动抓取失败'
  }
  finally {
    captureLoading.value = false
  }
}

async function completeCaptureAccount() {
  if (!captureFlow.value || captureCompleting.value)
    return
  captureCompleting.value = true
  captureError.value = ''
  try {
    const { data } = await api.post(`/api/capture/sessions/${captureFlow.value.id}/complete`, {
      name: captureAccountName.value.trim(),
    }, { timeout: 35000 })
    if (!data?.ok)
      throw new Error(data?.error || (props.editData ? '更新账号失败' : '添加账号失败'))
    localStorage.setItem(CAPTURE_SUCCESS_STORAGE_KEY, '1')
    stopCaptureCheck()
    captureFlow.value = null
    emit('saved')
    close()
  }
  catch (e: any) {
    if (e.response?.data?.code === 'DUPLICATE_CAPTURE_ACCOUNT') {
      stopCaptureCheck()
      captureFlow.value = null
    }
    captureError.value = e.response?.data?.error || e.message || (props.editData ? '更新账号失败' : '添加账号失败')
  }
  finally {
    captureCompleting.value = false
  }
}

function openCaptureHelp() {
  captureHelpMode.value = localStorage.getItem(CAPTURE_SUCCESS_STORAGE_KEY) === '1' ? 'daily' : 'first'
  showCaptureHelp.value = true
}

async function copyCaptureValue(field: 'host' | 'port') {
  const host = captureFlow.value?.publicInfo.host || ''
  const port = captureFlow.value?.publicInfo.mitmPort || 0
  if (!host || !port)
    return
  const value = field === 'host' ? host : String(port)
  try {
    let copied = false
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value)
        copied = true
      }
      catch {}
    }
    if (!copied) {
      const textarea = document.createElement('textarea')
      textarea.value = value
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      copied = document.execCommand('copy')
      textarea.remove()
    }
    if (!copied)
      throw new Error('copy failed')
    captureCopiedField.value = field
    setTimeout(() => {
      if (captureCopiedField.value === field)
        captureCopiedField.value = ''
    }, 1800)
  }
  catch {
    captureError.value = '复制失败，请手动填写代理地址和端口'
  }
}

async function addAccount(data: any) {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', data)
    if (res.data.ok) {
      emit('saved')
      close()
    }
    else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }
}

async function submitManual() {
  errorMessage.value = ''
  if (!form.code) {
    errorMessage.value = '请输入 Code'
    return
  }

  let code = form.code.trim()
  const match = code.match(CODE_QUERY_RE)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code
  }

  let payload: any = {}
  if (props.editData) {
    const onlyNameChanged = form.name !== props.editData.name
      && form.code === (props.editData.code || '')
      && form.platform === (props.editData.platform || 'qq')

    if (onlyNameChanged) {
      payload = { id: props.editData.id, name: form.name }
    }
    else {
      payload = {
        id: props.editData.id,
        name: form.name,
        code,
        platform: form.platform,
        loginType: 'manual',
      }
    }
  }
  else {
    payload = {
      name: form.name,
      code,
      platform: form.platform,
      loginType: 'manual',
    }
  }

  await addAccount(payload)
}

function close() {
  stopCaptureCheck()
  void cancelCaptureSession()
  showCaptureHelp.value = false
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    captureError.value = ''
    captureCopiedField.value = ''
    captureAccountName.value = props.editData?.name || ''
    capturePlatform.value = props.editData?.platform === 'wx' ? 'wx' : 'qq'
    captureHelpMode.value = localStorage.getItem(CAPTURE_SUCCESS_STORAGE_KEY) === '1' ? 'daily' : 'first'
    void loadCaptureConfig()
    if (props.defaultTab === 'capture') {
      // 首页"抓包登录"入口：明确要抓包 → 优先进入抓包 tab（无论账号类型）
      activeTab.value = 'capture'
      // 顺手回填手动表单，切 tab 时不会丢账号信息
      if (props.editData) {
        form.name = props.editData.name || ''
        form.code = props.editData.code || ''
        form.platform = props.editData.platform || 'qq'
      }
    } else if (props.editData) {
      activeTab.value = 'manual'
      form.name = props.editData.name || ''
      form.code = props.editData.code || ''
      form.platform = props.editData.platform || 'qq'
    }
    else {
      // 没有 editData：按 defaultTab（首页"抓包登录"入口传 capture）或无则 manual
      activeTab.value = props.defaultTab || 'manual'
      form.name = ''
      form.code = ''
      form.platform = 'qq'
    }
  }
  else {
    stopCaptureCheck()
    void cancelCaptureSession()
  }
})

watch(activeTab, (tab) => {
  if (tab !== 'capture')
    void cancelCaptureSession()
})

</script>

<template>
  <div v-if="show" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
    <div class="max-h-[90vh] max-w-md w-full overflow-hidden rounded-lg shadow-xl" :style="{ background: 'var(--theme-bg)' }">
      <div class="flex items-center justify-between border-b p-4" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
        <h3 class="text-lg font-semibold" :style="{ color: 'var(--theme-text)' }">
          {{ editData ? '编辑账号' : '添加账号' }}
        </h3>
        <BaseButton variant="ghost" class="!p-1" @click="close">
          <div class="i-carbon-close text-xl" :style="{ color: 'var(--theme-text)' }" />
        </BaseButton>
      </div>

      <div class="max-h-[calc(90vh-80px)] overflow-y-auto p-4">
        <div v-if="errorMessage" class="mb-4 rounded p-3 text-sm" :style="{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }">
          {{ errorMessage }}
        </div>

        <div class="mb-4 flex border-b" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
          <button
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'manual' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'manual' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'manual'"
          >
            手动填码
          </button>
          <button
            v-if="captureEnabled"
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'capture' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'capture' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'capture'"
          >
            抓包登录
          </button>
        </div>

        <div v-if="activeTab === 'capture'" class="space-y-4">
          <BaseInput
            v-model="captureAccountName"
            label="账号备注（可选）"
            placeholder="留空则使用默认账号名"
            :disabled="!!captureFlow"
          />

          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium" :style="{ color: 'var(--theme-text)' }">抓包设备</label>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="captureDeviceMode === 'pc' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="captureDeviceMode === 'pc' ? { background: 'var(--theme-gradient)' } : {}"
                :disabled="!!captureFlow"
                @click="captureDeviceMode = 'pc'"
              >
                电脑（自动配置）
              </button>
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="captureDeviceMode === 'mobile' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="captureDeviceMode === 'mobile' ? { background: 'var(--theme-gradient)' } : {}"
                :disabled="!!captureFlow"
                @click="captureDeviceMode = 'mobile'"
              >
                手机（手动设代理）
              </button>
            </div>
            <p v-if="captureDeviceMode === 'pc'" class="text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
              开始后自动设置系统代理并信任证书，直接打开电脑 QQ 农场即可抓到登录信息
            </p>
          </div>

          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium" :style="{ color: 'var(--theme-text)' }">平台</label>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="capturePlatform === 'qq' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="capturePlatform === 'qq' ? { background: 'var(--theme-gradient)' } : {}"
                :disabled="!!captureFlow"
                @click="capturePlatform = 'qq'"
              >
                QQ 小程序
              </button>
              <button
                type="button"
                class="h-9 rounded-lg px-3 text-sm transition-colors"
                :class="capturePlatform === 'wx' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                :style="capturePlatform === 'wx' ? { background: 'var(--theme-gradient)' } : {}"
                :disabled="!!captureFlow"
                @click="capturePlatform = 'wx'"
              >
                微信小程序
              </button>
            </div>
          </div>

          <button
            v-if="!captureFlow"
            type="button"
            class="h-11 w-full flex items-center justify-between border border-gray-200 rounded-lg px-3 text-left text-sm dark:border-gray-700"
            :style="{ color: 'var(--theme-text)' }"
            @click="openCaptureHelp"
          >
            <span class="flex items-center gap-2">
              <span class="i-carbon-help" :style="{ color: 'var(--theme-primary)' }" />
              使用说明
            </span>
            <span class="i-carbon-chevron-right opacity-60" />
          </button>

          <div v-if="captureError" class="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
            {{ captureError }}
          </div>

          <div v-if="!captureFlow" class="flex flex-col items-center gap-3 py-4">
            <div class="h-16 w-16 flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
              <div class="i-carbon-data-connected text-3xl" :style="{ color: 'var(--theme-primary)' }" />
            </div>
            <BaseButton variant="primary" :loading="captureLoading" @click="startCaptureSession">
              开始抓取
            </BaseButton>
          </div>

          <template v-else>
            <div class="rounded-lg px-3 py-3 text-sm" style="background-color: color-mix(in srgb, var(--theme-primary) 10%, transparent); color: var(--theme-text);">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-xs opacity-60">
                    当前步骤
                  </div>
                  <div class="mt-1 break-words font-semibold">
                    {{ captureCurrentStep }}
                  </div>
                  <div class="mt-1 break-words text-xs opacity-70">
                    下一步：{{ captureNextStep }}
                  </div>
                </div>
                <button
                  type="button"
                  class="h-8 w-8 flex flex-none items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10"
                  title="使用说明"
                  @click="openCaptureHelp"
                >
                  <span class="i-carbon-help text-lg" />
                </button>
              </div>
            </div>

            <!-- PC 模式：显示自动配置状态 -->
            <div v-if="captureFlow.deviceMode === 'pc'" class="rounded-lg border border-gray-200 p-3 space-y-2 text-sm dark:border-gray-700">
              <div class="flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">系统代理</span>
                <span v-if="captureFlow.pcStatus.proxyActive" class="text-green-600 dark:text-green-400">
                  已自动指向本机（{{ captureFlow.pcStatus.proxyServer || `127.0.0.1:${captureFlow.pcStatus.proxyPort}` }}）
                </span>
                <span v-else class="text-amber-600 dark:text-amber-400">
                  未生效{{ captureFlow.pcStatus.error ? `：${captureFlow.pcStatus.error}` : '' }}
                </span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">证书信任</span>
                <span :class="captureFlow.pcStatus.caTrusted ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'">
                  {{ captureFlow.pcStatus.caTrusted ? '已自动安装到受信任区' : '未信任（可能影响抓包）' }}
                </span>
              </div>
            </div>

            <!-- 手机模式：显示手动代理信息 -->
            <div v-else class="grid grid-cols-2 gap-2 text-sm">
              <div class="min-w-0 flex items-center justify-between gap-1 border border-gray-200 rounded-lg px-3 py-3 dark:border-gray-700">
                <div class="min-w-0">
                  <div class="text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
                    代理服务器
                  </div>
                  <div class="mt-1 break-all font-semibold" :style="{ color: 'var(--theme-text)' }">
                    {{ captureFlow.publicInfo.host || '-' }}
                  </div>
                </div>
                <BaseButton
                  variant="ghost"
                  size="sm"
                  :title="captureCopiedField === 'host' ? '已复制' : '复制代理服务器'"
                  class="flex-none !px-2"
                  @click="copyCaptureValue('host')"
                >
                  <span :class="captureCopiedField === 'host' ? 'i-carbon-checkmark text-green-600' : 'i-carbon-copy'" />
                </BaseButton>
              </div>
              <div class="min-w-0 flex items-center justify-between gap-1 border border-gray-200 rounded-lg px-3 py-3 dark:border-gray-700">
                <div class="min-w-0">
                  <div class="text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
                    代理端口
                  </div>
                  <div class="mt-1 font-semibold" :style="{ color: 'var(--theme-text)' }">
                    {{ captureFlow.publicInfo.mitmPort || '-' }}
                  </div>
                </div>
                <BaseButton
                  variant="ghost"
                  size="sm"
                  :title="captureCopiedField === 'port' ? '已复制' : '复制代理端口'"
                  class="flex-none !px-2"
                  @click="copyCaptureValue('port')"
                >
                  <span :class="captureCopiedField === 'port' ? 'i-carbon-checkmark text-green-600' : 'i-carbon-copy'" />
                </BaseButton>
              </div>
            </div>

            <div class="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-800">
              <div class="flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">Code</span>
                <span :class="captureFlow.codeCaptured ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'">
                  {{ captureFlow.codeCaptured ? '已获取' : '等待中' }}
                </span>
              </div>
              <div v-if="captureFlow.platform === 'qq'" class="mt-2 flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">好友 GID</span>
                <span :style="{ color: 'var(--theme-primary)' }">{{ captureFlow.friendCount }} 个</span>
              </div>
              <div class="mt-2 flex items-center justify-between gap-3">
                <span :style="{ color: 'var(--theme-text)' }">剩余时间</span>
                <span :style="{ color: 'var(--theme-text)' }">{{ captureFlow.publicInfo.remainingSec }} 秒</span>
              </div>
            </div>

            <div class="sticky bottom-0 z-10 flex flex-wrap justify-end gap-2 border-t border-gray-200 px-4 py-3 -mx-4 dark:border-gray-700" :style="{ background: 'var(--theme-bg)' }">
              <BaseButton
                v-if="captureFlow.deviceMode !== 'pc'"
                variant="secondary"
                size="sm"
                :href="captureFlow.publicInfo.certificateUrl"
              >
                <span class="i-carbon-certificate" />
                打开证书
              </BaseButton>
              <BaseButton variant="outline" size="sm" @click="cancelCaptureSession">
                取消抓取
              </BaseButton>
              <BaseButton
                v-if="captureFlow.codeCaptured"
                variant="primary"
                size="sm"
                :loading="captureCompleting"
                @click="completeCaptureAccount"
              >
                {{ editData ? '立即更新' : '立即添加' }}
              </BaseButton>
            </div>
          </template>
        </div>

        <div v-if="activeTab === 'manual'" class="space-y-4">
          <BaseInput
            v-model="form.name"
            label="账号备注（可选）"
            placeholder="留空则使用默认账号名"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code"
            placeholder="请输入登录 Code"
            :rows="3"
          />

          <div v-if="!editData" class="flex gap-4">
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="qq"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">QQ 小程序</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="wx"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">微信小程序</span>
            </label>
          </div>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>

      </div>
    </div>

    <div
      v-if="showCaptureHelp"
      class="fixed inset-0 z-[10001] flex items-end justify-center bg-black/50 md:items-center"
      @click.self="showCaptureHelp = false"
    >
      <div class="max-h-[78vh] max-w-md w-full flex flex-col overflow-hidden rounded-t-lg shadow-2xl md:rounded-lg" :style="{ background: 'var(--theme-bg)' }">
        <div class="h-14 flex flex-none items-center justify-between border-b border-gray-200 px-4 dark:border-gray-700">
          <h4 class="text-base font-semibold" :style="{ color: 'var(--theme-text)' }">
            抓包登录使用说明
          </h4>
          <BaseButton variant="ghost" class="!h-9 !w-9 !p-0" title="关闭使用说明" @click="showCaptureHelp = false">
            <span class="i-carbon-close text-lg" />
          </BaseButton>
        </div>

        <div class="flex-1 overflow-y-auto p-4">
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-sm transition-colors"
              :class="captureHelpMode === 'first' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
              :style="captureHelpMode === 'first' ? { background: 'var(--theme-gradient)' } : {}"
              @click="captureHelpMode = 'first'"
            >
              首次使用
            </button>
            <button
              type="button"
              class="h-9 rounded-lg px-3 text-sm transition-colors"
              :class="captureHelpMode === 'daily' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
              :style="captureHelpMode === 'daily' ? { background: 'var(--theme-gradient)' } : {}"
              @click="captureHelpMode = 'daily'"
            >
              已装证书
            </button>
          </div>

          <div class="mt-4 divide-y divide-gray-200 dark:divide-gray-700">
            <div v-for="(step, index) in captureHelpSteps" :key="step" class="flex items-start gap-3 py-3 first:pt-0">
              <span class="h-6 w-6 flex flex-none items-center justify-center rounded-full text-xs text-white font-semibold" :style="{ background: 'var(--theme-primary)' }">
                {{ index + 1 }}
              </span>
              <span class="min-w-0 break-words text-sm leading-6" :style="{ color: 'var(--theme-text)' }">
                {{ step }}
              </span>
            </div>
          </div>

          <template v-if="captureHelpMode === 'first'">
            <div class="mt-3 border-t border-gray-200 pt-4 dark:border-gray-700">
              <div class="mb-3 text-sm font-semibold" :style="{ color: 'var(--theme-text)' }">
                证书安装帮助
              </div>
              <div class="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  class="h-9 rounded-lg px-3 text-sm transition-colors"
                  :class="captureHelpDevice === 'ios' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                  :style="captureHelpDevice === 'ios' ? { background: 'var(--theme-gradient)' } : {}"
                  @click="captureHelpDevice = 'ios'"
                >
                  iPhone / iPad
                </button>
                <button
                  type="button"
                  class="h-9 rounded-lg px-3 text-sm transition-colors"
                  :class="captureHelpDevice === 'android' ? 'text-white' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200'"
                  :style="captureHelpDevice === 'android' ? { background: 'var(--theme-gradient)' } : {}"
                  @click="captureHelpDevice = 'android'"
                >
                  Android
                </button>
              </div>
              <div class="mt-3 space-y-2">
                <div v-for="(step, index) in captureDeviceSteps" :key="step" class="flex items-start gap-2 text-xs leading-5" :style="{ color: 'var(--theme-text)' }">
                  <span class="flex-none opacity-60">{{ index + 1 }}.</span>
                  <span class="break-words">{{ step }}</span>
                </div>
              </div>
            </div>
          </template>

          <div class="mt-4 rounded-lg bg-amber-50 px-3 py-3 text-xs text-amber-800 leading-5 dark:bg-amber-900/20 dark:text-amber-200">
            <div>每次任务的代理端口可能变化，请以当前页面显示为准。</div>
            <div class="mt-1">
              服务端会自动释放代理，但账号完成后仍需在手机上手动关闭 Wi-Fi 代理。
            </div>
            <div v-if="capturePlatform === 'wx'" class="mt-1">
              微信抓取成功后无法继续进入农场属于正常现象。
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

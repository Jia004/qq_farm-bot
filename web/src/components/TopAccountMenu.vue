<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue'
import AccountModal from '@/components/AccountModal.vue'
import RemarkModal from '@/components/RemarkModal.vue'
import type { Account } from '@/stores/account'
import { getPlatformClass, getPlatformLabel, useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { useUserStore } from '@/stores/user'

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const userStore = useUserStore()
const { accounts, currentAccount } = storeToRefs(accountStore)
const { currentStatusReady, status } = storeToRefs(statusStore)

const showAccountDropdown = ref(false)
const showAccountModal = ref(false)
const showRemarkModal = ref(false)
const accountToEdit = ref<any>(null)
const failedAvatars = ref(new Set<string>())
const showRenewModal = ref(false)
const renewCardKey = ref('')
const renewError = ref('')
const renewLoading = ref(false)
// —— 更新 Code 并重连弹窗 ——
const showUpdateCodeModal = ref(false)
const updateCodeAccount = ref<any>(null)
const updateCodeValue = ref('')
const updateCodeError = ref('')
const updateCodeLoading = ref(false)
const updateCodeCopied = ref(false)

const triggerRef = useTemplateRef<HTMLElement>('trigger')
const dropdownPos = ref({ top: 0, left: 0, width: 320 })

function onScroll() {
  if (showAccountDropdown.value) {
    updateDropdownPos()
  }
}

function onResize() {
  if (showAccountDropdown.value) {
    updateDropdownPos()
  }
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onResize)
})

const platform = computed(() => getPlatformLabel(currentAccount.value?.platform))

function cleanText(value: unknown) {
  return String(value || '').trim()
}

function liveAccountName() {
  if (!currentStatusReady.value)
    return ''
  const name = cleanText(status.value?.status?.name)
  return name && name !== '未登录' ? name : ''
}

function liveAccountAvatar() {
  if (!currentStatusReady.value)
    return ''
  return cleanText(
    status.value?.status?.avatar
    || status.value?.status?.avatarUrl
    || status.value?.status?.avatar_url,
  )
}

function accountDisplayName(acc?: Account | null) {
  if (!acc)
    return '选择账号'

  const liveName = currentAccount.value?.id === acc.id ? liveAccountName() : ''
  const nick = cleanText(liveName || acc.nick)
  const remark = cleanText(acc.name)
  if (nick && remark && nick !== remark)
    return `${nick} (${remark})`
  if (nick)
    return nick
  if (remark)
    return remark
  return cleanText(acc.uin || acc.qq || acc.id) || '选择账号'
}

function accountSubtitle(acc?: Account | null) {
  if (!acc)
    return ''
  return cleanText(acc.uin || acc.qq || acc.id)
}

function avatarSource(acc?: Account | null) {
  if (!acc)
    return ''
  const explicit = currentAccount.value?.id === acc.id
    ? cleanText(liveAccountAvatar() || acc.avatar)
    : cleanText(acc.avatar)
  if (explicit)
    return explicit
  const qq = cleanText(acc.uin || acc.qq)
  if (qq && /^\d+$/.test(qq))
    return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`
  return ''
}

function avatarKey(acc?: Account | null) {
  return cleanText(acc?.id || acc?.uin || acc?.qq || acc?.wxid || '')
}

function shouldShowAvatar(acc?: Account | null) {
  const key = avatarKey(acc)
  return !!avatarSource(acc) && !!key && !failedAvatars.value.has(key)
}

function markAvatarFailed(acc?: Account | null) {
  const key = avatarKey(acc)
  if (!key)
    return
  const next = new Set(failedAvatars.value)
  next.add(key)
  failedAvatars.value = next
}

function avatarInitial(acc?: Account | null) {
  return accountDisplayName(acc).replace(/[()（）\s]/g, '').slice(0, 1) || '账'
}

const displayName = computed(() => accountDisplayName(currentAccount.value))
const currentAvatarSrc = computed(() => avatarSource(currentAccount.value))
const currentSubtitle = computed(() => accountSubtitle(currentAccount.value))

async function openDropdown() {
  updateDropdownPos()
  showAccountDropdown.value = true
  await nextTick()
  updateDropdownPos()
}

function closeDropdown() {
  showAccountDropdown.value = false
}

function toggleDropdown() {
  if (showAccountDropdown.value) {
    closeDropdown()
    return
  }
  openDropdown()
}

function updateDropdownPos() {
  const el = triggerRef.value
  if (!el)
    return

  const rect = el.getBoundingClientRect()
  const viewportGap = 8
  const width = Math.min(320, window.innerWidth - viewportGap * 2)
  const left = Math.min(
    Math.max(viewportGap, rect.right - width),
    window.innerWidth - width - viewportGap,
  )

  dropdownPos.value = {
    top: rect.bottom + viewportGap,
    left,
    width,
  }
}

function selectAccount(acc: any) {
  accountStore.setCurrentAccount(acc)
  closeDropdown()
}

function openAddAccount() {
  accountToEdit.value = null
  showAccountModal.value = true
  closeDropdown()
}

function openUpdateCodeModal(acc: any) {
  // 手机登录顶掉挂机后：粘贴电脑抓包拿到的“新 Code”→ 自动更新并重连
  updateCodeAccount.value = acc
  updateCodeValue.value = ''
  updateCodeError.value = ''
  updateCodeCopied.value = false
  showUpdateCodeModal.value = true
  closeDropdown()
}

async function submitUpdateCode() {
  const code = updateCodeValue.value.trim()
  if (!code) {
    updateCodeError.value = '请粘贴抓包拿到的新 Code'
    return
  }
  updateCodeLoading.value = true
  updateCodeError.value = ''
  try {
    const { default: api } = await import('@/api')
    const res = await api.post(
      `/api/accounts/${encodeURIComponent(updateCodeAccount.value?.id)}/update-code`,
      { code },
      { timeout: 20000 },
    )
    if (res.data?.ok) {
      showUpdateCodeModal.value = false
      updateCodeAccount.value = null
      await accountStore.fetchAccounts()
    } else {
      updateCodeError.value = res.data?.error || '更新失败'
    }
  } catch (e: any) {
    updateCodeError.value = e?.response?.data?.error || e?.message || '更新失败'
  } finally {
    updateCodeLoading.value = false
  }
}

function closeUpdateCodeModal() {
  if (updateCodeLoading.value) return
  showUpdateCodeModal.value = false
  updateCodeAccount.value = null
  updateCodeError.value = ''
}

async function pasteUpdateCode() {
  try {
    const text = await navigator.clipboard?.readText()
    if (text) {
      updateCodeValue.value = text
      updateCodeError.value = ''
      updateCodeCopied.value = true
      setTimeout(() => (updateCodeCopied.value = false), 1200)
    }
  } catch {
    updateCodeError.value = '无法读取剪贴板，请手动粘贴'
  }
}

function openRemarkModal(acc: any) {
  accountToEdit.value = acc
  showRemarkModal.value = true
  closeDropdown()
}

async function handleAccountSaved() {
  await accountStore.fetchAccounts()
  showAccountModal.value = false
  showRemarkModal.value = false
  accountToEdit.value = null
}

function openRenewModal() {
  renewCardKey.value = ''
  renewError.value = ''
  showRenewModal.value = true
  closeDropdown()
}

async function submitRenew() {
  if (!renewCardKey.value.trim()) {
    renewError.value = '请输入卡密'
    return
  }
  renewLoading.value = true
  renewError.value = ''
  try {
    const { default: api } = await import('@/api')
    const res = await api.post('/api/renew', { cardKey: renewCardKey.value.trim() })
    if (res.data.ok) {
      showRenewModal.value = false
      await userStore.fetchUserInfo?.()
    } else {
      renewError.value = res.data.error || '续费失败'
    }
  } catch (e: any) {
    renewError.value = e?.response?.data?.error || e?.message || '续费失败'
  } finally {
    renewLoading.value = false
  }
}

async function handleLogout() {
  closeDropdown()
  await userStore.logout()
}
</script>

<template>
  <div class="relative">
    <button
      ref="trigger"
      class="max-w-[min(76vw,280px)] flex items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-gray-100/70 dark:hover:bg-gray-700/50"
      @click="toggleDropdown"
    >
      <div class="h-9 w-9 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-100 ring-1 ring-gray-200 dark:bg-gray-700 dark:ring-gray-600">
        <img
          v-if="shouldShowAvatar(currentAccount)"
          :src="currentAvatarSrc"
          :alt="displayName"
          class="h-full w-full object-cover"
          @error="markAvatarFailed(currentAccount)"
        >
        <span v-else class="text-sm text-gray-500 font-semibold dark:text-gray-300">
          {{ avatarInitial(currentAccount) }}
        </span>
      </div>
      <div class="min-w-0 flex flex-col">
        <span class="truncate text-sm text-gray-900 font-semibold dark:text-gray-100">
          {{ displayName }}
        </span>
        <span class="mt-0.5 flex items-center gap-1.5 text-xs text-gray-400">
          <span
            v-if="platform"
            class="rounded px-1 py-0.2 text-[10px] font-medium leading-tight"
            :class="getPlatformClass(currentAccount?.platform)"
          >
            {{ platform }}
          </span>
          <span v-if="currentSubtitle" class="truncate">{{ currentSubtitle }}</span>
        </span>
      </div>
      <div
        class="i-carbon-chevron-down shrink-0 text-gray-400 transition-transform duration-200"
        :class="{ 'rotate-180': showAccountDropdown }"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="showAccountDropdown"
        class="fixed inset-0 z-[9998] bg-transparent"
        @click="closeDropdown"
      />

      <div
        v-if="showAccountDropdown"
        class="fixed z-[9999] overflow-hidden border border-gray-200/70 rounded-xl bg-white/95 py-1 shadow-xl backdrop-blur-sm dark:border-gray-700/70 dark:bg-gray-900/95"
        :style="{ top: dropdownPos.top + 'px', left: dropdownPos.left + 'px', width: dropdownPos.width + 'px' }"
      >
        <div class="custom-scrollbar max-h-72 overflow-y-auto">
          <template v-if="accounts.length > 0">
            <button
              v-for="acc in accounts"
              :key="acc.id || acc.uin"
              class="w-full flex items-center gap-3 px-4 py-2 transition-colors hover:bg-gray-100/60 dark:hover:bg-gray-700/50"
              :style="{ backgroundColor: currentAccount?.id === acc.id ? 'color-mix(in srgb, var(--theme-primary) 10%, transparent)' : undefined }"
              @click="selectAccount(acc)"
            >
              <div class="h-7 w-7 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 dark:bg-gray-600">
                <img
                  v-if="shouldShowAvatar(acc)"
                  :src="avatarSource(acc)"
                  :alt="accountDisplayName(acc)"
                  class="h-full w-full object-cover"
                  @error="markAvatarFailed(acc)"
                >
                <span v-else class="text-xs text-gray-500 font-semibold dark:text-gray-300">
                  {{ avatarInitial(acc) }}
                </span>
              </div>
              <div class="min-w-0 flex flex-1 flex-col items-start">
                <span class="w-full truncate text-left text-sm font-medium">
                  {{ accountDisplayName(acc) }}
                </span>
                <div class="flex items-center gap-1.5">
                  <span
                    v-if="getPlatformLabel(acc.platform)"
                    class="rounded px-1 py-0.2 text-[10px] font-medium leading-tight"
                    :class="getPlatformClass(acc.platform)"
                  >
                    {{ getPlatformLabel(acc.platform) }}
                  </span>
                  <span v-if="accountSubtitle(acc)" class="text-xs text-gray-400">{{ accountSubtitle(acc) }}</span>
                </div>
              </div>
              <button
                class="rounded-full p-1 text-gray-400 transition-colors hover:bg-blue-50/50 hover:text-blue-500 dark:hover:bg-blue-900/20"
                title="更新 Code 并重连（手机登录顶掉后，粘贴电脑抓包新 Code）"
                @click.stop="openUpdateCodeModal(acc)"
              >
                <div class="i-carbon-refresh" />
              </button>
              <button
                class="rounded-full p-1 text-gray-400 transition-colors hover:bg-blue-50/50 hover:text-blue-500 dark:hover:bg-blue-900/20"
                title="修改备注"
                @click.stop="openRemarkModal(acc)"
              >
                <div class="i-carbon-edit" />
              </button>
              <div v-if="currentAccount?.id === acc.id" class="i-carbon-checkmark shrink-0" :style="{ color: 'var(--theme-primary)' }" />
            </button>
          </template>
          <div v-else class="px-4 py-3 text-center text-sm text-gray-400">
            暂无账号
          </div>
        </div>
        <div class="mt-1 border-t border-gray-100 pt-1 dark:border-gray-700">
          <button
            class="w-full flex items-center gap-2 px-4 py-2 text-sm transition-colors hover:bg-gray-100/50 dark:hover:bg-gray-700/50"
            :style="{ color: 'var(--theme-primary)' }"
            @click="openAddAccount"
          >
            <div class="i-carbon-add" />
            <span>添加账号</span>
          </button>
          <router-link
            to="/settings"
            class="w-full flex items-center gap-2 px-4 py-2 text-sm transition-colors hover:bg-gray-100/50 dark:hover:bg-gray-700/50"
            :style="{ color: 'var(--theme-primary)' }"
            @click="closeDropdown"
          >
            <div class="i-carbon-add-alt" />
            <span>管理账号</span>
          </router-link>
          <button
            class="w-full flex items-center gap-2 px-4 py-2 text-sm transition-colors hover:bg-gray-100/50 dark:hover:bg-gray-700/50"
            :style="{ color: 'var(--theme-primary)' }"
            @click="openRenewModal"
          >
            <div class="i-carbon-renew" />
            <span>续费卡密/额度</span>
          </button>
          <button
            class="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
            @click="handleLogout"
          >
            <div class="i-carbon-logout" />
            <span>退出登录</span>
          </button>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <AccountModal
        :show="showAccountModal"
        :edit-data="accountToEdit"
        @close="showAccountModal = false; accountToEdit = null"
        @saved="handleAccountSaved"
      />

      <RemarkModal
        :show="showRemarkModal"
        :account="accountToEdit"
        @close="showRemarkModal = false"
        @saved="handleAccountSaved"
      />

      <!-- 续费弹窗 -->
      <div
        v-if="showRenewModal"
        class="fixed inset-0 z-[10002] flex items-center justify-center bg-black/50 backdrop-blur-sm"
        @click.self="showRenewModal = false"
      >
        <div class="w-full max-w-sm mx-4 rounded-xl p-5 shadow-2xl" :style="{ background: 'var(--surface-1, #fff)' }">
          <h3 class="text-base font-semibold mb-3" :style="{ color: 'var(--theme-text)' }">
            续费卡密/额度
          </h3>
          <input
            v-model="renewCardKey"
            type="text"
            placeholder="请输入卡密"
            class="w-full rounded-lg border px-3 py-2 text-sm outline-none mb-3"
            :style="{
              borderColor: 'color-mix(in srgb, var(--theme-text) 15%, transparent)',
              background: 'var(--surface-1, #fff)',
              color: 'var(--theme-text)',
            }"
            @keyup.enter="submitRenew"
          >
          <div v-if="renewError" class="text-sm text-red-500 mb-2">
            {{ renewError }}
          </div>
          <div class="flex justify-end gap-2">
            <button
              class="px-4 py-1.5 rounded-lg text-sm transition-colors"
              :style="{ color: 'var(--theme-text)' }"
              @click="showRenewModal = false"
            >
              取消
            </button>
            <button
              class="px-4 py-1.5 rounded-lg text-sm text-white transition-opacity"
              :style="{ background: 'var(--theme-gradient)' }"
              :disabled="renewLoading"
              @click="submitRenew"
            >
              {{ renewLoading ? '处理中...' : '确认续费' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 更新 Code 并重连弹窗 -->
      <div
        v-if="showUpdateCodeModal"
        class="fixed inset-0 z-[10002] flex items-center justify-center bg-black/50 backdrop-blur-sm"
        @click.self="closeUpdateCodeModal"
      >
        <div class="w-full max-w-md mx-4 rounded-xl p-5 shadow-2xl" :style="{ background: 'var(--surface-1, #fff)' }">
          <h3 class="text-base font-semibold" :style="{ color: 'var(--theme-text)' }">
            更新 Code 并重连
          </h3>
          <p class="mt-1 text-xs opacity-70" :style="{ color: 'var(--theme-text)' }">
            账号：{{ accountDisplayName(updateCodeAccount) }}
            <template v-if="updateCodeAccount?.running">（在线，将用新 Code 重启）</template>
            <template v-else>（离线，将用新 Code 启动）</template>
          </p>
          <p class="mt-2 text-xs leading-relaxed opacity-60" :style="{ color: 'var(--theme-text)' }">
            被手机登录顶掉后：在电脑 QQ 农场登录并用抓包工具抓到新 Code，粘贴到下方即可自动重连。
          </p>
          <div class="mt-3 flex gap-2">
            <input
              v-model="updateCodeValue"
              type="text"
              placeholder="粘贴新 Code（可整段 URL，自动提取 code=）"
              class="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
              :style="{
                borderColor: 'color-mix(in srgb, var(--theme-text) 15%, transparent)',
                background: 'var(--surface-1, #fff)',
                color: 'var(--theme-text)',
              }"
              @keyup.enter="submitUpdateCode"
            >
            <button
              class="shrink-0 rounded-lg border px-3 py-2 text-sm transition-colors"
              :style="{
                borderColor: 'color-mix(in srgb, var(--theme-text) 15%, transparent)',
                color: updateCodeCopied ? 'var(--theme-primary)' : 'var(--theme-text)',
              }"
              title="从剪贴板粘贴"
              @click="pasteUpdateCode"
            >
              <span :class="updateCodeCopied ? 'i-carbon-checkmark' : 'i-carbon-paste'" />
            </button>
          </div>
          <div v-if="updateCodeError" class="mt-2 text-sm text-red-500">
            {{ updateCodeError }}
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <button
              class="px-4 py-1.5 rounded-lg text-sm transition-colors"
              :style="{ color: 'var(--theme-text)' }"
              @click="closeUpdateCodeModal"
            >
              取消
            </button>
            <button
              class="px-4 py-1.5 rounded-lg text-sm text-white transition-opacity disabled:opacity-50"
              :style="{ background: 'var(--theme-gradient)' }"
              :disabled="updateCodeLoading"
              @click="submitUpdateCode"
            >
              {{ updateCodeLoading ? '更新并重连中...' : '更新并重连' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.3);
  border-radius: 2px;
}
.custom-scrollbar:hover::-webkit-scrollbar-thumb {
  background-color: rgba(156, 163, 175, 0.5);
}
</style>

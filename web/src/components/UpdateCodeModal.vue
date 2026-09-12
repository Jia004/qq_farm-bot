<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  show: boolean
  account: any
}>()

const emit = defineEmits(['close', 'saved'])

const updateCodeValue = ref('')
const updateCodeError = ref('')
const updateCodeLoading = ref(false)
const updateCodeCopied = ref(false)

function displayName(acc: any) {
  const nick = acc?.nick || ''
  const remark = acc?.name || ''
  if (nick && remark && nick !== remark) return `${nick} (${remark})`
  return nick || remark || acc?.uin || acc?.qq || acc?.id || '账号'
}

function closeModal() {
  if (updateCodeLoading.value) return
  updateCodeValue.value = ''
  updateCodeError.value = ''
  emit('close')
}

async function submit() {
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
      `/api/accounts/${encodeURIComponent(props.account?.id)}/update-code`,
      { code },
      { timeout: 20000 },
    )
    if (res.data?.ok) {
      updateCodeValue.value = ''
      emit('saved')
      emit('close')
    } else {
      updateCodeError.value = res.data?.error || '更新失败'
    }
  } catch (e: any) {
    updateCodeError.value = e?.response?.data?.error || e?.message || '更新失败'
  } finally {
    updateCodeLoading.value = false
  }
}

async function paste() {
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
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="fixed inset-0 z-[10002] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      @click.self="closeModal"
    >
      <div class="w-full max-w-md mx-4 rounded-xl p-5 shadow-2xl" :style="{ background: 'var(--surface-1, #fff)' }">
        <h3 class="text-base font-semibold" :style="{ color: 'var(--theme-text)' }">
          更新 Code 并重连
        </h3>
        <p class="mt-1 text-xs opacity-70" :style="{ color: 'var(--theme-text)' }">
          账号：{{ displayName(account) }}
          <template v-if="account?.running">（在线，将用新 Code 重启）</template>
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
            @keyup.enter="submit"
          >
          <button
            class="shrink-0 rounded-lg border px-3 py-2 text-sm transition-colors"
            :style="{
              borderColor: 'color-mix(in srgb, var(--theme-text) 15%, transparent)',
              color: updateCodeCopied ? 'var(--theme-primary)' : 'var(--theme-text)',
            }"
            title="从剪贴板粘贴"
            @click="paste"
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
            @click="closeModal"
          >
            取消
          </button>
          <button
            class="px-4 py-1.5 rounded-lg text-sm text-white transition-opacity disabled:opacity-50"
            :style="{ background: 'var(--theme-gradient)' }"
            :disabled="updateCodeLoading"
            @click="submit"
          >
            {{ updateCodeLoading ? '更新并重连中...' : '更新并重连' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

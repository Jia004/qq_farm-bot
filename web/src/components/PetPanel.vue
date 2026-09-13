<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import { useToastStore } from '@/stores/toast'

const props = defineProps<{
  accountId: string
  accountRunning: boolean
}>()

const toast = useToastStore()

interface DogItem {
  id: number
  name: string
  displayName: string
  customName: string
  protectProbability: number
  skillDesc: string
  tag: string
  price: number
  owned: boolean
  activated: boolean
  hasDog: boolean
  deployed: boolean
  status: string
  expireTime: number
  availableSkins: number[]
}

interface FoodItem {
  id: number
  name: string
  durationSec: number
  durationDays: number
  ownCount: number
}

const loading = ref(false)
const acting = ref(false)
const errorText = ref('')
const loadError = ref('')

const dogs = ref<DogItem[]>([])
const foodList = ref<FoodItem[]>([])
const deployedDogId = ref(0)
const foodLastSec = ref(0)
const maxFoodLastSec = ref(0)
const pendingGiftCount = ref(0)

const selectedDogId = ref(0)
const feedCounts = ref<Record<number, number>>({})
const lastClaim = ref(0)

// 我的宠物（已拥有或已激活 —— 服务端激活后 owned 会重置为 false）
const myDogs = computed(() => dogs.value.filter(d => d.hasDog))
const activatedDogs = computed(() => myDogs.value.filter(d => d.activated))
// 未拥有且未激活的宠物（含可购买/活动获取）
const lockedDogs = computed(() => dogs.value.filter(d => !d.hasDog))

const deployedDog = computed(() => dogs.value.find(d => d.id === deployedDogId.value) || null)

const foodPercent = computed(() => {
  if (maxFoodLastSec.value <= 0)
    return 0
  return Math.min(100, Math.round(foodLastSec.value / maxFoodLastSec.value * 100))
})

function fmtDuration(sec: number) {
  if (sec <= 0)
    return '0分钟'
  const hours = sec / 3600
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const restH = Math.round(hours % 24)
    return restH > 0 ? `${days}天${restH}小时` : `${days}天`
  }
  if (hours >= 1)
    return `${Math.round(hours * 10) / 10}小时`
  return `${Math.round(sec / 60)}分钟`
}

function statusLabel(d: DogItem) {
  if (d.deployed)
    return '护农中'
  if (d.activated)
    return '已激活'
  if (d.owned)
    return '待激活'
  return '未拥有'
}

function statusClass(d: DogItem) {
  if (d.deployed)
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
  if (d.activated)
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
  if (d.owned)
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
  return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
}

function probabilityText(d: DogItem) {
  return `${(d.protectProbability / 100).toFixed(0)}%`
}

async function fetchPanel() {
  if (!props.accountId)
    return
  loading.value = true
  loadError.value = ''
  try {
    const res = await api.get('/api/dog/panel', {
      headers: { 'x-account-id': props.accountId },
      timeout: 30000,
    })
    if (res.data.ok && res.data.data) {
      const d = res.data.data
      dogs.value = Array.isArray(d.dogs) ? d.dogs : []
      foodList.value = Array.isArray(d.foodList) ? d.foodList : []
      deployedDogId.value = Number(d.deployedDogId) || 0
      foodLastSec.value = Number(d.foodLastSec) || 0
      maxFoodLastSec.value = Number(d.maxFoodLastSec) || 0
      pendingGiftCount.value = Number(d.pendingGiftCount) || 0
      // 默认选中当前出战宠或第一个已激活宠
      if (selectedDogId.value <= 0 || !myDogs.value.find(x => x.id === selectedDogId.value)) {
        selectedDogId.value = deployedDogId.value || activatedDogs.value[0]?.id || myDogs.value[0]?.id || 0
      }
      // 初始化投喂数量
      for (const f of foodList.value) {
        if (!feedCounts.value[f.id])
          feedCounts.value[f.id] = 1
      }
    }
    else {
      loadError.value = res.data.error || '加载失败'
    }
  }
  catch (e: any) {
    loadError.value = e?.response?.data?.error || e?.message || '加载失败'
  }
  finally {
    loading.value = false
  }
}

function ensureRunning() {
  if (!props.accountRunning) {
    toast.error('当前账号未在线，请先在账号列表启动该账号')
    return false
  }
  return true
}

async function deploy(dog: DogItem) {
  if (!ensureRunning())
    return
  if (!dog.activated) {
    toast.error('该宠物尚未激活，请先激活')
    return
  }
  acting.value = true
  errorText.value = ''
  try {
    const res = await api.post('/api/dog/deploy', { dogId: dog.id }, {
      headers: { 'x-account-id': props.accountId },
      timeout: 30000,
    })
    if (res.data.ok) {
      toast.success(`「${dog.displayName}」已出战护农`)
      deployedDogId.value = Number(res.data.data?.deployedDogId) || dog.id
      await fetchPanel()
    }
    else {
      const msg = res.data.error || '出战失败'
      errorText.value = msg
      toast.error(msg)
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '出战失败'
    errorText.value = msg
    toast.error(msg)
  }
  finally {
    acting.value = false
  }
}

async function withdraw() {
  if (!ensureRunning())
    return
  acting.value = true
  errorText.value = ''
  try {
    const res = await api.post('/api/dog/withdraw', {}, {
      headers: { 'x-account-id': props.accountId },
      timeout: 30000,
    })
    if (res.data.ok) {
      toast.success('宠物已收回，停止护农')
      deployedDogId.value = 0
      await fetchPanel()
    }
    else {
      const msg = res.data.error || '收回失败'
      errorText.value = msg
      toast.error(msg)
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '收回失败'
    errorText.value = msg
    toast.error(msg)
  }
  finally {
    acting.value = false
  }
}

async function activate(dog: DogItem) {
  if (!ensureRunning())
    return
  acting.value = true
  errorText.value = ''
  try {
    const res = await api.post('/api/dog/activate', { dogId: dog.id }, {
      headers: { 'x-account-id': props.accountId },
      timeout: 30000,
    })
    if (res.data.ok) {
      toast.success(`「${dog.displayName}」已激活`)
      await fetchPanel()
    }
    else {
      const msg = res.data.error || '激活失败'
      errorText.value = msg
      toast.error(msg)
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '激活失败'
    errorText.value = msg
    toast.error(msg)
  }
  finally {
    acting.value = false
  }
}

async function feed(food: FoodItem) {
  if (!ensureRunning())
    return
  const count = Math.max(1, Number(feedCounts.value[food.id]) || 1)
  if (count > food.ownCount) {
    toast.error(`「${food.name}」数量不足（拥有 ${food.ownCount}）`)
    return
  }
  acting.value = true
  errorText.value = ''
  try {
    const res = await api.post('/api/dog/feed', { foodId: food.id, count }, {
      headers: { 'x-account-id': props.accountId },
      timeout: 30000,
    })
    if (res.data.ok) {
      const h = Number(res.data.data?.foodLastHours) || 0
      toast.success(`投喂「${food.name}」×${count} 成功，食物剩余 ${h} 小时`)
      await fetchPanel()
    }
    else {
      const msg = res.data.error || '投喂失败'
      errorText.value = msg
      toast.error(msg)
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '投喂失败'
    errorText.value = msg
    toast.error(msg)
  }
  finally {
    acting.value = false
  }
}

async function claimGifts() {
  if (!ensureRunning())
    return
  if (pendingGiftCount.value <= 0) {
    toast.info('当前没有可领取的同气礼包')
    return
  }
  acting.value = true
  errorText.value = ''
  try {
    const res = await api.post('/api/dog/gifts/claim', {}, {
      headers: { 'x-account-id': props.accountId },
      timeout: 30000,
    })
    if (res.data.ok) {
      const claimed = Number(res.data.data?.claimed) || 0
      lastClaim.value = claimed
      toast.success(`领取成功：同气礼包 ×${claimed}`)
      await fetchPanel()
    }
    else {
      const msg = res.data.error || '领取失败'
      errorText.value = msg
      toast.error(msg)
      await fetchPanel()
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '领取失败'
    errorText.value = msg
    toast.error(msg)
  }
  finally {
    acting.value = false
  }
}

onMounted(fetchPanel)
</script>

<template>
  <div class="space-y-4">
    <!-- 使用说明 -->
    <div class="rounded-lg bg-blue-50 p-3 text-sm text-blue-800 dark:bg-blue-900/20 dark:text-blue-200 sm:p-4">
      <div class="mb-1 flex items-center gap-2 font-medium">
        <div class="i-carbon-dog-walker" />
        宠物（护主犬）系统
      </div>
      <ul class="list-disc pl-5 space-y-1 text-blue-700/90 dark:text-blue-200/80">
        <li><b>我的宠物</b>：展示你已拥有的宠物，可激活、选择出战护农。</li>
        <li><b>投喂狗粮</b>：宠物需要食物才能保持看护状态，食物耗尽后停止护农。</li>
        <li><b>同气礼包</b>：护主犬在护农时有概率掉落礼包，可直接领取。</li>
      </ul>
    </div>

    <!-- 账号在线提示 -->
    <div
      v-if="!accountRunning"
      class="flex items-center gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-300 sm:p-4"
    >
      <div class="i-carbon-warning-alt" />
      当前账号未在线，宠物操作前请先到「账号」页启动该账号。
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="flex items-center justify-center gap-2 rounded-lg bg-white p-8 text-gray-500 shadow dark:bg-gray-800 dark:text-gray-400">
      <div class="i-svg-spinners-90-ring-with-bg" />
      正在加载宠物数据…
    </div>

    <div
      v-else-if="loadError"
      class="flex items-center justify-between gap-2 rounded-lg bg-red-50 p-4 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400"
    >
      <span>{{ loadError }}</span>
      <button class="rounded px-3 py-1 text-xs font-medium text-white" :style="{ backgroundColor: 'var(--theme-primary)' }" @click="fetchPanel">
        重试
      </button>
    </div>

    <template v-else>
      <!-- 护农状态卡 -->
      <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800 sm:p-5">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center gap-4">
            <div
              class="flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow"
              :class="deployedDog ? 'bg-gradient-to-br from-green-400 to-emerald-600' : 'bg-gradient-to-br from-gray-300 to-gray-500'"
            >
              <div class="i-carbon-dog-walker text-2xl" />
            </div>
            <div>
              <div class="text-sm text-gray-500 dark:text-gray-400">
                护农状态
              </div>
              <div class="text-xl font-bold text-gray-800 dark:text-gray-100">
                <template v-if="deployedDog">
                  {{ deployedDog.displayName }}
                  <span class="ml-1 text-sm font-medium text-green-600 dark:text-green-400">护农中</span>
                </template>
                <template v-else>
                  <span class="text-gray-400">未出战</span>
                </template>
              </div>
              <div v-if="deployedDog" class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                看护率 {{ probabilityText(deployedDog) }}<template v-if="deployedDog.skillDesc"> · {{ deployedDog.skillDesc }}</template>
              </div>
            </div>
          </div>
          <button
            v-if="deployedDog"
            class="rounded-xl px-5 py-2.5 text-sm font-medium transition disabled:opacity-50"
            :class="'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400'"
            :disabled="acting"
            @click="withdraw"
          >
            <span v-if="acting" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
            收回宠物
          </button>
        </div>

        <!-- 食物进度 -->
        <div class="mt-4 border-t border-gray-100 pt-3 dark:border-gray-700">
          <div class="flex items-center justify-between text-sm">
            <span class="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
              <div class="i-carbon-restaurant text-amber-500" />
              食物剩余
            </span>
            <span class="font-medium text-gray-800 dark:text-gray-100">
              {{ fmtDuration(foodLastSec) }}
              <span class="text-xs text-gray-400">/ 上限 {{ fmtDuration(maxFoodLastSec) }}</span>
            </span>
          </div>
          <div class="mt-2 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div
              class="h-full rounded-full transition-all"
              :class="foodPercent > 30 ? 'bg-amber-400' : 'bg-red-400'"
              :style="{ width: `${foodPercent}%` }"
            />
          </div>
          <div v-if="deployedDog && foodLastSec <= 0" class="mt-2 flex items-center gap-1.5 text-xs text-red-500">
            <div class="i-carbon-warning-alt" />
            食物已耗尽，宠物已停止护农！请投喂狗粮。
          </div>
        </div>
      </div>

      <!-- 我的宠物 -->
      <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800 sm:p-5">
        <div class="mb-3 flex items-center justify-between">
          <div class="flex items-center gap-2 font-medium text-gray-800 dark:text-gray-100">
            <div class="i-carbon-catalog" />
            我的宠物
            <span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">{{ myDogs.length }}</span>
          </div>
        </div>

        <div v-if="myDogs.length === 0" class="py-6 text-center text-sm text-gray-400">
          暂无宠物，可在游戏中获取后再来查看
        </div>

        <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="dog in myDogs"
            :key="dog.id"
            class="cursor-pointer rounded-xl border p-3 transition"
            :class="[
              selectedDogId === dog.id ? 'border-blue-400 bg-blue-50/50 dark:border-blue-500 dark:bg-blue-900/20' : 'border-gray-100 hover:border-gray-200 dark:border-gray-700 dark:hover:border-gray-600',
            ]"
            @click="selectedDogId = dog.id"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-2">
                <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-amber-300 to-orange-500 text-white">
                  <div class="i-carbon-dog-walker text-xl" />
                </div>
                <div>
                  <div class="text-sm font-medium text-gray-800 dark:text-gray-100">
                    {{ dog.displayName }}
                  </div>
                  <div class="text-xs text-gray-400">
                    {{ dog.name }} · 看护率 {{ probabilityText(dog) }}
                  </div>
                </div>
              </div>
              <span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium" :class="statusClass(dog)">
                {{ statusLabel(dog) }}
              </span>
            </div>

            <div v-if="dog.skillDesc" class="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {{ dog.skillDesc }}
            </div>

            <div class="mt-3 flex gap-2">
              <button
                v-if="!dog.activated"
                class="flex-1 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition disabled:opacity-50"
                :style="{ backgroundColor: 'var(--theme-primary)' }"
                :disabled="acting"
                @click.stop="activate(dog)"
              >
                激活
              </button>
              <button
                v-else-if="!dog.deployed"
                class="flex-1 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition disabled:opacity-50"
                :style="{ backgroundColor: 'var(--theme-primary)' }"
                :disabled="acting"
                @click.stop="deploy(dog)"
              >
                出战护农
              </button>
              <button
                v-else
                class="flex-1 rounded-lg bg-green-50 px-3 py-1.5 text-xs font-medium text-green-600 dark:bg-green-900/30 dark:text-green-400"
                disabled
              >
                ✓ 护农中
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 投喂狗粮 -->
      <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800 sm:p-5">
        <div class="mb-3 flex items-center gap-2 font-medium text-gray-800 dark:text-gray-100">
          <div class="i-carbon-restaurant" />
          投喂食物
          <span class="text-xs font-normal text-gray-400">保证宠物持续活动</span>
        </div>

        <div v-if="foodList.length === 0" class="py-6 text-center text-sm text-gray-400">
          暂无狗粮库存，可在游戏商店购买
        </div>

        <div v-else class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div
            v-for="food in foodList"
            :key="food.id"
            class="rounded-xl border border-gray-100 p-3 dark:border-gray-700"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-lime-300 to-green-500 text-white">
                  <div class="i-carbon-wheat text-lg" />
                </div>
                <div>
                  <div class="text-sm font-medium text-gray-800 dark:text-gray-100">
                    {{ food.name }}
                  </div>
                  <div class="text-xs text-gray-400">
                    每份 {{ food.durationDays }} 天 · 拥有 {{ food.ownCount }}
                  </div>
                </div>
              </div>
            </div>
            <div class="mt-3 flex items-center gap-2">
              <input
                v-model.number="feedCounts[food.id]"
                type="number"
                min="1"
                :max="food.ownCount"
                class="w-16 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-center text-sm outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 focus:border-blue-400"
              >
              <button
                class="flex-1 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition disabled:opacity-50"
                :style="{ backgroundColor: 'var(--theme-primary)' }"
                :disabled="acting || food.ownCount <= 0"
                @click="feed(food)"
              >
                投喂
              </button>
            </div>
          </div>
        </div>

        <div class="mt-3 rounded-lg bg-gray-50 p-2.5 text-xs text-gray-500 dark:bg-gray-900/50 dark:text-gray-400">
          <div class="i-carbon-information inline-block align-text-bottom" />
          提示：食物时长会累加到现有剩余时间上（上限 {{ fmtDuration(maxFoodLastSec) }}），食物耗尽后宠物停止护农。
        </div>
      </div>

      <!-- 同气礼包 -->
      <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800 sm:p-5">
        <div class="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
          <div class="flex items-center gap-4">
            <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow">
              <div class="i-carbon-gift text-2xl" />
            </div>
            <div>
              <div class="text-sm text-gray-500 dark:text-gray-400">
                护主犬同气礼包
              </div>
              <div class="text-2xl font-bold text-gray-800 dark:text-gray-100">
                {{ pendingGiftCount }}
                <span class="text-base font-medium text-gray-400">个可领取</span>
              </div>
            </div>
          </div>
          <button
            class="w-full rounded-xl px-6 py-3 text-sm font-medium text-white transition disabled:opacity-50 sm:w-auto"
            :style="{ backgroundColor: 'var(--theme-primary)' }"
            :disabled="acting || pendingGiftCount <= 0"
            @click="claimGifts"
          >
            <span v-if="acting" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
            {{ `领取全部 (${pendingGiftCount})` }}
          </button>
        </div>
        <div v-if="lastClaim > 0" class="mt-4 border-t border-gray-100 pt-3 text-sm text-green-600 dark:border-gray-700 dark:text-green-400">
          ✓ 上次领取：同气礼包 ×{{ lastClaim }}
        </div>
      </div>

      <!-- 未拥有的宠物（仅供参考） -->
      <div v-if="lockedDogs.length" class="rounded-lg bg-white p-4 shadow dark:bg-gray-800 sm:p-5">
        <div class="mb-3 flex items-center gap-2 font-medium text-gray-800 dark:text-gray-100">
          <div class="i-carbon-locked" />
          可获取的宠物
          <span class="text-xs font-normal text-gray-400">需在游戏中购买/活动获取</span>
        </div>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <div
            v-for="dog in lockedDogs"
            :key="dog.id"
            class="flex items-center gap-2 rounded-lg border border-dashed border-gray-200 p-2 dark:border-gray-700"
          >
            <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-200 text-gray-400 dark:bg-gray-700">
              <div class="i-carbon-dog-walker" />
            </div>
            <div class="min-w-0">
              <div class="truncate text-xs font-medium text-gray-600 dark:text-gray-300">
                {{ dog.displayName }}
              </div>
              <div class="text-[10px] text-gray-400">
                看护率 {{ probabilityText(dog) }}<template v-if="dog.price > 0"> · {{ dog.price }} 金币</template>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="errorText" class="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
        {{ errorText }}
      </div>
    </template>
  </div>
</template>

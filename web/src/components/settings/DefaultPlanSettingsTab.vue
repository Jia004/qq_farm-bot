<script setup lang="ts">
import { computed, onMounted, ref, watch, watchEffect } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import AutomationSettingsTab from '@/components/settings/AutomationSettingsTab.vue'
import StrategySettingsTab from '@/components/settings/StrategySettingsTab.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'

interface BagSeedItem {
  seedId: number
  name: string
  count: number
  requiredLevel: number
  plantSize: number
}

const props = defineProps<{
  currentAccountId: string | number | null | undefined
  currentAccountName: string | null
  plantingStrategyOptions: { label: string, value: string }[]
  preferredSeedOptions: { label: string, value: number }[]
  bagFallbackStrategyOptions: { label: string, value: string }[]
  bagSeeds: BagSeedItem[]
  bagSeedsLoading: boolean
  bagSeedsError: string | null
  fetchBagSeeds?: () => void
  fertilizerLandTypeOptions: { label: string, value: string }[]
  fertilizerOptions: { label: string, value: string | number }[]
}>()

const emit = defineEmits<{
  notify: [message: string, type?: 'primary' | 'danger']
}>()

const activeSection = ref<'strategy' | 'automation'>('strategy')
const loading = ref(false)
const saving = ref(false)
const importing = ref(false)
const resetting = ref(false)
const showResetConfirm = ref(false)
const exists = ref(false)
const enabled = ref(true)
const updatedAt = ref(0)
let draggedSeedId: number | null = null

// 「已跳过」的种子（点 × 移除过）：与首页策略面板共用同一份 localStorage 记忆
const BAG_SEED_EXCLUDED_PREFIX = 'qqfarm:bagSeedExcluded:'
const bagSeedExcluded = ref<Set<number>>(new Set())

function readBagSeedExcluded(accountId: string | number): Set<number> {
  try {
    const raw = localStorage.getItem(BAG_SEED_EXCLUDED_PREFIX + String(accountId))
    if (!raw)
      return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed))
      return new Set()
    return new Set(parsed.map(Number).filter((id: number) => Number.isInteger(id) && id > 0))
  }
  catch {
    return new Set()
  }
}

function persistBagSeedExcluded() {
  const accountId = props.currentAccountId
  if (!accountId)
    return
  try {
    const key = BAG_SEED_EXCLUDED_PREFIX + String(accountId)
    if (bagSeedExcluded.value.size === 0)
      localStorage.removeItem(key)
    else
      localStorage.setItem(key, JSON.stringify([...bagSeedExcluded.value]))
  }
  catch {
    // localStorage 不可用时忽略（仅损失跨会话记忆）
  }
}

const strategySettings = ref(createStrategySettings())
const automationSettings = ref(createAutomationSettings())
const autoCodeRefresh = ref({ enabled: false, intervalMinutes: 60 })

function createStrategySettings() {
  return {
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    prioritize2x2Crops: false,
    bagSeedPriority: [] as number[],
    bagSeedFallbackStrategy: 'level',
    bagPriorityLandTypes: ['purple', 'gold', 'black', 'red', 'normal'] as string[],
    stealDelaySeconds: 1,
    plantOrderRandom: true,
    plantDelaySeconds: 2,
    intervals: { farmMin: 2, farmMax: 5, helpMin: 30, helpMax: 35, stealMin: 25, stealMax: 30 },
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00' },
  }
}

function createAutomationSettings() {
  return {
    automation: {
      farm: false,
      task: false,
      sell: false,
      friend: false,
      farm_push: false,
      land_upgrade: false,
      friend_steal: false,
      friend_help: false,
      friend_bad: false,
      friend_golden_bug: false,
      friend_help_exp_limit: false,
      friend_turbo_mode: false,
      friend_turbo_scheduled: false,
      friend_turbo_schedule_time: '',
      golden_bug_clear: true,
      fertilizer_gift: false,
      fertilizer_buy_organic: false,
      fertilizer_buy_normal: false,
      fertilizer: 'none',
      skip_own_weed_bug: false,
      fertilizer_multi_season: false,
      fertilizer_land_types: ['purple', 'gold', 'black', 'red', 'normal'],
      fertilizer_smart_seconds: 300,
    },
    autoAcceptFriendMinLevel: 0,
    fertilizerBuyOrganicCount: 1,
    fertilizerBuyOrganicThresholdHours: 10,
    fertilizerBuyNormalCount: 1,
    fertilizerBuyNormalThresholdHours: 10,
    fertilizerBuyCheckIntervalMinutes: 60,
    goldenBugKeepCount: 0,
    goldenBugRoundLimit: 24,
  }
}

function applyPlan(data: any) {
  const config = data?.config || {}
  exists.value = data?.exists === true
  enabled.value = data?.enabled !== false
  updatedAt.value = Number(data?.updatedAt) || 0
  strategySettings.value = {
    ...createStrategySettings(),
    plantingStrategy: config.plantingStrategy || 'max_exp',
    preferredSeedId: config.preferredSeedId ?? 0,
    prioritize2x2Crops: config.prioritize2x2Crops === true,
    bagSeedPriority: Array.isArray(config.bagSeedPriority) ? [...config.bagSeedPriority] : [],
    bagSeedFallbackStrategy: config.bagSeedFallbackStrategy || 'level',
    bagPriorityLandTypes: (Array.isArray(config.bagPriorityLandTypes) && config.bagPriorityLandTypes.length > 0)
      ? [...config.bagPriorityLandTypes]
      : ['purple', 'gold', 'black', 'red', 'normal'],
    stealDelaySeconds: config.stealDelaySeconds ?? 1,
    plantOrderRandom: config.plantOrderRandom ?? true,
    plantDelaySeconds: config.plantDelaySeconds ?? 2,
    intervals: { ...createStrategySettings().intervals, ...(config.intervals || {}) },
    friendQuietHours: { ...createStrategySettings().friendQuietHours, ...(config.friendQuietHours || {}) },
  }
  const automationDefaults = createAutomationSettings()
  automationSettings.value = {
    ...automationDefaults,
    automation: { ...automationDefaults.automation, ...(config.automation || {}) },
    autoAcceptFriendMinLevel: config.autoAcceptFriendMinLevel ?? 0,
    fertilizerBuyOrganicCount: config.fertilizerBuyOrganicCount ?? 1,
    fertilizerBuyOrganicThresholdHours: config.fertilizerBuyOrganicThresholdHours ?? 10,
    fertilizerBuyNormalCount: config.fertilizerBuyNormalCount ?? 1,
    fertilizerBuyNormalThresholdHours: config.fertilizerBuyNormalThresholdHours ?? 10,
    fertilizerBuyCheckIntervalMinutes: config.fertilizerBuyCheckIntervalMinutes ?? 60,
    goldenBugKeepCount: config.goldenBugKeepCount ?? 0,
    goldenBugRoundLimit: config.goldenBugRoundLimit ?? 24,
  }
  autoCodeRefresh.value = {
    enabled: config.autoCodeRefresh?.enabled === true,
    intervalMinutes: Number(config.autoCodeRefresh?.intervalMinutes) || 60,
  }
}

const sortedBagSeeds = computed(() => {
  const excluded = bagSeedExcluded.value
  const byId = new Map(props.bagSeeds.map(seed => [seed.seedId, seed]))
  return strategySettings.value.bagSeedPriority
    .map(id => byId.get(id))
    .filter((seed): seed is BagSeedItem => !!seed && !excluded.has(Number(seed.seedId)))
})

// 「已跳过」区：被移除且不会被自动追加回来的种子
const excludedBagSeeds = computed(() =>
  props.bagSeeds.filter(seed => bagSeedExcluded.value.has(Number(seed.seedId))),
)

const strategyPreviewLabel = computed(() => {
  const option = props.plantingStrategyOptions.find(item => item.value === strategySettings.value.plantingStrategy)
  return option?.label || '默认策略'
})

const updatedAtLabel = computed(() => {
  if (!updatedAt.value)
    return '尚未保存'
  return new Date(updatedAt.value).toLocaleString('zh-CN', { hour12: false })
})

function buildConfig() {
  return {
    plantingStrategy: strategySettings.value.plantingStrategy,
    preferredSeedId: strategySettings.value.preferredSeedId,
    prioritize2x2Crops: strategySettings.value.prioritize2x2Crops,
    bagSeedPriority: strategySettings.value.bagSeedPriority,
    bagSeedFallbackStrategy: strategySettings.value.bagSeedFallbackStrategy,
    bagPriorityLandTypes: strategySettings.value.bagPriorityLandTypes,
    stealDelaySeconds: strategySettings.value.stealDelaySeconds,
    plantOrderRandom: strategySettings.value.plantOrderRandom,
    plantDelaySeconds: strategySettings.value.plantDelaySeconds,
    intervals: strategySettings.value.intervals,
    friendQuietHours: strategySettings.value.friendQuietHours,
    automation: automationSettings.value.automation,
    autoAcceptFriendMinLevel: automationSettings.value.autoAcceptFriendMinLevel,
    fertilizerBuyOrganicCount: automationSettings.value.fertilizerBuyOrganicCount,
    fertilizerBuyOrganicThresholdHours: automationSettings.value.fertilizerBuyOrganicThresholdHours,
    fertilizerBuyNormalCount: automationSettings.value.fertilizerBuyNormalCount,
    fertilizerBuyNormalThresholdHours: automationSettings.value.fertilizerBuyNormalThresholdHours,
    fertilizerBuyCheckIntervalMinutes: automationSettings.value.fertilizerBuyCheckIntervalMinutes,
    goldenBugKeepCount: automationSettings.value.goldenBugKeepCount,
    goldenBugRoundLimit: automationSettings.value.goldenBugRoundLimit,
    autoCodeRefresh: autoCodeRefresh.value,
  }
}

async function fetchPlan() {
  loading.value = true
  try {
    const { data } = await api.get('/api/settings/default-plan')
    if (data?.ok)
      applyPlan(data.data)
  }
  catch (error: any) {
    emit('notify', error.response?.data?.error || '默认方案加载失败', 'danger')
  }
  finally {
    loading.value = false
  }
}

async function savePlan() {
  saving.value = true
  try {
    const { data } = await api.put('/api/settings/default-plan', {
      enabled: enabled.value,
      config: buildConfig(),
    })
    if (!data?.ok)
      throw new Error(data?.error || '保存失败')
    applyPlan(data.data)
    emit('notify', '默认方案已保存')
  }
  catch (error: any) {
    emit('notify', error.response?.data?.error || error.message || '默认方案保存失败', 'danger')
  }
  finally {
    saving.value = false
  }
}

async function importCurrentAccount() {
  if (!props.currentAccountId)
    return
  importing.value = true
  try {
    const { data } = await api.post('/api/settings/default-plan/import', {}, {
      headers: { 'x-account-id': String(props.currentAccountId) },
    })
    if (!data?.ok)
      throw new Error(data?.error || '导入失败')
    applyPlan(data.data)
    emit('notify', `已从 ${props.currentAccountName || '当前账号'} 导入默认方案`)
  }
  catch (error: any) {
    emit('notify', error.response?.data?.error || error.message || '导入默认方案失败', 'danger')
  }
  finally {
    importing.value = false
  }
}

async function resetPlan() {
  resetting.value = true
  try {
    const { data } = await api.post('/api/settings/default-plan/reset')
    if (!data?.ok)
      throw new Error(data?.error || '恢复失败')
    applyPlan(data.data)
    showResetConfirm.value = false
    emit('notify', '默认方案已恢复为系统默认')
  }
  catch (error: any) {
    emit('notify', error.response?.data?.error || error.message || '恢复系统默认失败', 'danger')
  }
  finally {
    resetting.value = false
  }
}

function resetBagSeedPriority() {
  bagSeedExcluded.value = new Set()
  persistBagSeedExcluded()
  strategySettings.value.bagSeedPriority = props.bagSeeds.map(seed => seed.seedId)
}

function moveBagSeed(seedId: number, direction: -1 | 1) {
  const list = strategySettings.value.bagSeedPriority
  const index = list.indexOf(seedId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= list.length) {
    return
  }
  const current = list[index]!
  list[index] = list[target]!
  list[target] = current
}

function removeBagSeedPriority(seedId: number) {
  const numericSeedId = Number(seedId)
  // 记入「已跳过」：确保新种子自动追加逻辑不会把它重新加回来
  const nextExcluded = new Set(bagSeedExcluded.value)
  nextExcluded.add(numericSeedId)
  bagSeedExcluded.value = nextExcluded
  persistBagSeedExcluded()
  strategySettings.value.bagSeedPriority = strategySettings.value.bagSeedPriority.filter(id => id !== numericSeedId)
}

function restoreBagSeed(seedId: number) {
  const numericSeedId = Number(seedId)
  const nextExcluded = new Set(bagSeedExcluded.value)
  nextExcluded.delete(numericSeedId)
  bagSeedExcluded.value = nextExcluded
  persistBagSeedExcluded()
  if (Number.isInteger(numericSeedId) && numericSeedId > 0) {
    const current = strategySettings.value.bagSeedPriority || []
    if (!current.map(Number).includes(numericSeedId))
      strategySettings.value.bagSeedPriority = [...current, numericSeedId]
  }
}

/**
 * 把背包中的新种子合并进优先列表（保留已有顺序 + 追加未列入且未跳过的）。
 * 与首页策略面板的合并逻辑保持一致，避免「新种子不显示/用不到」。
 */
function mergeBagSeedsIntoPriority() {
  if (!props.bagSeeds.length)
    return
  const excluded = bagSeedExcluded.value
  const merged: number[] = []
  const seen = new Set<number>()
  for (const rawSeedId of strategySettings.value.bagSeedPriority || []) {
    const seedId = Number(rawSeedId)
    if (!seedId || seen.has(seedId) || excluded.has(seedId))
      continue
    seen.add(seedId)
    merged.push(seedId)
  }
  for (const seed of props.bagSeeds) {
    const seedId = Number(seed.seedId)
    if (!seedId || seen.has(seedId) || excluded.has(seedId))
      continue
    seen.add(seedId)
    merged.push(seedId)
  }
  strategySettings.value.bagSeedPriority = merged
}

function startBagSeedDrag(seedId: number) {
  draggedSeedId = seedId
}

function dropBagSeed(seedId: number) {
  if (!draggedSeedId || draggedSeedId === seedId)
    return
  const list = strategySettings.value.bagSeedPriority
  const from = list.indexOf(draggedSeedId)
  const to = list.indexOf(seedId)
  if (from < 0 || to < 0)
    return
  const [moved] = list.splice(from, 1)
  if (moved !== undefined)
    list.splice(to, 0, moved)
  draggedSeedId = null
}

onMounted(fetchPlan)

// 切换账号时同步该账号的「已跳过」记忆（与首页策略面板共用同一份 localStorage）
watch(() => props.currentAccountId, (accountId) => {
  bagSeedExcluded.value = accountId ? readBagSeedExcluded(accountId) : new Set()
}, { immediate: true })

// 背包种子到位后合并新种子进优先列表（仅当处于背包优先策略且列表非空时增量合并）
watch(() => props.bagSeeds, (seeds) => {
  if (strategySettings.value.plantingStrategy !== 'bag_priority' || !seeds.length)
    return
  if (!strategySettings.value.bagSeedPriority || strategySettings.value.bagSeedPriority.length === 0)
    strategySettings.value.bagSeedPriority = seeds.map(seed => Number(seed.seedId)).filter(id => id > 0)
  else
    mergeBagSeedsIntoPriority()
}, { deep: false })

// 当种植策略切到「背包种子优先」且已选中账号时，主动拉取背包种子
watchEffect(() => {
  if (strategySettings.value.plantingStrategy === 'bag_priority' && props.currentAccountId)
    props.fetchBagSeeds?.()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-3 border-b border-gray-200 pb-4 lg:flex-row lg:items-center lg:justify-between dark:border-gray-700">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-3">
          <h3 class="flex items-center gap-2 text-lg text-gray-900 font-bold dark:text-gray-100 max-sm:text-base">
            <span class="i-carbon-settings-adjust" />
            默认方案
          </h3>
          <BaseSwitch v-model="enabled" label="新账号自动应用" />
        </div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {{ exists ? `最后保存：${updatedAtLabel}` : '尚未保存默认方案' }}
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <BaseButton
          variant="outline"
          size="sm"
          :loading="importing"
          :disabled="!currentAccountId || loading"
          :title="currentAccountId ? `从 ${currentAccountName || '当前账号'} 导入` : '请先选择账号'"
          @click="importCurrentAccount"
        >
          <span class="i-carbon-document-import mr-1.5" />
          从当前账号导入
        </BaseButton>
        <BaseButton variant="ghost" size="sm" :disabled="loading" @click="showResetConfirm = true">
          <span class="i-carbon-reset mr-1.5" />
          恢复系统默认
        </BaseButton>
      </div>
    </div>

    <div class="inline-flex border border-gray-200 rounded-lg bg-gray-50 p-1 dark:border-gray-700 dark:bg-gray-900/30">
      <button
        data-testid="default-plan-strategy-section"
        class="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors max-sm:px-2.5 max-sm:py-1 max-sm:text-xs"
        :class="activeSection === 'strategy' ? 'text-white' : 'text-gray-600 dark:text-gray-300'"
        :style="activeSection === 'strategy' ? { background: 'var(--theme-primary)' } : {}"
        @click="activeSection = 'strategy'"
      >
        <span class="i-fas-cogs" />
        策略设置
      </button>
      <button
        data-testid="default-plan-automation-section"
        class="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
        :class="activeSection === 'automation' ? 'text-white' : 'text-gray-600 dark:text-gray-300'"
        :style="activeSection === 'automation' ? { background: 'var(--theme-primary)' } : {}"
        @click="activeSection = 'automation'"
      >
        <span class="i-carbon-toggle-on" />
        自动控制
      </button>
    </div>

    <div v-if="loading" class="py-10 text-center text-gray-500">
      <span class="i-svg-spinners-ring-resize mb-2 inline-block text-2xl" />
      <div>加载中...</div>
    </div>

    <StrategySettingsTab
      v-else-if="activeSection === 'strategy'"
      v-model:settings="strategySettings"
      :current-account-id="currentAccountId"
      :current-account-name="currentAccountName"
      :loading="false"
      :saving="saving"
      title="默认策略"
      save-label="保存默认方案"
      :planting-strategy-options="plantingStrategyOptions"
      :preferred-seed-options="preferredSeedOptions"
      :bag-fallback-strategy-options="bagFallbackStrategyOptions"
      :strategy-preview-label="strategyPreviewLabel"
      :bag-seeds="bagSeeds"
      :sorted-bag-seeds="sortedBagSeeds"
      :excluded-bag-seeds="excludedBagSeeds"
      :bag-seeds-loading="bagSeedsLoading"
      :bag-seeds-error="bagSeedsError"
      @reset-bag-seed-priority="resetBagSeedPriority"
      @move-bag-seed="moveBagSeed"
      @remove-bag-seed="removeBagSeedPriority"
      @restore-bag-seed="restoreBagSeed"
      @start-bag-seed-drag="startBagSeedDrag"
      @drag-over-bag-seed="() => {}"
      @drop-bag-seed="dropBagSeed"
      @save="savePlan"
    />

    <AutomationSettingsTab
      v-else
      v-model:settings="automationSettings"
      v-model:auto-code-refresh="autoCodeRefresh"
      :current-account-id="currentAccountId"
      :current-account-name="currentAccountName"
      :loading="false"
      :saving="saving"
      :auto-code-refreshing="false"
      :show-run-auto-code-refresh="false"
      title="默认自动控制"
      save-label="保存默认方案"
      :fertilizer-land-type-options="fertilizerLandTypeOptions"
      :fertilizer-options="fertilizerOptions"
      @save="savePlan"
    />

    <ConfirmModal
      :show="showResetConfirm"
      :loading="resetting"
      title="恢复系统默认"
      message="确定要用系统默认设置覆盖当前默认方案吗？"
      confirm-text="确认恢复"
      @close="!resetting && (showResetConfirm = false)"
      @cancel="!resetting && (showResetConfirm = false)"
      @confirm="resetPlan"
    />
  </div>
</template>

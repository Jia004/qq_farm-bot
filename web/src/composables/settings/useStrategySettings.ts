import type { Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { computed, ref, watchEffect } from 'vue'
import api from '@/api'
import { useFarmStore } from '@/stores/farm'
import { useSettingStore } from '@/stores/setting'

interface BagSeedItem {
  seedId: number
  name: string
  count: number
  requiredLevel: number
  plantSize: number
}

interface AutomationSettingsSnapshot {
  automation: Record<string, unknown>
}

type AlertType = 'primary' | 'danger'

const analyticsSortByMap: Record<string, string> = {
  max_exp: 'exp',
  max_fert_exp: 'fert',
  max_profit: 'profit',
  max_fert_profit: 'fert_profit',
}

export function useStrategySettings({
  currentAccountId,
  getAutomationSettings,
  showAlert,
}: {
  currentAccountId: Ref<string | number | null | undefined>
  getAutomationSettings: () => AutomationSettingsSnapshot
  showAlert: (message: string, type?: AlertType) => void
}) {
  const settingStore = useSettingStore()
  const farmStore = useFarmStore()
  const { settings, loading: settingsLoading } = storeToRefs(settingStore)
  const { seeds } = storeToRefs(farmStore)

  const strategySaving = ref(false)

  const localStrategySettings = ref({
    plantingStrategy: 'max_exp',
    preferredSeedId: 0,
    prioritize2x2Crops: false,
    bagSeedPriority: [] as number[],
    bagSeedFallbackStrategy: 'level',
    bagPriorityLandTypes: ['purple', 'gold', 'black', 'red', 'normal'] as string[],
    stealDelaySeconds: 0,
    plantOrderRandom: false,
    plantDelaySeconds: 0,
    intervals: { farmMin: 2, farmMax: 5, helpMin: 10, helpMax: 15, stealMin: 10, stealMax: 15 },
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00' },
  })

  const plantingStrategyOptions = [
    { label: '优先种植种子', value: 'preferred' },
    { label: '最高等级作物', value: 'level' },
    { label: '最大经验/时', value: 'max_exp' },
    { label: '最大普通肥经验/时', value: 'max_fert_exp' },
    { label: '最大净利润/时', value: 'max_profit' },
    { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
    { label: '背包种子优先', value: 'bag_priority' },
  ]

  const bagFallbackStrategyOptions = [
    { label: '最高等级作物', value: 'level' },
    { label: '最大经验/时', value: 'max_exp' },
    { label: '最大普通肥经验/时', value: 'max_fert_exp' },
    { label: '最大净利润/时', value: 'max_profit' },
    { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
    { label: '优先种植种子', value: 'preferred' },
  ]

  const bagSeeds = ref<BagSeedItem[]>([])
  const bagSeedsLoading = ref(false)
  const bagSeedsError = ref<string | null>(null)
  const draggingBagSeedId = ref<number | null>(null)
  // 「已跳过」的种子（用户点 × 移除过的）：不参与背包优先种植，也不会被
  // 「新种子自动追加」逻辑重新显示。按账号隔离持久化在 localStorage，
  // 避免"移出后一刷新又回来"。
  const bagSeedExcluded = ref<Set<number>>(new Set())
  let bagSeedsRequestId = 0
  let strategyPreviewRequestId = 0

  const BAG_SEED_EXCLUDED_PREFIX = 'qqfarm:bagSeedExcluded:'

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
    const accountId = currentAccountId.value
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

  const sortedBagSeeds = computed(() => {
    const priority = localStrategySettings.value.bagSeedPriority || []
    const excluded = bagSeedExcluded.value
    const seedMap = new Map(bagSeeds.value.map(seed => [Number(seed.seedId), seed]))
    const orderedSeeds: BagSeedItem[] = []
    const seen = new Set<number>()

    // 1) 先按用户保存的优先级顺序排列
    for (const rawSeedId of priority) {
      const seedId = Number(rawSeedId)
      if (!seedId || seen.has(seedId) || excluded.has(seedId))
        continue
      const seed = seedMap.get(seedId)
      if (!seed)
        continue
      seen.add(seedId)
      orderedSeeds.push(seed)
    }

    // 2) 再追加背包中「有但不在优先列表里」的种子（新获得/早期漏掉的种子）。
    //    旧实现只返回第 1 步的结果——若优先列表是早期保存的，新种子永远不显示，
    //    表现为「只读取到很早的种子」。
    for (const seed of bagSeeds.value) {
      const seedId = Number(seed.seedId)
      if (!seedId || seen.has(seedId) || excluded.has(seedId))
        continue
      seen.add(seedId)
      orderedSeeds.push(seed)
    }

    return orderedSeeds
  })

  // 「已跳过」区展示数据（背包中确实存在但被用户移除的种子）
  const excludedBagSeeds = computed(() =>
    bagSeeds.value.filter(seed => bagSeedExcluded.value.has(Number(seed.seedId))),
  )

  /**
   * 把背包种子合并进优先列表：
   * - 保留用户已有顺序（含暂时用完、不在背包中的种子——避免补货后丢失位置）
   * - 剔除用户明确跳过的
   * - 背包中新获得、未跳过、未列入的种子自动追加到末尾 → 保存后即可被种植
   */
  function syncBagSeedPriorityWithBag() {
    if (!bagSeeds.value.length)
      return
    const excluded = bagSeedExcluded.value
    const merged: number[] = []
    const seen = new Set<number>()
    // 注意：不按「当前是否在背包」过滤已有 ID——种子暂时耗尽时仍保留其位置，
    // 补货后无需重新排队。
    for (const rawSeedId of localStrategySettings.value.bagSeedPriority || []) {
      const seedId = Number(rawSeedId)
      if (!seedId || seen.has(seedId) || excluded.has(seedId))
        continue
      seen.add(seedId)
      merged.push(seedId)
    }
    for (const seed of bagSeeds.value) {
      const seedId = Number(seed.seedId)
      if (!seedId || seen.has(seedId) || excluded.has(seedId))
        continue
      seen.add(seedId)
      merged.push(seedId)
    }
    localStrategySettings.value.bagSeedPriority = merged
  }

  async function fetchBagSeeds() {
    const accountId = currentAccountId.value
    if (!accountId)
      return
    const requestedId = String(accountId)
    const requestId = ++bagSeedsRequestId
    bagSeedsLoading.value = true
    bagSeedsError.value = null
    // 切换账号时同步该账号的「已跳过」记忆
    bagSeedExcluded.value = readBagSeedExcluded(accountId)
    try {
      const res = await api.get('/api/bag/seeds', {
        headers: { 'x-account-id': accountId },
      })
      if (requestId !== bagSeedsRequestId || String(currentAccountId.value || '') !== requestedId)
        return
      if (res.data.ok) {
        bagSeeds.value = res.data.data || []
        // 合并：保留已保存顺序 + 自动追加背包中未列入（且未跳过）的新种子。
        // 这样「背包种子优先」既能消耗到新获得的种子，又不会因优先列表
        // 过期而显示不到它们。列表为空时也走同一逻辑（避免把已跳过的
        // 种子重新加回来）。
        syncBagSeedPriorityWithBag()
      }
    }
    catch (e: any) {
      if (requestId === bagSeedsRequestId && String(currentAccountId.value || '') === requestedId)
        bagSeedsError.value = e.message || '加载失败'
    }
    finally {
      if (requestId === bagSeedsRequestId)
        bagSeedsLoading.value = false
    }
  }

  function resetBagSeedPriority() {
    bagSeedExcluded.value = new Set()
    persistBagSeedExcluded()
    localStrategySettings.value.bagSeedPriority = bagSeeds.value.map(seed => Number(seed.seedId)).filter(seedId => seedId > 0)
  }

  /**
   * 完整优先顺序（含暂时用完、不在背包中的种子；剔除用户跳过的）。
   * 移动/删除都应基于它——若基于「当前在背包」的子集会静默剔除已用完的种子。
   */
  function getCurrentBagSeedOrder() {
    const excluded = bagSeedExcluded.value
    const order: number[] = []
    const seen = new Set<number>()
    for (const rawSeedId of localStrategySettings.value.bagSeedPriority || []) {
      const seedId = Number(rawSeedId)
      if (!seedId || seen.has(seedId) || excluded.has(seedId))
        continue
      seen.add(seedId)
      order.push(seedId)
    }
    // 兜底：背包中有但列表未列入的（正常情况下 fetch 后已合并）
    for (const seed of bagSeeds.value) {
      const seedId = Number(seed.seedId)
      if (!seedId || seen.has(seedId) || excluded.has(seedId))
        continue
      seen.add(seedId)
      order.push(seedId)
    }
    return order
  }

  function moveBagSeed(seedId: number, direction: -1 | 1) {
    const displayedIds = sortedBagSeeds.value.map(seed => Number(seed.seedId))
    const currentIndex = displayedIds.indexOf(seedId)
    const targetIndex = currentIndex + direction
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= displayedIds.length)
      return
    const targetSeedId = displayedIds[targetIndex]!

    // 交换两个种子在完整列表中的位置（未显示的种子保持原有相对顺序）
    const full = getCurrentBagSeedOrder()
    const p = full.indexOf(seedId)
    const q = full.indexOf(targetSeedId)
    if (p < 0 || q < 0)
      return
    const temp = full[p]!
    full[p] = full[q]!
    full[q] = temp
    localStrategySettings.value.bagSeedPriority = full
  }

  function removeBagSeedPriority(seedId: number) {
    const numericSeedId = Number(seedId)
    // 记入「已跳过」——既从优先列表移除，也保证新种子自动追加逻辑
    // 不会把它重新加回来（旧实现移出后又会被追加显示，无法真正跳过）。
    const nextExcluded = new Set(bagSeedExcluded.value)
    nextExcluded.add(numericSeedId)
    bagSeedExcluded.value = nextExcluded
    persistBagSeedExcluded()
    localStrategySettings.value.bagSeedPriority = getCurrentBagSeedOrder()
  }

  function restoreBagSeed(seedId: number) {
    const numericSeedId = Number(seedId)
    const nextExcluded = new Set(bagSeedExcluded.value)
    nextExcluded.delete(numericSeedId)
    bagSeedExcluded.value = nextExcluded
    persistBagSeedExcluded()
    if (Number.isInteger(numericSeedId) && numericSeedId > 0) {
      const current = localStrategySettings.value.bagSeedPriority || []
      if (!current.map(Number).includes(numericSeedId))
        localStrategySettings.value.bagSeedPriority = [...current, numericSeedId]
    }
  }

  function startBagSeedDrag(seedId: number, event: DragEvent) {
    draggingBagSeedId.value = seedId
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(seedId))
    }
  }

  function dragOverBagSeed(_seedId: number, event: DragEvent) {
    if (draggingBagSeedId.value === null)
      return
    event.preventDefault()
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = 'move'
  }

  function dropBagSeed(seedId: number, event: DragEvent) {
    event.preventDefault()
    const sourceSeedId = draggingBagSeedId.value ?? Number(event.dataTransfer?.getData('text/plain') || '')
    if (!sourceSeedId || sourceSeedId === seedId) {
      draggingBagSeedId.value = null
      return
    }

    const nextOrder = getCurrentBagSeedOrder()
    const sourceIndex = nextOrder.indexOf(sourceSeedId)
    const targetIndex = nextOrder.indexOf(seedId)

    if (sourceIndex < 0 || targetIndex < 0) {
      draggingBagSeedId.value = null
      return
    }

    const [moved] = nextOrder.splice(sourceIndex, 1)
    const newTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
    nextOrder.splice(newTargetIndex, 0, moved!)

    localStrategySettings.value.bagSeedPriority = nextOrder
    draggingBagSeedId.value = null
  }

  watchEffect(() => {
    if (localStrategySettings.value.plantingStrategy === 'bag_priority' && currentAccountId.value) {
      fetchBagSeeds()
    }
  })

  const preferredSeedOptions = computed(() => {
    const options: { label: string, value: number, disabled?: boolean }[] = [{ label: '自动选择', value: 0, disabled: false }]
    if (seeds.value) {
      options.push(...seeds.value.map(seed => ({
        label: `${seed.requiredLevel}级 ${seed.name} (${seed.price}金)`,
        value: seed.seedId,
        disabled: seed.locked || seed.soldOut,
      })))
    }
    return options
  })

  const strategyPreviewLabel = ref<string | null>(null)

  watchEffect(async () => {
    const requestId = ++strategyPreviewRequestId
    let strategy = localStrategySettings.value.plantingStrategy
    if (strategy === 'preferred') {
      strategyPreviewLabel.value = null
      return
    }
    if (strategy === 'bag_priority') {
      strategy = localStrategySettings.value.bagSeedFallbackStrategy || 'level'
      if (strategy === 'preferred') {
        const preferredId = localStrategySettings.value.preferredSeedId
        if (preferredId > 0 && seeds.value) {
          const seed = seeds.value.find(s => s.seedId === preferredId)
          strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : '未选择优先种子'
        }
        else {
          strategyPreviewLabel.value = '未选择优先种子'
        }
        return
      }
    }
    if (!seeds.value || seeds.value.length === 0) {
      strategyPreviewLabel.value = null
      return
    }
    const available = seeds.value.filter(s => !s.locked && !s.soldOut)
    if (available.length === 0) {
      strategyPreviewLabel.value = '暂无可用种子'
      return
    }
    if (strategy === 'level') {
      const best = [...available].sort((a, b) => b.requiredLevel - a.requiredLevel)[0]
      strategyPreviewLabel.value = best ? `${best.requiredLevel}级 ${best.name}` : null
      return
    }
    const sortBy = analyticsSortByMap[strategy]
    if (sortBy) {
      try {
        const accountId = currentAccountId.value
        if (!accountId) {
          strategyPreviewLabel.value = null
          return
        }
        const requestedId = String(accountId)
        const res = await api.get(`/api/analytics?sort=${sortBy}`, {
          headers: { 'x-account-id': accountId },
        })
        if (requestId !== strategyPreviewRequestId || String(currentAccountId.value || '') !== requestedId)
          return
        const rankings: any[] = res.data.ok ? (res.data.data || []) : []
        const availableIds = new Set(available.map(s => s.seedId))
        const match = rankings.find(r => availableIds.has(Number(r.seedId)))
        if (match) {
          const seed = available.find(s => s.seedId === Number(match.seedId))
          strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : null
        }
        else {
          strategyPreviewLabel.value = '暂无匹配种子'
        }
      }
      catch {
        if (requestId === strategyPreviewRequestId)
          strategyPreviewLabel.value = null
      }
    }
  })

  function syncLocalStrategySettings() {
    if (settings.value) {
      localStrategySettings.value = JSON.parse(JSON.stringify({
        plantingStrategy: settings.value.plantingStrategy,
        preferredSeedId: settings.value.preferredSeedId,
        prioritize2x2Crops: settings.value.prioritize2x2Crops === true,
        bagSeedPriority: settings.value.bagSeedPriority ?? [],
        bagSeedFallbackStrategy: settings.value.bagSeedFallbackStrategy ?? 'level',
        bagPriorityLandTypes: (settings.value.bagPriorityLandTypes && settings.value.bagPriorityLandTypes.length > 0)
          ? settings.value.bagPriorityLandTypes
          : ['purple', 'gold', 'black', 'red', 'normal'],
        stealDelaySeconds: settings.value.stealDelaySeconds ?? 0,
        plantOrderRandom: !!settings.value.plantOrderRandom,
        plantDelaySeconds: settings.value.plantDelaySeconds ?? 0,
        intervals: settings.value.intervals,
        friendQuietHours: settings.value.friendQuietHours,
      }))
    }
  }

  async function loadStrategyData() {
    if (currentAccountId.value) {
      const accountId = String(currentAccountId.value)
      await settingStore.fetchSettings(accountId)
      syncLocalStrategySettings()
      await farmStore.fetchSeeds(accountId)
    }
  }

  async function saveStrategySettings() {
    if (!currentAccountId.value)
      return
    strategySaving.value = true
    try {
      const fullSettings = {
        ...settings.value,
        ...localStrategySettings.value,
        automation: getAutomationSettings().automation,
      }
      const res = await settingStore.saveSettings(String(currentAccountId.value), fullSettings)
      if (res.ok) {
        showAlert('策略设置已保存', 'primary')
      }
      else {
        showAlert(`保存失败: ${res.error}`, 'danger')
      }
    }
    finally {
      strategySaving.value = false
    }
  }

  function resetStrategyState() {
    bagSeeds.value = []
    bagSeedsError.value = null
    bagSeedsLoading.value = false
    draggingBagSeedId.value = null
    strategyPreviewLabel.value = null
    bagSeedExcluded.value = new Set()
  }

  return {
    settings,
    settingsLoading,
    strategySaving,
    localStrategySettings,
    plantingStrategyOptions,
    bagFallbackStrategyOptions,
    bagSeeds,
    bagSeedsLoading,
    bagSeedsError,
    sortedBagSeeds,
    excludedBagSeeds,
    preferredSeedOptions,
    strategyPreviewLabel,
    resetBagSeedPriority,
    moveBagSeed,
    removeBagSeedPriority,
    restoreBagSeed,
    startBagSeedDrag,
    dragOverBagSeed,
    dropBagSeed,
    syncLocalStrategySettings,
    loadStrategyData,
    saveStrategySettings,
    resetStrategyState,
    fetchBagSeeds,
  }
}

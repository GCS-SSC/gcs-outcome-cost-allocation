<script setup lang="ts">
import { h, type VNode, computed, ref, watch, type Ref } from 'vue'
import type { ExtensionEntityTabContext, GcsExtensionJsonConfig, GcsExtensionRbacRequirement } from '@gcs-ssc/extensions'
import { ExtensionBadge, ExtensionButton, ExtensionResourceLayout, useExtensionApi, useExtensionI18n, useExtensionToast } from '@gcs-ssc/extensions/ui'
import { AgreementOutcomeCostAllocationTabMessages, AgreementOutcomeCostAllocationTabStatusMessages } from '../i18n/AgreementOutcomeCostAllocationTab'
import { type AllocationMoney, type CostAllocationVersion, resolveAllocationAmounts, subtractMoney, sumMoney, toMoney } from '../shared/allocation'
import {
  type AllocationResponse,
  deleteOutcomeAllocationDraftVersionRequest,
  formatCurrencyAmount,
  getOutcomeAllocationVersionEndpoint,
  getOutcomeAllocationVersionsEndpoint,
  getOutcomeAllocationToastText
} from '../shared/agreement-outcome-cost-allocation-tab'

const { extensionKey, context, navigation, canUpdate = false, canDelete = false, canWork = false } = defineProps<{
  extensionKey: string
  context: ExtensionEntityTabContext
  config: GcsExtensionJsonConfig
  rbac: GcsExtensionRbacRequirement
  navigation?: { collectionHref: string; recordHref: (recordId: string) => string }
  canUpdate?: boolean
  canDelete?: boolean
  canWork?: boolean
}>()
const { locale, t } = useExtensionI18n(AgreementOutcomeCostAllocationTabMessages)
const { t: statusText } = useExtensionI18n(AgreementOutcomeCostAllocationTabStatusMessages)
const api = useExtensionApi(extensionKey)
const toast = useExtensionToast()
const data: Ref<AllocationResponse | null> = ref(null)
const status: Ref<'idle' | 'pending' | 'success' | 'error'> = ref('idle')
const search = ref('')
const pagination = ref({ pageIndex: 0, pageSize: 10 })
const isCreatingDraft = ref(false)
const deletingVersionId = ref('')
const error: Ref<{ kind: 'local'; key: 'assignmentRequired' | 'pendingEffects' } | { kind: 'api'; message: string } | null> = ref(null)
const saveError = computed(() => error.value?.kind === 'local' ? t(error.value.key) : error.value?.message ?? '')
const endpoint = computed(() => `/agreements/${context.agreementId}/allocations`)
let requestGeneration = 0
const refresh = async () => {
  const generation = ++requestGeneration
  status.value = 'pending'
  try {
    const response = await api.get<AllocationResponse>(endpoint.value)
    if (generation !== requestGeneration) return
    data.value = response
    status.value = 'success'
  } catch {
    if (generation !== requestGeneration) return
    data.value = null
    status.value = 'error'
  }
}
await refresh()
watch(() => context.agreementId, () => {
  data.value = null
  error.value = null
  search.value = ''
  pagination.value.pageIndex = 0
  refresh()
})
const hasPendingMutation = computed(() => isCreatingDraft.value || Boolean(deletingVersionId.value))
const hasDraftVersion = computed(() => data.value?.versions.some(version => version.status === 'draft') === true)
const formatMoney = (value: AllocationMoney) => data.value?.currency
  ? formatCurrencyAmount(value, locale.value, data.value.currency)
  : '—'
const formatDate = (value?: string | null) => value
  ? new Intl.DateTimeFormat(locale.value === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'medium' }).format(new Date(value))
  : ''
const versionLabel = (version: CostAllocationVersion) => `${t('version')} ${version.versionNumber}`
const rows = computed(() => (data.value?.versions ?? []).map(version => {
  const allocations = data.value?.allocations.filter(allocation => allocation.allocationVersionId === version.id) ?? []
  const total = version.status === 'draft'
    ? sumMoney(resolveAllocationAmounts(allocations, (data.value?.budgetYears ?? []).map(year => ({ agreementBudgetFiscalYearId: String(year.id), programFunding: year.remaining_funding ?? year.program_funding }))).map(allocation => allocation.amount))
    : sumMoney(allocations.map(allocation => toMoney(allocation.resolvedAmount ?? allocation.allocationValue)))
  const funding = version.fundingBasisAmount ?? sumMoney((data.value?.budgetYears ?? []).map(year => year.remaining_funding ?? year.program_funding))
  return { ...version, label: versionLabel(version), date: formatDate(version.completedAt ?? version.createdAt), statusLabel: statusText(version.status), total, unallocated: subtractMoney(funding, total) }
}))
const filteredRows = computed(() => {
  const query = search.value.trim().toLocaleLowerCase(locale.value)
  return rows.value.filter(row => !query || `${row.label} ${row.statusLabel} ${row.date}`.toLocaleLowerCase(locale.value).includes(query))
})
const visibleRows = computed(() => filteredRows.value.slice(pagination.value.pageIndex * pagination.value.pageSize, (pagination.value.pageIndex + 1) * pagination.value.pageSize))
watch(() => filteredRows.value.length, count => {
  const lastPageIndex = Math.max(0, Math.ceil(count / pagination.value.pageSize) - 1)
  pagination.value.pageIndex = Math.min(pagination.value.pageIndex, lastPageIndex)
})
watch(search, () => {
  pagination.value.pageIndex = 0
})
const columns = computed(() => [
  { id: 'version', accessorKey: 'label', header: t('version') },
  { id: 'status', accessorKey: 'statusLabel', header: t('status') },
  { id: 'amount', accessorKey: 'total', header: t('amount') },
  { id: 'unallocated', accessorKey: 'unallocated', header: t('unallocated') },
  { id: 'actions', header: t('actions') }
])
const statusColor = (version: CostAllocationVersion) => ({ draft: 'neutral', active: 'success', inactive: 'warning' } as const)[version.status]
const createDraftVersion = async () => {
  if (!canUpdate) return
  if (!canWork) {
    error.value = { kind: 'local', key: 'assignmentRequired' }
    return
  }
  if (hasPendingMutation.value || hasDraftVersion.value) return
  if (data.value?.hasPendingEffects) {
    error.value = { kind: 'local', key: 'pendingEffects' }
    const warningKey = 'pendingEffects'
    toast.add({ title: getOutcomeAllocationToastText(() => locale.value, 'error').title, description: (): VNode => h('span', t(warningKey)), color: 'warning' })
    return
  }
  isCreatingDraft.value = true
  error.value = null
  try {
    await api.post<{ version?: CostAllocationVersion }>(getOutcomeAllocationVersionsEndpoint(endpoint.value))
    await refresh()
  } catch (cause) {
    error.value = { kind: 'api', message: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    isCreatingDraft.value = false
  }
}
const deleteDraftVersion = async (versionId: string) => {
  if (!canDelete) return
  if (!canWork) {
    error.value = { kind: 'local', key: 'assignmentRequired' }
    return
  }
  if (hasPendingMutation.value) return
  deletingVersionId.value = versionId
  error.value = null
  try {
    await deleteOutcomeAllocationDraftVersionRequest(api.path(getOutcomeAllocationVersionEndpoint(endpoint.value, encodeURIComponent(versionId))))
    await refresh()
    toast.add({ ...getOutcomeAllocationToastText(() => locale.value, 'deleted'), color: 'success' })
  } catch (cause) {
    error.value = { kind: 'api', message: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    deletingVersionId.value = ''
  }
}
</script>

<template>
  <div class="w-full min-w-0 space-y-4">
    <p v-if="saveError" role="alert" class="text-sm text-error">
      {{ saveError }}
    </p>
    <p v-if="data?.hasPendingEffects" role="status" class="text-sm text-warning">
      {{ t('pendingEffects') }}
    </p>
    <ExtensionResourceLayout
      v-model:search="search" v-model:pagination="pagination" :data="visibleRows" :columns="columns"
      :total-records="filteredRows.length" :loading="status === 'pending'" :request-status="status" :aria-label="t('allocationVersions')"
      :button-label="t('newDraft')" :show-button="canUpdate" :button-disabled="hasPendingMutation || status !== 'success' || hasDraftVersion" :search-placeholder="t('search')"
      @add="createDraftVersion" @retry="refresh">
      <template #version-cell="{ row }">
        <div class="flex flex-col gap-0.5">
          <ExtensionButton v-if="navigation" :to="navigation.recordHref(row.original.id)" color="neutral" variant="link" :label="row.original.label" :disabled="hasPendingMutation" class="cursor-pointer justify-start p-0 text-sm leading-tight font-bold tracking-normal text-zinc-900 normal-case transition-colors hover:text-primary dark:text-white" />
          <span v-else class="leading-tight font-bold text-zinc-900 dark:text-white">{{ row.original.label }}</span>
          <p class="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            {{ row.original.date }}
          </p>
        </div>
      </template>
      <template #status-cell="{ row }">
        <ExtensionBadge :color="statusColor(row.original)" variant="subtle">
          {{ row.original.statusLabel }}
        </ExtensionBadge>
      </template>
      <template #amount-cell="{ row }">
        {{ formatMoney(row.original.total) }}
      </template>
      <template #unallocated-cell="{ row }">
        {{ formatMoney(row.original.unallocated) }}
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <ExtensionButton v-if="navigation" :to="navigation.recordHref(row.original.id)" icon="i-lucide-arrow-right" :aria-label="`${t('view')}: ${row.original.label}`" :disabled="hasPendingMutation" color="neutral" variant="ghost" size="sm" />
          <ExtensionButton
            v-if="canDelete && row.original.status === 'draft'" icon="i-lucide-trash-2" :aria-label="`${t('delete')}: ${row.original.label}`" color="error" variant="ghost" size="sm"
            :loading="deletingVersionId === row.original.id" :disabled="hasPendingMutation" @click="deleteDraftVersion(row.original.id)" />
        </div>
      </template>
      <template #empty>
        <p class="py-8 text-center text-muted">
          {{ t(search ? 'noMatches' : 'noVersions') }}
        </p>
      </template>
    </ExtensionResourceLayout>
  </div>
</template>

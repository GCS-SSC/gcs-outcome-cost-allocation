<script setup lang="ts">
import { computed, ref, watch, type Ref } from 'vue'
import type { ExtensionEntityTabContext, GcsExtensionJsonConfig, GcsExtensionRbacRequirement } from '@gcs-ssc/extensions'
import { ExtensionBadge, ExtensionButton, ExtensionResourceLayoutCard, useExtensionApi, useExtensionI18n, useExtensionToast } from '@gcs-ssc/extensions/ui'
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
const saveError = ref('')
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
  saveError.value = ''
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
    saveError.value = t('assignmentRequired')
    return
  }
  if (hasPendingMutation.value || hasDraftVersion.value) return
  if (data.value?.hasPendingEffects) {
    saveError.value = t('pendingEffects')
    toast.add({ title: getOutcomeAllocationToastText(locale.value, 'error').title, description: saveError.value, color: 'warning' })
    return
  }
  isCreatingDraft.value = true
  saveError.value = ''
  try {
    await api.post<{ version?: CostAllocationVersion }>(getOutcomeAllocationVersionsEndpoint(endpoint.value))
    await refresh()
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isCreatingDraft.value = false
  }
}
const deleteDraftVersion = async (versionId: string) => {
  if (!canDelete) return
  if (!canWork) {
    saveError.value = t('assignmentRequired')
    return
  }
  if (hasPendingMutation.value) return
  deletingVersionId.value = versionId
  saveError.value = ''
  try {
    await deleteOutcomeAllocationDraftVersionRequest(api.path(getOutcomeAllocationVersionEndpoint(endpoint.value, encodeURIComponent(versionId))))
    await refresh()
    toast.add({ ...getOutcomeAllocationToastText(locale.value, 'deleted'), color: 'success' })
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error)
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
    <ExtensionResourceLayoutCard
      v-model:search="search" v-model:pagination="pagination" :data="visibleRows" :columns="columns"
      :total-records="filteredRows.length" :loading="status === 'pending'" :request-status="status" :aria-label="t('allocationVersions')"
      :button-label="t('newDraft')" :show-button="canUpdate" :button-disabled="hasPendingMutation || status !== 'success' || hasDraftVersion" :search-placeholder="t('search')"
      @add="createDraftVersion" @retry="refresh">
      <template #version-cell="{ row }">
        <div>
          <ExtensionButton v-if="navigation" :to="navigation.recordHref(row.original.id)" color="neutral" variant="link" :label="row.original.label" :disabled="hasPendingMutation" class="p-0 font-semibold" />
          <span v-else class="font-semibold">{{ row.original.label }}</span>
          <p class="text-xs text-muted">
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
            v-if="canDelete && row.original.status === 'draft'" icon="i-lucide-trash-2" :label="t('delete')" :aria-label="`${t('delete')}: ${row.original.label}`" color="error" variant="ghost" size="sm"
            :loading="deletingVersionId === row.original.id" :disabled="hasPendingMutation" @click="deleteDraftVersion(row.original.id)" />
        </div>
      </template>
      <template #empty>
        <p class="py-8 text-center text-muted">
          {{ t(search ? 'noMatches' : 'noVersions') }}
        </p>
      </template>
    </ExtensionResourceLayoutCard>
  </div>
</template>

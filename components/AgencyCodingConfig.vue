<script setup lang="ts">
import { computed, ref, watch, type Ref } from 'vue'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import { ExtensionAlert, ExtensionButton, ExtensionFormField, ExtensionInput, ExtensionSelectMenu, ExtensionSaveButton, ExtensionModal, ExtensionResourceLayout, useExtensionI18n, useHostApi } from '@gcs-ssc/extensions/ui'
import { AgencyCodingSchema, emptyAgencyCodingConfig, type AgencyCodingConfig } from '../shared/agency-coding'
import { AgencyCodingConfigMessages } from '../i18n/AgencyCodingConfig'

interface Account {
  id: string
  egcs_ay_kind: 'account_receivable' | 'credit_memo' | 'commitment'
  egcs_ay_fiscalyear: string
  egcs_ay_currency: string
  egcs_ay_commitmentchartofaccount: string | null
  fiscal_year_display: string
  egcs_ay_accountingdimensions: Array<{ label_en: string; label_fr: string; value: string }>
}
interface FiscalYear { id: string; egcs_ay_fiscalyeardisplay: string }
const { agencyId, section = 'receivables', extensionKey = 'gcs-outcome-cost-allocation', config = {}, readOnly = false, disabled = false } = defineProps<{ agencyId?: string; section?: string; extensionKey?: string; config?: GcsExtensionJsonConfig; readOnly?: boolean; disabled?: boolean }>()
const { t, locale } = useExtensionI18n(AgencyCodingConfigMessages)
const api = useHostApi()
const copy = (value: GcsExtensionJsonConfig | AgencyCodingConfig) => JSON.parse(JSON.stringify({ ...emptyAgencyCodingConfig(), ...value })) as AgencyCodingConfig
const local: Ref<AgencyCodingConfig> = ref(copy(config))
const accounts: Ref<Account[]> = ref([])
const fiscalYears: Ref<FiscalYear[]> = ref([])
const lookupError = ref(false)
const loading = ref(false)
const saving = ref(false)
const saveError = ref('')
const saved = ref(false)
const kind = computed(() => section === 'credit-memos' ? 'creditMemoRules' : 'receivableSets')
const search = ref('')
const pagination = ref({ pageIndex: 0, pageSize: 10 })
const editor: Ref<{ config: AgencyCodingConfig; index: number; isNew: boolean } | null> = ref(null)
const removing = ref<string | null>(null)
const set = computed(() => editor.value?.config[kind.value][editor.value.index])
const editorResult = computed(() => AgencyCodingSchema.safeParse(editor.value?.config))
const editorError = computed(() => !editorResult.value.success && editorResult.value.error.issues.some(issue => issue.message === 'duplicateYear') ? t('duplicateYear') : t('invalid'))
const attempted = ref(false)
const selectedCreditMemoAccounts: Ref<string[]> = ref([])
const closeEditor = () => { editor.value = null; selectedCreditMemoAccounts.value = []; attempted.value = false }
const openEditor = (index?: number) => {
  if (locked.value) return
  const draft = copy(local.value)
  if (index === undefined) {
    if (kind.value === 'receivableSets') draft.receivableSets.push({ fiscalYearId: '', currency: '', lines: [{ codingLineId: '', percentage: '100' }] })
    else draft.creditMemoRules.push({ commitmentCodingLineId: '', startDate: '', endDate: '', currency: '', lines: [] })
  }
  editor.value = { config: draft, index: index ?? draft[kind.value].length - 1, isNew: index === undefined }
  selectedCreditMemoAccounts.value = kind.value === 'creditMemoRules' ? draft.creditMemoRules[editor.value.index]!.lines.map(line => line.codingLineId) : []
  attempted.value = false
  saveError.value = ''
  saved.value = false
}
const applyEditor = async () => {
  attempted.value = true
  if (locked.value || !editor.value || !editorResult.value.success) return
  const draft = editor.value
  if (!await persist(draft.config)) return
  closeEditor()
}
const remove = async () => {
  if (locked.value || !removing.value) return
  const index = rows.value.find(row => row.key === removing.value)?.index ?? -1
  if (index === -1) return
  const candidate = copy(local.value)
  candidate[kind.value].splice(index, 1)
  if (!await persist(candidate)) return
  removing.value = null
}
const locked = computed(() => readOnly || disabled || loading.value || saving.value || lookupError.value || !agencyId)
const result = computed(() => AgencyCodingSchema.safeParse(local.value))
const fieldError = (path: string) => !attempted.value || editorResult.value.success ? undefined : editorResult.value.error.issues.some(issue => {
  if (issue.message === 'duplicateYear') return path.endsWith('.fiscalYearId') || path.endsWith('.currency')
  const issuePath = issue.path.join('.')
  return issuePath.startsWith(path) || (issuePath.length > 0 && path.startsWith(`${issuePath}.`))
}) ? editorError.value : undefined
const years = computed(() => fiscalYears.value.map(year => ({ value: year.id, label: year.egcs_ay_fiscalyeardisplay })))
const currencies = computed(() => [...new Set(accounts.value.map(account => account.egcs_ay_currency))].map(value => ({ value, label: value.toUpperCase() })))
const options = (kind: Account['egcs_ay_kind'], currency: string, year?: string) => accounts.value.filter(account => account.egcs_ay_kind === kind && account.egcs_ay_currency === currency && (!year || account.egcs_ay_fiscalyear === year)).map(account => ({
  value: account.id,
  label: `${account.fiscal_year_display} — ${account.egcs_ay_accountingdimensions.map(dimension => `${locale.value === 'fr' ? dimension.label_fr : dimension.label_en}: ${dimension.value}`).join(', ')}${kind === 'credit_memo' ? ` — ${t(account.egcs_ay_commitmentchartofaccount ? 'restore' : 'catchAll')}` : ''}`
}))
const formatPercentage = (value: string) => t('percentageValue', { value: locale.value === 'fr' ? value.replace('.', ',') : value })
const codingLabel = (account: Account | undefined) => account?.egcs_ay_accountingdimensions.map(dimension => `${locale.value === 'fr' ? dimension.label_fr : dimension.label_en}: ${dimension.value}`).join(', ') || t('unavailable')
const targetLabel = (codingLineId: string) => options('credit_memo', set.value?.currency ?? '').find(account => account.value === codingLineId)?.label ?? t('unavailable')
watch(selectedCreditMemoAccounts, ids => {
  if (!set.value || !('commitmentCodingLineId' in set.value)) return
  const previous = set.value.lines
  set.value.lines = ids.map((codingLineId, index) => previous.find(line => line.codingLineId === codingLineId) ?? { codingLineId, percentage: index === 0 && !previous.length ? '100' : '' })
})
watch(() => set.value?.currency, (currency, previous) => {
  if (previous === undefined || currency === previous || !set.value || !('commitmentCodingLineId' in set.value)) return
  const current = set.value
  if (!options('commitment', currency ?? '').some(account => account.value === current.commitmentCodingLineId)) current.commitmentCodingLineId = ''
  selectedCreditMemoAccounts.value = selectedCreditMemoAccounts.value.filter(id => options('credit_memo', currency ?? '').some(account => account.value === id))
})
const rows = computed(() => loading.value || lookupError.value ? [] : local.value[kind.value].map((item, index) => ({
  key: 'fiscalYearId' in item ? `${item.fiscalYearId}:${item.currency}` : `${item.commitmentCodingLineId}:${item.currency}:${item.startDate}:${item.endDate}`,
  index, currency: item.currency.toUpperCase(),
  source: 'commitmentCodingLineId' in item ? codingLabel(accounts.value.find(account => account.id === item.commitmentCodingLineId)) : '',
  label: 'fiscalYearId' in item ? years.value.find(year => year.value === item.fiscalYearId)?.label ?? t('unavailable') : `${item.startDate} – ${item.endDate}`,
  coding: item.lines.map(line => {
    const account = accounts.value.find(account => account.id === line.codingLineId)
    return { ...line, fiscalYear: account?.fiscal_year_display ?? t('unavailable'), label: codingLabel(account) }
  })
})))
const filteredRows = computed(() => rows.value.filter(row => `${row.source} ${row.label} ${row.currency} ${row.coding.map(line => `${line.label} ${line.percentage}`).join(' ')}`.toLocaleLowerCase(locale.value).includes(search.value.trim().toLocaleLowerCase(locale.value))))
const visibleRows = computed(() => filteredRows.value.slice(pagination.value.pageIndex * pagination.value.pageSize, (pagination.value.pageIndex + 1) * pagination.value.pageSize))
const columns = computed(() => [
  ...(kind.value === 'creditMemoRules' ? [{ id: 'source', header: t('sourceAccount') }] : []),
  { id: 'period', header: t(kind.value === 'receivableSets' ? 'fiscalYear' : 'dateRange') },
  { id: 'currency', accessorKey: 'currency', header: t('currency') },
  ...(kind.value === 'creditMemoRules' ? [{ id: 'fiscalYear', header: t('fiscalYear') }] : []),
  { id: 'coding', header: t('codingLines') },
  { id: 'percentage', header: t('percentage') },
  { id: 'actions', header: t('actions') }
])
watch(search, () => { pagination.value.pageIndex = 0 })
watch(kind, () => { pagination.value.pageIndex = 0; closeEditor(); removing.value = null })
watch(() => filteredRows.value.length, count => { pagination.value.pageIndex = Math.min(pagination.value.pageIndex, Math.max(0, Math.ceil(count / pagination.value.pageSize) - 1)) })
watch(() => readOnly || disabled || loading.value || lookupError.value || !agencyId, value => { if (value) { closeEditor(); removing.value = null } })

let lookupGeneration = 0
const refresh = async () => {
  const generation = ++lookupGeneration
  const contextAgencyId = agencyId
  const contextExtensionKey = extensionKey
  closeEditor()
  removing.value = null
  search.value = ''
  pagination.value.pageIndex = 0
  accounts.value = []
  fiscalYears.value = []
  local.value = copy(config)
  saved.value = false
  saveError.value = ''
  lookupError.value = false
  loading.value = false
  if (!agencyId) return
  loading.value = true
  try {
    const registry = await api.get<{ items: Array<{ extension: { key: string }; config: GcsExtensionJsonConfig }> }>(`/api/extensions/agency/${contextAgencyId}`)
    if (generation !== lookupGeneration) return
    const entry = registry.items.find(item => item.extension.key === contextExtensionKey)
    if (!entry) throw new Error('Missing extension configuration')
    if (generation === lookupGeneration) local.value = copy(entry.config)
    const loadedYears: FiscalYear[] = []
    for (let page = 1; ; page += 1) {
      const response = await api.get<{ items: FiscalYear[]; total: number }>(`/api/agency/${contextAgencyId}/fiscal-years?page=${page}&limit=100`)
      loadedYears.push(...response.items)
      if (response.items.length < 100 || page * 100 >= response.total) break
    }
    if (generation === lookupGeneration) fiscalYears.value = loadedYears
    const items: Account[] = []
    for (const kind of ['account_receivable', 'credit_memo', 'commitment']) {
      let page = 1
      while (true) {
        const response = await api.get<{ items: Account[]; total: number }>(`/api/agency/${contextAgencyId}/chart-of-accounts?kind=${kind}&page=${page}&limit=100`)
        items.push(...response.items)
        if (response.items.length < 100 || page * 100 >= response.total) break
        page += 1
      }
    }
    if (generation === lookupGeneration) accounts.value = items
  } catch {
    if (generation === lookupGeneration) lookupError.value = true
  } finally {
    if (generation === lookupGeneration) loading.value = false
  }
}
const persist = async (candidate: AgencyCodingConfig) => {
  if (locked.value || !AgencyCodingSchema.safeParse(candidate).success) return false
  const generation = lookupGeneration
  saving.value = true
  saveError.value = ''
  saved.value = false
  try {
    await api.patch(`/api/extensions/agency/${agencyId}`, {
      extensionKey, enabled: true, config: JSON.parse(JSON.stringify(candidate)) as GcsExtensionJsonConfig
    })
    if (generation !== lookupGeneration) return false
    local.value = copy(candidate)
    saved.value = true
    return true
  } catch (error) {
    if (generation === lookupGeneration) saveError.value = error instanceof Error ? error.message : t('saveError')
    return false
  } finally {
    if (generation === lookupGeneration) saving.value = false
  }
}
watch(() => [agencyId, extensionKey], () => { saving.value = false; void refresh() }, { immediate: true })
</script>

<template>
  <div class="space-y-6" data-field-scope="extension.gcs-outcome-cost-allocation.agency-coding-config">
    <h2 class="text-base font-semibold">{{ t(section === 'credit-memos' ? 'creditMemo' : 'receivable') }}</h2>
    <p>{{ t(kind === 'creditMemoRules' ? 'creditMemoDescription' : 'description') }}</p>
    <p v-if="loading" role="status">{{ t('loading') }}</p>
    <ExtensionAlert v-if="!agencyId" :description="t('noContext')" />
    <div v-if="lookupError" role="alert">
      <p>{{ t('lookupError') }}</p>
      <ExtensionButton :label="t('retry')" @click="refresh" />
    </div>
    <ExtensionAlert v-if="!result.success" color="error" :description="t('invalid')" />
    <ExtensionResourceLayout
      v-model:search="search" v-model:pagination="pagination"
      :data="visibleRows" :columns="columns" :total-records="filteredRows.length" :loading="loading"
      :show-button="!readOnly" :button-disabled="locked" :button-label="t(kind === 'receivableSets' ? 'addSet' : 'addRule')" :search-placeholder="t('search')" @add="openEditor()">
      <template #source-cell="{ row }"><span class="font-medium">{{ row.original.source }}</span></template>
      <template #period-cell="{ row }"><span class="font-medium whitespace-nowrap">{{ row.original.label }}</span></template>
      <template #fiscalYear-cell="{ row }"><ul class="space-y-1"><li v-for="line in row.original.coding" :key="line.codingLineId">{{ line.fiscalYear }}</li></ul></template>
      <template #percentage-cell="{ row }"><ul class="space-y-1"><li v-for="line in row.original.coding" :key="line.codingLineId">{{ formatPercentage(line.percentage) }}</li></ul></template>
      <template #coding-cell="{ row }">
        <ul class="space-y-1">
          <li v-for="line in row.original.coding" :key="line.codingLineId" class="whitespace-normal">{{ line.label }}</li>
        </ul>
      </template>
      <template #actions-cell="{ row }">
        <div v-if="!readOnly" class="flex justify-end gap-1">
          <ExtensionButton icon="i-lucide-pencil" color="neutral" variant="ghost" :aria-label="`${t('edit')}: ${row.original.label}`" :disabled="locked" @click="openEditor(row.original.index)" />
          <ExtensionButton icon="i-lucide-trash-2" color="error" variant="ghost" :aria-label="`${t('delete')}: ${row.original.label}`" :disabled="locked" @click="saveError = ''; removing = row.original.key" />
        </div>
      </template>
      <template #empty><p class="py-8 text-center text-muted">{{ t(search ? 'noMatch' : kind === 'creditMemoRules' ? 'emptyExceptions' : 'empty') }}</p></template>
    </ExtensionResourceLayout>
    <ExtensionModal :open="Boolean(editor)" :title="t(editor?.isNew ? (kind === 'receivableSets' ? 'addSet' : 'addRule') : 'edit')" :dismissible="!saving" @update:open="!$event && !saving && closeEditor()">
      <template #body>
        <form v-if="editor && set" class="space-y-4" novalidate @submit.prevent="applyEditor">
          <ExtensionFormField v-if="'fiscalYearId' in set" :label="t('fiscalYear')" :name="`${kind}.${editor.index}.fiscalYearId`" :error="fieldError(`${kind}.${editor.index}.fiscalYearId`)" required data-ui-target="extension.gcs-outcome-cost-allocation.agency-coding-config.fiscal-year">
            <ExtensionSelectMenu v-model="set.fiscalYearId" class="w-full min-w-0" :items="years" value-key="value" :disabled="locked" aria-required="true" />
          </ExtensionFormField>
          <ExtensionFormField :label="t('currency')" :name="`${kind}.${editor.index}.currency`" :error="fieldError(`${kind}.${editor.index}.currency`)" required data-ui-target="extension.gcs-outcome-cost-allocation.agency-coding-config.currency">
            <ExtensionSelectMenu v-model="set.currency" class="w-full min-w-0" :items="currencies" value-key="value" :disabled="locked" aria-required="true" />
          </ExtensionFormField>
          <template v-if="'commitmentCodingLineId' in set">
            <ExtensionFormField :label="t('sourceAccount')" :name="`${kind}.${editor.index}.commitmentCodingLineId`" :error="fieldError(`${kind}.${editor.index}.commitmentCodingLineId`)" required data-ui-target="extension.gcs-outcome-cost-allocation.agency-coding-config.source-account">
              <ExtensionSelectMenu v-model="set.commitmentCodingLineId" class="w-full min-w-0" :items="options('commitment', set.currency)" value-key="value" :disabled="locked" aria-required="true" />
            </ExtensionFormField>
            <ExtensionFormField :label="t('startDate')" :name="`${kind}.${editor.index}.startDate`" :error="fieldError(`${kind}.${editor.index}.startDate`)" required data-ui-target="extension.gcs-outcome-cost-allocation.agency-coding-config.start-date">
              <ExtensionInput v-model="set.startDate" type="date" :disabled="locked" required />
            </ExtensionFormField>
            <ExtensionFormField :label="t('endDate')" :name="`${kind}.${editor.index}.endDate`" :error="fieldError(`${kind}.${editor.index}.endDate`)" required data-ui-target="extension.gcs-outcome-cost-allocation.agency-coding-config.end-date">
              <ExtensionInput v-model="set.endDate" type="date" :disabled="locked" required />
            </ExtensionFormField>
          </template>
          <ExtensionFormField v-if="'commitmentCodingLineId' in set" :label="t('targetAccounts')" :name="`${kind}.${editor.index}.lines`" :error="fieldError(`${kind}.${editor.index}.lines`)" required data-ui-target="extension.gcs-outcome-cost-allocation.agency-coding-config.target-accounts">
            <ExtensionSelectMenu v-model="selectedCreditMemoAccounts" class="w-full min-w-0" :items="options('credit_memo', set.currency)" multiple value-key="value" :disabled="locked" aria-required="true" />
          </ExtensionFormField>
          <div v-for="(line, lineIndex) in set.lines" :key="line.codingLineId || lineIndex" :class="'commitmentCodingLineId' in set ? 'space-y-3' : 'grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]'">
            <ExtensionFormField v-if="'fiscalYearId' in set" class="min-w-0" :label="t('account')" :name="`${kind}.${editor.index}.lines.${lineIndex}.codingLineId`" :error="fieldError(`${kind}.${editor.index}.lines.${lineIndex}.codingLineId`)" required data-ui-target="extension.gcs-outcome-cost-allocation.agency-coding-config.account">
              <ExtensionSelectMenu v-model="line.codingLineId" class="w-full min-w-0" :items="options('account_receivable', set.currency, set.fiscalYearId)" value-key="value" :disabled="locked" aria-required="true" />
            </ExtensionFormField>
            <ExtensionFormField :label="'commitmentCodingLineId' in set ? `${t('percentage')} — ${targetLabel(line.codingLineId)}` : t('percentage')" :name="`${kind}.${editor.index}.lines.${lineIndex}.percentage`" :error="fieldError(`${kind}.${editor.index}.lines.${lineIndex}.percentage`)" required data-ui-target="extension.gcs-outcome-cost-allocation.agency-coding-config.percentage">
              <ExtensionInput v-model="line.percentage" inputmode="decimal" :disabled="locked" required />
            </ExtensionFormField>
          </div>
          <p v-if="attempted && !editorResult.success" role="alert" class="text-sm text-error">{{ editorError }}</p>
          <p v-if="saveError" role="alert" class="text-sm text-error">{{ saveError }}</p>
          <div class="flex justify-end gap-2">
            <ExtensionButton type="button" color="neutral" variant="ghost" :label="t('cancel')" :disabled="saving" @click="closeEditor" />
            <ExtensionSaveButton type="submit" :label="t(editor.isNew ? 'add' : 'update')" :loading="saving" :disabled="locked" />
          </div>
        </form>
      </template>
    </ExtensionModal>
    <ExtensionModal :open="Boolean(removing)" :title="t('deleteTitle')" :dismissible="!saving" @update:open="!$event && !saving && (removing = null)">
      <template #body><p>{{ t('deleteDescription') }}</p><p v-if="saveError" role="alert" class="text-sm text-error">{{ saveError }}</p></template>
      <template #footer>
        <ExtensionButton color="neutral" variant="ghost" :label="t('cancel')" :disabled="saving" @click="removing = null" />
        <ExtensionButton color="error" :label="t('delete')" :disabled="locked" :loading="saving" @click="remove" />
      </template>
    </ExtensionModal>
    <p v-if="saveError && !editor && !removing" role="alert">{{ saveError }}</p>
    <p v-if="saved" role="status">{{ t('saved') }}</p>
  </div>
</template>

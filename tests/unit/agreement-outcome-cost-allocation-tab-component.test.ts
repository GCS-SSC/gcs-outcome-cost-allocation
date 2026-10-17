// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import {
  computed,
  defineComponent,
  h,
  ref,
  Suspense,
  watch
} from 'vue'
import type { GcsExtensionJsonConfig } from '@gcs-ssc/extensions'
import { installExtensionTestUiRuntime } from '@gcs-ssc/extensions/testing'
import OutcomeAllocationDetail from '../../components/OutcomeAllocationDetail.vue'

const ArraySelectMenu = defineComponent({
  name: 'ArraySelectMenu',
  inheritAttrs: false,
  props: {
    modelValue: {
      type: Array,
      default: () => []
    }
  },
  emits: ['update:modelValue'],
  setup: props => () => h('div', {
    'data-control': 'generation-years',
    'data-model-value': JSON.stringify(props.modelValue)
  })
})

const InteractiveSelect = defineComponent({
  name: 'InteractiveSelect',
  inheritAttrs: false,
  emits: ['update:modelValue'],
  setup: (_, { attrs, emit }) => () => {
    const items = Array.isArray(attrs.items) ? attrs.items : []
    const values = items.map(item => (
      item !== null
      && typeof item === 'object'
      && 'value' in item
        ? String(item.value)
        : String(item)
    ))
    const control = values.includes('percentage')
      ? 'allocation-method'
      : 'single-select'

    return h('select', {
      'data-control': control,
      'disabled': attrs.disabled === true,
      'value': String(attrs.modelValue ?? ''),
      'onChange': (event: Event) => {
        emit('update:modelValue', (event.target as HTMLSelectElement).value)
      }
    }, items.map(item => {
      const option = item as { label?: unknown, value?: unknown }
      return h('option', {
        value: String(option.value ?? '')
      }, String(option.label ?? ''))
    }))
  }
})

const AllocationTable = defineComponent({
  name: 'AllocationTable',
  inheritAttrs: false,
  setup: (_, { attrs, slots }) => () => h('div', {
    'data-control': 'allocation-table'
  }, (Array.isArray(attrs.data) ? attrs.data : []).map((original, index) =>
    h('div', {
      'data-row-index': String(index)
    }, [
      h('div', { 'data-cell': 'commitment' }, slots['commitmentLine-cell']?.({ row: { original } })),
      slots['allocationActions-cell']?.({
        row: {
          original
        }
      }),
      h('div', { 'data-cell': 'amount' }, slots['amount-cell']?.({
        row: {
          original
        }
      })),
      h('div', { 'data-cell': 'unallocated' }, slots['unallocated-cell']?.({
        row: {
          original
        }
      }))
    ])
  ))
})

const ReactiveModal = defineComponent({
  name: 'ReactiveModal',
  inheritAttrs: false,
  emits: ['update:open'],
  setup: (_, { attrs, slots, emit }) => () => attrs.open === false
    ? null
    : h('div', { 'data-control': attrs.title === 'Edit allocation' || attrs.title === 'Modifier la répartition' ? 'allocation-modal' : 'generate-modal' }, [
        h('button', { 'data-control': 'dismiss-modal', onClick: () => emit('update:open', false) }, 'Dismiss'),
        slots.body?.(),
        slots.footer?.()
      ])
})

const WorkflowSection = defineComponent({
  name: 'WorkflowSection',
  inheritAttrs: false,
  props: {
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    canEdit: { type: Boolean, default: true },
    refreshKey: { type: Number, default: 0 }
  },
  emits: ['changed'],
  setup: props => () => h('div', {
    'data-control': 'workflow-section',
    'data-entity-type': props.entityType,
    'data-entity-id': props.entityId,
    'data-can-edit': String(props.canEdit),
    'data-refresh-key': String(props.refreshKey)
  })
})

const DetailPage = defineComponent({ setup: (_, { slots }) => () => h('div', slots.body?.()) })
const DetailWorkspace = defineComponent({
  props: ['items', 'modelValue', 'sectionDescription', 'priorityValues'],
  emits: ['update:modelValue'],
  setup: (props, { slots, emit }) => () => h('div', [
    h('nav', (props.items ?? []).map((item: { value: string; label: string }) => h('button', {
      'data-view': item.value,
      onClick: () => emit('update:modelValue', item.value)
    }, item.label))),
    h('h2', props.items?.find((item: { value: string }) => item.value === props.modelValue)?.label),
    props.sectionDescription ? h('p', props.sectionDescription) : null,
    slots.actions?.(), slots.notices?.(), slots.default?.()
  ])
})
const CompletionPanel = defineComponent({
  props: ['entityType', 'entityId', 'canComplete', 'canWorkWorkflow', 'labels', 'refreshKey'],
  emits: ['changed'],
  setup: props => () => h('div', {
    'data-control': 'approval-submission-workflow',
    'data-entity-id': props.entityId,
    'data-can-work': String(props.canWorkWorkflow)
  }, props.labels?.description)
})

const jsonResponse = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: {
    'content-type': 'application/json'
  }
})

const allocationResponse = {
  currency: 'cad',
  outcomes: [{
    id: 'outcome-1',
    label_en: 'Outcome 1',
    label_fr: 'Résultat 1'
  }],
  budgetYears: [
    {
      id: 1,
      stream_budget_id: 'stream-budget-1',
      fiscal_year_display: '2026-2027',
      program_funding: '100.00'
    },
    {
      id: 2,
      stream_budget_id: 'stream-budget-2',
      fiscal_year_display: '2027-2028',
      program_funding: '100.00'
    }
  ],
  versions: [{
    id: 'version-1',
    agreementId: 'agreement-1',
    versionNumber: 1,
    status: 'draft',
    createdAt: '2026-07-24T00:00:00.000Z',
    completedAt: null
  }],
  allocations: [],
  streamCommitments: [
    {
      id: 'stream-commitment-1',
      stream_budget_id: 'stream-budget-1',
      fiscal_year_display: '2026-2027',
      gl: 501,
      gl_description: 'First commitment'
    },
    {
      id: 'stream-commitment-2',
      stream_budget_id: 'stream-budget-2',
      fiscal_year_display: '2027-2028',
      gl: 502,
      gl_description: 'Second commitment'
    }
  ]
}

const config: GcsExtensionJsonConfig = {
  enabledCommitmentTypes: ['1'],
  mappings: [
    {
      commitmentType: '1',
      outcomeId: 'outcome-1',
      streamBudgetId: 'stream-budget-1',
      streamCommitmentId: 'stream-commitment-1'
    },
    {
      commitmentType: '1',
      outcomeId: 'outcome-1',
      streamBudgetId: 'stream-budget-2',
      streamCommitmentId: 'stream-commitment-2'
    }
  ]
}

const findButton = (
  wrapper: ReturnType<typeof mount>,
  label: string,
  position: 'first' | 'last' = 'first'
) => {
  const buttons = wrapper.findAll('button').filter(button => button.attributes('aria-label')?.split(':')[0] === label || button.text() === label)
  const button = position === 'last'
    ? buttons.at(-1)
    : buttons[0]
  if (!button) {
    throw new Error(`Expected ${label} button.`)
  }

  return button
}

const mountTab = async (
  fetchMock: typeof fetch,
  componentConfig: GcsExtensionJsonConfig = config,
  initialLocale = 'en',
  completionItem: unknown | null = null,
  initialView = 'allocation',
  permissions = { canUpdate: true, canDelete: true, canWork: true },
  completionRequest?: () => Promise<Response>,
  localeOverride = ref(initialLocale),
  toasts: Record<string, unknown>[] = []
) => {
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/completions/runtime')) {
      if (completionRequest) return await completionRequest()
      return jsonResponse({ item: completionItem })
    }
    return await fetchMock(input, init)
  }) as typeof fetch)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  const runtime = installExtensionTestUiRuntime()
  runtime.composables.useToast = () => ({ add: notification => { toasts.push(notification) } })
  const i18n = runtime.composables.useI18n()
  runtime.composables.useI18n = () => ({
    ...i18n,
    locale: localeOverride
  })
  runtime.components.USelectMenu = ArraySelectMenu
  runtime.components.USelect = InteractiveSelect
  runtime.components.UTable = AllocationTable
  runtime.components.UModal = ReactiveModal
  runtime.components.CommonWorkflowSection = WorkflowSection
  runtime.components.CommonCompletionPanel = CompletionPanel
  runtime.components.CommonDetailPage = DetailPage
  runtime.components.CommonDetailWorkspace = DetailWorkspace
  const selectedTab = ref(initialView)
  runtime.composables.useUrlTabState = options => ({ tabs: computed(() => options.tabs as never), selectedTab, selectedTabKey: selectedTab, defaultTab: ref(initialView) })

  const Host = defineComponent({
    props: { recordId: { type: String, default: 'version-1' } },
    setup: props => () => h(Suspense, null, {
      default: () => h(OutcomeAllocationDetail, {
        recordId: props.recordId,
        ...permissions,
        navigation: { collectionHref: '/en/agreements/agreement-1?section=extension:gcs-outcome-cost-allocation:agreement:outcome-cost-allocation', recordHref: (id: string) => `/en/agreements/agreement-1/extension/gcs-outcome-cost-allocation/outcome-cost-allocation/${id}` },
        extensionKey: 'gcs-outcome-cost-allocation',
        context: {
          target: 'agreement',
          agencyId: 'agency-1',
          streamId: 'stream-1',
          agreementId: 'agreement-1',
          ownerType: 'fundingcaseagreement',
          ownerId: 'agreement-1',
          scope: {
            type: 'agency',
            agencyId: 'agency-1'
          }
        },
        config: componentConfig,
        rbac: {
          subject: 'agreement',
          action: 'update'
        }
      })
    })
  })
  const wrapper = mount(Host)
  await flushPromises()
  return wrapper
}

afterEach(() => {
  vi.unstubAllGlobals()
  installExtensionTestUiRuntime()
})

describe('AgreementOutcomeCostAllocationTab select boundaries', () => {
  it('renders the approval submission workflow after the allocation has been submitted', async () => {
    const wrapper = await mountTab(vi.fn(async () => jsonResponse(allocationResponse)) as typeof fetch, config, 'en', { id: 'completion-1' }, 'completion')
    expect(wrapper.find('[data-control="approval-submission-workflow"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('waits for the Completion read before allowing a draft matrix edit', async () => {
    let releaseCompletion = (_response: Response) => {}
    const pendingCompletion = new Promise<Response>(resolve => { releaseCompletion = resolve })
    const wrapper = await mountTab(vi.fn(async () => jsonResponse(allocationResponse)) as typeof fetch, config, 'en', null, 'allocation', undefined, () => pendingCompletion)
    expect(findButton(wrapper, 'Generate rows').attributes()).toHaveProperty('disabled')
    expect(findButton(wrapper, 'Save').attributes()).toHaveProperty('disabled')
    expect(wrapper.text()).not.toContain('Only draft allocations can be edited.')
    releaseCompletion(jsonResponse({ item: null }))
    await flushPromises()
    expect(findButton(wrapper, 'Generate rows').attributes('disabled')).toBeUndefined()
    await findButton(wrapper, 'Generate rows').trigger('click')
    expect(wrapper.find('[data-control="generate-modal"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows a recoverable Completion read failure and retries before enabling edits', async () => {
    const completionRequest = vi.fn()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValue(jsonResponse({ item: null }))
    const wrapper = await mountTab(vi.fn(async () => jsonResponse(allocationResponse)) as typeof fetch, config, 'en', null, 'allocation', undefined, completionRequest)
    expect(wrapper.get('[role="alert"]').text()).toContain('Completion status could not be loaded.')
    await findButton(wrapper, 'Generate rows').trigger('click')
    expect(wrapper.find('[data-control="generate-modal"]').exists()).toBe(false)
    await findButton(wrapper, 'Retry').trigger('click')
    await flushPromises()
    expect(completionRequest).toHaveBeenCalledTimes(2)
    await findButton(wrapper, 'Generate rows').trigger('click')
    expect(wrapper.find('[data-control="generate-modal"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('rejects an older Completion response after the detail record changes', async () => {
    let releaseOldCompletion = (_response: Response) => {}
    const pendingOldCompletion = new Promise<Response>(resolve => { releaseOldCompletion = resolve })
    const completionRequest = vi.fn()
      .mockImplementationOnce(() => pendingOldCompletion)
      .mockResolvedValue(jsonResponse({ item: null }))
    const response = { ...allocationResponse, versions: [
      { ...allocationResponse.versions[0], status: 'inactive' },
      { ...allocationResponse.versions[0], id: 'version-2', versionNumber: 2 }
    ] }
    const wrapper = await mountTab(vi.fn(async () => jsonResponse(response)) as typeof fetch, config, 'en', null, 'allocation', undefined, completionRequest)
    await wrapper.setProps({ recordId: 'version-2' })
    await flushPromises()
    releaseOldCompletion(jsonResponse({ item: { id: 'old-completion' } }))
    await flushPromises()
    expect(findButton(wrapper, 'Generate rows').attributes('disabled')).toBeUndefined()
    await findButton(wrapper, 'Generate rows').trigger('click')
    expect(wrapper.find('[data-control="generate-modal"]').exists()).toBe(true)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it.each([
    ['en', 'Workflows', 'Start and complete a standard workflow for this cost allocation.'],
    ['fr', 'Processus', 'Démarrez et terminez un processus standard pour cette répartition des coûts.']
  ])('mounts the standard host Workflow section for the selected qualified target in %s', async (
    locale,
    heading,
    description
  ) => {
    const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse(allocationResponse))
    const wrapper = await mountTab(fetchMock as typeof fetch, config, locale, null, 'workflows')

    const workflow = wrapper.getComponent(WorkflowSection)
    expect(workflow.props()).toMatchObject({
      entityType: 'gcs-outcome-cost-allocation:allocation-version',
      entityId: 'version-1',
      canEdit: true,
      refreshKey: 0
    })
    expect(wrapper.text()).toContain(heading)
    expect(wrapper.text()).toContain(description)

    workflow.vm.$emit('changed')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalled()

    wrapper.unmount()
  })

  it.each(['en', 'fr'])('renders remaining funding and paid-only coding once in %s', async locale => {
    const response = {
      ...allocationResponse,
      budgetYears: [{ ...allocationResponse.budgetYears[0], fiscal_year_id: '2026', program_funding: '1000.00', paid_amount: '200.00', remaining_funding: '800.00' }],
      codingPaidAmounts: [{ agencyChartOfAccountId: 'retained-code', agencyFiscalYearId: '2026', paidAmount: '200.00' }],
      hasPendingEffects: false
    }
    const wrapper = await mountTab(vi.fn(async () => jsonResponse(response)) as typeof fetch, config, locale, null, 'summary')
    expect(wrapper.getComponent(DetailWorkspace).props('priorityValues')).toEqual(['summary'])
    const tables = wrapper.findAll('table')
    const paidTable = tables.find(table => table.find('caption').text() === (locale === 'fr' ? 'Paiements par ligne comptable' : 'Paid by coding line'))!
    expect(paidTable.findAll('tbody tr')).toHaveLength(1)
    expect(paidTable.text()).toContain('retained-code')
    const balances = tables.find(table => table.find('caption').text() === (locale === 'fr' ? 'Soldes de financement actuels' : 'Current funding balances'))!
    const cells = balances.findAll('tbody td').map(cell => cell.text())
    expect(cells).toHaveLength(3)
    expect(cells[0]).toMatch(/1[\s,]?000/)
    expect(cells[1]).toContain('200')
    expect(cells[2]).toContain('800')
    wrapper.unmount()
  })

  it('normalizes generation years and accepts only supported allocation methods', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return init?.method === 'PUT'
        ? jsonResponse({ ok: true })
        : jsonResponse(allocationResponse)
    })
    const wrapper = await mountTab(fetchMock as typeof fetch)

    await findButton(wrapper, 'Generate rows').trigger('click')
    await flushPromises()

    const yearSelect = wrapper.getComponent(ArraySelectMenu)
    yearSelect.vm.$emit('update:modelValue', [1, 2])
    await wrapper.vm.$nextTick()
    expect(yearSelect.props('modelValue')).toEqual(['1', '2'])

    await findButton(wrapper, 'Generate rows', 'last').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('[data-control="allocation-method"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-cell="value"] input')).toHaveLength(0)
    await findButton(wrapper, 'Edit allocation').trigger('click')
    await flushPromises()

    const modal = wrapper.get('[data-control="allocation-modal"]')
    const methodSelect = wrapper.findAllComponents(InteractiveSelect)
      .find(select => select.attributes('data-control') === 'allocation-method')!
    const valueField = modal.findAll('[required]').find(field => field.attributes('name') === 'allocationValue')!
    expect(valueField.attributes('label')).toBe('Amount')
    expect(modal.findAll('[required]').some(field => field.attributes('name') === 'allocationMethod')).toBe(true)
    expect(valueField.get('input').attributes('data-currency')).toBe('cad')
    await methodSelect.get('select').setValue('percentage')
    expect(valueField.get('input').attributes('data-currency')).toBeUndefined()
    await valueField.get('input').setValue('12.3456')
    methodSelect.vm.$emit('update:modelValue', ['amount'])
    await wrapper.vm.$nextTick()
    await modal.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-control="allocation-modal"]').exists()).toBe(false)

    await findButton(wrapper, 'Save').trigger('click')
    await flushPromises()

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    if (!putCall) {
      throw new Error('Expected allocation save request.')
    }
    const body = JSON.parse(String(putCall[1]?.body)) as {
      allocations: Array<{
        agreementBudgetFiscalYearId: string
        allocationMethod: string
      }>
    }
    expect(body.allocations).toEqual([
      expect.objectContaining({
        agreementBudgetFiscalYearId: '1',
        allocationMethod: 'percentage',
        allocationValue: '12.3456'
      }),
      expect.objectContaining({
        agreementBudgetFiscalYearId: '2',
        allocationMethod: 'amount'
      })
    ])

    wrapper.unmount()
  })

  it.each(['cancel', 'dismiss'])('discards isolated edits on %s and restores the saved value when reopened', async action => {
    const response = { ...allocationResponse, allocations: [{
      allocationVersionId: 'version-1', commitmentType: '1', streamCommitmentId: 'stream-commitment-1',
      agreementBudgetFiscalYearId: '1', outcomeId: 'outcome-1', allocationMethod: 'amount', allocationValue: '25.0000'
    }] }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(response))
    const wrapper = await mountTab(fetchMock as typeof fetch)
    await findButton(wrapper, 'Edit allocation').trigger('click')
    await flushPromises()
    const modal = wrapper.get('[data-control="allocation-modal"]')
    await modal.get('input').setValue('70.25')
    if (action === 'cancel') await findButton(wrapper, 'Cancel').trigger('click')
    else await modal.get('[data-control="dismiss-modal"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-control="allocation-modal"]').exists()).toBe(false)
    expect(wrapper.get('[data-cell="amount"]').text()).toBe('CA$25.00')
    await findButton(wrapper, 'Edit allocation').trigger('click')
    await flushPromises()
    expect((wrapper.get('[data-control="allocation-modal"] input').element as HTMLInputElement).value).toBe('25.0000')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    wrapper.unmount()
  })

  it('keeps invalid or excessive drafts available for correction and applies a valid value only on Update', async () => {
    const response = { ...allocationResponse, allocations: [{
      allocationVersionId: 'version-1', commitmentType: '1', streamCommitmentId: 'stream-commitment-1',
      agreementBudgetFiscalYearId: '1', outcomeId: 'outcome-1', allocationMethod: 'amount', allocationValue: '25.0000'
    }] }
    const locale = ref('en')
    const wrapper = await mountTab(vi.fn(async () => jsonResponse(response)) as typeof fetch, config, 'en', null, 'allocation', undefined, undefined, locale)
    await findButton(wrapper, 'Edit allocation').trigger('click')
    await flushPromises()
    const modal = wrapper.get('[data-control="allocation-modal"]')
    for (const invalidValue of ['', '1e3', '101.0000']) {
      await modal.get('input').setValue(invalidValue)
      await modal.get('form').trigger('submit')
      await flushPromises()
      expect(wrapper.find('[data-control="allocation-modal"]').exists()).toBe(true)
      expect((modal.get('input').element as HTMLInputElement).value).toBe(invalidValue)
      expect(wrapper.get('[data-cell="amount"]').text()).toBe('CA$25.00')
      const englishError = modal.get('[name="allocationValue"]').attributes('error')
      expect(englishError).toBeTruthy()
      locale.value = 'fr'
      await flushPromises()
      expect(modal.get('[name="allocationValue"]').attributes('error')).not.toBe(englishError)
      expect((modal.get('input').element as HTMLInputElement).value).toBe(invalidValue)
      locale.value = 'en'
      await flushPromises()
    }
    await modal.get('input').setValue('75.1250')
    await modal.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-control="allocation-modal"]').exists()).toBe(false)
    expect(wrapper.get('[data-cell="amount"]').text()).toBe('CA$75.13')
    wrapper.unmount()
  })

  it('converts between money and percentage without changing the resolved allocation', async () => {
    const response = { ...allocationResponse, allocations: [{
      allocationVersionId: 'version-1', commitmentType: '1', streamCommitmentId: 'stream-commitment-1',
      agreementBudgetFiscalYearId: '1', outcomeId: 'outcome-1', allocationMethod: 'amount', allocationValue: '25.0000'
    }] }
    const wrapper = await mountTab(vi.fn(async () => jsonResponse(response)) as typeof fetch)
    await findButton(wrapper, 'Edit allocation').trigger('click')
    await flushPromises()
    const modal = wrapper.get('[data-control="allocation-modal"]')
    await modal.get('select').setValue('percentage')
    expect((modal.get('input').element as HTMLInputElement).value).toMatch(/^25(?:\.0+)?$/)
    expect(modal.get('input').attributes('data-currency')).toBeUndefined()
    await modal.get('select').setValue('amount')
    expect((modal.get('input').element as HTMLInputElement).value).toMatch(/^25(?:\.0+)?$/)
    expect(modal.get('input').attributes('data-currency')).toBe('cad')
    await modal.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-cell="amount"]').text()).toBe('CA$25.00')
    wrapper.unmount()
  })

  it('keeps the edit action visible and warns instead of opening while effects are pending', async () => {
    const response = { ...allocationResponse, hasPendingEffects: true, allocations: [{
      allocationVersionId: 'version-1', commitmentType: '1', streamCommitmentId: 'stream-commitment-1',
      agreementBudgetFiscalYearId: '1', outcomeId: 'outcome-1', allocationMethod: 'amount', allocationValue: '25.0000'
    }] }
    const locale = ref('en')
    const toasts: Record<string, unknown>[] = []
    const wrapper = await mountTab(vi.fn(async () => jsonResponse(response)) as typeof fetch, config, 'en', null, 'allocation', undefined, undefined, locale, toasts)
    await findButton(wrapper, 'Edit allocation').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-control="allocation-modal"]').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').text()).toContain('pending payments')
    expect(wrapper.get('[role="alert"]').text()).toContain('pending payments')
    locale.value = 'fr'
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('paiements')
    expect(wrapper.get('[role="alert"]').text()).not.toContain('pending payments')
    const warning = toasts[0]!
    if (typeof warning.title !== 'function' || typeof warning.description !== 'function') throw new Error('Expected reactive toast text')
    await wrapper.setProps({ recordId: 'another-version' })
    await flushPromises()
    wrapper.unmount()
    locale.value = 'en'
    expect(warning.title().children).toBe('Error')
    expect(warning.description().children).toContain('pending payments')
    locale.value = 'fr'
    expect(warning.title().children).toBe('Erreur')
    expect(warning.description().children).toContain('paiements')
  })

  it('keeps draft allocations read-only once Completion exists', async () => {
    const response = { ...allocationResponse, allocations: [{
      allocationVersionId: 'version-1', commitmentType: '1', streamCommitmentId: 'stream-commitment-1',
      agreementBudgetFiscalYearId: '1', outcomeId: 'outcome-1', allocationMethod: 'amount', allocationValue: '25.0000'
    }] }
    const wrapper = await mountTab(vi.fn(async () => jsonResponse(response)) as typeof fetch, config, 'en', { id: 'completion-1' })
    expect(wrapper.findAll('button').some(button => button.attributes('aria-label')?.startsWith('Edit allocation:'))).toBe(true)
    expect(wrapper.findAll('[data-cell="value"] input')).toHaveLength(0)
    expect(wrapper.get('[data-cell="amount"]').text()).toBe('CA$25.00')
    wrapper.unmount()
  })

  it('discards an open modal when switching allocation versions', async () => {
    const response = { ...allocationResponse, versions: [allocationResponse.versions[0], {
      ...allocationResponse.versions[0], id: 'version-2', versionNumber: 2, status: 'inactive'
    }], allocations: [{
      allocationVersionId: 'version-1', commitmentType: '1', streamCommitmentId: 'stream-commitment-1',
      agreementBudgetFiscalYearId: '1', outcomeId: 'outcome-1', allocationMethod: 'amount', allocationValue: '25.0000'
    }] }
    const wrapper = await mountTab(vi.fn(async () => jsonResponse(response)) as typeof fetch)
    await findButton(wrapper, 'Edit allocation').trigger('click')
    await flushPromises()
    await wrapper.get('[data-control="allocation-modal"] input').setValue('70.25')
    await wrapper.setProps({ recordId: 'version-2' })
    await flushPromises()
    expect(wrapper.find('[data-control="allocation-modal"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-cell="value"] input')).toHaveLength(0)
    wrapper.unmount()
  })

  it('renders saved historical allocations after their current mapping is removed', async () => {
    const historicalResponse = {
      ...allocationResponse,
      versions: [{
        ...allocationResponse.versions[0],
        status: 'inactive',
        fundingBasisAmount: 80
      }],
      allocations: [{
        allocationVersionId: 'version-1',
        commitmentType: '1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: '1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 100
      }]
    }
    const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse(historicalResponse))
    const wrapper = await mountTab(fetchMock as typeof fetch, {
      enabledCommitmentTypes: [],
      mappings: []
    })

    const methodSelects = wrapper.findAllComponents(InteractiveSelect)
      .filter(select => select.attributes('data-control') === 'allocation-method')
    expect(methodSelects).toHaveLength(0)
    expect(wrapper.findAll('button').some(button => button.attributes('aria-label')?.startsWith('Edit allocation:'))).toBe(true)
    expect(wrapper.text()).toContain('1 allocations')
    expect(wrapper.text()).not.toContain('Add agreement activities with outcomes')
    await findButton(wrapper, 'Edit allocation').trigger('click')
    expect(wrapper.find('[data-control="allocation-modal"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('removes only a disabled-type historical draft allocation and saves the repaired draft', async () => {
    let savedAllocations: unknown[] = []
    const driftedDraftResponse = {
      ...allocationResponse,
      allocations: [
        {
          allocationVersionId: 'version-1',
          commitmentType: '1',
          streamCommitmentId: 'stream-commitment-2',
          agreementBudgetFiscalYearId: '2',
          outcomeId: 'outcome-1',
          allocationMethod: 'amount',
          allocationValue: 100
        },
        {
          allocationVersionId: 'version-1',
          commitmentType: '2',
          streamCommitmentId: 'stream-commitment-1',
          agreementBudgetFiscalYearId: '1',
          outcomeId: 'outcome-1',
          allocationMethod: 'amount',
          allocationValue: 100
        }
      ]
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { allocations: unknown[] }
        savedAllocations = body.allocations
        return jsonResponse({ ok: true })
      }

      return jsonResponse({
        ...driftedDraftResponse,
        allocations: savedAllocations.length > 0
          ? savedAllocations
          : driftedDraftResponse.allocations
      })
    })
    const wrapper = await mountTab(fetchMock as typeof fetch, {
      enabledCommitmentTypes: ['1'],
      mappings: [{
        commitmentType: '1',
        outcomeId: 'outcome-1',
        streamBudgetId: 'stream-budget-2',
        streamCommitmentId: 'stream-commitment-2'
      }]
    })

    const removeButton = findButton(wrapper, 'Remove allocation')
    await removeButton.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('button').some(button => button.text() === 'Remove allocation')).toBe(false)

    await findButton(wrapper, 'Save').trigger('click')
    await flushPromises()

    expect(savedAllocations).toEqual([
      expect.objectContaining({
        commitmentType: '1',
        agreementBudgetFiscalYearId: '2',
        outcomeId: 'outcome-1'
      })
    ])

    wrapper.unmount()
  })

  it.each([
    {
      label: 'deleted',
      streamCommitments: []
    },
    {
      label: 'reparented',
      streamCommitments: [{
        ...allocationResponse.streamCommitments[0],
        stream_budget_id: 'different-stream-budget'
      }]
    }
  ])('treats a $label mapped stream commitment as removable history and excludes it from generation', async ({
    streamCommitments
  }) => {
    let savedAllocations: unknown[] | null = null
    const staleDraftResponse = {
      ...allocationResponse,
      streamCommitments,
      allocations: [{
        allocationVersionId: 'version-1',
        commitmentType: '1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: '1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 100
      }]
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { allocations: unknown[] }
        savedAllocations = body.allocations
        return jsonResponse({ ok: true })
      }

      return jsonResponse({
        ...staleDraftResponse,
        allocations: savedAllocations ?? staleDraftResponse.allocations
      })
    })
    const wrapper = await mountTab(fetchMock as typeof fetch, {
      enabledCommitmentTypes: ['1'],
      mappings: [{
        commitmentType: '1',
        outcomeId: 'outcome-1',
        streamBudgetId: 'stream-budget-1',
        streamCommitmentId: 'stream-commitment-1'
      }]
    })

    expect(findButton(wrapper, 'Remove allocation')).toBeDefined()
    await findButton(wrapper, 'Generate rows').trigger('click')
    await flushPromises()
    await findButton(wrapper, 'Generate rows', 'last').trigger('click')
    await flushPromises()
    await findButton(wrapper, 'Save').trigger('click')
    await flushPromises()

    expect(savedAllocations).toEqual([])
    wrapper.unmount()
  })

  it.each([
    ['en', '$100.00'],
    ['fr', '100,00 $US']
  ])('uses owning USD currency for allocation inputs and displayed totals in %s', async (language, expected) => {
    const response = { ...allocationResponse, currency: 'usd', allocations: [{
      allocationVersionId: 'version-1', commitmentType: '1', streamCommitmentId: 'stream-commitment-1',
      agreementBudgetFiscalYearId: '1', outcomeId: 'outcome-1', allocationMethod: 'amount', allocationValue: '100.0000'
    }] }
    const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse(response))
    const wrapper = await mountTab(fetchMock as typeof fetch, config, language)
    await findButton(wrapper, language === 'fr' ? 'Modifier la répartition' : 'Edit allocation').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-control="allocation-modal"] input').attributes('data-currency')).toBe('usd')
    const formatter = wrapper.findComponent({ name: 'GcsCommonCurrencyInput' }).vm.$attrs['format-value'] as (value: string, locale: string, currency: string) => string | null
    expect(formatter('100.2350', language, 'usd')).toBe(language === 'fr' ? '100,24 $US' : '$100.24')
    expect(formatter('', language, 'usd')).toBeNull()
    expect(formatter('1e3', language, 'usd')).toBeNull()
    expect(formatter('999999999999999.9949', language, 'usd')).toBe(language === 'fr' ? '999 999 999 999 999,99 $US' : '$999,999,999,999,999.99')
    expect(wrapper.get('[data-cell="amount"]').text()).toBe(expected)
    wrapper.unmount()
  })

  it('renders completed amount and funding snapshots after the current budget changes', async () => {
    const completedResponse = {
      ...allocationResponse,
      budgetYears: [{
        ...allocationResponse.budgetYears[0],
        program_funding: '250.00'
      }],
      versions: [{
        ...allocationResponse.versions[0],
        status: 'inactive',
        fundingBasisAmount: 80
      }],
      allocations: [{
        allocationVersionId: 'version-1',
        commitmentType: '1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: '1',
        outcomeId: 'outcome-1',
        allocationMethod: 'percentage',
        allocationValue: 50,
        resolvedAmount: 40,
        fundingBasisAmount: 80,
        outcomeLabelEn: 'Recorded outcome',
        outcomeLabelFr: 'Résultat enregistré',
        commitmentLabelEn: 'GL 4000 - Recorded commitment',
        commitmentLabelFr: 'GL 4000 - Engagement enregistré',
        fiscalYearDisplay: '2024-2025'
      }]
    }
    const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse(completedResponse))
    const wrapper = await mountTab(fetchMock as typeof fetch)
    const tableRows = wrapper.getComponent(AllocationTable).vm.$attrs.data as Array<{
      rowType: string
      programFunding: number
    }>

    expect(tableRows.find(row => row.rowType === 'association')?.programFunding).toBe(80)
    expect(wrapper.text()).toContain('$40.00')
    expect(wrapper.text()).toContain('$40.00')
    expect(wrapper.text()).not.toContain('$125.00')

    wrapper.unmount()
  })

  it('uses shared residual balancing for a five-cent percentage split and draft totals', async () => {
    const splitResponse = {
      ...allocationResponse,
      outcomes: [
        allocationResponse.outcomes[0],
        {
          id: 'outcome-2',
          label_en: 'Outcome 2',
          label_fr: 'Résultat 2'
        }
      ],
      budgetYears: [{
        ...allocationResponse.budgetYears[0],
        program_funding: '0.05'
      }],
      allocations: [
        {
          allocationVersionId: 'version-1',
          commitmentType: '1',
          streamCommitmentId: 'stream-commitment-1',
          agreementBudgetFiscalYearId: '1',
          outcomeId: 'outcome-1',
          allocationMethod: 'percentage',
          allocationValue: 50
        },
        {
          allocationVersionId: 'version-1',
          commitmentType: '1',
          streamCommitmentId: 'stream-commitment-1',
          agreementBudgetFiscalYearId: '1',
          outcomeId: 'outcome-2',
          allocationMethod: 'percentage',
          allocationValue: 50
        }
      ]
    }
    const splitConfig: GcsExtensionJsonConfig = {
      enabledCommitmentTypes: ['1'],
      mappings: [
        {
          commitmentType: '1',
          outcomeId: 'outcome-1',
          streamBudgetId: 'stream-budget-1',
          streamCommitmentId: 'stream-commitment-1'
        },
        {
          commitmentType: '1',
          outcomeId: 'outcome-2',
          streamBudgetId: 'stream-budget-1',
          streamCommitmentId: 'stream-commitment-1'
        }
      ]
    }
    const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse(splitResponse))
    const wrapper = await mountTab(fetchMock as typeof fetch, splitConfig)
    const associationRows = wrapper.findAll('[data-row-index]').filter(row =>
      row.findAll('button').some(button => button.attributes('aria-label')?.startsWith('Edit allocation:'))
    )

    expect(associationRows).toHaveLength(2)
    expect(associationRows.map(row => row.get('[data-cell="amount"]').text())).toEqual([
      'CA$0.03',
      'CA$0.02'
    ])
    expect(wrapper.findAll('[data-cell="unallocated"]').map(cell => cell.text()))
      .toContain('CA$0.00')
    expect(wrapper.text()).not.toContain('-CA$0.01')

    wrapper.unmount()
  })

  it('shows the agreement residual for commitment types and each fiscal-year residual for year groups', async () => {
    const combinedResponse = {
      ...allocationResponse,
      allocations: [
        {
          allocationVersionId: 'version-1',
          commitmentType: '1',
          streamCommitmentId: 'stream-commitment-1',
          agreementBudgetFiscalYearId: '1',
          outcomeId: 'outcome-1',
          allocationMethod: 'amount',
          allocationValue: 120
        },
        {
          allocationVersionId: 'version-1',
          commitmentType: '2',
          streamCommitmentId: 'stream-commitment-2',
          agreementBudgetFiscalYearId: '2',
          outcomeId: 'outcome-1',
          allocationMethod: 'amount',
          allocationValue: 80
        }
      ]
    }
    const combinedConfig: GcsExtensionJsonConfig = {
      enabledCommitmentTypes: ['1', '2'],
      mappings: [
        {
          commitmentType: '1',
          outcomeId: 'outcome-1',
          streamBudgetId: 'stream-budget-1',
          streamCommitmentId: 'stream-commitment-1'
        },
        {
          commitmentType: '2',
          outcomeId: 'outcome-1',
          streamBudgetId: 'stream-budget-2',
          streamCommitmentId: 'stream-commitment-2'
        }
      ]
    }
    const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse(combinedResponse))
    const wrapper = await mountTab(fetchMock as typeof fetch, combinedConfig)
    const groupResiduals = wrapper.findAll('[data-cell="unallocated"]')
      .map(cell => cell.text())
      .filter(Boolean)

    expect(groupResiduals.length).toBeGreaterThan(1)
    expect(new Set(groupResiduals)).toEqual(new Set(['CA$0.00', '-CA$20.00', 'CA$20.00']))

    wrapper.unmount()
  })

  it.each([
    {
      locale: 'en',
      outcomeLabel: 'Recorded outcome',
      commitmentLabel: 'GL 4000 - Recorded commitment'
    },
    {
      locale: 'fr',
      outcomeLabel: 'Résultat enregistré',
      commitmentLabel: 'GL 4000 - Engagement enregistré'
    }
  ])('renders immutable $locale snapshots for completed versions after current references are renamed or deleted', async ({
    locale,
    outcomeLabel,
    commitmentLabel
  }) => {
    const completedResponse = {
      ...allocationResponse,
      outcomes: [{
        id: 'outcome-1',
        label_en: 'Renamed outcome',
        label_fr: 'Résultat renommé'
      }],
      streamCommitments: [],
      versions: [{
        ...allocationResponse.versions[0],
        status: 'inactive'
      }],
      allocations: [{
        allocationVersionId: 'version-1',
        commitmentType: '1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: '1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 100,
        outcomeLabelEn: 'Recorded outcome',
        outcomeLabelFr: 'Résultat enregistré',
        commitmentLabelEn: 'GL 4000 - Recorded commitment',
        commitmentLabelFr: 'GL 4000 - Engagement enregistré',
        fiscalYearDisplay: '2024-2025'
      }]
    }
    const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse(completedResponse))
    const wrapper = await mountTab(fetchMock as typeof fetch, config, locale)
    const tableRows = wrapper.getComponent(AllocationTable).vm.$attrs.data as Array<{
      rowType: string
      outcomeLabel?: string
      commitmentLineLabel?: string
      yearLabel?: string
    }>
    const associationRow = tableRows.find(row => row.rowType === 'association')

    expect(associationRow).toMatchObject({
      outcomeLabel,
      commitmentLineLabel: commitmentLabel,
      yearLabel: '2024-2025'
    })
    expect(associationRow?.outcomeLabel).not.toBe('Renamed outcome')
    expect(associationRow?.outcomeLabel).not.toBe('Résultat renommé')
    const cell = wrapper.get(`[data-row-index="${tableRows.indexOf(associationRow!)}"] [data-cell="commitment"]`)
    expect(cell.text()).toContain(commitmentLabel)
    expect(cell.text()).toContain(outcomeLabel)
    expect(cell.text()).not.toContain('2024-2025')
    expect((wrapper.getComponent(AllocationTable).vm.$attrs.columns as Array<{ id: string }>).map(column => column.id))
      .toEqual(['commitmentLine', 'amount', 'unallocated', 'allocationActions'])

    wrapper.unmount()
  })

  it('renders read-only matrix data for viewers and warns before unassigned Contributors edit', async () => {
    const response = { ...allocationResponse, allocations: [{
      allocationVersionId: 'version-1', commitmentType: '1', streamCommitmentId: 'stream-commitment-1',
      agreementBudgetFiscalYearId: '1', outcomeId: 'outcome-1', allocationMethod: 'amount', allocationValue: '25.0000'
    }] }
    const fetchMock = vi.fn(async () => jsonResponse(response))
    const viewer = await mountTab(fetchMock as typeof fetch, config, 'en', null, 'allocation', { canUpdate: false, canDelete: false, canWork: false })
    expect(viewer.get('[data-cell="amount"]').text()).toBe('CA$25.00')
    expect(viewer.findAll('button').some(button => ['Save', 'Edit allocation', 'Generate rows'].includes(button.attributes('aria-label')?.split(':')[0] ?? button.text()))).toBe(false)
    viewer.unmount()
    const locale = ref('en')
    const unassigned = await mountTab(fetchMock as typeof fetch, config, 'en', null, 'allocation', { canUpdate: true, canDelete: false, canWork: false }, undefined, locale)
    await findButton(unassigned, 'Edit allocation').trigger('click')
    expect(unassigned.get('[role="alert"]').text()).toContain('must be assigned')
    locale.value = 'fr'
    await flushPromises()
    expect(unassigned.get('[role="alert"]').text()).toContain('affecté')
    locale.value = 'en'
    await flushPromises()
    expect(unassigned.find('[data-control="allocation-modal"]').exists()).toBe(false)
    await findButton(unassigned, 'Save').trigger('click')
    expect(fetchMock.mock.calls).toHaveLength(2)
    unassigned.unmount()
  })

  it('disables draft controls while a save is pending and retains unsaved edits across section changes', async () => {
    let releaseSave = (_response: Response) => {}
    const pendingSave = new Promise<Response>(resolve => { releaseSave = resolve })
    const response = { ...allocationResponse, allocations: [{
      allocationVersionId: 'version-1', commitmentType: '1', streamCommitmentId: 'stream-commitment-1',
      agreementBudgetFiscalYearId: '1', outcomeId: 'outcome-1', allocationMethod: 'amount', allocationValue: '25.0000'
    }] }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'PUT' ? pendingSave : jsonResponse(response))
    const wrapper = await mountTab(fetchMock as typeof fetch)
    await findButton(wrapper, 'Edit allocation').trigger('click')
    await flushPromises()
    await wrapper.get('[data-control="allocation-modal"] input').setValue('70.00')
    await wrapper.get('[data-control="allocation-modal"] form').trigger('submit')
    await wrapper.get('[data-view="completion"]').trigger('click')
    expect(wrapper.text()).toContain('Save your changes in Allocation')
    expect(wrapper.getComponent(CompletionPanel).props('canComplete')).toBe(false)
    await wrapper.get('[data-view="allocation"]').trigger('click')
    expect(wrapper.get('[data-cell="amount"]').text()).toBe('CA$70.00')
    await findButton(wrapper, 'Save').trigger('click')
    expect(findButton(wrapper, 'Edit allocation').attributes()).toHaveProperty('disabled')
    expect(findButton(wrapper, 'Generate rows').attributes()).toHaveProperty('disabled')
    releaseSave(jsonResponse({ ok: true }))
    await flushPromises()
    wrapper.unmount()
  })

  it('refreshes completion state after the approval workflow changes and leaves submitted workflow actions available', async () => {
    const response = { ...allocationResponse, allocations: allocationResponse.budgetYears.map((year, index) => ({
      allocationVersionId: 'version-1', commitmentType: '1', streamCommitmentId: `stream-commitment-${index + 1}`,
      agreementBudgetFiscalYearId: String(year.id), outcomeId: 'outcome-1', allocationMethod: 'amount', allocationValue: '100.0000'
    })) }
    const fetchMock = vi.fn(async () => jsonResponse(response))
    const wrapper = await mountTab(fetchMock as typeof fetch, config, 'en', { id: 'completion-1' }, 'completion')
    const panel = wrapper.getComponent(CompletionPanel)
    expect(panel.props()).toMatchObject({ entityType: 'gcs-outcome-cost-allocation:allocation-version', entityId: 'version-1', canComplete: false, canWorkWorkflow: true })
    panel.vm.$emit('changed')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(panel.props('canWorkWorkflow')).toBe(true)
    wrapper.unmount()
  })
})

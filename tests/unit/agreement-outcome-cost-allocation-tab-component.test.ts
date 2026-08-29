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
import AgreementOutcomeCostAllocationTab from '../../components/AgreementOutcomeCostAllocationTab.vue'

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
      slots['method-cell']?.({
        row: {
          original
        }
      }),
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
  setup: (_, { attrs, slots }) => () => attrs.open === false
    ? null
    : h('div', { 'data-control': 'generate-modal' }, [
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

const jsonResponse = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: {
    'content-type': 'application/json'
  }
})

const allocationResponse = {
  outcomes: [{
    id: 'outcome-1',
    label_en: 'Outcome 1',
    label_fr: 'Resultat 1'
  }],
  budgetYears: [
    {
      id: 1,
      stream_budget_id: 'stream-budget-1',
      fiscal_year_display: '2026-2027',
      program_funding: 100
    },
    {
      id: 2,
      stream_budget_id: 'stream-budget-2',
      fiscal_year_display: '2027-2028',
      program_funding: 100
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
  const buttons = wrapper.findAll('button').filter(button => button.text() === label)
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
  initialLocale = 'en'
) => {
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/completions/runtime')) {
      return jsonResponse({ item: null })
    }
    return await fetchMock(input, init)
  }) as typeof fetch)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  const runtime = installExtensionTestUiRuntime()
  const i18n = runtime.composables.useI18n()
  runtime.composables.useI18n = () => ({
    ...i18n,
    locale: ref(initialLocale)
  })
  runtime.components.USelectMenu = ArraySelectMenu
  runtime.components.USelect = InteractiveSelect
  runtime.components.UTable = AllocationTable
  runtime.components.UModal = ReactiveModal
  runtime.components.CommonWorkflowSection = WorkflowSection

  const Host = defineComponent({
    setup: () => () => h(Suspense, null, {
      default: () => h(AgreementOutcomeCostAllocationTab, {
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
          },
          rbac: {
            subject: 'agreement',
            action: 'update'
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
  it.each([
    ['en', 'Workflows', 'Start and complete a standard workflow for the selected allocation version.'],
    ['fr', 'Flux de travail', 'Demarrez et terminez un flux de travail standard pour la version de repartition selectionnee.']
  ])('mounts the standard host Workflow section for the selected qualified target in %s', async (
    locale,
    heading,
    description
  ) => {
    const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse(allocationResponse))
    const wrapper = await mountTab(fetchMock as typeof fetch, config, locale)

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

    const methodSelects = wrapper.findAllComponents(InteractiveSelect)
      .filter(select => select.attributes('data-control') === 'allocation-method')
    expect(methodSelects).toHaveLength(2)

    await methodSelects[0]?.get('select').setValue('percentage')
    methodSelects[0]?.vm.$emit('update:modelValue', ['amount'])
    await wrapper.vm.$nextTick()

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
        allocationMethod: 'percentage'
      }),
      expect.objectContaining({
        agreementBudgetFiscalYearId: '2',
        allocationMethod: 'amount'
      })
    ])

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
    expect(methodSelects).toHaveLength(1)
    expect(wrapper.text()).toContain('1 allocations')
    expect(wrapper.text()).not.toContain('Add agreement activities with outcomes')
    expect(wrapper.findAll('button').some(button => button.text() === 'Remove allocation')).toBe(false)

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

  it('renders completed amount and funding snapshots after the current budget changes', async () => {
    const completedResponse = {
      ...allocationResponse,
      budgetYears: [{
        ...allocationResponse.budgetYears[0],
        program_funding: 250
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
          label_fr: 'Resultat 2'
        }
      ],
      budgetYears: [{
        ...allocationResponse.budgetYears[0],
        program_funding: 0.05
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
      row.find('[data-control="allocation-method"]').exists()
    )

    expect(associationRows).toHaveLength(2)
    expect(associationRows.map(row => row.get('[data-cell="amount"]').text())).toEqual([
      '$0.03',
      '$0.02'
    ])
    expect(wrapper.findAll('[data-cell="unallocated"]').map(cell => cell.text()))
      .toContain('$0.00')
    expect(wrapper.text()).not.toContain('-$0.01')

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
    expect(new Set(groupResiduals)).toEqual(new Set(['$0.00', '-$20.00', '$20.00']))

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

    wrapper.unmount()
  })

  it('disables draft editing, selection, and deletion while a save is pending', async () => {
    let releaseSave = (_response: Response) => {}
    const pendingSave = new Promise<Response>(resolve => {
      releaseSave = resolve
    })
    const responseWithAllocation = {
      ...allocationResponse,
      allocations: [{
        allocationVersionId: 'version-1',
        commitmentType: '1',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: '1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 100
      }, {
        allocationVersionId: 'version-1',
        commitmentType: '2',
        streamCommitmentId: 'stream-commitment-1',
        agreementBudgetFiscalYearId: '1',
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 0
      }]
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'PUT') {
        return await pendingSave
      }
      return jsonResponse(responseWithAllocation)
    })
    const wrapper = await mountTab(fetchMock as typeof fetch)

    await findButton(wrapper, 'Save').trigger('click')
    await wrapper.vm.$nextTick()

    const methodSelect = wrapper.findAllComponents(InteractiveSelect)
      .find(select => select.attributes('data-control') === 'allocation-method')
    expect(methodSelect?.get('select').attributes()).toHaveProperty('disabled')
    expect(findButton(wrapper, 'Delete').attributes()).toHaveProperty('disabled')
    expect(findButton(wrapper, 'Remove allocation').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('tr[role="button"]').attributes()).toMatchObject({
      'aria-disabled': 'true',
      'tabindex': '-1'
    })

    releaseSave(jsonResponse({ ok: true }))
    await flushPromises()
    wrapper.unmount()
  })

  it('blocks save, complete, and row generation while draft deletion is pending', async () => {
    let releaseDelete = (_response: Response) => {}
    const pendingDelete = new Promise<Response>(resolve => {
      releaseDelete = resolve
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'DELETE') {
        return await pendingDelete
      }
      return jsonResponse(allocationResponse)
    })
    const wrapper = await mountTab(fetchMock as typeof fetch)

    await findButton(wrapper, 'Delete').trigger('click')
    await wrapper.vm.$nextTick()

    const generateButton = findButton(wrapper, 'Generate rows')
    const saveButton = findButton(wrapper, 'Save')
    const completeButton = findButton(wrapper, 'Submit for approval')
    expect(generateButton.attributes()).toHaveProperty('disabled')
    expect(saveButton.attributes()).toHaveProperty('disabled')
    expect(completeButton.attributes()).toHaveProperty('disabled')
    expect(wrapper.getComponent(WorkflowSection).props('canEdit')).toBe(false)

    await generateButton.trigger('click')
    await saveButton.trigger('click')
    await completeButton.trigger('click')
    expect(wrapper.find('[data-control="generate-modal"]').exists()).toBe(false)
    expect(fetchMock.mock.calls.filter(([, init]) =>
      init?.method === 'PUT' || init?.method === 'POST'
    )).toHaveLength(0)

    releaseDelete(jsonResponse({ ok: true }))
    await flushPromises()
    wrapper.unmount()
  })

  it('refreshes the selected Workflow projection after submitting the allocation for approval', async () => {
    const completeReadyResponse = {
      ...allocationResponse,
      allocations: allocationResponse.budgetYears.map((year, index) => ({
        allocationVersionId: 'version-1',
        commitmentType: '1',
        streamCommitmentId: `stream-commitment-${index + 1}`,
        agreementBudgetFiscalYearId: String(year.id),
        outcomeId: 'outcome-1',
        allocationMethod: 'amount',
        allocationValue: 100
      }))
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      jsonResponse(completeReadyResponse))
    const wrapper = await mountTab(fetchMock as typeof fetch)

    await findButton(wrapper, 'Submit for approval').trigger('click')
    await flushPromises()

    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).includes('/api/completions/complete') && init?.method === 'POST'
    )).toBe(true)
    expect(wrapper.getComponent(WorkflowSection).props('refreshKey')).toBe(1)

    wrapper.unmount()
  })
})

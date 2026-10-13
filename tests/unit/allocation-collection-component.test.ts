// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref, Suspense } from 'vue'
import { installExtensionTestUiRuntime } from '@gcs-ssc/extensions/testing'
import AgreementOutcomeCostAllocationTab from '../../components/AgreementOutcomeCostAllocationTab.vue'

const ResourceTable = defineComponent({
  inheritAttrs: false,
  props: ['data', 'columns', 'search', 'pagination', 'totalRecords', 'requestStatus', 'buttonLabel', 'buttonDisabled', 'searchPlaceholder', 'showButton'],
  emits: ['update:search', 'update:pagination', 'add', 'retry'],
  setup: (props, { slots, emit }) => () => h('section', { 'data-testid': 'allocations-collection' }, [
    h('input', { 'aria-label': props.searchPlaceholder, value: props.search, onInput: (event: Event) => emit('update:search', (event.target as HTMLInputElement).value) }),
    props.showButton ? h('button', { disabled: props.buttonDisabled, onClick: () => emit('add') }, props.buttonLabel) : null,
    props.requestStatus === 'error' ? h('button', { onClick: () => emit('retry') }, 'Retry') : null,
    h('table', props.data.length ? props.data.map((original: { id: string }) => h('tr', { 'data-version-id': original.id }, props.columns.map((column: { id: string }) => h('td', slots[`${column.id}-cell`]?.({ row: { original } }))))) : slots.empty?.()),
    h('p', { 'data-testid': 'record-count' }, props.totalRecords),
    h('button', { onClick: () => emit('update:pagination', { ...props.pagination, pageIndex: props.pagination.pageIndex + 1 }) }, 'Next')
  ])
})
const LinkButton = defineComponent({
  inheritAttrs: false,
  setup: (_, { attrs, slots }) => () => h(attrs.to ? 'a' : 'button', { ...attrs, href: attrs.to, type: attrs.to ? undefined : 'button' }, attrs.label ? String(attrs.label) : slots.default?.())
})
const version = { id: '1', agreementId: 'agreement-1', versionNumber: 1, status: 'draft', createdAt: '2026-10-01T00:00:00Z' }
const response = {
  currency: 'cad', outcomes: [], commitmentTypes: [], streamCommitments: [], codingPaidAmounts: [], hasPendingEffects: false,
  budgetYears: [{ id: 'year-1', fiscal_year_id: 'fy-1', fiscal_year_display: '2026-2027', program_funding: '1000.00', paid_amount: '200.00', remaining_funding: '800.00' }],
  versions: [version, { ...version, id: '2', status: 'inactive', versionNumber: 2, fundingBasisAmount: '0.05' }],
  allocations: [
    { allocationVersionId: '1', commitmentType: '1', streamCommitmentId: 'line-1', agreementBudgetFiscalYearId: 'year-1', outcomeId: 'one', allocationMethod: 'percentage', allocationValue: '50' },
    { allocationVersionId: '1', commitmentType: '1', streamCommitmentId: 'line-1', agreementBudgetFiscalYearId: 'year-1', outcomeId: 'two', allocationMethod: 'percentage', allocationValue: '50' },
    { allocationVersionId: '2', commitmentType: '1', streamCommitmentId: 'line-1', agreementBudgetFiscalYearId: 'year-1', outcomeId: 'one', allocationMethod: 'percentage', allocationValue: '50', resolvedAmount: '0.03' },
    { allocationVersionId: '2', commitmentType: '1', streamCommitmentId: 'line-1', agreementBudgetFiscalYearId: 'year-1', outcomeId: 'two', allocationMethod: 'percentage', allocationValue: '50', resolvedAmount: '0.02' }
  ]
}
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const mountCollection = async (fetcher: typeof fetch, permissions = { canUpdate: true, canDelete: true, canWork: true }) => {
  vi.stubGlobal('fetch', fetcher)
  const locale = ref('en')
  const runtime = installExtensionTestUiRuntime()
  runtime.composables.useI18n = () => ({ locale, n: value => String(value) })
  runtime.components.CommonResourceLayoutCard = ResourceTable
  runtime.components.UButton = LinkButton
  const wrapper = mount(defineComponent({
    setup: () => () => h(Suspense, null, { default: () => h(AgreementOutcomeCostAllocationTab, {
      ...permissions,
      extensionKey: 'gcs-outcome-cost-allocation', config: {}, rbac: { subject: 'agreement', action: 'update' },
      context: { target: 'agreement', agreementId: 'agreement-1', agencyId: 'agency-1', ownerType: 'fundingcaseagreement', ownerId: 'agreement-1', scope: { type: 'agency', agencyId: 'agency-1' } },
      navigation: { collectionHref: '/en/agreements/agreement-1', recordHref: (id: string) => `/en/agreements/agreement-1/extension/gcs-outcome-cost-allocation/outcome-cost-allocation/${id}` }
    }) })
  }))
  await flushPromises()
  return { wrapper, locale }
}
const button = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('button').find(item => item.text() === label || item.attributes('aria-label')?.startsWith(`${label}: `))!

afterEach(() => { vi.unstubAllGlobals(); installExtensionTestUiRuntime() })

describe('Agreement cost allocation collection', () => {
  it('lists exact draft and snapshot totals with drill-down links, search and pagination', async () => {
    const { wrapper, locale } = await mountCollection(vi.fn(async () => jsonResponse(response)) as typeof fetch)
    expect(wrapper.findAll('tr')).toHaveLength(2)
    const draft = wrapper.get('[data-version-id="1"]')
    expect(draft.get('a').classes()).toContain('font-bold')
    expect(draft.get('a').classes()).toContain('normal-case')
    expect(draft.get('a').classes()).toContain('cursor-pointer')
    expect(draft.get('a').text()).toBe('Version 1')
    expect(draft.get('p').text()).toContain('2026')
    expect(draft.get('button[aria-label="Delete: Version 1"]').text()).toBe('')
    expect(wrapper.get('[data-version-id="1"]').text()).toContain('CA$800.00')
    expect(wrapper.get('[data-version-id="2"]').text()).toContain('CA$0.05')
    expect(wrapper.findAll('a').map(link => link.attributes('href'))).toContain('/en/agreements/agreement-1/extension/gcs-outcome-cost-allocation/outcome-cost-allocation/1')
    expect(wrapper.find('.outcome-cost-allocation-table').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Current funding balances')
    expect(wrapper.text()).not.toContain('Submit for approval')
    expect(wrapper.getComponent(ResourceTable).props('totalRecords')).toBe(2)
    wrapper.getComponent(ResourceTable).vm.$emit('update:pagination', { pageIndex: 0, pageSize: 1 })
    await flushPromises()
    expect(wrapper.findAll('tr')).toHaveLength(1)
    await button(wrapper, 'Next').trigger('click')
    expect(wrapper.get('tr').attributes('data-version-id')).toBe('2')
    await wrapper.get('input').setValue('draft')
    expect(wrapper.get('tr').attributes('data-version-id')).toBe('1')
    await wrapper.get('input').setValue('missing')
    expect(wrapper.text()).toContain('No cost allocations match your search.')
    locale.value = 'fr'
    await flushPromises()
    expect(wrapper.text()).toContain('Aucune répartition des coûts ne correspond')
    await wrapper.get('input').setValue('ébauche')
    expect(wrapper.get('tr').attributes('data-version-id')).toBe('1')
    wrapper.unmount()
  })

  it('creates a draft in the table and preserves a failed deletion for retry', async () => {
    let created = false
    let failDelete = true
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { created = true; return jsonResponse({ version }) }
      if (init?.method === 'DELETE') {
        if (failDelete) return jsonResponse({ message: 'Please retry deletion.' }, 409)
        created = false
        return jsonResponse({ ok: true })
      }
      return jsonResponse({ ...response, versions: created ? [version] : [], allocations: [] })
    })
    const { wrapper } = await mountCollection(fetcher as typeof fetch)
    expect(wrapper.text()).toContain('No cost allocations have been created.')
    await button(wrapper, 'New draft').trigger('click')
    await flushPromises()
    expect(wrapper.get('tr').attributes('data-version-id')).toBe('1')
    expect(button(wrapper, 'New draft').attributes()).toHaveProperty('disabled')
    await button(wrapper, 'Delete').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Please retry deletion.')
    expect(wrapper.findAll('tr')).toHaveLength(1)
    failDelete = false
    await button(wrapper, 'Delete').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('tr')).toHaveLength(0)
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps New draft visible and warns about pending effects without creating a version', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ...response, versions: [], allocations: [], hasPendingEffects: true }))
    const { wrapper } = await mountCollection(fetcher as typeof fetch)
    expect(button(wrapper, 'New draft').attributes('disabled')).toBeUndefined()
    await button(wrapper, 'New draft').trigger('click')
    expect(wrapper.get('[role="alert"]').text()).toContain('pending payments')
    expect(fetcher).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('returns to the previous page after deleting the final record on a page', async () => {
    const versions = Array.from({ length: 11 }, (_, index) => ({ ...version, id: String(index + 1), versionNumber: index + 1, status: index === 10 ? 'draft' : 'inactive' }))
    let deleted = false
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted = true
        return jsonResponse({ ok: true })
      }
      return jsonResponse({ ...response, versions: deleted ? versions.slice(0, 10) : versions, allocations: [] })
    })
    const { wrapper } = await mountCollection(fetcher as typeof fetch)
    await button(wrapper, 'Next').trigger('click')
    expect(wrapper.findAll('tr')).toHaveLength(1)
    expect(wrapper.get('tr').attributes('data-version-id')).toBe('11')
    await button(wrapper, 'Delete').trigger('click')
    await flushPromises()
    expect(wrapper.getComponent(ResourceTable).props('pagination').pageIndex).toBe(0)
    expect(wrapper.findAll('tr')).toHaveLength(10)
    expect(wrapper.getComponent(ResourceTable).props('totalRecords')).toBe(10)
    wrapper.unmount()
  })

  it('allows Viewer drill-down links while hiding writes and warns on unassigned role-permitted writes', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ...response, versions: [], allocations: [] }))
    const { wrapper: viewer } = await mountCollection(fetcher as typeof fetch, { canUpdate: false, canDelete: false, canWork: false })
    expect(button(viewer, 'New draft')).toBeUndefined()
    expect(button(viewer, 'Delete')).toBeUndefined()
    viewer.unmount()
    const { wrapper: contributor } = await mountCollection(fetcher as typeof fetch, { canUpdate: true, canDelete: true, canWork: false })
    await button(contributor, 'New draft').trigger('click')
    expect(contributor.get('[role="alert"]').text()).toContain('must be assigned')
    expect(fetcher).toHaveBeenCalledTimes(2)
    contributor.unmount()
  })

  it('offers retry for a failed collection request', async () => {
    let fail = true
    const { wrapper } = await mountCollection(vi.fn(async () => {
      if (fail) throw new Error('Unavailable')
      return jsonResponse(response)
    }) as typeof fetch)
    expect(wrapper.getComponent(ResourceTable).props('requestStatus')).toBe('error')
    fail = false
    await button(wrapper, 'Retry').trigger('click')
    await flushPromises()
    expect(wrapper.getComponent(ResourceTable).props('requestStatus')).toBe('success')
    expect(wrapper.findAll('tr')).toHaveLength(2)
    wrapper.unmount()
  })
})

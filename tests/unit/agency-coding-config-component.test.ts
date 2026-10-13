// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createExtensionTestUiRuntime, installExtensionTestUiRuntime } from '@gcs-ssc/extensions/testing'
import AgencyCodingConfig from '../../components/AgencyCodingConfig.vue'

const ResourceTable = defineComponent({
  name: 'ResourceTable', inheritAttrs: false, emits: ['update:search', 'update:pagination', 'add'],
  setup: (_, { attrs, emit, slots }) => () => h('div', { 'data-table': '' }, [
    ...((attrs.showButton ?? attrs['show-button']) === false ? [] : [h('button', { 'data-add': '', disabled: attrs.buttonDisabled ?? attrs['button-disabled'], onClick: () => emit('add') }, String(attrs.buttonLabel ?? attrs['button-label'] ?? 'Add'))]),
    h('input', { 'data-search': '', value: attrs.search ?? '', onInput: (event: Event) => emit('update:search', (event.target as HTMLInputElement).value) }),
    h('button', { 'data-next-page': '', onClick: () => emit('update:pagination', { pageIndex: 1, pageSize: 10 }) }, 'Next page'),
    ...(Array.isArray(attrs.columns) ? attrs.columns : []).map(column => h('div', { 'data-column': (column as { id?: string }).id }, String((column as { header?: string }).header ?? ''))),
    ...(Array.isArray(attrs.data) ? attrs.data : []).map(original => h('div', { 'data-row': '' },
      (Array.isArray(attrs.columns) ? attrs.columns : []).map(column => {
        const id = (column as { id?: string; accessorKey?: string }).id ?? (column as { accessorKey?: string }).accessorKey ?? ''
        return h('div', { 'data-cell': id }, slots[`${id}-cell`]?.({ row: { original } }) ?? String((original as Record<string, unknown>)[id] ?? ''))
      }))),
    ...(Array.isArray(attrs.data) && attrs.data.length ? [] : [slots.empty?.()])
  ])
})
const ReactiveModal = defineComponent({
  name: 'ReactiveModal', inheritAttrs: false, emits: ['update:open'],
  setup: (_, { attrs, emit, slots }) => () => attrs.open === false ? null : h('div', { 'data-modal': '' }, [
    h('button', { 'data-dismiss': '', onClick: () => emit('update:open', false) }, 'Dismiss'),
    slots.body?.(), slots.footer?.(), slots.default?.()
  ])
})
const InteractiveSelectMenu = defineComponent({
  name: 'InteractiveSelectMenu', inheritAttrs: false, emits: ['update:modelValue'],
  setup: (_, { attrs, emit }) => () => {
    const multiple = attrs.multiple === true || attrs.multiple === ''
    const values = Array.isArray(attrs.modelValue) ? attrs.modelValue : [attrs.modelValue]
    return h('select', { multiple, disabled: attrs.disabled === true, ...(multiple ? {} : { value: attrs.modelValue }), onChange: (event: Event) => {
      const control = event.target as HTMLSelectElement
      emit('update:modelValue', multiple ? Array.from(control.selectedOptions).map(option => option.value) : control.value)
    } }, (Array.isArray(attrs.items) ? attrs.items : []).map(item => h('option', { value: item.value, selected: values.includes(item.value) }, String(item.label))))
  }
})
const installUi = () => installExtensionTestUiRuntime({ components: { ...createExtensionTestUiRuntime().components, CommonResourceLayoutCard: ResourceTable, UModal: ReactiveModal, USelectMenu: InteractiveSelectMenu } })
beforeEach(() => { installUi() })

const extensionKey = 'gcs-outcome-cost-allocation'
const account = (kind: string) => ({ id: kind === 'account_receivable' ? '10' : kind === 'commitment' ? '30' : '20', egcs_ay_kind: kind, egcs_ay_currency: 'cad', egcs_ay_fiscalyear: '1', fiscal_year_display: '2026–2027', egcs_ay_commitmentchartofaccount: null, egcs_ay_accountingdimensions: [{ label_en: 'Fund', label_fr: 'Fonds', value: 'A' }] })
const policy = () => ({
  version: 1,
  receivableSets: [{ fiscalYearId: '1', currency: 'cad', lines: [{ codingLineId: '10', percentage: '100' }] }],
  creditMemoRules: [{ commitmentCodingLineId: '30', startDate: '2026-04-01', endDate: '2027-03-31', currency: 'cad', lines: [{ codingLineId: '20', percentage: '100' }] }]
})
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const registry = (config: unknown) => ({ items: [{ extension: { key: extensionKey }, enabled: true, canConfigure: true, config }], total: 1 })
const fixture = (config: unknown = policy()) => vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'PATCH') return json({ enabled: true, config: JSON.parse(String(init.body)).config })
  if (url.startsWith('/api/extensions/agency/')) return json(registry(config))
  if (url.includes('/fiscal-years')) return json({ items: [{ id: '1', egcs_ay_fiscalyeardisplay: '2026–2027' }], total: 1 })
  return json({ items: [account(url.includes('kind=account_receivable') ? 'account_receivable' : url.includes('kind=commitment') ? 'commitment' : 'credit_memo')], total: 1 })
})
const findButton = (wrapper: ReturnType<typeof mount>, label: string) => wrapper.findAll('button').find(button => button.text() === label)!
const editRow = async (wrapper: ReturnType<typeof mount>) => {
  await wrapper.findAll('button').find(button => button.attributes('aria-label')?.startsWith('Edit:') || button.attributes('aria-label')?.startsWith('Modifier:'))!.trigger('click')
}
const modalInputs = (wrapper: ReturnType<typeof mount>) => wrapper.get('[data-modal]').findAll('input')
const applyDraft = async (wrapper: ReturnType<typeof mount>) => { await wrapper.get('[data-modal] form').trigger('submit'); await flushPromises() }
const savedBody = (fetchMock: ReturnType<typeof fixture>) => JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))

afterEach(() => { vi.unstubAllGlobals(); installExtensionTestUiRuntime() })

describe('Agency coding workspace', () => {
  it('closes Add after persisting on an HTTP origin without randomUUID', async () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    const fetchMock = fixture({ version: 1, receivableSets: [], creditMemoRules: [] })
    vi.stubGlobal('fetch', fetchMock)
    const errors: unknown[] = []
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1' }, global: { config: { errorHandler: error => errors.push(error) } } })
    await flushPromises()
    await wrapper.get('[data-add]').trigger('click')
    await wrapper.findAll('select')[0]!.setValue('1')
    await wrapper.findAll('select')[1]!.setValue('cad')
    await wrapper.findAll('select')[2]!.setValue('10')
    await applyDraft(wrapper)
    expect(savedBody(fetchMock).config.receivableSets).toHaveLength(1)
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    expect(wrapper.get('[data-cell="period"]').text()).toBe('2026–2027')
    expect(wrapper.get('[data-cell="coding"]').text()).toBe('Fund: A')
    expect(errors).toEqual([])
  })

  it('hydrates persisted year and account labels on an HTTP origin without randomUUID', async () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    vi.stubGlobal('fetch', fixture())
    const errors: unknown[] = []
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', config: policy() }, global: { config: { errorHandler: error => errors.push(error) } } })
    await flushPromises()
    expect(wrapper.get('[data-cell="period"]').text()).toBe('2026–2027')
    expect(wrapper.get('[data-cell="coding"]').text()).toBe('Fund: A')
    expect(errors).toEqual([])
  })

  it.each([
    ['en', 'receivables', 'Accounts receivable', 'Add yearly set', 'Add remap exception'],
    ['fr', 'receivables', 'Comptes débiteurs', 'Ajouter un ensemble annuel', 'Ajouter une exception de redirection'],
    ['en', 'credit-memos', 'Credit memos', 'Add remap exception', 'Add yearly set'],
    ['fr', 'credit-memos', 'Notes de crédit', 'Ajouter une exception de redirection', 'Ajouter un ensemble annuel']
  ])('renders only the selected %s/%s settings and saves both policies', async (locale, section, heading, visibleAdd, hiddenAdd) => {
    const runtime = installUi()
    const base = runtime.composables.useI18n()
    runtime.composables.useI18n = () => ({ ...base, locale: ref(locale) })
    const currentPolicy = policy()
    const fetchMock = fixture(currentPolicy)
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section } })
    await flushPromises()
    expect(wrapper.findAll('h2,h3,h4').some(title => title.text() === heading)).toBe(true)
    expect(wrapper.get('[data-table] [data-add]').text()).toBe(visibleAdd)
    expect(findButton(wrapper, hiddenAdd)).toBeUndefined()
    await wrapper.get('[data-table] [data-add]').trigger('click')
    expect(findButton(wrapper, locale === 'fr' ? 'Ajouter' : 'Add')).toBeDefined()
    expect(wrapper.get('[data-modal]').findAll('button').filter(button => button.attributes('data-dismiss') === undefined).map(button => button.text()).sort()).toEqual((locale === 'fr' ? ['Ajouter', 'Annuler'] : ['Add', 'Cancel']).sort())
    await wrapper.get('[data-dismiss]').trigger('click')
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    await editRow(wrapper)
    expect(modalInputs(wrapper)).toHaveLength(section === 'credit-memos' ? 3 : 1)
    await modalInputs(wrapper).at(-1)!.setValue('100.0000')
    await applyDraft(wrapper)
    const body = savedBody(fetchMock)
    expect(body).toMatchObject({ extensionKey, enabled: true })
    const selected = section === 'receivables' ? 'receivableSets' : 'creditMemoRules'
    const hidden = section === 'receivables' ? 'creditMemoRules' : 'receivableSets'
    expect(body.config[selected][0].lines[0].percentage).toBe('100.0000')
    expect(body.config[hidden]).toEqual(currentPolicy[hidden])
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    expect(findButton(wrapper, 'Save')).toBeUndefined()
  })

  it('authors a yearly set through the shared fields and rejects incomplete or unbalanced settings', async () => {
    const fetchMock = fixture({})
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1' } })
    await flushPromises()
    await findButton(wrapper, 'Add yearly set').trigger('click')
    expect(findButton(wrapper, 'Add')).toBeDefined()
    expect(findButton(wrapper, 'Update')).toBeUndefined()
    expect(wrapper.findAll('select')).toHaveLength(3)
    expect(modalInputs(wrapper)[0]!.element.value).toBe('100')
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(true)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
    const selects = wrapper.findAll('select')
    await selects[0]!.setValue('1')
    await selects[1]!.setValue('cad')
    await selects[2]!.setValue('10')
    await modalInputs(wrapper)[0]!.setValue('99')
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(true)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
    await modalInputs(wrapper)[0]!.setValue('100')
    await applyDraft(wrapper)
    expect(savedBody(fetchMock).config).toEqual({ version: 1, receivableSets: policy().receivableSets, creditMemoRules: [] })
  })

  it('reads the latest saved configuration on each workspace mount instead of stale page props', async () => {
    let latest = policy()
    const fetchMock = fixture()
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') { latest = JSON.parse(String(init.body)).config; return json({ config: latest }) }
      if (url.startsWith('/api/extensions/agency/')) return json(registry(latest))
      return json({ items: [account(url.includes('kind=account_receivable') ? 'account_receivable' : url.includes('kind=commitment') ? 'commitment' : 'credit_memo')], total: 1 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const staleConfig = policy()
    const first = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'credit-memos', config: staleConfig } })
    await flushPromises()
    await editRow(first)
    await modalInputs(first)[1]!.setValue('2027-03-30')
    await applyDraft(first)
    first.unmount()
    const second = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'receivables', config: staleConfig } })
    await flushPromises()
    await editRow(second)
    await applyDraft(second)
    const lastSave = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH').at(-1)!
    expect(JSON.parse(String(lastSave[1]!.body)).config.creditMemoRules[0].endDate).toBe('2027-03-30')
  })

  it('retains edits after a failed save and permits retry', async () => {
    const fetchMock = fixture()
    let attempts = 0
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === 'PATCH' && attempts++ === 0) return json({ message: 'Coding is locked by pending effects.' }, 409)
      return await original(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'credit-memos' } })
    await flushPromises()
    await editRow(wrapper)
    await modalInputs(wrapper)[1]!.setValue('2027-03-30')
    await applyDraft(wrapper)
    expect(wrapper.get('[role="alert"]').text()).toContain('Coding is locked by pending effects.')
    expect(modalInputs(wrapper)[1]!.element.value).toBe('2027-03-30')
    await applyDraft(wrapper)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(2)
  })

  it('offers Retry after a failed configuration load without saving an empty replacement', async () => {
    const fetchMock = fixture()
    const original = fetchMock.getMockImplementation()!
    let attempts = 0
    fetchMock.mockImplementation(async (url, init) => {
      if (url.startsWith('/api/extensions/agency/') && init?.method !== 'PATCH' && attempts++ === 0) throw new Error('network')
      return await original(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1' } })
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    await wrapper.get('[data-add]').trigger('click')
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
    await findButton(wrapper, 'Retry').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-row]')).toHaveLength(1)
  })

  it('keeps read-only configuration visible and never exposes a Save action', async () => {
    const fetchMock = fixture()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', readOnly: true } })
    await flushPromises()
    expect(wrapper.findAll('[data-row]')).toHaveLength(1)
    expect(findButton(wrapper, 'Save')).toBeUndefined()
    expect(wrapper.findAll('button').some(button => /^Edit:|^Delete:/.test(button.attributes('aria-label') ?? ''))).toBe(false)
    expect(findButton(wrapper, 'Add yearly set')).toBeUndefined()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })

  it('rejects late load and save responses after switching the Agency', async () => {
    let releaseLoad!: (response: Response) => void
    let releaseSave!: (response: Response) => void
    const firstLoad = new Promise<Response>(resolve => { releaseLoad = resolve })
    const pendingSave = new Promise<Response>(resolve => { releaseSave = resolve })
    const fetchMock = fixture()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/api/extensions/agency/1' && init?.method !== 'PATCH') return await firstLoad
      if (init?.method === 'PATCH') return await pendingSave
      return await original(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1' } })
    await flushPromises()
    await wrapper.setProps({ agencyId: '2' })
    await flushPromises()
    releaseLoad(json(registry({})))
    await flushPromises()
    expect(wrapper.findAll('[data-row]')).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/agency/1/'))).toBe(false)
    await editRow(wrapper)
    await applyDraft(wrapper)
    await wrapper.setProps({ agencyId: '3' })
    await flushPromises()
    releaseSave(json({ enabled: true }))
    await flushPromises()
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    await editRow(wrapper)
    expect(modalInputs(wrapper)[0]!.element.value).toBe('100')
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[0]).toBe('/api/extensions/agency/2')
  })

  it('loads every account page and renders linked and unlinked credit memo options', async () => {
    const fetchMock = fixture()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      if (url.includes('kind=account_receivable')) {
        const firstPage = url.includes('page=1&')
        return json({ items: firstPage ? Array.from({ length: 100 }, (_, index) => ({ ...account('account_receivable'), id: String(index + 100) })) : [account('account_receivable')], total: 101 })
      }
      if (url.includes('kind=credit_memo')) return json({ items: [account('credit_memo'), { ...account('credit_memo'), id: '21', egcs_ay_commitmentchartofaccount: '30' }], total: 2 })
      return await original(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'credit-memos' } })
    await flushPromises()
    expect(fetchMock.mock.calls.some(([url]) => url.includes('kind=account_receivable&page=2&limit=100'))).toBe(true)
    await editRow(wrapper)
    const options = wrapper.findAll('select').at(-1)!.findAll('option').map(option => option.text())
    expect(options.some(label => label.includes('Clears debt without restoring funding'))).toBe(true)
    expect(options.some(label => label.includes('Restores commitment coding'))).toBe(true)
  })

  it('requires Agency context and retries account lookup failures without losing persisted rules', async () => {
    const fetchMock = fixture()
    const original = fetchMock.getMockImplementation()!
    let failed = false
    fetchMock.mockImplementation(async (url, init) => {
      if (url.includes('chart-of-accounts') && !failed) { failed = true; throw new Error('network') }
      return await original(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig)
    await flushPromises()
    expect(wrapper.get('[description]').attributes('description')).toBe('Agency context is unavailable.')
    expect(fetchMock).not.toHaveBeenCalled()
    await wrapper.get('[data-add]').trigger('click')
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    await wrapper.setProps({ agencyId: '1' })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Unable to load')
    await findButton(wrapper, 'Retry').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    await editRow(wrapper)
    await applyDraft(wrapper)
    expect(savedBody(fetchMock).config).toEqual(policy())
  })


  it.each(['receivables', 'credit-memos'])('discards canceled or dismissed %s edits and additions without changing the saved collection', async section => {
    const fetchMock = fixture()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section } })
    await flushPromises()
    await editRow(wrapper)
    await modalInputs(wrapper).at(-1)!.setValue('25')
    await findButton(wrapper, 'Cancel').trigger('click')
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    await editRow(wrapper)
    expect(modalInputs(wrapper).at(-1)!.element.value).toBe('100')
    await modalInputs(wrapper).at(-1)!.setValue('50')
    await wrapper.get('[data-dismiss]').trigger('click')
    await findButton(wrapper, section === 'receivables' ? 'Add yearly set' : 'Add remap exception').trigger('click')
    await wrapper.get('[data-dismiss]').trigger('click')
    expect(wrapper.findAll('[data-row]')).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })

  it('prevents applying duplicate year/currency sets and duplicate accounts in existing multi-line settings', async () => {
    const currentPolicy = policy()
    currentPolicy.receivableSets[0]!.lines = [{ codingLineId: '10', percentage: '50' }, { codingLineId: '11', percentage: '50' }]
    const fetchMock = fixture(currentPolicy)
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      if (url.includes('kind=account_receivable')) return json({ items: [account('account_receivable'), { ...account('account_receivable'), id: '11' }], total: 2 })
      return await original(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1' } })
    await flushPromises()
    await findButton(wrapper, 'Add yearly set').trigger('click')
    const selects = wrapper.findAll('select')
    await selects[0]!.setValue('1')
    await selects[1]!.setValue('cad')
    await selects[2]!.setValue('10')
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(true)
    expect(wrapper.findAll('[data-row]')).toHaveLength(1)
    await findButton(wrapper, 'Cancel').trigger('click')
    await editRow(wrapper)
    expect(findButton(wrapper, 'Add coding line')).toBeUndefined()
    expect(findButton(wrapper, 'Remove')).toBeUndefined()
    expect(modalInputs(wrapper)).toHaveLength(2)
    await wrapper.findAll('select').at(-1)!.setValue('10')
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(true)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
    await wrapper.findAll('select').at(-1)!.setValue('11')
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    expect(savedBody(fetchMock).config).toEqual(currentPolicy)
  })

  it('prevents applying overlapping inclusive credit memo date ranges', async () => {
    const fetchMock = fixture()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'credit-memos' } })
    await flushPromises()
    await findButton(wrapper, 'Add remap exception').trigger('click')
    await modalInputs(wrapper)[0]!.setValue('2027-03-31')
    await modalInputs(wrapper)[1]!.setValue('2027-04-30')
    await wrapper.findAll('select')[0]!.setValue('cad')
    await wrapper.findAll('select')[1]!.setValue('30')
    await wrapper.findAll('select')[2]!.setValue(['20'])
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(true)
    await modalInputs(wrapper)[0]!.setValue('2027-04-01')
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    expect(wrapper.findAll('[data-row]')).toHaveLength(2)
    expect(savedBody(fetchMock).config.creditMemoRules[1]).toMatchObject({ startDate: '2027-04-01', endDate: '2027-04-30', lines: [{ codingLineId: '20', percentage: '100' }] })
  })

  it('confirms row deletion before changing only the selected collection', async () => {
    const fetchMock = fixture()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'credit-memos' } })
    await flushPromises()
    const deleteRow = () => wrapper.findAll('button').find(button => button.attributes('aria-label')?.startsWith('Delete:'))!
    await deleteRow().trigger('click')
    await findButton(wrapper, 'Cancel').trigger('click')
    expect(wrapper.findAll('[data-row]')).toHaveLength(1)
    await deleteRow().trigger('click')
    await findButton(wrapper, 'Delete').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-row]')).toHaveLength(0)
    expect(savedBody(fetchMock).config).toEqual({ ...policy(), creditMemoRules: [] })
  })

  it('searches and paginates rows while persisting the full configuration on Update', async () => {
    const current = policy()
    current.receivableSets = Array.from({ length: 12 }, (_, index) => ({ ...policy().receivableSets[0]!, fiscalYearId: String(index + 1) }))
    const fetchMock = fixture(current)
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1' } })
    await flushPromises()
    expect(wrapper.findAll('[data-row]')).toHaveLength(10)
    await wrapper.get('[data-next-page]').trigger('click')
    expect(wrapper.findAll('[data-row]')).toHaveLength(2)
    await wrapper.get('[data-search]').setValue('no-match')
    expect(wrapper.findAll('[data-row]')).toHaveLength(0)
    await wrapper.get('[data-search]').setValue('2026')
    expect(wrapper.findAll('[data-row]')).toHaveLength(1)
    await editRow(wrapper)
    await applyDraft(wrapper)
    expect(savedBody(fetchMock).config).toEqual(current)
  })


  it('discards an open draft when identity or edit permission changes', async () => {
    const fetchMock = fixture()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1' } })
    await flushPromises()
    await editRow(wrapper)
    await modalInputs(wrapper)[0]!.setValue('25')
    await wrapper.setProps({ agencyId: '2' })
    await flushPromises()
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    await editRow(wrapper)
    expect(modalInputs(wrapper)[0]!.element.value).toBe('100')
    await wrapper.setProps({ disabled: true })
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    await wrapper.setProps({ disabled: false })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })


  it('keeps the modal and collection stable until the edit request succeeds, blocking duplicate submits and dismissal', async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    const fetchMock = fixture()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => init?.method === 'PATCH' ? await pending : await original(url, init))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'credit-memos' } })
    await flushPromises()
    await editRow(wrapper)
    await modalInputs(wrapper)[1]!.setValue('2027-03-30')
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(true)
    expect(wrapper.get('[data-row]').text()).toContain('2027-03-31')
    await applyDraft(wrapper)
    await wrapper.get('[data-dismiss]').trigger('click')
    expect(wrapper.find('[data-modal]').exists()).toBe(true)
    expect(findButton(wrapper, 'Cancel').attributes('disabled')).toBeDefined()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
    release(json({ enabled: true }))
    await flushPromises()
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    expect(wrapper.get('[data-row]').text()).toContain('2027-03-30')
  })

  it('keeps a failed deletion in its confirmation modal until a successful retry', async () => {
    const fetchMock = fixture()
    const original = fetchMock.getMockImplementation()!
    let attempts = 0
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === 'PATCH' && attempts++ === 0) return json({ message: 'These settings are in use.' }, 409)
      return await original(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'credit-memos' } })
    await flushPromises()
    await wrapper.findAll('button').find(button => button.attributes('aria-label')?.startsWith('Delete:'))!.trigger('click')
    await findButton(wrapper, 'Delete').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-modal] [role="alert"]').text()).toContain('These settings are in use.')
    expect(wrapper.findAll('[data-row]')).toHaveLength(1)
    await findButton(wrapper, 'Delete').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    expect(wrapper.findAll('[data-row]')).toHaveLength(0)
    expect(savedBody(fetchMock).config).toEqual({ ...policy(), creditMemoRules: [] })
  })


  it.each([
    ['en', 'receivables', 'Fund: A', 'Percentage'],
    ['fr', 'receivables', 'Fonds: A', 'Pourcentage'],
    ['en', 'credit-memos', 'Fund: A', 'Percentage'],
    ['fr', 'credit-memos', 'Fonds: A', 'Pourcentage']
  ])('shows hydrated fiscal years and coding with a separate percentage column in %s/%s', async (locale, section, codingLabel, percentageHeader) => {
    const runtime = installUi()
    const base = runtime.composables.useI18n()
    runtime.composables.useI18n = () => ({ ...base, locale: ref(locale) })
    let releaseAccounts!: (response: Response) => void
    const pendingAccounts = new Promise<Response>(resolve => { releaseAccounts = resolve })
    const fetchMock = fixture()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => url.includes('kind=account_receivable') ? await pendingAccounts : await original(url, init))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section, config: policy() } })
    await flushPromises()
    expect(wrapper.findAll('[data-row]')).toHaveLength(0)
    releaseAccounts(json({ items: [account('account_receivable')], total: 1 }))
    await flushPromises()
    expect(wrapper.findAll('[data-row]')).toHaveLength(1)
    expect(wrapper.get('[data-column="percentage"]').text()).toBe(percentageHeader)
    expect(wrapper.get('[data-cell="coding"]').text()).toBe(codingLabel)
    expect(wrapper.get('[data-cell="percentage"]').text()).toBe('100%')
    const yearCell = section === 'credit-memos' ? 'fiscalYear' : 'period'
    expect(wrapper.get(`[data-cell="${yearCell}"]`).text()).toBe('2026–2027')
    expect(wrapper.get('[data-cell="coding"]').text()).not.toContain('2026')
    expect(wrapper.get('[data-cell="coding"]').text()).not.toContain('%')
  })

  it('keeps the fiscal year display when coding metadata is unavailable without exposing identifiers', async () => {
    const fetchMock = fixture()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => url.includes('chart-of-accounts') ? json({ items: [], total: 0 }) : await original(url, init))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1' } })
    await flushPromises()
    expect(wrapper.get('[data-cell="period"]').text()).toBe('2026–2027')
    expect(wrapper.get('[data-cell="coding"]').text()).toBe('Unavailable')
    expect(wrapper.get('[data-cell="percentage"]').text()).toBe('100%')
  })

  it.each([['en', 'Edit the existing set'], ['fr', 'Modifiez l’ensemble existant']])('explains duplicate yearly sets in %s without changing the saved rows', async (locale, message) => {
    const runtime = installUi()
    const base = runtime.composables.useI18n()
    runtime.composables.useI18n = () => ({ ...base, locale: ref(locale) })
    const fetchMock = fixture()
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1' } })
    await flushPromises()
    await wrapper.get('[data-add]').trigger('click')
    await wrapper.findAll('select')[0]!.setValue('1')
    await wrapper.findAll('select')[1]!.setValue('cad')
    await wrapper.findAll('select')[2]!.setValue('10')
    await applyDraft(wrapper)
    expect(wrapper.get('[data-modal] [role="alert"]').text()).toContain(message)
    expect(wrapper.get('[data-cell="period"]').text()).toBe('2026–2027')
    expect(wrapper.get('[data-cell="coding"]').text()).toBe(locale === 'fr' ? 'Fonds: A' : 'Fund: A')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })


  it.each(['en', 'fr'])('explains default committed-matrix coding without requiring credit memo exceptions in %s', async locale => {
    const runtime = installUi()
    const base = runtime.composables.useI18n()
    runtime.composables.useI18n = () => ({ ...base, locale: ref(locale) })
    const fetchMock = fixture({ ...policy(), creditMemoRules: [] })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'credit-memos' } })
    await flushPromises()
    expect(wrapper.findAll('[data-row]')).toHaveLength(0)
    expect(wrapper.text()).toContain(locale === 'fr' ? 'Les notes de crédit suivent la matrice de répartition engagée.' : 'Credit memos follow the committed allocation matrix.')
    expect(wrapper.find('[description]').exists()).toBe(false)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  })

  it('authors a source-specific multi-account remap exception with exact percentages using shared multi-select', async () => {
    const fetchMock = fixture({ ...policy(), creditMemoRules: [] })
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      if (url.includes('kind=credit_memo')) return json({ items: [account('credit_memo'), { ...account('credit_memo'), id: '21', egcs_ay_fiscalyear: '2', fiscal_year_display: '2027–2028', egcs_ay_accountingdimensions: [{ label_en: 'Fund', label_fr: 'Fonds', value: 'B' }] }], total: 2 })
      return await original(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'credit-memos' } })
    await flushPromises()
    await findButton(wrapper, 'Add remap exception').trigger('click')
    await wrapper.findAll('select')[0]!.setValue('cad')
    await wrapper.findAll('select')[1]!.setValue('30')
    await modalInputs(wrapper)[0]!.setValue('2026-04-01')
    await modalInputs(wrapper)[1]!.setValue('2027-03-31')
    const targets = wrapper.findAll('select')[2]!
    expect(targets.attributes('multiple')).toBeDefined()
    await targets.setValue(['20', '21'])
    expect(modalInputs(wrapper)[2]!.element.value).toBe('100')
    expect(modalInputs(wrapper)[3]!.element.value).toBe('')
    expect(wrapper.get('[data-modal]').text()).toContain('2027–2028 — Fund: B')
    expect(wrapper.get('[name="creditMemoRules.0.lines.1.percentage"]').attributes('label')).toContain('2027–2028 — Fund: B')
    expect(findButton(wrapper, 'Add coding line')).toBeUndefined()
    expect(findButton(wrapper, 'Remove')).toBeUndefined()
    await modalInputs(wrapper)[2]!.setValue('30.0000')
    await modalInputs(wrapper)[3]!.setValue('69')
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(true)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
    await modalInputs(wrapper)[3]!.setValue('70.0000')
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    expect(savedBody(fetchMock).config).toEqual({ ...policy(), creditMemoRules: [{ commitmentCodingLineId: '30', currency: 'cad', startDate: '2026-04-01', endDate: '2027-03-31', lines: [{ codingLineId: '20', percentage: '30.0000' }, { codingLineId: '21', percentage: '70.0000' }] }] })
    expect(wrapper.get('[data-cell="source"]').text()).toBe('Fund: A')
    expect(wrapper.get('[data-cell="percentage"]').findAll('li').map(line => line.text())).toEqual(['30.0000%', '70.0000%'])
    await editRow(wrapper)
    await wrapper.findAll('select')[2]!.setValue(['20'])
    expect(modalInputs(wrapper)[2]!.element.value).toBe('30.0000')
    await wrapper.findAll('select')[2]!.setValue(['20', '21'])
    expect(modalInputs(wrapper)[2]!.element.value).toBe('30.0000')
    expect(modalInputs(wrapper)[3]!.element.value).toBe('')
  })

  it('permits overlapping date ranges for different source commitment accounts', async () => {
    const fetchMock = fixture()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      if (url.includes('kind=commitment')) return json({ items: [account('commitment'), { ...account('commitment'), id: '31' }], total: 2 })
      return await original(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'credit-memos' } })
    await flushPromises()
    await findButton(wrapper, 'Add remap exception').trigger('click')
    await wrapper.findAll('select')[0]!.setValue('cad')
    await wrapper.findAll('select')[1]!.setValue('31')
    await modalInputs(wrapper)[0]!.setValue('2026-04-01')
    await modalInputs(wrapper)[1]!.setValue('2027-03-31')
    await wrapper.findAll('select')[2]!.setValue(['20'])
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    expect(savedBody(fetchMock).config.creditMemoRules).toHaveLength(2)
    expect(savedBody(fetchMock).config.creditMemoRules[1].commitmentCodingLineId).toBe('31')
  })


  it('clears source and target selections that no longer belong to the chosen currency', async () => {
    const fetchMock = fixture()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      if (url.includes('kind=commitment')) return json({ items: [account('commitment'), { ...account('commitment'), id: '31', egcs_ay_currency: 'usd' }], total: 2 })
      if (url.includes('kind=credit_memo')) return json({ items: [account('credit_memo'), { ...account('credit_memo'), id: '21', egcs_ay_currency: 'usd' }], total: 2 })
      return await original(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(AgencyCodingConfig, { props: { agencyId: '1', section: 'credit-memos' } })
    await flushPromises()
    await editRow(wrapper)
    await wrapper.findAll('select')[0]!.setValue('usd')
    expect(wrapper.findAll('select')[1]!.element.value).not.toBe('30')
    expect(wrapper.findAll('select')[2]!.element.selectedOptions).toHaveLength(0)
    expect(modalInputs(wrapper)).toHaveLength(2)
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(true)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
    await wrapper.findAll('select')[1]!.setValue('31')
    await wrapper.findAll('select')[2]!.setValue(['21'])
    expect(modalInputs(wrapper)[2]!.element.value).toBe('100')
    await applyDraft(wrapper)
    expect(wrapper.find('[data-modal]').exists()).toBe(false)
    expect(savedBody(fetchMock).config.creditMemoRules[0]).toMatchObject({ currency: 'usd', commitmentCodingLineId: '31', lines: [{ codingLineId: '21', percentage: '100' }] })
  })

})

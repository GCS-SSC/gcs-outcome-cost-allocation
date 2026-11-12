// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref, Suspense, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { installExtensionTestUiRuntime } from '@gcs-ssc/extensions/testing'
import StreamConfig from '../../components/StreamOutcomeCostAllocationConfig.vue'
import { parseOutcomeCostAllocationConfig } from '../../shared/allocation'

afterEach(() => vi.unstubAllGlobals())

it.each(['en', 'fr'])('loads and selects labels past the first page (%s)', async locale => {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('useI18n', () => ({ locale: ref(locale), n: (value: number) => String(value) }))
  const runtime = installExtensionTestUiRuntime()
  runtime.components.UTable = defineComponent({ inheritAttrs: false, setup: (_, { attrs }) => () => h('div', attrs, h('table')) })
  const requestedPages: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(String(input), 'http://localhost')
    requestedPages.push(`${url.pathname}:${url.searchParams.get('page')}`)
    const page = Number(url.searchParams.get('page'))
    const items = Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => {
      const id = String((page - 1) * 100 + index + 1)
      return {
        id,
        egcs_tp_name_en: `English ${id}`, egcs_tp_name_fr: `Français ${id}`,
        egcs_ay_name_en: `English ${id}`, egcs_ay_name_fr: `Français ${id}`,
        fiscal_year_display: `Year ${id}`, egcs_tp_fiscalyear: id, egcs_ay_fiscalyear: id, egcs_tp_currency: 'cad', egcs_ay_currency: 'cad',
        egcs_ay_accountingdimensions: [{ label_en: 'Account', label_fr: 'Compte', value: id }]
      }
    })
    return new Response(JSON.stringify({ items, total: 101 }), { headers: { 'content-type': 'application/json' } })
  }))
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(StreamConfig, {
    extension: {} as never, streamId: 'stream', transferPaymentId: 'program', modelValue: { enabledCommitmentTypes: [], mappings: [] }
  }) }) }))
  await flushPromises()
  const scroll = wrapper.get('[role="group"]')
  expect(scroll.attributes('tabindex')).toBe('0')
  expect(scroll.attributes('aria-label')).toBe(wrapper.get('h2').text())
  expect(scroll.get('table').attributes('role')).toBeUndefined()
  const component = wrapper.findComponent(StreamConfig)
  const instance = component.vm.$
  if (!instance) throw new Error('Stream configuration component did not mount')
  const state = (instance as unknown as { setupState: { openCreateAssociation: (id?: string) => void } }).setupState
  state.openCreateAssociation('101')
  await nextTick()
  const selects = wrapper.findAllComponents(runtime.components.USelect)
  expect(selects).toHaveLength(3)
  for (const select of selects) {
    const options = select.vm.$attrs.items as Array<{ value: string, label: string }>
    expect(options).toHaveLength(101)
    expect(options.at(-1)?.value).toBe('101')
    expect(options.at(-1)?.label).toContain(locale === 'en' ? select === selects[0] ? 'Account' : 'English' : select === selects[0] ? 'Compte' : 'Français')
    select.vm.$emit('update:modelValue', '101')
  }
  await nextTick()
  expect(wrapper.findAll('select').every(select => (select.element as HTMLSelectElement).value === '101')).toBe(true)
  expect(requestedPages).toHaveLength(8)
  expect(requestedPages.filter(path => path.endsWith(':2'))).toHaveLength(4)
  wrapper.unmount()
})


it('authors the matching currency budget when two currencies share the same fiscal year', async () => {
  vi.stubGlobal('computed', computed); vi.stubGlobal('ref', ref); vi.stubGlobal('watch', watch)
  vi.stubGlobal('useI18n', () => ({ locale: ref('en'), n: (value: number) => String(value) }))
  const runtime = installExtensionTestUiRuntime()
  runtime.components.UTable = defineComponent({ inheritAttrs: false, setup: (_, { attrs }) => () => h('div', attrs, h('table')) })
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const items = path.endsWith('/budgets')
      ? [{ id: '10', egcs_tp_fiscalyear: '5', egcs_tp_currency: 'cad', fiscal_year_display: '2026–2027' },
          { id: '11', egcs_tp_fiscalyear: '5', egcs_tp_currency: 'jpy', fiscal_year_display: '2026–2027' }]
      : path.endsWith('/chart-of-accounts')
        ? [{ id: '19', egcs_ay_fiscalyear: '5', egcs_ay_currency: 'cad', fiscal_year_display: '2026–2027', egcs_ay_accountingdimensions: [{ label_en: 'Account', label_fr: 'Compte', value: '100' }] },
          { id: '20', egcs_ay_fiscalyear: '5', egcs_ay_currency: 'jpy', fiscal_year_display: '2026–2027', egcs_ay_accountingdimensions: [{ label_en: 'Account', label_fr: 'Compte', value: '100' }] }]
        : [{ id: '1', egcs_tp_name_en: 'Outcome', egcs_tp_name_fr: 'Résultat', egcs_ay_name_en: 'Grant', egcs_ay_name_fr: 'Subvention' }]
    return new Response(JSON.stringify({ items, total: items.length }), { headers: { 'content-type': 'application/json' } })
  }))
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(StreamConfig, {
    extension: {} as never, streamId: 'stream', transferPaymentId: 'program', modelValue: { enabledCommitmentTypes: [], mappings: [] }
  }) }) }))
  await flushPromises()
  const component = wrapper.findComponent(StreamConfig)
  const state = (component.vm.$ as unknown as { setupState: { openCreateAssociation: (id?: string) => void } }).setupState
  state.openCreateAssociation('20')
  await nextTick()
  const options = wrapper.findAllComponents(runtime.components.USelect)[0]!.vm.$attrs.items as Array<{ value: string; label: string }>
  expect(options.find(option => option.value === '19')?.label).toBe('Account: 100 · CAD')
  expect(options.find(option => option.value === '20')?.label).toBe('Account: 100 · JPY')
  const add = wrapper.findAll('button').find(button => button.text() === 'Add')
  expect(add, 'The association modal exposes its ordinary Add action').toBeDefined()
  await add!.trigger('click')
  expect(component.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ mappings: [{ streamCommitmentId: '20', streamBudgetId: '11' }] })
  wrapper.unmount()
})

it('keeps replacement stream choices when an earlier stream finishes later and closes the old editor', async () => {
  const runtime = installExtensionTestUiRuntime()
  runtime.components.UTable = defineComponent({ inheritAttrs: false, setup: (_, { attrs }) => () => h('div', attrs, h('table')) })
  const pending: Array<() => void> = []
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const respond = () => new Response(JSON.stringify({ items: [{
      id: path.endsWith('/commitment-types') ? '1' : path.includes('/replacement/') ? 'replacement' : 'initial',
      egcs_tp_name_en: 'Outcome', egcs_tp_name_fr: 'Résultat',
      egcs_ay_name_en: 'Grant', egcs_ay_name_fr: 'Subvention',
      fiscal_year_display: '2026', egcs_tp_fiscalyear: '1', egcs_ay_fiscalyear: '1',
      egcs_tp_currency: 'cad', egcs_ay_currency: 'cad',
      egcs_ay_accountingdimensions: [{ label_en: 'Account', label_fr: 'Compte', value: path.includes('/replacement/') ? 'replacement' : 'initial' }]
    }], total: 1 }), { headers: { 'content-type': 'application/json' } })
    if (path.includes('/delayed/')) return new Promise<Response>(resolve => pending.push(() => resolve(respond())))
    return Promise.resolve(respond())
  }))
  const activeStream = ref('initial')
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(StreamConfig, {
    extension: {} as never, streamId: activeStream.value, transferPaymentId: 'program', modelValue: { enabledCommitmentTypes: [], mappings: [] }
  }) }) }))
  await flushPromises()
  const addAssociation = () => wrapper.findAll('button').find(button => button.text() === 'Add association')
  expect(addAssociation()).toBeDefined()
  await addAssociation()!.trigger('click')
  expect(wrapper.findAllComponents(runtime.components.USelect)).toHaveLength(3)
  activeStream.value = 'delayed'
  await nextTick()
  expect(wrapper.findAllComponents(runtime.components.USelect)).toHaveLength(0)
  activeStream.value = 'replacement'
  await nextTick()
  await flushPromises()
  pending.forEach(resolve => resolve())
  await flushPromises()
  await addAssociation()!.trigger('click')
  const options = wrapper.findAllComponents(runtime.components.USelect)[0]!.vm.$attrs.items as Array<{ value: string }>
  expect(options.map(option => option.value)).toEqual(['replacement'])
  wrapper.unmount()
})

it.each(['en', 'fr'])('distinguishes failed association choices from empty data and retries (%s)', async locale => {
  const runtime = installExtensionTestUiRuntime()
  const currentI18n = runtime.composables.useI18n()
  runtime.composables.useI18n = () => ({ ...currentI18n, locale: ref(locale) })
  let unavailable = true
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (unavailable && path.endsWith('/chart-of-accounts')) throw new Error('offline')
    const item = {
      id: '1', egcs_tp_name_en: 'Outcome', egcs_tp_name_fr: 'Résultat',
      egcs_ay_name_en: 'Grant', egcs_ay_name_fr: 'Subvention',
      fiscal_year_display: '2026', egcs_tp_fiscalyear: '1', egcs_ay_fiscalyear: '1',
      egcs_tp_currency: 'cad', egcs_ay_currency: 'cad',
      egcs_ay_accountingdimensions: [{ label_en: 'Account', label_fr: 'Compte', value: '100' }]
    }
    return new Response(JSON.stringify({ items: [item], total: 1 }), { headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(StreamConfig, {
    extension: {} as never, streamId: 'stream', transferPaymentId: 'program', modelValue: { enabledCommitmentTypes: [], mappings: [] }
  }) }) }))
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain(locale === 'en' ? 'could not be loaded' : 'n’ont pas pu être chargés')
  expect(wrapper.text()).not.toContain(locale === 'en' ? 'Add program outcomes' : 'Ajoutez des résultats')
  const add = () => wrapper.findAll('button').find(button => button.text() === (locale === 'en' ? 'Add association' : 'Ajouter une association'))!
  expect(add().attributes()).toHaveProperty('disabled')
  unavailable = false
  await wrapper.get('[role="alert"] button').trigger('click')
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(add().attributes()).not.toHaveProperty('disabled')
  await add().trigger('click')
  expect(wrapper.findAllComponents(runtime.components.USelect)).toHaveLength(3)
  for (const select of wrapper.findAllComponents(runtime.components.USelect)) {
    expect(select.vm.$attrs.items).toHaveLength(1)
  }
  expect(fetchMock).toHaveBeenCalledTimes(8)
  wrapper.unmount()
})

it('keeps prerequisite guidance for successfully loaded empty association choices', async () => {
  installExtensionTestUiRuntime()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], total: 0 }), {
    headers: { 'content-type': 'application/json' }
  })))
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(StreamConfig, {
    extension: {} as never, streamId: 'stream', transferPaymentId: 'program', modelValue: { enabledCommitmentTypes: [], mappings: [] }
  }) }) }))
  await flushPromises()
  expect(wrapper.text()).toContain('Add program outcomes, stream budgets, stream commitments, and commitment types')
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.findAll('button').some(button => button.text() === 'Retry')).toBe(false)
  expect(wrapper.findAll('button').find(button => button.text() === 'Add association')!.attributes()).toHaveProperty('disabled')
  wrapper.unmount()
})

it.each(['en', 'fr'])('renders, expands, removes, and externally replaces controlled associations (%s)', async locale => {
  const runtime = installExtensionTestUiRuntime()
  const i18n = runtime.composables.useI18n()
  runtime.composables.useI18n = () => ({ ...i18n, locale: ref(locale) })
  runtime.components.UTable = defineComponent({
    inheritAttrs: false,
    setup: (_, { attrs, slots }) => () => h('table', { 'data-associations': '' }, h('tbody',
      (Array.isArray(attrs.data) ? attrs.data : []).map(original => h('tr',
        ['commitmentLine', 'outcome', 'actions'].map(id => h('td', slots[`${id}-cell`]?.({ row: { original } })))))))
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const items = path.endsWith('/budgets')
      ? ['1', '2'].map(id => ({ id: `budget-${id}`, egcs_tp_fiscalyear: id, egcs_tp_currency: 'cad', fiscal_year_display: `Year ${id}` }))
      : path.endsWith('/chart-of-accounts')
        ? ['1', '2', '3'].map(id => ({ id: `chart-${id}`, egcs_ay_fiscalyear: id === '3' ? '2' : '1', egcs_ay_currency: 'cad',
          fiscal_year_display: `Year ${id === '3' ? '2' : '1'}`, egcs_ay_accountingdimensions: [{ label_en: 'Account', label_fr: 'Compte', value: id }] }))
        : ['1', '2'].map(id => ({ id, egcs_tp_name_en: `Outcome ${id}`, egcs_tp_name_fr: `Résultat ${id}`, egcs_ay_name_en: `Type ${id}`, egcs_ay_name_fr: `Genre ${id}` }))
    return new Response(JSON.stringify({ items, total: items.length }), { headers: { 'content-type': 'application/json' } })
  }))
  const model = ref({ enabledCommitmentTypes: ['1', '2'], mappings: [
    { commitmentType: '1', streamBudgetId: 'budget-1', streamCommitmentId: 'chart-1', outcomeId: '1' },
    { commitmentType: '1', streamBudgetId: 'budget-1', streamCommitmentId: 'chart-1', outcomeId: '2' },
    { commitmentType: '1', streamBudgetId: 'budget-1', streamCommitmentId: 'chart-2', outcomeId: '1' },
    { commitmentType: '1', streamBudgetId: 'budget-2', streamCommitmentId: 'chart-3', outcomeId: '1' },
    { commitmentType: '2', streamBudgetId: 'budget-2', streamCommitmentId: 'chart-3', outcomeId: '1' }
  ] })
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(StreamConfig, {
    extension: {} as never, streamId: 'stream', transferPaymentId: 'program', agencyId: 'agency',
    modelValue: model.value, 'onUpdate:modelValue': value => { model.value = parseOutcomeCostAllocationConfig(value) }
  }) }) }))
  await flushPromises()
  const typeLabel = locale === 'en' ? 'Type' : 'Genre'
  const group = (label: string) => wrapper.findAll('[data-associations] button').find(button => button.text().startsWith(label))!
  expect(wrapper.findAll('[data-associations] tr')).toHaveLength(2)
  await group(`${typeLabel} 1`).trigger('click')
  await group('Year 1').trigger('click')
  expect(wrapper.text()).toContain(locale === 'en' ? 'Account: 1' : 'Compte: 1')
  expect(wrapper.text()).toContain(locale === 'en' ? 'Outcome 2' : 'Résultat 2')
  const removeLabel = locale === 'en' ? 'Remove association' : 'Retirer l’association'
  await wrapper.get(`[aria-label="${removeLabel}"]`).trigger('click')
  await flushPromises()
  expect(model.value.mappings).toHaveLength(4)
  await group('Year 1').trigger('click')
  await group(`${typeLabel} 1`).trigger('click')
  model.value = { enabledCommitmentTypes: ['2'], mappings: [model.value.mappings.at(-1)!] }
  await flushPromises()
  expect(wrapper.findAll('[data-associations] tr')).toHaveLength(1)
  expect(wrapper.findComponent(StreamConfig).emitted('update:modelValue')).toHaveLength(1)
  await group(`${typeLabel} 2`).trigger('click')
  await group('Year 2').trigger('click')
  await wrapper.get(`[aria-label="${removeLabel}"]`).trigger('click')
  await flushPromises()
  expect(model.value).toEqual({ enabledCommitmentTypes: [], mappings: [] })
  wrapper.unmount()
})

it.each([
  { locale: 'en', types: [], budgetCurrency: 'cad' },
  { locale: 'fr', types: [], budgetCurrency: 'cad' },
  { locale: 'en', types: ['invalid-type'], budgetCurrency: 'cad' },
  { locale: 'en', types: ['1'], budgetCurrency: 'jpy' }
])('does not open or emit associations without usable prerequisites ($locale, $types, $budgetCurrency)', async ({ locale, types, budgetCurrency }) => {
  const runtime = installExtensionTestUiRuntime()
  const i18n = runtime.composables.useI18n()
  runtime.composables.useI18n = () => ({ ...i18n, locale: ref(locale) })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const item = { id: '1', egcs_tp_name_en: 'Outcome', egcs_tp_name_fr: 'Résultat',
      egcs_ay_name_en: 'Grant', egcs_ay_name_fr: 'Subvention', fiscal_year_display: '2026',
      egcs_tp_fiscalyear: '1', egcs_ay_fiscalyear: '1', egcs_tp_currency: budgetCurrency, egcs_ay_currency: 'cad', egcs_ay_accountingdimensions: [] }
    const items = path.endsWith('/commitment-types') ? types.map(id => ({ ...item, id })) : [item]
    return new Response(JSON.stringify({ items, total: items.length }), { headers: { 'content-type': 'application/json' } })
  }))
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(StreamConfig, {
    extension: {} as never, streamId: 'stream', transferPaymentId: 'program', modelValue: { enabledCommitmentTypes: [], mappings: [] }
  }) }) }))
  await flushPromises()
  const label = locale === 'en' ? 'Add association' : 'Ajouter une association'
  const open = wrapper.findAllComponents(runtime.components.UButton).find(button => button.vm.$attrs.label === label)!
  expect(wrapper.findAll('button').find(button => button.text() === label)!.attributes()).toHaveProperty('disabled')
  expect(wrapper.text()).toContain(locale === 'en' ? 'commitment types' : 'types d’engagement')
  open.vm.$emit('click')
  await nextTick()
  expect(wrapper.findAllComponents(runtime.components.USelect)).toHaveLength(0)
  expect(wrapper.findComponent(StreamConfig).emitted('update:modelValue')).toBeUndefined()
  wrapper.unmount()
})

it('requires current valid association selections before publishing the controlled model', async () => {
  const runtime = installExtensionTestUiRuntime()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const item = { id: '1', egcs_tp_name_en: 'Outcome', egcs_tp_name_fr: 'Résultat',
      egcs_ay_name_en: 'Grant', egcs_ay_name_fr: 'Subvention', fiscal_year_display: '2026',
      egcs_tp_fiscalyear: '1', egcs_ay_fiscalyear: '1', egcs_tp_currency: 'cad', egcs_ay_currency: 'cad', egcs_ay_accountingdimensions: [] }
    const items = path.endsWith('/commitment-types') ? [item, { ...item, id: '2' }]
      : path.endsWith('/chart-of-accounts') ? [item, { ...item, id: '2', egcs_ay_currency: 'jpy' }] : [item]
    return new Response(JSON.stringify({ items, total: items.length }), { headers: { 'content-type': 'application/json' } })
  }))
  const model = ref<ReturnType<typeof parseOutcomeCostAllocationConfig>>({ enabledCommitmentTypes: [], mappings: [] })
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(StreamConfig, {
    extension: {} as never, streamId: 'stream', transferPaymentId: 'program', modelValue: model.value,
    'onUpdate:modelValue': value => { model.value = parseOutcomeCostAllocationConfig(value) }
  }) }) }))
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === 'Add association')!.trigger('click')
  const selections = wrapper.findAllComponents(runtime.components.USelect)
  const add = wrapper.findAllComponents(runtime.components.UButton).find(button => button.vm.$attrs.label === 'Add')!
  const rejectsSelection = async (index: number, value: string) => {
    selections[index]!.vm.$emit('update:modelValue', value)
    await nextTick()
    expect(wrapper.findAll('button').find(button => button.text() === 'Add')!.attributes()).toHaveProperty('disabled')
    add.vm.$emit('click')
    await nextTick()
    expect(model.value.mappings).toEqual([])
    expect(wrapper.findComponent(StreamConfig).emitted('update:modelValue')).toBeUndefined()
  }
  for (const value of ['', 'invalid', '999']) await rejectsSelection(1, value)
  selections[1]!.vm.$emit('update:modelValue', '2')
  await rejectsSelection(2, '999')
  selections[2]!.vm.$emit('update:modelValue', '1')
  await rejectsSelection(0, '2')
  selections[0]!.vm.$emit('update:modelValue', '1')
  await nextTick()
  expect(wrapper.findAll('button').find(button => button.text() === 'Add')!.attributes()).not.toHaveProperty('disabled')
  await wrapper.findAll('button').find(button => button.text() === 'Add')!.trigger('click')
  await flushPromises()
  expect(model.value).toEqual({ enabledCommitmentTypes: ['2'], mappings: [{
    commitmentType: '2', streamBudgetId: '1', streamCommitmentId: '1', outcomeId: '1'
  }] })
  expect(wrapper.findComponent(StreamConfig).emitted('update:modelValue')).toHaveLength(1)
  wrapper.unmount()
})

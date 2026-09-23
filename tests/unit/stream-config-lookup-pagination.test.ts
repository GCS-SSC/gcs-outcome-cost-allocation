// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref, Suspense, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { installExtensionTestUiRuntime } from '@gcs-ssc/extensions/testing'
import StreamConfig from '../../components/StreamOutcomeCostAllocationConfig.vue'

afterEach(() => vi.unstubAllGlobals())

it.each(['en', 'fr'])('loads and selects labels past the first page (%s)', async locale => {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('useI18n', () => ({ locale: ref(locale), n: (value: number) => String(value) }))
  const runtime = installExtensionTestUiRuntime()
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
        fiscal_year_display: `Year ${id}`, egcs_tp_fiscalyear: id, egcs_ay_fiscalyear: id,
        egcs_ay_accountingdimensions: [{ label_en: 'Account', label_fr: 'Compte', value: id }]
      }
    })
    return new Response(JSON.stringify({ items, total: 101 }), { headers: { 'content-type': 'application/json' } })
  }))
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(StreamConfig, {
    extension: {} as never, streamId: 'stream', transferPaymentId: 'program', modelValue: { enabledCommitmentTypes: [], mappings: [] }
  }) }) }))
  await flushPromises()
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

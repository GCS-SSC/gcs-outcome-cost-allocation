// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref, Suspense, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { installExtensionTestUiRuntime } from '@gcs-ssc/extensions/testing'
import StreamConfig from '../../components/StreamOutcomeCostAllocationConfig.vue'

afterEach(() => vi.unstubAllGlobals())

it.each(['en', 'fr'])('delegates allocation Workflow links to the host Stream catalog (%s)', async locale => {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('useI18n', () => ({ locale: ref(locale), n: (value: number) => String(value) }))
  const runtime = installExtensionTestUiRuntime()
  runtime.components.UTable = defineComponent({ setup: () => () => h('table') })
  const WorkflowLinks = defineComponent({
    name: 'WorkflowLinks', props: ['transferPaymentId', 'streamId', 'agencyId', 'entityType', 'canUpdate'],
    setup: () => () => h('div', { 'data-testid': 'host-workflow-links' })
  })
  runtime.components.CommonStreamWorkflowLinks = WorkflowLinks
  vi.stubGlobal('fetch', vi.fn(async () => {
    return new Response(JSON.stringify({ items: [], total: 0 }), {
      headers: { 'content-type': 'application/json' }
    })
  }))
  const context = ref({ agencyId: 'agency', streamId: 'stream', transferPaymentId: 'program' })
  const config = ref({ enabledCommitmentTypes: [], mappings: [] })
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, {
    default: () => h(StreamConfig, {
      extension: {} as never,
      ...context.value,
      modelValue: config.value,
      'onUpdate:modelValue': value => { config.value = value as typeof config.value }
    })
  }) }))
  await flushPromises()

  const links = wrapper.findComponent(WorkflowLinks)
  expect(links.exists(), 'Stream configuration needs the host Workflow link picker').toBe(true)
  expect(links.props()).toMatchObject({
    transferPaymentId: 'program', streamId: 'stream', agencyId: 'agency',
    entityType: 'gcs-outcome-cost-allocation:allocation-version', canUpdate: true
  })
  expect(wrapper.findAll('h2').map(heading => heading.text())).toContain(locale === 'fr' ? 'Flux de travail' : 'Workflows')
  expect(wrapper.text()).toContain(locale === 'fr'
    ? 'Les associations de flux de travail sont enregistrées immédiatement lors de leur ajout ou de leur retrait.'
    : 'Workflow links are saved immediately when added or removed.')
  expect(config.value).toEqual({ enabledCommitmentTypes: [], mappings: [] })

  context.value = { agencyId: 'next-agency', streamId: 'next-stream', transferPaymentId: 'next-program' }
  await nextTick()
  expect(links.props()).toMatchObject({
    transferPaymentId: 'next-program', streamId: 'next-stream', agencyId: 'next-agency'
  })
  context.value = { agencyId: '', streamId: 'next-stream', transferPaymentId: 'next-program' }
  await nextTick()
  expect(wrapper.findComponent(WorkflowLinks).exists()).toBe(false)
  wrapper.unmount()
})

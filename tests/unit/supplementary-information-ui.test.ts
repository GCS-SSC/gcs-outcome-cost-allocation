// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, h, onUnmounted, ref, Suspense, watch } from 'vue'
import type { PropType } from 'vue'
import { installExtensionTestUiRuntime } from '@gcs-ssc/extensions/testing'
import OutcomeAllocationDetail from '../../components/OutcomeAllocationDetail.vue'

const unmountedSupplementaryIds: string[] = []
const SupplementaryInformation = defineComponent({
  name: 'SupplementaryInformation',
  inheritAttrs: false,
  props: {
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    showHeader: { type: Boolean, default: true },
    showDescription: { type: Boolean, default: true }
  },
  setup: (props, { attrs }) => {
    const initialEntityId = props.entityId
    onUnmounted(() => unmountedSupplementaryIds.push(initialEntityId))
    return () => h('section', {
      'data-testid': 'supplementary-information',
      'data-entity-type': props.entityType,
      'data-entity-id': props.entityId,
      'data-extra-props': JSON.stringify(attrs)
    }, [props.showHeader ? h('h3', 'Supplementary') : null, props.showDescription ? h('p', 'Saved workflow answers') : null])
  }
})

const DetailPage = defineComponent({ setup: (_, { slots }) => () => h('div', slots.body?.()) })
const Workspace = defineComponent({
  props: {
    modelValue: { type: String, required: true },
    items: { type: Array as PropType<Array<{ value: string, label: string }>>, required: true }
  },
  emits: ['update:modelValue'],
  setup: (props, { slots, emit }) => () => h('div', [
    h('aside', h('nav', { 'data-orientation': 'vertical' }, props.items.map(item => h('button', {
      type: 'button', 'data-view': item.value,
      'aria-current': item.value === props.modelValue ? 'page' : undefined,
      onClick: () => emit('update:modelValue', item.value)
    }, item.label)))),
    h('main', [h('h2', props.items.find(item => item.value === props.modelValue)?.label), slots.actions?.(), slots.notices?.(), slots.default?.()])
  ])
})

const response = {
  currency: 'cad', outcomes: [], budgetYears: [], allocations: [], streamCommitments: [], commitmentTypes: [],
  versions: [
    { id: 'allocation-111', agreementId: 'agreement-9', versionNumber: 1, status: 'draft', createdAt: '2026-10-01T00:00:00.000Z', completedAt: null },
    { id: 'allocation-222', agreementId: 'agreement-9', versionNumber: 2, status: 'active', createdAt: '2026-10-02T00:00:00.000Z', completedAt: '2026-10-03T00:00:00.000Z' }
  ]
}

const mountTab = async (hasVersions = true) => {
  const locale = ref('en')
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
    String(input).includes('/api/completions/runtime')
      ? { item: null }
      : { ...response, versions: hasVersions ? response.versions : [] }
  ), { status: 200 })))

  const runtime = installExtensionTestUiRuntime()
  runtime.composables.useI18n = () => ({ locale, n: value => String(value) })
  runtime.components.CommonDetailWorkspace = Workspace
  runtime.components.CommonDetailPage = DetailPage
  runtime.components.CommonWorkflowSupplementaryInformation = SupplementaryInformation

  const wrapper = mount(defineComponent({
    props: { recordId: { type: String, default: 'allocation-111' } },
    setup: props => () => h(Suspense, null, {
      default: () => h(OutcomeAllocationDetail, {
        recordId: props.recordId,
        navigation: { collectionHref: '/en/agreements/agreement-9', recordHref: (id: string) => `/en/agreements/agreement-9/extension/gcs-outcome-cost-allocation/outcome-cost-allocation/${id}` },
        extensionKey: 'gcs-outcome-cost-allocation',
        context: {
          target: 'agreement', agencyId: 'agency-1', streamId: 'stream-1', agreementId: 'agreement-9',
          ownerType: 'fundingcaseagreement', ownerId: 'agreement-9', scope: { type: 'agency', agencyId: 'agency-1' }
        },
        config: { enabledCommitmentTypes: [], mappings: [] },
        rbac: { subject: 'agreement', action: 'read' }
      })
    })
  }))
  await flushPromises()
  return { wrapper, locale }
}

afterEach(() => {
  vi.unstubAllGlobals()
  unmountedSupplementaryIds.length = 0
  installExtensionTestUiRuntime()
})

describe('Allocation-version Supplementary Information', () => {
  it('uses package-owned bilingual navigation and gives evidence its own selected section', async () => {
    const { wrapper, locale } = await mountTab()
    expect(wrapper.get('aside nav').attributes('data-orientation')).toBe('vertical')
    expect(wrapper.get('[data-view="workflows"]').text()).toBe('Workflows')
    expect(wrapper.get('[data-view="supplementary-information"]').text()).toBe('Supplementary')
    expect(wrapper.findComponent(SupplementaryInformation).exists()).toBe(false)

    await wrapper.get('[data-view="supplementary-information"]').trigger('click')
    expect(wrapper.getComponent(SupplementaryInformation).props()).toEqual({
      entityType: 'gcs-outcome-cost-allocation:allocation-version', entityId: 'allocation-111', showHeader: false, showDescription: true
    })
    expect(wrapper.findAll('h2,h3').filter(heading => heading.text() === 'Supplementary')).toHaveLength(1)
    expect(wrapper.text()).toContain('Saved workflow answers')
    expect(wrapper.get('[data-testid="supplementary-information"]').attributes('data-extra-props')).toBe('{}')
    expect(wrapper.find('.outcome-cost-allocation-table').exists()).toBe(false)
    expect(wrapper.find('[data-view="summary"]').exists()).toBe(true)
    expect(wrapper.find('[data-view="allocation"]').exists()).toBe(true)
    expect(wrapper.find('[data-view="completion"]').exists()).toBe(true)

    locale.value = 'fr'
    await flushPromises()
    expect(wrapper.get('[data-view="workflows"]').text()).toBe('Processus')
    expect(wrapper.get('[data-view="supplementary-information"]').text()).toBe('Supplémentaire')
    expect(wrapper.get('[data-view="supplementary-information"]').attributes('aria-current')).toBe('page')
    wrapper.unmount()
  })

  it('replaces evidence identity when selecting another version without substituting the Agreement owner', async () => {
    const { wrapper } = await mountTab()
    await wrapper.get('[data-view="supplementary-information"]').trigger('click')
    const oldEvidence = wrapper.getComponent(SupplementaryInformation).element
    await wrapper.setProps({ recordId: 'allocation-222' })
    await flushPromises()

    const currentEvidence = wrapper.getComponent(SupplementaryInformation)
    expect(currentEvidence.element).not.toBe(oldEvidence)
    expect(unmountedSupplementaryIds).toEqual(['allocation-111'])
    expect(currentEvidence.props()).toEqual({
      entityType: 'gcs-outcome-cost-allocation:allocation-version', entityId: 'allocation-222', showHeader: false, showDescription: true
    })
    expect(currentEvidence.props('entityId')).not.toBe('agreement-9')
    wrapper.unmount()
  })

  it('does not request an evidence target when there is no selected allocation version', async () => {
    const { wrapper } = await mountTab(false)
    expect(wrapper.find('[data-view="supplementary-information"]').exists()).toBe(false)
    expect(wrapper.findComponent(SupplementaryInformation).exists()).toBe(false)
    wrapper.unmount()
  })
})

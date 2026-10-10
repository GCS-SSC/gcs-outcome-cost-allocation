// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, h, onUnmounted, ref, Suspense, watch } from 'vue'
import type { PropType } from 'vue'
import { installExtensionTestUiRuntime } from '@gcs-ssc/extensions/testing'
import AgreementOutcomeCostAllocationTab from '../../components/AgreementOutcomeCostAllocationTab.vue'

const unmountedSupplementaryIds: string[] = []
const SupplementaryInformation = defineComponent({
  name: 'SupplementaryInformation',
  inheritAttrs: false,
  props: {
    entityType: { type: String, required: true },
    entityId: { type: String, required: true }
  },
  setup: (props, { attrs }) => {
    const initialEntityId = props.entityId
    onUnmounted(() => unmountedSupplementaryIds.push(initialEntityId))
    return () => h('section', {
      'data-testid': 'supplementary-information',
      'data-entity-type': props.entityType,
      'data-entity-id': props.entityId,
      'data-extra-props': JSON.stringify(attrs)
    })
  }
})

const Workspace = defineComponent({
  setup: (_, { slots }) => () => h('div', [h('aside', slots.sidebar?.()), h('main', slots.default?.())])
})

const RouteTabs = defineComponent({
  props: {
    modelValue: { type: String, required: true },
    orientation: { type: String, required: true },
    items: { type: Array as PropType<Array<{ value: string, label: string }>>, required: true }
  },
  emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('nav', { 'data-orientation': props.orientation }, props.items.map(item => h('button', {
    'type': 'button',
    'data-view': item.value,
    'aria-current': item.value === props.modelValue ? 'page' : undefined,
    'onClick': () => emit('update:modelValue', item.value)
  }, item.label)))
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
  runtime.components.CommonEntityEditorWorkspace = Workspace
  runtime.components.CommonRouteTabs = RouteTabs
  runtime.components.CommonWorkflowSupplementaryInformation = SupplementaryInformation

  const wrapper = mount(defineComponent({
    setup: () => () => h(Suspense, null, {
      default: () => h(AgreementOutcomeCostAllocationTab, {
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
  it('uses package-owned bilingual navigation and preserves the allocation editor', async () => {
    const { wrapper, locale } = await mountTab()
    expect(wrapper.get('aside nav').attributes('data-orientation')).toBe('vertical')
    expect(wrapper.get('[data-view="workflows"]').text()).toBe('Workflows')
    expect(wrapper.get('[data-view="supplementary-information"]').text()).toBe('Supplementary')
    expect(wrapper.findComponent(SupplementaryInformation).exists()).toBe(false)

    await wrapper.get('[data-view="supplementary-information"]').trigger('click')
    expect(wrapper.getComponent(SupplementaryInformation).props()).toEqual({
      entityType: 'gcs-outcome-cost-allocation:allocation-version', entityId: 'allocation-111'
    })
    expect(wrapper.get('[data-testid="supplementary-information"]').attributes('data-extra-props')).toBe('{}')
    expect(wrapper.find('.outcome-cost-allocation-table').exists()).toBe(true)
    expect(wrapper.findAll('tr[role="button"]')).toHaveLength(2)

    locale.value = 'fr'
    await flushPromises()
    expect(wrapper.get('[data-view="workflows"]').text()).toBe('Flux de travail')
    expect(wrapper.get('[data-view="supplementary-information"]').text()).toBe('Supplémentaire')
    expect(wrapper.get('[data-view="supplementary-information"]').attributes('aria-current')).toBe('page')
    wrapper.unmount()
  })

  it('replaces evidence identity when selecting another version without substituting the Agreement owner', async () => {
    const { wrapper } = await mountTab()
    await wrapper.get('[data-view="supplementary-information"]').trigger('click')
    const oldEvidence = wrapper.getComponent(SupplementaryInformation).element
    await wrapper.findAll('tr[role="button"]')[1]!.trigger('click')
    await flushPromises()

    const currentEvidence = wrapper.getComponent(SupplementaryInformation)
    expect(currentEvidence.element).not.toBe(oldEvidence)
    expect(unmountedSupplementaryIds).toEqual(['allocation-111'])
    expect(currentEvidence.props()).toEqual({
      entityType: 'gcs-outcome-cost-allocation:allocation-version', entityId: 'allocation-222'
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

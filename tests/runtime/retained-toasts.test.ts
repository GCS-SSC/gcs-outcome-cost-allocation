import { expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, Suspense } from 'vue'
import UToaster from '@nuxt/ui/components/Toaster.vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import { installExtensionTestUiRuntime } from '@gcs-ssc/extensions/testing'
import { useExtensionI18n } from '@gcs-ssc/extensions/ui'
import AgreementOutcomeCostAllocationTab from '../../components/AgreementOutcomeCostAllocationTab.vue'
import { getOutcomeAllocationToastText } from '../../shared/agreement-outcome-cost-allocation-tab'
import { notifications } from '../../i18n/notifications'


it('renders retained Nuxt UI warning and success toasts after the producing component unmounts', async () => {
  const locale = ref('en')
  const producerVisible = ref(true)
  const runtime = installExtensionTestUiRuntime()
  runtime.composables.useI18n = () => ({ locale, n: value => String(value) })
  runtime.composables.useToast = useToast
  runtime.components.CommonResourceLayoutCard = defineComponent({
    emits: ['add'],
    setup: (_, { attrs, emit }) => () => h('button', { onClick: () => emit('add') }, String(attrs.buttonLabel ?? attrs['button-label']))
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    currency: 'cad', versions: [], allocations: [], budgetYears: [], hasPendingEffects: true
  }), { headers: { 'content-type': 'application/json' } })))
  const Producer = defineComponent({ setup() {
    const { locale: currentLocale } = useExtensionI18n(notifications)
    const toast = useToast()
    toast.add({ ...getOutcomeAllocationToastText(() => currentLocale.value, 'saved'), duration: 0 })
    toast.add({ ...getOutcomeAllocationToastText(() => currentLocale.value, 'deleted'), duration: 0 })
    return () => h(Suspense, null, { default: () => h(AgreementOutcomeCostAllocationTab, {
      extensionKey: 'gcs-outcome-cost-allocation', config: {}, rbac: { subject: 'agreement', action: 'update' },
      canUpdate: true, canDelete: true, canWork: true,
      context: { target: 'agreement', agreementId: '1', agencyId: '1', ownerType: 'fundingcaseagreement', ownerId: '1', scope: { type: 'agency', agencyId: '1' } }
    }) })
  } })
  const wrapper = mount(defineComponent({ setup: () => () => h(UToaster, { portal: false, duration: 0 }, { default: () => producerVisible.value ? h(Producer) : null }) }))
  try {
    await flushPromises()
    expect(wrapper.text()).toContain('Allocation saved.')
    expect(wrapper.text()).toContain('Draft allocation deleted.')
    await wrapper.findAll('button').find(button => button.text() === 'New draft')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('pending payments')
    producerVisible.value = false
    locale.value = 'fr'
    await flushPromises()
    expect(wrapper.findAll('[role="alert"][aria-live="off"]').every(node => node.attributes('aria-hidden') !== 'true')).toBe(true)
    expect(wrapper.findAll('[role="alert"][aria-live="off"]').map(node => node.text()).join(' ')).toContain('Répartition enregistrée.')
    expect(wrapper.findAll('[role="alert"][aria-live="off"]').map(node => node.text()).join(' ')).not.toContain('pending payments')
    expect(wrapper.text()).toContain('Répartition enregistrée.')
    expect(wrapper.text()).toContain('Ébauche supprimée.')
    expect(wrapper.text()).toContain('Erreur')
    expect(wrapper.text()).toContain('paiements')
    expect(wrapper.findAll('[data-slot="description"]').map(node => node.text()).join(' ')).not.toContain('pending payments')
    expect(wrapper.findAll('[data-slot="description"]').map(node => node.text()).join(' ')).not.toContain('Allocation saved.')
  } finally {
    wrapper.unmount()
    vi.unstubAllGlobals()
    installExtensionTestUiRuntime()
  }
})

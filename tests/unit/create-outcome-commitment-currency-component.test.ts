// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import CreateOutcomeCommitmentAction from '../../components/CreateOutcomeCommitmentAction.vue'

const mounted: Array<ReturnType<typeof mount>> = []
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals() })

const stubs = {
  UModal: defineComponent({ name: 'UModal', props: ['open'], emits: ['update:open'],
    setup(_, { slots }) { return () => h('div', [slots.default?.(), slots.body?.()]) } }),
  UFormField: defineComponent({ props: { label: String, required: Boolean, name: String },
    setup(props, { slots }) { return () => h('div', [h('label', `${props.label}${props.required ? ' *' : ''}`), slots.default?.()]) } }),
  USelect: defineComponent({ props: ['modelValue', 'items', 'valueKey'], emits: ['update:modelValue'],
    setup(props, { emit }) { return () => h('select', {
      value: props.modelValue, onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value)
    }, (props.items ?? []).map((item: { value: string, label: string }) => h('option', { value: item.value }, item.label))) } }),
  UButton: defineComponent({ props: ['label', 'loading', 'disabled'], emits: ['click'],
    setup(props, { emit }) { return () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, props.label) } })
}

const response = (body: unknown) => ({ ok: true, json: async () => body })
const lookup = { commitmentTypes: [{ id: '1', label_en: 'Native allocation', label_fr: 'Repartition native' }], currency: 'usd', budgetYears: [{ currency: 'usd' }] }
const createAction = (locale = 'en') => {
  vi.stubGlobal('useI18n', () => ({ locale: ref(locale) }))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  const onCreated = vi.fn()
  const wrapper = mount(CreateOutcomeCommitmentAction, { props: {
    extensionKey: 'gcs-outcome-cost-allocation', operation: 'agreement.commitments.create',
    context: { target: 'agreement', agencyId: 'agency-1', streamId: 'stream-1', agreementId: 'agreement-1',
      ownerType: 'fundingcaseagreement', ownerId: 'agreement-1', scope: { type: 'agency', agencyId: 'agency-1' } },
    agencyId: 'agency-1', streamId: 'stream-1', agreementId: 'agreement-1',
    label: { en: 'Add allocated commitment', fr: 'Ajouter un engagement reparti' }, mode: 'replace',
    config: { enabledCommitmentTypes: ['1'], mappings: [] }, rbac: { subject: 'agreement', action: 'update' }, onCreated
  }, global: { stubs } })
  mounted.push(wrapper)
  return { wrapper, onCreated }
}
const open = async (wrapper: ReturnType<typeof mount>) => {
  wrapper.findComponent({ name: 'UModal' }).vm.$emit('update:open', true)
  await flushPromises()
}

describe('Outcome generated Commitment native currency control', () => {
  it.each([['en', 'Currency', 'Add'], ['fr', 'Devise', 'Ajouter']])('labels, locks and submits the actual USD control in %s', async (locale, label, add) => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => response(init?.method === 'POST' ? { id: 'commitment-usd' } : lookup))
    vi.stubGlobal('fetch', request)
    const { wrapper, onCreated } = createAction(locale)
    await open(wrapper)
    const currency = wrapper.get('select[name="egcs_fc_currency"]')
    expect(currency.attributes()).toMatchObject({ required: '', disabled: '', 'aria-required': 'true', 'aria-label': label })
    expect(wrapper.findAll('label').some(item => item.text() === `${label} *`)).toBe(true)
    expect((currency.element as HTMLSelectElement).value).toBe('usd')
    expect(currency.findAll('option').map(item => item.text())).toEqual(['USD'])
    const addButton = wrapper.findAll('button').find(button => button.text() === add)!
    await addButton.trigger('click'); await flushPromises()
    const post = request.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post?.[0]).toBe('/api/agreements/agreement-1/commitments')
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({ egcs_fc_type: '1', egcs_fc_currency: 'usd' })
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it('blocks creation while lookup is pending, and when the required type is cleared', async () => {
    let finish!: (value: ReturnType<typeof response>) => void
    const request = vi.fn(() => new Promise<ReturnType<typeof response>>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', request)
    const { wrapper } = createAction()
    wrapper.findComponent({ name: 'UModal' }).vm.$emit('update:open', true)
    await flushPromises()
    expect(wrapper.findAll('button').at(-1)?.attributes('disabled')).toBeDefined()
    await wrapper.findAll('button').at(-1)?.trigger('click')
    expect(request).toHaveBeenCalledOnce()
    finish(response(lookup)); await flushPromises()
    const currency = wrapper.get('select[name="egcs_fc_currency"]')
    expect(currency.attributes('disabled')).toBeDefined()
    await wrapper.get('select[name="egcs_fc_type"]').setValue('')
    expect(wrapper.findAll('button').at(-1)?.attributes('disabled')).toBeDefined()
    await wrapper.findAll('button').at(-1)?.trigger('click')
    expect(request).toHaveBeenCalledOnce()
  })

  it('renders the bilingual mixed-basis rejection and leaves creation disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, statusText: 'Bad Request',
      json: async () => ({ data: { code: 'GCS_OUTCOME_COST_ALLOCATION_MIXED_CURRENCY_UNSUPPORTED' } }) })))
    const { wrapper } = createAction('fr')
    await open(wrapper)
    expect(wrapper.text()).toContain('Le budget de l entente doit utiliser sa seule devise fixe')
    const control = wrapper.get('select[name="egcs_fc_currency"]')
    expect(control.attributes('aria-invalid')).toBe('true')
    expect(control.attributes('aria-describedby')).toBe(wrapper.get('p').attributes('id'))
    expect(wrapper.findAll('button').at(-1)?.attributes('disabled')).toBeDefined()
  })

  it('ignores an old Agreement lookup after the native currency context changes', async () => {
    let finishOld!: (value: ReturnType<typeof response>) => void
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValueOnce(response({ ...lookup, currency: 'cad', budgetYears: [] }))
    vi.stubGlobal('fetch', request)
    const { wrapper } = createAction()
    wrapper.findComponent({ name: 'UModal' }).vm.$emit('update:open', true)
    await flushPromises()
    await wrapper.setProps({ agreementId: 'agreement-2' }); await flushPromises()
    expect((wrapper.get('select[name="egcs_fc_currency"]').element as HTMLSelectElement).value).toBe('cad')
    finishOld(response(lookup)); await flushPromises()
    expect((wrapper.get('select[name="egcs_fc_currency"]').element as HTMLSelectElement).value).toBe('cad')
    expect(request.mock.calls[1]?.[0]).toContain('/agreements/agreement-2/allocations')
  })
})

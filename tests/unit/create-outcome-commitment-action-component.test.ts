// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import CreateOutcomeCommitmentAction from '../../components/CreateOutcomeCommitmentAction.vue'

describe('outcome cost allocation commitment action', () => {
  it('shows extension-owned server error messages from failed commitment creation', async () => {
    vi.stubGlobal('useI18n', () => ({
      locale: { value: 'en' }
    }))
    vi.stubGlobal('useToast', () => ({
      add: vi.fn()
    }))
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({
        data: {
          code: 'GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED',
          message: 'Complete and activate a cost allocation before creating this commitment.'
        }
      })
    })))

    const wrapper = mount(CreateOutcomeCommitmentAction, {
      props: {
        extensionKey: 'gcs-outcome-cost-allocation',
        operation: 'agreement.commitments.create',
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
        agencyId: 'agency-1',
        streamId: 'stream-1',
        agreementId: 'agreement-1',
        label: {
          en: 'Add allocated commitment',
          fr: 'Ajouter un engagement reparti'
        },
        mode: 'replace',
        config: {},
        rbac: {
          subject: 'agreement',
          action: 'update'
        },
        onCreated: vi.fn()
      },
      global: {
        stubs: {
          UModal: defineComponent({
            setup(_, { slots }) {
              return () => h('div', [
                slots.default?.(),
                slots.body?.()
              ])
            }
          }),
          UFormField: defineComponent({
            setup(_, { slots }) {
              return () => h('label', slots.default?.())
            }
          }),
          USelect: defineComponent({
            props: ['modelValue'],
            emits: ['update:modelValue'],
            setup() {
              return () => h('select')
            }
          }),
          UButton: defineComponent({
            props: ['label', 'loading', 'disabled'],
            emits: ['click'],
            setup(props, { emit }) {
              return () => h('button', {
                disabled: props.disabled,
                onClick: () => emit('click')
              }, props.label)
            }
          })
        }
      }
    })

    await wrapper.findAll('button').at(-1)?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Complete and activate a cost allocation before creating this commitment.')
  })
})

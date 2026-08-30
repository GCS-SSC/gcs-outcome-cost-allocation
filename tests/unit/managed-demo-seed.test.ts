import { describe, expect, it, vi } from 'vitest'
import {
  ALLOCATION_VERSION_ENTITY_TYPE,
  seedManagedOutcomeCostAllocationDemo,
  type ManagedDemoRequest
} from '../../demo/managed-demo-seed'
import { parseAllocationMoney } from '../../shared/allocation'

const response = (body: unknown) => ({
  json: async () => body,
  ok: () => true,
  status: () => 200,
  text: async () => ''
})

describe('managed OCA demo seeding', () => {
  it('passes a full-range allocation value as exact decimal text', async () => {
    const exactFunding = parseAllocationMoney('999999999999999.99')!
    const put = vi.fn(async () => response({}))
    const post = vi.fn(async (url: string) => response(
      url.endsWith('/allocation-versions')
        ? { version: { id: 'version-1', versionNumber: 1 } }
        : {}
    ))
    const get = vi.fn(async (url: string) => {
      if (url.includes('/entity-tabs')) {
        return response({
          items: [{
            extensionKey: 'gcs-outcome-cost-allocation',
            config: {
              enabledCommitmentTypes: ['1'],
              mappings: [{
                commitmentType: '1',
                outcomeId: 'outcome-1',
                streamBudgetId: 'stream-budget-1',
                streamCommitmentId: 'stream-commitment-1'
              }]
            }
          }]
        })
      }
      if (url.includes('/completions/runtime')) {
        return response({ item: { id: 'completion-1', entityType: ALLOCATION_VERSION_ENTITY_TYPE } })
      }
      const completed = get.mock.calls.filter(([calledUrl]) => String(calledUrl).includes('/allocations')).length > 1
      return response({
        outcomes: [{ id: 'outcome-1' }],
        budgetYears: [{
          id: 'year-1',
          stream_budget_id: 'stream-budget-1',
          program_funding: exactFunding
        }],
        versions: completed ? [{ id: 'version-1', status: 'active', versionNumber: 1 }] : [],
        allocations: [],
        streamCommitments: [{ id: 'stream-commitment-1' }]
      })
    })
    const request: ManagedDemoRequest = { get, post, put }

    await expect(seedManagedOutcomeCostAllocationDemo(request, 'agreement-1')).resolves.toEqual({
      agreementId: 'agreement-1',
      versionId: 'version-1',
      versionNumber: 1
    })

    expect(put).toHaveBeenCalledWith(
      '/api/extensions/gcs-outcome-cost-allocation/agreements/agreement-1/allocations',
      expect.objectContaining({
        data: expect.objectContaining({
          allocations: [expect.objectContaining({ allocationValue: '999999999999999.99' })]
        })
      })
    )
  })
})

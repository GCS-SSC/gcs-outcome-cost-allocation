import { describe, expect, it, vi } from 'vitest'
import {
  buildOutcomeAllocationRows,
  buildSaveOutcomeAllocationsRequestBody,
  deleteOutcomeAllocationDraftVersionRequest,
  getOutcomeAllocationVersionEndpoint,
  getOutcomeAllocationVersionsEndpoint,
  getOutcomeAllocationResponseErrorMessage,
  getOutcomeAllocationToastText,
  resolveCreatedDraftVersionId,
  resolveDeletedDraftVersionId,
  resolveSelectedOutcomeAllocationVersionId,
  saveOutcomeAllocationsRequest
} from '../../shared/agreement-outcome-cost-allocation-tab'
import type {
  CostAllocationVersion,
  VersionedOutcomeAllocationInput
} from '../../shared/allocation'

const versions = [
  { id: 'active-1', status: 'active' },
  { id: 'draft-1', status: 'draft' },
  { id: 'archived-1', status: 'archived' }
] as unknown as CostAllocationVersion[]

describe('agreement outcome cost allocation tab helpers', () => {
  it('keeps the currently selected allocation version when available', () => {
    expect(resolveSelectedOutcomeAllocationVersionId('active-1', versions)).toBe('active-1')
  })

  it('prefers draft, then active, then the first available version', () => {
    expect(resolveSelectedOutcomeAllocationVersionId('', versions)).toBe('draft-1')
    expect(resolveSelectedOutcomeAllocationVersionId('', versions.filter(version => version.status !== 'draft'))).toBe('active-1')
    expect(resolveSelectedOutcomeAllocationVersionId('', [{ id: 'archived-1', status: 'archived' }] as unknown as CostAllocationVersion[]))
      .toBe('archived-1')
    expect(resolveSelectedOutcomeAllocationVersionId('', [])).toBe('')
  })

  it('extracts the most specific API error message', async () => {
    await expect(getOutcomeAllocationResponseErrorMessage(new Response(JSON.stringify({
      data: {
        message: 'Data message',
        details: [{ message: 'Detail message' }]
      },
      message: 'Top message',
      statusMessage: 'Status message'
    }), { statusText: 'Bad Request' }))).resolves.toBe('Data message')

    await expect(getOutcomeAllocationResponseErrorMessage(new Response(JSON.stringify({
      data: {
        details: [{ message: 'Detail message' }]
      }
    }), { statusText: 'Bad Request' }))).resolves.toBe('Detail message')
  })

  it('falls back to response status text when JSON parsing fails', async () => {
    await expect(getOutcomeAllocationResponseErrorMessage(new Response('{', {
      statusText: 'Bad Request'
    }))).resolves.toBe('Bad Request')
  })

  it('builds grouped allocation rows from configured associations', () => {
    const associations = [
      {
        id: 'association-1',
        commitmentType: '1',
        commitmentTypeLabel: 'Commitments',
        yearId: 'year-1',
        yearLabel: '2026-2027',
        programFunding: 1000,
        streamBudgetId: 'budget-1',
        streamCommitmentId: 'commitment-1',
        commitmentLineLabel: 'GL 100',
        outcomeId: 'outcome-1',
        outcomeLabel: 'Outcome 1'
      },
      {
        id: 'association-2',
        commitmentType: '1',
        commitmentTypeLabel: 'Commitments',
        yearId: 'year-1',
        yearLabel: '2026-2027',
        programFunding: 1000,
        streamBudgetId: 'budget-1',
        streamCommitmentId: 'commitment-2',
        commitmentLineLabel: 'GL 200',
        outcomeId: 'outcome-2',
        outcomeLabel: 'Outcome 2'
      }
    ] as const

    expect(buildOutcomeAllocationRows([...associations], {
      isExpanded: () => true,
      recordsLabel: 'records'
    })).toEqual([
      expect.objectContaining({
        id: 'type:1',
        rowType: 'commitmentType',
        associationCount: 2
      }),
      expect.objectContaining({
        id: 'year:1:year-1',
        rowType: 'fiscalYear',
        associationCount: 2,
        programFunding: 1000
      }),
      expect.objectContaining({
        id: 'association-1',
        rowType: 'association',
        association: associations[0]
      }),
      expect.objectContaining({
        id: 'association-2',
        rowType: 'association',
        association: associations[1]
      })
    ])
  })

  it('omits collapsed allocation child rows', () => {
    const association = {
      id: 'association-1',
      commitmentType: '1',
      commitmentTypeLabel: 'Commitments',
      yearId: 'year-1',
      yearLabel: '2026-2027',
      programFunding: 1000,
      streamBudgetId: 'budget-1',
      streamCommitmentId: 'commitment-1',
      commitmentLineLabel: 'GL 100',
      outcomeId: 'outcome-1',
      outcomeLabel: 'Outcome 1'
    } as const

    expect(buildOutcomeAllocationRows([association], {
      isExpanded: groupId => groupId !== 'type:1',
      recordsLabel: 'records'
    })).toEqual([
      expect.objectContaining({
        id: 'type:1',
        rowType: 'commitmentType'
      })
    ])
  })

  it('builds allocation version endpoints from the allocations endpoint', () => {
    expect(getOutcomeAllocationVersionsEndpoint('/api/extensions/ext/agreements/1/allocations'))
      .toBe('/api/extensions/ext/agreements/1/allocation-versions')
    expect(getOutcomeAllocationVersionEndpoint('/api/extensions/ext/agreements/1/allocations', 'version-1'))
      .toBe('/api/extensions/ext/agreements/1/allocation-versions/version-1')
  })

  it('updates selected draft versions after create and delete responses', () => {
    expect(resolveCreatedDraftVersionId('current', {
      version: { id: 'draft-1', status: 'draft' } as CostAllocationVersion
    })).toBe('draft-1')
    expect(resolveCreatedDraftVersionId('current', {})).toBe('current')
    expect(resolveDeletedDraftVersionId('draft-1', 'draft-1')).toBe('')
    expect(resolveDeletedDraftVersionId('active-1', 'draft-1')).toBe('active-1')
  })

  it('builds save request bodies for active allocations', () => {
    const allocations = [{
      allocationVersionId: 'version-1',
      commitmentType: '1',
      agreementBudgetFiscalYearId: 'year-1',
      streamCommitmentId: 'commitment-1',
      outcomeId: 'outcome-1',
      allocationMethod: 'amount',
      allocationValue: 10
    }] as const

    expect(buildSaveOutcomeAllocationsRequestBody('version-1', [...allocations])).toEqual({
      allocationVersionId: 'version-1',
      allocations
    })
  })

  it('sends save requests with the selected allocation version payload', async () => {
    const allocations: VersionedOutcomeAllocationInput[] = [{
      allocationVersionId: 'version-1',
      commitmentType: '1',
      agreementBudgetFiscalYearId: 'year-1',
      streamCommitmentId: 'commitment-1',
      outcomeId: 'outcome-1',
      allocationMethod: 'amount',
      allocationValue: 10
    }]
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

    await expect(saveOutcomeAllocationsRequest('/allocations', 'version-1', allocations, fetcher)).resolves.toBeUndefined()

    expect(fetcher).toHaveBeenCalledWith('/allocations', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        allocationVersionId: 'version-1',
        allocations
      })
    })
  })

  it('raises API response messages from save requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { message: 'Cannot save allocations' }
    }), {
      status: 400,
      statusText: 'Bad Request'
    }))

    await expect(saveOutcomeAllocationsRequest('/allocations', 'version-1', [], fetcher))
      .rejects.toThrow('Cannot save allocations')
  })

  it('sends draft delete requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

    await expect(deleteOutcomeAllocationDraftVersionRequest('/allocation-versions/version-1', fetcher))
      .resolves.toBeUndefined()

    expect(fetcher).toHaveBeenCalledWith('/allocation-versions/version-1', { method: 'DELETE' })
  })

  it('returns localized outcome allocation toast text', () => {
    expect(getOutcomeAllocationToastText('en', 'saved')).toEqual({
      title: 'Success',
      description: 'Allocation saved.'
    })
    expect(getOutcomeAllocationToastText('fr', 'deleted')).toEqual({
      title: 'Succes',
      description: 'Brouillon supprime.'
    })
    expect(getOutcomeAllocationToastText('en', 'error')).toEqual({
      title: 'Error',
      description: ''
    })
  })
})

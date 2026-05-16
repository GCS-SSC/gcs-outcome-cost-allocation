import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'

const routeMocks = vi.hoisted(() => ({
  asOutcomeCostAllocationDb: vi.fn((db: unknown) => ({ wrapped: db })),
  completeAllocationVersion: vi.fn()
}))

vi.mock('../../server/db', () => ({
  asOutcomeCostAllocationDb: routeMocks.asOutcomeCostAllocationDb
}))

vi.mock('../../server/allocation-data', () => ({
  completeAllocationVersion: routeMocks.completeAllocationVersion
}))

const buildEvent = () => ({
  context: {
    $db: { raw: true },
    params: {
      agreementId: 'agreement-1',
      allocationVersionId: 'allocation-version-1'
    },
    gcsExtension: {
      config: {
        enabledCommitmentTypes: ['commitment']
      },
      entity: {
        streamId: 'stream-1'
      }
    }
  }
}) as H3Event & {
  context: {
    $db: unknown
    params: Record<string, string>
    gcsExtension: {
      config: unknown
      entity: {
        streamId: string
      }
    }
  }
}

describe('outcome allocation version completion route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the completed allocation version', async () => {
    const route = (await import('../../server/api/allocation-version-complete.post')).default
    const version = {
      id: 'allocation-version-1',
      agreementId: 'agreement-1',
      status: 'active',
      versionNumber: 2
    }
    routeMocks.completeAllocationVersion.mockResolvedValue(version)

    await expect(route(buildEvent())).resolves.toEqual({
      ok: true,
      version
    })
    expect(routeMocks.asOutcomeCostAllocationDb).toHaveBeenCalledWith({ raw: true })
    expect(routeMocks.completeAllocationVersion).toHaveBeenCalledWith(
      { wrapped: { raw: true } },
      'agreement-1',
      'stream-1',
      'allocation-version-1',
      { enabledCommitmentTypes: ['commitment'] }
    )
  })

  it('throws a localized extension user error for allocation validation issues', async () => {
    const route = (await import('../../server/api/allocation-version-complete.post')).default
    routeMocks.completeAllocationVersion.mockRejectedValue(Object.assign(new Error('invalid'), {
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING',
        path: 'years.2025',
        message: 'Year missing'
      }]
    }))

    await expect(route(buildEvent())).rejects.toMatchObject({
      name: 'GcsExtensionUserError',
      statusCode: 400,
      code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING',
      localizedMessage: {
        en: 'The full agreement budget must be allocated.',
        fr: 'Le budget complet de l entente doit etre reparti.'
      },
      details: [{
        path: 'years.2025',
        code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING',
        message: {
          en: 'The full agreement budget must be allocated.',
          fr: 'Le budget complet de l entente doit etre reparti.'
        }
      }]
    })
  })

  it('uses the default allocation code when validation issues are empty', async () => {
    const route = (await import('../../server/api/allocation-version-complete.post')).default
    routeMocks.completeAllocationVersion.mockRejectedValue(Object.assign(new Error('invalid'), {
      issues: []
    }))

    await expect(route(buildEvent())).rejects.toMatchObject({
      name: 'GcsExtensionUserError',
      statusCode: 400,
      code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      localizedMessage: {
        en: 'Outcome cost allocations are invalid.',
        fr: 'Les repartitions des couts par resultat sont invalides.'
      },
      details: []
    })
  })

  it('rethrows non-allocation errors', async () => {
    const route = (await import('../../server/api/allocation-version-complete.post')).default
    const error = new Error('database failed')
    routeMocks.completeAllocationVersion.mockRejectedValue(error)

    await expect(route(buildEvent())).rejects.toBe(error)
  })
})

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { GcsExtensionRouteContext } from '@gcs-ssc/extensions/server'

const routeMocks = vi.hoisted(() => ({
  asOutcomeCostAllocationDb: vi.fn((db: unknown) => ({ wrapped: db })),
  saveAndCompleteAllocationVersionWithCurrentConfiguration: vi.fn()
}))

vi.mock('@gcs-ssc/extensions/server', async () => {
  const actual = await vi.importActual<typeof import('@gcs-ssc/extensions/server')>(
    '@gcs-ssc/extensions/server'
  )

  return {
    ...actual,
    defineGcsExtensionRouteHandler: (handler: unknown) => handler
  }
})

vi.mock('../../server/db', () => ({
  asOutcomeCostAllocationDb: routeMocks.asOutcomeCostAllocationDb
}))

vi.mock('../../server/allocation-data', () => ({
  saveAndCompleteAllocationVersionWithCurrentConfiguration:
    routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration
}))

const allocations = [{
  commitmentType: '1' as const,
  streamCommitmentId: 'stream-commitment-1',
  agreementBudgetFiscalYearId: 'year-1',
  outcomeId: 'outcome-1',
  allocationMethod: 'amount' as const,
  allocationValue: 100
}]

const buildContext = (
  body: unknown = { allocations }
): GcsExtensionRouteContext => ({
  event: {
    context: {
      $db: { raw: true }
    }
  },
  db: { raw: true },
  params: {
    agreementId: 'agreement-1',
    allocationVersionId: 'allocation-version-1'
  },
  config: {
    enabledCommitmentTypes: ['1']
  },
  writeAuthorization: {
    lockAuthState: vi.fn(async () => undefined),
    authorizeCurrentEntity: vi.fn(async () => undefined)
  },
  entity: {
    agencyId: 'agency-1',
    streamId: 'stream-1'
  },
  readBody: async <T>() => body as T,
  getHeader: () => undefined
})

const invokeRoute = async <T>(
  route: unknown,
  context: GcsExtensionRouteContext
): Promise<T> => await (
  route as unknown as (routeContext: GcsExtensionRouteContext) => Promise<T>
)(context)

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
    routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration.mockResolvedValue(version)

    await expect(invokeRoute(route, buildContext())).resolves.toEqual({
      ok: true,
      version
    })
    expect(routeMocks.asOutcomeCostAllocationDb).toHaveBeenCalledWith({ raw: true })
    expect(routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration).toHaveBeenCalledWith(
      { wrapped: { raw: true } },
      'agreement-1',
      'agency-1',
      'stream-1',
      'allocation-version-1',
      allocations,
      expect.objectContaining({
        lockAuthState: expect.any(Function),
        authorizeCurrentEntity: expect.any(Function)
      })
    )
  })

  it('throws a localized extension user error for allocation validation issues', async () => {
    const route = (await import('../../server/api/allocation-version-complete.post')).default
    routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration.mockRejectedValue(Object.assign(new Error('invalid'), {
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_YEAR_MISSING',
        path: 'years.2025',
        message: 'Year missing'
      }]
    }))

    await expect(invokeRoute(route, buildContext())).rejects.toMatchObject({
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
    routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration.mockRejectedValue(Object.assign(new Error('invalid'), {
      issues: []
    }))

    await expect(invokeRoute(route, buildContext())).rejects.toMatchObject({
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
    routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration.mockRejectedValue(error)

    await expect(invokeRoute(route, buildContext())).rejects.toBe(error)
  })

  it('translates a known completion database conflict to a bilingual user error', async () => {
    const route = (await import('../../server/api/allocation-version-complete.post')).default
    routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration.mockRejectedValue({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_version_transition_guard',
      message: 'private trigger detail'
    })

    await expect(invokeRoute(route, buildContext())).rejects.toMatchObject({
      name: 'GcsExtensionUserError',
      code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT',
      message: 'The cost allocation changed while this request was being processed. Refresh and try again.',
      details: [{
        path: 'allocationVersionId',
        code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT'
      }]
    })
  })

  it('rejects malformed atomic completion payloads before writing', async () => {
    const route = (await import('../../server/api/allocation-version-complete.post')).default

    await expect(invokeRoute(route, buildContext({ allocations: [{}] }))).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      details: [{
        path: 'allocations.0.commitmentType'
      }]
    })
    expect(routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration).not.toHaveBeenCalled()
  })

  it.each([
    null,
    '',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '0.00001',
    '-1',
    '900719925474.0992',
    '999999999999999.9999'
  ])(
    'rejects unsafe allocation numeric input %s before atomic completion writes',
    async allocationValue => {
      const route = (await import('../../server/api/allocation-version-complete.post')).default

      await expect(invokeRoute(route, buildContext({
        allocations: [{
          ...allocations[0],
          allocationValue
        }]
      }))).rejects.toMatchObject({
        code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
        details: [{
          path: 'allocations.0.allocationValue'
        }]
      })
      expect(routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration).not.toHaveBeenCalled()
    }
  )

  it('accepts the largest scale-four value that remains exact in the public number contract', async () => {
    const route = (await import('../../server/api/allocation-version-complete.post')).default
    routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration.mockResolvedValue({
      id: 'allocation-version-1',
      agreementId: 'agreement-1',
      status: 'active',
      versionNumber: 1
    })

    await expect(invokeRoute(route, buildContext({
      allocations: [{
        ...allocations[0],
        allocationValue: '900719925474.0991'
      }]
    }))).resolves.toMatchObject({ ok: true })
    expect(routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration).toHaveBeenCalledWith(
      expect.anything(),
      'agreement-1',
      'agency-1',
      'stream-1',
      'allocation-version-1',
      [expect.objectContaining({
        allocationValue: 900719925474.0991
      })],
      expect.objectContaining({
        lockAuthState: expect.any(Function),
        authorizeCurrentEntity: expect.any(Function)
      })
    )
  })

  it('rejects percentages above one hundred before financial resolution', async () => {
    const route = (await import('../../server/api/allocation-version-complete.post')).default

    await expect(invokeRoute(route, buildContext({
      allocations: [{
        ...allocations[0],
        allocationMethod: 'percentage',
        allocationValue: 100.0001
      }]
    }))).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID',
      details: [{
        path: 'allocations.0.allocationValue'
      }]
    })
    expect(routeMocks.saveAndCompleteAllocationVersionWithCurrentConfiguration).not.toHaveBeenCalled()
  })
})

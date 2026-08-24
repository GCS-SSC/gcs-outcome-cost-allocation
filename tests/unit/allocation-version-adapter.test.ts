import { beforeEach, describe, expect, it, vi } from 'vitest'

const completeMock = vi.fn()
const activateMock = vi.fn()
const configMock = vi.fn()

vi.mock('@gcs-ssc/extensions/server', () => ({
  defineGcsLifecycleEntityAdapter: (value: unknown) => value,
  createGcsExtensionUserError: (options: Record<string, unknown>) => Object.assign(new Error(String(options.code)), options)
}))

vi.mock('../../server/db', () => ({ asOutcomeCostAllocationDb: (value: unknown) => value }))
vi.mock('../../server/allocation-data', () => ({
  activateAllocationVersionInTransaction: (...args: unknown[]) => activateMock(...args),
  completeAllocationVersionInTransaction: (...args: unknown[]) => completeMock(...args),
  lockAndGetOutcomeCostAllocationConfig: (...args: unknown[]) => configMock(...args)
}))

const record = {
  id: 'version-1',
  agreement_id: 'agreement-1',
  agency_id: 'agency-1',
  stream_id: 'stream-1',
  lifecycle_status_id: 'status-1',
  status: 'draft'
}

const makeDb = (options: { missingVersion?: boolean, missingStatus?: boolean } = {}) => {
  const queryFor = (table: string) => {
    const query = new Proxy({}, {
      get: (_target, property) => {
        if (property === 'executeTakeFirst') {
          return async () => table.includes('versions')
            ? (options.missingVersion ? undefined : record)
            : (options.missingStatus ? undefined : { egcs_cn_readonly: false, egcs_cn_terminal: false, egcs_cn_isdraft: true })
        }
        if (property === 'executeTakeFirstOrThrow' || property === 'execute') return async () => ({})
        return () => query
      }
    })
    return query
  }
  return {
    selectFrom: (table: string) => queryFor(table),
    updateTable: (table: string) => queryFor(table)
  }
}

const lockedEntity = {
  record: {
    id: 'version-1', agreementId: 'agreement-1', agencyId: 'agency-1', streamId: 'stream-1',
    lifecycleStatusId: 'status-1', domainStatus: 'draft'
  }
}

describe('allocation version lifecycle adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configMock.mockResolvedValue({ mappings: [] })
    completeMock.mockResolvedValue(undefined)
  })

  it('resolves the inherited Agreement owner, scope, status, and locked record', async () => {
    const adapter = (await import('../../server/allocation-version-adapter')).default
    const context = { transaction: makeDb() }
    const target = { entityType: 'gcs-outcome-cost-allocation:allocation-version', entityId: 'version-1' } as const

    await expect(adapter.registerIdentity()).resolves.toBeUndefined()
    await expect(adapter.resolveOwner(context as never, target)).resolves.toMatchObject({
      owner: 'agreement', ownerId: 'agreement-1', agencyId: 'agency-1', streamId: 'stream-1'
    })
    await expect(adapter.resolveScope(context as never, target)).resolves.toMatchObject({
      agencyId: 'agency-1', streamId: 'stream-1'
    })
    await expect(adapter.resolveStatus(context as never, target)).resolves.toEqual({
      statusId: 'status-1', readOnly: false, terminal: false, isDraft: true
    })
    await expect(adapter.lockEntity(context as never, target)).resolves.toMatchObject({
      assignmentMode: 'inherited', record: { id: 'version-1' }
    })
  })

  it('validates Completion with locked configuration and localizes domain issues', async () => {
    const adapter = (await import('../../server/allocation-version-adapter')).default
    const context = { transaction: makeDb() }
    await adapter.validateCompletion(context as never, { lockedEntity } as never)
    expect(completeMock).toHaveBeenCalledWith(expect.anything(), 'agreement-1', 'stream-1', 'version-1', { mappings: [] }, {
      agencyId: 'agency-1', streamId: 'stream-1'
    }, false)

    completeMock.mockRejectedValueOnce(Object.assign(new Error('invalid'), {
      issues: [{ code: 'GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID', path: 'allocations' }]
    }))
    await expect(adapter.validateCompletion(context as never, { lockedEntity } as never)).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_TOTAL_INVALID'
    })

    completeMock.mockRejectedValueOnce(new Error('unexpected completion failure'))
    await expect(adapter.validateCompletion(context as never, { lockedEntity } as never))
      .rejects.toThrow('unexpected completion failure')
  })

  it('delegates status mutation and positive terminus activation', async () => {
    const adapter = (await import('../../server/allocation-version-adapter')).default
    const context = { transaction: makeDb() }
    await adapter.mutateStatus(context as never, { lockedEntity, nextStatusId: 'status-2' } as never)
    await adapter.onPositiveTerminus(context as never, { lockedEntity } as never)
    expect(activateMock).toHaveBeenCalledWith(expect.anything(), 'agreement-1', 'version-1')
  })

  it('returns null for missing lifecycle records and rejects unavailable configuration', async () => {
    const adapter = (await import('../../server/allocation-version-adapter')).default
    const target = { entityType: 'gcs-outcome-cost-allocation:allocation-version', entityId: 'missing' } as const
    const missingContext = { transaction: makeDb({ missingVersion: true }) }
    await expect(adapter.resolveOwner(missingContext as never, target)).resolves.toBeNull()
    await expect(adapter.resolveScope(missingContext as never, target)).resolves.toBeNull()
    await expect(adapter.resolveStatus(missingContext as never, target)).resolves.toBeNull()
    await expect(adapter.lockEntity(missingContext as never, target)).resolves.toBeNull()

    configMock.mockResolvedValueOnce(null)
    await expect(adapter.validateCompletion({ transaction: makeDb() } as never, { lockedEntity } as never))
      .rejects.toThrow('configuration is unavailable')
  })
})

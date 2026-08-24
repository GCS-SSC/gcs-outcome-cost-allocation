import { defineGcsLifecycleEntityAdapter } from '@gcs-ssc/extensions/server'
import type { Transaction } from 'kysely'
import { asOutcomeCostAllocationDb } from './db.ts'
import {
  activateAllocationVersionInTransaction,
  completeAllocationVersionInTransaction,
  lockAndGetOutcomeCostAllocationConfig
} from './allocation-data.ts'
import { createAllocationValidationUserError } from './errors.ts'
import type { AllocationValidationIssue } from '../shared/allocation.ts'

type LockedVersion = {
  id: string
  agreementId: string
  agencyId: string
  streamId: string
  lifecycleStatusId: string
  domainStatus: 'draft' | 'active' | 'inactive'
}

const loadLockedVersion = async (transaction: Transaction<unknown>, entityId: string): Promise<LockedVersion | null> => {
  const db = asOutcomeCostAllocationDb(transaction)
  const row = await db
    .selectFrom('extensions.gcs_outcome_cost_allocation_versions as allocation_version')
    .innerJoin(
      'Funding_Case_Agreement_Profile',
      'Funding_Case_Agreement_Profile.id',
      'allocation_version.agreement_id'
    )
    .innerJoin(
      'Transfer_Payment_Stream',
      'Transfer_Payment_Stream.id',
      'Funding_Case_Agreement_Profile.egcs_fc_transferpaymentstream'
    )
    .innerJoin(
      'Transfer_Payment_Profile',
      'Transfer_Payment_Profile.id',
      'Transfer_Payment_Stream.egcs_tp_transferpaymentprofile'
    )
    .where('allocation_version.id', '=', entityId)
    .where('allocation_version._deleted', '=', false)
    .where('Funding_Case_Agreement_Profile._deleted', '=', false)
    .where('Transfer_Payment_Stream._deleted', '=', false)
    .where('Transfer_Payment_Profile._deleted', '=', false)
    .select([
      'allocation_version.id',
      'allocation_version.agreement_id',
      'allocation_version.lifecycle_status_id',
      'allocation_version.status',
      'Funding_Case_Agreement_Profile.egcs_fc_transferpaymentstream as stream_id',
      'Transfer_Payment_Profile.egcs_tp_agency as agency_id'
    ])
    .forUpdate('allocation_version')
    .executeTakeFirst()
  return row
    ? {
        id: String(row.id),
        agreementId: String(row.agreement_id),
        agencyId: String(row.agency_id),
        streamId: String(row.stream_id),
        lifecycleStatusId: String(row.lifecycle_status_id),
        domainStatus: row.status
      }
    : null
}

const adapter = defineGcsLifecycleEntityAdapter({
  registerIdentity: async () => undefined,
  resolveOwner: async (context, target) => {
    const record = await loadLockedVersion(context.transaction, target.entityId)
    return record ? { owner: 'agreement' as const, ownerId: record.agreementId, agencyId: record.agencyId, streamId: record.streamId } : null
  },
  resolveScope: async (context, target) => {
    const record = await loadLockedVersion(context.transaction, target.entityId)
    return record ? {
      agencyId: record.agencyId,
      streamId: record.streamId,
      scope: {
        type: 'entity' as const,
        agencyId: record.agencyId,
        path: [{ type: 'transferpaymentstream', id: record.streamId }]
      }
    } : null
  },
  resolveStatus: async (context, target) => {
    const db = asOutcomeCostAllocationDb(context.transaction)
    const record = await loadLockedVersion(context.transaction, target.entityId)
    if (!record) return null
    const status = await db.selectFrom('Common_Status').selectAll().where('id', '=', record.lifecycleStatusId).executeTakeFirst()
    return status ? {
      statusId: record.lifecycleStatusId,
      readOnly: status.egcs_cn_readonly,
      terminal: status.egcs_cn_terminal,
      isDraft: status.egcs_cn_isdraft
    } : null
  },
  lockEntity: async (context, target) => {
    const record = await loadLockedVersion(context.transaction, target.entityId)
    if (!record) return null
    const db = asOutcomeCostAllocationDb(context.transaction)
    const status = await db.selectFrom('Common_Status').selectAll().where('id', '=', record.lifecycleStatusId).executeTakeFirst()
    if (!status) return null
    return {
      target,
      owner: { owner: 'agreement' as const, ownerId: record.agreementId, agencyId: record.agencyId, streamId: record.streamId },
      scope: {
        agencyId: record.agencyId,
        streamId: record.streamId,
        scope: {
          type: 'entity' as const,
          agencyId: record.agencyId,
          path: [{ type: 'transferpaymentstream', id: record.streamId }]
        }
      },
      status: {
        statusId: record.lifecycleStatusId,
        readOnly: status.egcs_cn_readonly,
        terminal: status.egcs_cn_terminal,
        isDraft: status.egcs_cn_isdraft
      },
      assignmentMode: 'inherited' as const,
      record
    }
  },
  validateCompletion: async (context, completion) => {
    const record = completion.lockedEntity.record as LockedVersion
    const db = asOutcomeCostAllocationDb(context.transaction)
    const config = await lockAndGetOutcomeCostAllocationConfig(db, record.agencyId, record.streamId)
    if (config === null) throw new Error('Outcome cost allocation configuration is unavailable.')
    try {
      await completeAllocationVersionInTransaction(
        db,
        record.agreementId,
        record.streamId,
        record.id,
        config,
        { agencyId: record.agencyId, streamId: record.streamId },
        false
      )
    } catch (error: unknown) {
      const issues = error instanceof Error
        ? (error as Error & { issues?: unknown }).issues
        : undefined
      if (Array.isArray(issues)) {
        throw createAllocationValidationUserError(issues as AllocationValidationIssue[])
      }
      throw error
    }
  },
  mutateStatus: async (context, mutation) => {
    const record = mutation.lockedEntity.record as LockedVersion
    await asOutcomeCostAllocationDb(context.transaction)
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({ lifecycle_status_id: mutation.nextStatusId })
      .where('id', '=', record.id)
      .where('_deleted', '=', false)
      .executeTakeFirstOrThrow()
  },
  onPositiveTerminus: async (context, terminus) => {
    const record = terminus.lockedEntity.record as LockedVersion
    await activateAllocationVersionInTransaction(asOutcomeCostAllocationDb(context.transaction), record.agreementId, record.id)
  }
})

export default adapter

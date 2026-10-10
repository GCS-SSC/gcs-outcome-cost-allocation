import type { GcsCodingAllocator } from '@gcs-ssc/extensions/server'
import { sql } from 'kysely'
import { asOutcomeCostAllocationDb } from './db.ts'
import { createOutcomeCostAllocationUserError } from './errors.ts'
import { databaseNumericText, parseDatabaseMoney } from './numeric.ts'
import {
  allocatePaymentAmountToCommitmentLines,
  fromCents,
  parseOutcomeCostAllocationConfig,
  toCents
} from '../shared/allocation.ts'

/** Splits only unpaid funds; existing paid coding remains a host-enforced floor. */
const allocator: GcsCodingAllocator = async context => {
  if (context.output.kind !== 'commitment' && context.output.kind !== 'payment') return null
  const { commitmentTypeId } = context.output
  if (!parseOutcomeCostAllocationConfig(context.config).enabledCommitmentTypes.includes(commitmentTypeId)) return null

  const catalogIds = new Set(context.codingLines.map(line => line.codingLineId))
  if (context.output.kind === 'payment') {
    const candidates = context.codingAvailableAmounts
      .filter(line => catalogIds.has(line.codingLineId))
      .map(line => ({ commitmentLineId: line.codingLineId, weightAmount: line.amount, remainingAmount: line.amount }))
    const split = allocatePaymentAmountToCommitmentLines(candidates, context.amount)
    if (split.reduce((sum, line) => sum + toCents(line.paymentAmount), BigInt(0)) !== toCents(context.amount)) {
      throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING', 'paymentAmount')
    }
    return split.map(line => ({ codingLineId: line.commitmentLineId, amount: line.paymentAmount }))
  }

  const db = asOutcomeCostAllocationDb(context.db)
  const version = await db.selectFrom('extensions.gcs_outcome_cost_allocation_versions')
    .select('id').where('agreement_id', '=', context.agreementId).where('status', '=', 'active')
    .where('_deleted', '=', false).executeTakeFirst()
  if (!version) throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED', 'allocationVersion')

  const rows = await db.selectFrom('extensions.gcs_outcome_cost_allocation_allocations')
    .select(['stream_commitment_id', databaseNumericText(sql.ref('resolved_amount')).as('amount')])
    .where('allocation_version_id', '=', String(version.id)).where('agreement_id', '=', context.agreementId)
    .where('commitment_type', '=', commitmentTypeId).where('_deleted', '=', false)
    .orderBy('stream_commitment_id').execute()
  const weights = new Map<string, bigint>()
  for (const row of rows) {
    if (row.amount === null) throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_INVALID', 'allocations')
    const amount = toCents(parseDatabaseMoney(row.amount))
    const codingId = String(row.stream_commitment_id)
    if (amount > BigInt(0) && !catalogIds.has(codingId)) {
      throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_INACTIVE', 'allocations')
    }
    if (catalogIds.has(codingId)) weights.set(codingId, (weights.get(codingId) ?? BigInt(0)) + amount)
  }
  if (!weights.size) throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING', 'allocations')

  const paid = new Map<string, bigint>()
  for (const line of context.existingLines) {
    const amount = toCents(line.paidAmount)
    if (amount > BigInt(0)) paid.set(line.codingLineId, (paid.get(line.codingLineId) ?? BigInt(0)) + amount)
  }
  for (const floor of context.codingPaidFloors) {
    const amount = toCents(floor.paidAmount)
    if (amount > (paid.get(floor.codingLineId) ?? BigInt(0))) paid.set(floor.codingLineId, amount)
  }
  const unpaid = toCents(context.amount) - [...paid.values()].reduce((sum, amount) => sum + amount, BigInt(0))
  if (unpaid < BigInt(0)) {
    throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE', 'amount')
  }
  const split = allocatePaymentAmountToCommitmentLines([...weights].map(([codingId, weight]) => ({
    commitmentLineId: codingId, weightAmount: fromCents(weight), remainingAmount: fromCents(unpaid)
  })), fromCents(unpaid))
  if (split.reduce((sum, line) => sum + toCents(line.paymentAmount), BigInt(0)) !== unpaid) {
    throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_LINES_MISSING', 'allocations')
  }
  for (const line of split) paid.set(line.commitmentLineId, (paid.get(line.commitmentLineId) ?? BigInt(0)) + toCents(line.paymentAmount))
  // Retain selected zero coding so a zero-total Commitment can still complete.
  for (const codingId of weights.keys()) if (!paid.has(codingId)) paid.set(codingId, BigInt(0))
  return [...paid].map(([codingLineId, amount]) => ({ codingLineId, amount: fromCents(amount) }))
}

export default allocator

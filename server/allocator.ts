import type { GcsCodingAllocator } from '@gcs-ssc/extensions/server'
import { sql } from 'kysely'
import { createGcsExtensionUserError, getExtensionKvEntry, setExtensionKvEntry } from '@gcs-ssc/extensions/server'
import { allocateCreditMemo } from './credit-memo-allocation.ts'
import { AgencyCodingSchema, RetainedAgencyCodingSchema, splitAgencyCoding } from '../shared/agency-coding.ts'
import { asOutcomeCostAllocationDb } from './db.ts'
import { createOutcomeCostAllocationUserError } from './errors.ts'
import { databaseNumericText, parseDatabaseMoney } from './numeric.ts'
import {
  allocatePaymentAmountToCommitmentLines,
  fromCents,
  parseOutcomeCostAllocationConfig,
  toCents
} from '../shared/allocation.ts'

/**
 * Splits only unpaid funds; existing paid coding remains a host-enforced floor.
 * @param context Authoritative host financial context.
 * @returns Exact coding or null for unmanaged outputs.
 */
const allocator: GcsCodingAllocator = async context => {
  if (context.output.kind === 'credit-memo') return await allocateCreditMemo(context)
  if (context.output.kind === 'receivable') {
    const output = context.output
    const invalid = () => createGcsExtensionUserError({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID', statusCode: 400,
      message: { en: 'Configure a valid Agency coding set for this fiscal year and make its accounts available in this Stream.', fr: 'Configurez un ensemble valide de codes de l’agence pour cet exercice et rendez ses comptes disponibles dans ce volet.' } })
    const fiscalYearId = output.fiscalYearId ?? ''
    if (!fiscalYearId) throw invalid()
    let policy
    if (context.retainedPolicy) {
      const retained = RetainedAgencyCodingSchema.safeParse(context.retainedPolicy)
      if (!retained.success || retained.data.kind !== output.kind || retained.data.currency !== context.currency
        || retained.data.fiscalYearId !== fiscalYearId) throw invalid()
      policy = retained.data
    } else {
      const config = AgencyCodingSchema.safeParse(context.agencyConfig)
      if (!config.success) throw invalid()
      const sets = config.data.receivableSets.filter(set => set.fiscalYearId === fiscalYearId && set.currency === context.currency)
      const set = sets[0]
      if (sets.length !== 1 || !set) throw invalid()
      policy = { version: 1 as const, kind: output.kind, currency: context.currency, lines: set.lines, fiscalYearId }
    }
    // Retained v1 policy IDs are Agency account identities; only returned coding uses Stream selection IDs.
    const streamIds = new Map<string, string>()
    for (const line of policy.lines) {
      const matches = context.codingLines.filter(account => account.agencyChartOfAccountId === line.codingLineId)
      if (matches.length !== 1 || matches[0]!.agencyFiscalYearId !== fiscalYearId) throw invalid()
      streamIds.set(line.codingLineId, matches[0]!.codingLineId)
    }
    return { lines: splitAgencyCoding(policy.lines, context.amount).map(line => ({ ...line, codingLineId: streamIds.get(line.codingLineId)! })), policy }
  }
  const { commitmentTypeId } = context.output
  if (!parseOutcomeCostAllocationConfig(context.config).enabledCommitmentTypes.includes(commitmentTypeId)) return null

  const catalogIds = new Set(context.codingLines.map(line => line.codingLineId))
  const isPayment = context.output.kind === 'payment'
  const paymentYearId = context.output.kind === 'payment' ? context.output.fiscalYearId : null
  const missingPaymentMatrix = () => createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_PAYMENT_MATRIX_REQUIRED')
  const db = asOutcomeCostAllocationDb(context.db)
  const commitmentId = context.output.commitmentId
  if (!commitmentId) throw isPayment ? missingPaymentMatrix() : createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_INVALID', 'commitmentId')
  if (isPayment && !paymentYearId) throw missingPaymentMatrix()
  const kvDb = context.db as unknown as Parameters<typeof getExtensionKvEntry>[0]
  const pinned = await getExtensionKvEntry(kvDb, 'gcs-outcome-cost-allocation', 'fundingcaseagreementcommitment', commitmentId, 'allocation-version')
  const pinnedVersionId = pinned && typeof pinned === 'object' && !Array.isArray(pinned) ? pinned.versionId : null
  if (isPayment && (typeof pinnedVersionId !== 'string' || !/^[1-9]\d{0,18}$/.test(pinnedVersionId)
    || BigInt(pinnedVersionId) > BigInt('9223372036854775807'))) throw missingPaymentMatrix()
  if (pinned !== null && typeof pinnedVersionId !== 'string') throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_INVALID', 'allocationVersion')
  let versionQuery = db.selectFrom('extensions.gcs_outcome_cost_allocation_versions')
    .select('id').where('agreement_id', '=', context.agreementId).where('_deleted', '=', false)
  versionQuery = typeof pinnedVersionId === 'string' ? versionQuery.where('id', '=', pinnedVersionId) : versionQuery.where('status', '=', 'active')
  if (isPayment) versionQuery = versionQuery.where('status', 'in', ['active', 'inactive'])
  const version = await versionQuery.executeTakeFirst()
  if (!version && isPayment) throw missingPaymentMatrix()
  if (!version) throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_ACTIVE_REQUIRED', 'allocationVersion')

  let allocationQuery = db.selectFrom('extensions.gcs_outcome_cost_allocation_allocations')
    .select(['stream_commitment_id', databaseNumericText(sql.ref('resolved_amount')).as('amount')])
    .where('allocation_version_id', '=', String(version.id)).where('agreement_id', '=', context.agreementId)
    .where('commitment_type', '=', commitmentTypeId).where('_deleted', '=', false)
    .orderBy('stream_commitment_id')
  if (isPayment) allocationQuery = allocationQuery.where('agreement_budget_fiscal_year_id', '=', paymentYearId!)
  const rows = await allocationQuery.execute()
  if (isPayment && rows.length === 0) throw missingPaymentMatrix()
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

  if (isPayment) {
    const available = new Map(context.codingAvailableAmounts.map(line => [line.codingLineId, line.amount]))
    const split = allocatePaymentAmountToCommitmentLines([...weights].map(([codingId, weight]) => ({
      commitmentLineId: codingId, weightAmount: fromCents(weight), remainingAmount: available.get(codingId) ?? '0.00'
    })), context.amount)
    if (split.reduce((sum, line) => sum + toCents(line.paymentAmount), BigInt(0)) !== toCents(context.amount)) {
      throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING', 'paymentAmount')
    }
    return split.map(line => ({ codingLineId: line.commitmentLineId, amount: line.paymentAmount }))
  }

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
  if (pinned === null) await setExtensionKvEntry(kvDb, 'gcs-outcome-cost-allocation', 'fundingcaseagreementcommitment', commitmentId, 'allocation-version', { versionId: String(version.id) })
  return [...paid].map(([codingLineId, amount]) => ({ codingLineId, amount: fromCents(amount) }))
}

export default allocator

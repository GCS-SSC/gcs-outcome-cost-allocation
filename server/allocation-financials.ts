import type { GcsExtensionAgreementFinancials } from '@gcs-ssc/extensions/server'
import type { Transaction } from 'kysely'
import { fromCents, sumMoney, toCents } from '../shared/allocation.ts'
import type { AgreementBudgetYear } from './allocation-data.ts'
import { createOutcomeCostAllocationUserError } from './errors.ts'

export type AllocationFinancials = Pick<GcsExtensionAgreementFinancials, 'getCostAllocationContext'>
export type AllocationFinancialContext = Awaited<ReturnType<AllocationFinancials['getCostAllocationContext']>>

/** The host owns paid attribution; outcome weights never reconstruct historical spending. */
export const applyRemainingFunding = (
  years: AgreementBudgetYear[],
  context: AllocationFinancialContext
): AgreementBudgetYear[] => years.map(year => {
  const paid = sumMoney(context.codingPaidAmounts
    .filter(line => line.agencyFiscalYearId === String(year.fiscal_year_id))
    .map(line => line.paidAmount))
  const remaining = toCents(year.program_funding) - toCents(paid)
  return { ...year, paid_amount: paid, remaining_funding: fromCents(remaining > BigInt(0) ? remaining : BigInt(0)) }
})

export const getAllocationFinancialContext = async (
  financials: AllocationFinancials,
  transaction?: Transaction<unknown>
): Promise<AllocationFinancialContext> => await financials.getCostAllocationContext({ transaction })

export const assertNoPendingAllocationEffects = (context: AllocationFinancialContext): void => {
  if (context.hasPendingEffects) {
    throw createOutcomeCostAllocationUserError('GCS_OUTCOME_COST_ALLOCATION_PENDING_EFFECTS', 'allocations')
  }
}

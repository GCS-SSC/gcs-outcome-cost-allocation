import { sql } from 'kysely'
import { z } from 'zod'
import { createGcsExtensionUserError, type GcsExtensionConfigurationGuardContext } from '@gcs-ssc/extensions/server'
import { AgencyCodingSchema } from '../shared/agency-coding.ts'
import { EXTENSION_KEY } from '../shared/allocation.ts'

export const guardOutcomeCostAllocationConfiguration = async (context: GcsExtensionConfigurationGuardContext) => {
  if (context.targetExtensionKey !== EXTENSION_KEY || !context.enabled) return
  if (context.scope === 'stream') {
    await guardStreamMappings(context)
    return
  }
  if (context.scope !== 'agency') return
  const result = AgencyCodingSchema.safeParse(context.config ?? {})
  const invalid = () => createGcsExtensionUserError({
    code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID', statusCode: 400,
    message: {
      en: 'Coding sets and remap exceptions must contain distinct destination accounts totaling 100%. Year/currency sets must be unique. Credit memo exceptions for the same commitment account and currency must not overlap. Accounts must be active and match the Agency, currency, kind and applicable fiscal year.',
      fr: 'Les ensembles et les exceptions doivent contenir des comptes de destination distincts totalisant 100 %. Les ensembles exercice/devise doivent être uniques. Les exceptions de notes de crédit pour le même compte d’engagement et la même devise ne doivent pas se chevaucher. Les comptes doivent être actifs et correspondre à l’agence, à la devise, au type et à l’exercice applicable.'
    }
  })
  if (!result.success) throw invalid()
  for (const set of result.data.receivableSets) {
    if (!context.codingAccounts) throw invalid()
    const accounts = await context.codingAccounts.list({ kind: 'account_receivable', currency: set.currency, agencyFiscalYearId: set.fiscalYearId })
    if (set.lines.some(line => !accounts.some(account => account.codingLineId === line.codingLineId))) throw invalid()
  }
  for (const rule of result.data.creditMemoRules) {
    if (!context.codingAccounts) throw invalid()
    const sources = await context.codingAccounts.list({ kind: 'commitment', currency: rule.currency })
    if (!sources.some(account => account.codingLineId === rule.commitmentCodingLineId)) throw invalid()
    const accounts = await context.codingAccounts.list({ kind: 'credit_memo', currency: rule.currency })
    if (rule.lines.some(line => !accounts.some(account => account.codingLineId === line.codingLineId))) throw invalid()
  }
}

const identity = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value) <= BigInt('9223372036854775807'))
const streamConfiguration = z.object({
  enabledCommitmentTypes: z.array(identity).default([]),
  mappings: z.array(z.object({ commitmentType: identity, outcomeId: identity, streamBudgetId: identity, streamCommitmentId: identity })).default([])
})

/** Stream mapping authoring binds its budget, coding, type and outcome to the configured owner. */
const guardStreamMappings = async (context: GcsExtensionConfigurationGuardContext): Promise<void> => {
  const invalid = () => createGcsExtensionUserError({
    code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID', statusCode: 400,
    message: {
      en: 'Each cost allocation mapping must use an active outcome, commitment type, budget and accounting line from this Stream. The accounting line and budget must have the same Agency fiscal year and currency.',
      fr: 'Chaque association doit utiliser un résultat, un type d’engagement, un budget et une ligne comptable actifs de ce volet. La ligne comptable et le budget doivent avoir le même exercice de l’agence et la même devise.'
    }
  })
  const parsed = streamConfiguration.safeParse(context.config ?? {})
  if (!parsed.success || !context.streamId) throw invalid()
  for (const type of parsed.data.enabledCommitmentTypes) {
    const result = await sql`SELECT id FROM "Transfer_Payment_Stream_Commitment_Type"
      WHERE id = ${type}::bigint AND egcs_tp_transferpaymentstream = ${context.streamId}::bigint AND NOT _deleted`.execute(context.db)
    if (!result.rows.length) throw invalid()
  }
  for (const mapping of parsed.data.mappings) {
    const result = await sql`
      SELECT 1 FROM "Transfer_Payment_Stream" stream
      JOIN "Transfer_Payment_Profile" program ON program.id = stream.egcs_tp_transferpaymentprofile AND NOT program._deleted
      JOIN "Transfer_Payment_Stream_Chart_of_Account" selection ON selection.id = ${mapping.streamCommitmentId}::bigint
        AND selection.egcs_tp_transferpaymentstream = stream.id AND NOT selection._deleted
      JOIN "Agency_Chart_of_Account" chart ON chart.id = selection.egcs_tp_agencychartofaccount
        AND chart.egcs_ay_organizationagency = program.egcs_tp_agency AND chart.egcs_ay_kind = 'commitment' AND NOT chart._deleted
      JOIN "Transfer_Payment_Stream_Budget" stream_budget ON stream_budget.id = ${mapping.streamBudgetId}::bigint
        AND stream_budget.egcs_tp_transferpaymentstream = stream.id AND NOT stream_budget._deleted
      JOIN "Transfer_Payment_Fiscal_Year_Budget" program_budget ON program_budget.id = stream_budget.egcs_tp_transferpaymentbudget
        AND program_budget.egcs_tp_transferpaymentprofile = program.id AND program_budget.egcs_tp_fiscalyear = chart.egcs_ay_fiscalyear
        AND program_budget.egcs_tp_currency = chart.egcs_ay_currency AND NOT program_budget._deleted
      JOIN "Transfer_Payment_Stream_Commitment_Type" type ON type.id = ${mapping.commitmentType}::bigint
        AND type.egcs_tp_transferpaymentstream = stream.id AND NOT type._deleted
      JOIN "Transfer_Payment_Outcome" outcome ON outcome.id = ${mapping.outcomeId}::bigint
        AND outcome.egcs_tp_transferpaymentprofile = program.id AND NOT outcome._deleted
      WHERE stream.id = ${context.streamId}::bigint AND NOT stream._deleted AND program.egcs_tp_agency = ${context.agencyId}::bigint
    `.execute(context.db)
    if (!result.rows.length) throw invalid()
  }
}

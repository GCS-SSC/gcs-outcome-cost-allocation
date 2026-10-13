import { createGcsExtensionUserError, type GcsExtensionConfigurationGuardContext } from '@gcs-ssc/extensions/server'
import { AgencyCodingSchema } from '../shared/agency-coding'
import { EXTENSION_KEY } from '../shared/allocation'

export const guardAgencyCodingConfiguration = async (context: GcsExtensionConfigurationGuardContext) => {
  if (context.targetExtensionKey !== EXTENSION_KEY || context.scope !== 'agency' || !context.enabled) return
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

import type { GcsCodingAllocatorContext, GcsCodingAllocationResult } from '@gcs-ssc/extensions/server'
import { createGcsExtensionUserError, getExtensionKvEntry } from '@gcs-ssc/extensions/server'
import { sql } from 'kysely'
import { z } from 'zod'
import { AgencyCodingSchema, RetainedAgencyCodingSchema, RetainedCreditMemoCodingSchema, splitAgencyCoding } from '../shared/agency-coding.ts'
import { fromCents, parseOutcomeCostAllocationConfig, toCents, toExactNumeric19Scale4Units } from '../shared/allocation.ts'
import { asOutcomeCostAllocationDb } from './db.ts'
import { databaseNumericText, parseDatabaseMoney } from './numeric.ts'

const invalid = () => createGcsExtensionUserError({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID', statusCode: 400,
  message: { en: 'The credit memo allocation policy is invalid. Check its commitment coding, override percentages and dates, and make every target account available in this Stream.',
    fr: 'La politique de répartition de la note de crédit est invalide. Vérifiez les codes d’engagement, les pourcentages de remplacement et les dates, et rendez chaque compte cible disponible dans ce volet.' } })
const missingCommitment = () => createGcsExtensionUserError({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID', statusCode: 400,
  message: { en: 'Credit memo coding requires an active committed Commitment managed by Outcome Cost Allocation.',
    fr: 'Les codes de note de crédit nécessitent un engagement actif et approuvé géré par la répartition des coûts par résultat.' } })
const missingMatrix = () => createGcsExtensionUserError({ code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID', statusCode: 400,
  message: { en: 'The active Commitment has no valid retained cost allocation matrix. Create and commit a Commitment using a completed matrix.',
    fr: 'L’engagement actif ne possède aucune matrice de répartition des coûts conservée valide. Créez et approuvez un engagement à partir d’une matrice terminée.' } })
/**
 * Explains which source coding needs an account link or explicit override.
 * @param agencyChartOfAccountId Source Agency Commitment account.
 * @param ambiguous Whether several accounts match instead of none.
 * @returns A bilingual actionable configuration error.
 */
const missingLink = (agencyChartOfAccountId: string, ambiguous: boolean) => createGcsExtensionUserError({
  code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID', statusCode: 400,
  message: ambiguous
    ? { en: `More than one Stream-available credit memo account links to commitment coding account ${agencyChartOfAccountId}. Configure a dated override to select the coding.`,
        fr: `Plusieurs comptes de note de crédit disponibles dans ce volet sont liés au compte d’engagement ${agencyChartOfAccountId}. Configurez un remplacement daté pour choisir les codes.` }
    : { en: `No Stream-available credit memo account links to commitment coding account ${agencyChartOfAccountId}. Link an account or configure a dated override.`,
        fr: `Aucun compte de note de crédit disponible dans ce volet n’est lié au compte d’engagement ${agencyChartOfAccountId}. Liez un compte ou configurez un remplacement daté.` }
})

/**
 * Splits the complete weight vector once, retaining zero-cent selections and exact residual cents.
 * @param lines Validated positive account weights.
 * @param amount Exact Credit Memo total.
 * @returns Exact coding amounts with deterministic residual balancing.
 */
const splitWeights = (lines: Array<{ codingLineId: string; weight: string }>, amount: string) => {
  const total = toCents(amount)
  const denominator = lines.reduce((sum, line) => sum + BigInt(line.weight), BigInt(0))
  const split = lines.map(line => {
    const numerator = total * BigInt(line.weight)
    return { codingLineId: line.codingLineId, cents: numerator / denominator, remainder: numerator % denominator }
  })
  let remaining = total - split.reduce((sum, line) => sum + line.cents, BigInt(0))
  for (const line of [...split].sort((a, b) => a.remainder === b.remainder ? a.codingLineId.localeCompare(b.codingLineId) : a.remainder > b.remainder ? -1 : 1)) {
    if (remaining <= BigInt(0)) break
    line.cents += BigInt(1)
    remaining -= BigInt(1)
  }
  return split.map(line => ({ codingLineId: line.codingLineId, amount: fromCents(line.cents) }))
}

/**
 * Maps stable Agency policy identities to the host's eligible Stream selections.
 * @param context Authorized Stream account catalogue.
 * @param lines Exact allocations keyed by Agency account ID.
 * @returns Allocations keyed by Stream selection ID, rejecting unavailable or ambiguous accounts.
 */
const streamAllocations = (context: GcsCodingAllocatorContext, lines: Array<{ codingLineId: string; amount: string }>) => lines.map(line => {
  const matches = context.codingLines.filter(account => account.agencyChartOfAccountId === line.codingLineId)
  if (matches.length !== 1) throw invalid()
  return { ...line, codingLineId: matches[0]!.codingLineId }
})

/**
 * Resolves the latest committed matrix and optional source-account remaps; never uses an uncommitted matrix.
 * @param context Authoritative host financial context with optional retained policy.
 * @returns Exact Credit Memo coding and immutable allocation evidence.
 */
export const allocateCreditMemo = async (context: GcsCodingAllocatorContext): Promise<GcsCodingAllocationResult> => {
  if (context.output.kind !== 'credit-memo') throw invalid()
  const effectiveDate = context.output.effectiveDate ?? ''
  if (!z.iso.date().safeParse(effectiveDate).success) throw invalid()
  if (context.retainedPolicy) {
    const retained = RetainedCreditMemoCodingSchema.safeParse(context.retainedPolicy)
    if (retained.success) {
      if (retained.data.currency !== context.currency || retained.data.effectiveDate !== effectiveDate) throw invalid()
      return { lines: streamAllocations(context, splitWeights(retained.data.lines, context.amount)), policy: retained.data }
    }
    // Previously captured percentage policies remain immutable on amount-only draft edits.
    const legacy = RetainedAgencyCodingSchema.safeParse(context.retainedPolicy)
    if (!legacy.success || legacy.data.kind !== 'credit-memo' || legacy.data.currency !== context.currency
      || legacy.data.effectiveDate !== effectiveDate) throw invalid()
    return { lines: streamAllocations(context, splitAgencyCoding(legacy.data.lines, context.amount)), policy: legacy.data }
  }

  const config = AgencyCodingSchema.safeParse(context.agencyConfig)
  if (!config.success) throw invalid()
  const enabledTypes = parseOutcomeCostAllocationConfig(context.config).enabledCommitmentTypes
  const commitment = context.output.activeCommitments?.find(candidate => enabledTypes.includes(candidate.commitmentTypeId))
  if (!commitment) throw missingCommitment()
  const kvDb = context.db as unknown as Parameters<typeof getExtensionKvEntry>[0]
  const pinned = await getExtensionKvEntry(kvDb, 'gcs-outcome-cost-allocation', 'fundingcaseagreementcommitment', commitment.commitmentId, 'allocation-version')
  const versionId = pinned && typeof pinned === 'object' && !Array.isArray(pinned) ? pinned.versionId : null
  if (typeof versionId !== 'string' || !/^[1-9]\d{0,18}$/.test(versionId) || BigInt(versionId) > BigInt('9223372036854775807')) throw missingMatrix()
  const db = asOutcomeCostAllocationDb(context.db)
  const version = await db.selectFrom('extensions.gcs_outcome_cost_allocation_versions').select('id')
    .where('id', '=', versionId).where('agreement_id', '=', context.agreementId).where('_deleted', '=', false)
    .where('status', 'in', ['active', 'inactive']).executeTakeFirst()
  if (!version) throw missingMatrix()
  const rows = await db.selectFrom('extensions.gcs_outcome_cost_allocation_allocations')
    .select(['stream_commitment_id', databaseNumericText(sql.ref('resolved_amount')).as('amount')])
    .where('allocation_version_id', '=', String(version.id)).where('agreement_id', '=', context.agreementId)
    .where('commitment_type', '=', commitment.commitmentTypeId).where('_deleted', '=', false)
    .orderBy('stream_commitment_id').execute()
  const sources = new Map<string, bigint>()
  for (const row of rows) {
    if (row.amount === null) throw missingMatrix()
    let weight: bigint
    try {
      weight = toCents(parseDatabaseMoney(row.amount))
    } catch {
      throw missingMatrix()
    }
    if (weight === BigInt(0)) continue
    const source = context.commitmentCodingLines.find(account => account.codingLineId === String(row.stream_commitment_id))
    if (!source) throw missingMatrix()
    sources.set(source.agencyChartOfAccountId, (sources.get(source.agencyChartOfAccountId) ?? BigInt(0)) + weight)
  }
  if (!sources.size) throw missingMatrix()
  const weights = new Map<string, bigint>()
  for (const [agencyChartOfAccountId, sourceWeight] of sources) {
    const rules = config.data.creditMemoRules.filter(rule => rule.commitmentCodingLineId === agencyChartOfAccountId
      && rule.currency === context.currency && rule.startDate <= effectiveDate && effectiveDate <= rule.endDate)
    const rule = rules[0]
    const linked = rule ? [] : context.codingLines.filter(account => account.commitmentChartOfAccountId === agencyChartOfAccountId)
    if (!rule && linked.length !== 1) throw missingLink(agencyChartOfAccountId, linked.length > 1)
    // v1/v2 retained policies keep Agency account IDs, independent of Stream selection identities.
    const targets = rule?.lines ?? [{ codingLineId: linked[0]!.agencyChartOfAccountId, percentage: '100' }]
    for (const target of targets) {
      // AgencyCodingSchema already validates exact positive percentages totaling 100%.
      const percentage = toExactNumeric19Scale4Units(target.percentage)!
      weights.set(target.codingLineId, (weights.get(target.codingLineId) ?? BigInt(0)) + sourceWeight * percentage)
    }
  }
  const policy = { version: 2 as const, kind: 'credit-memo' as const, currency: context.currency, effectiveDate,
    commitmentId: commitment.commitmentId, allocationVersionId: String(version.id),
    lines: [...weights].sort(([a], [b]) => a.localeCompare(b)).map(([codingLineId, weight]) => ({ codingLineId, weight: weight.toString() })) }
  const checked = RetainedCreditMemoCodingSchema.safeParse(policy)
  if (!checked.success) throw invalid()
  return { lines: streamAllocations(context, splitWeights(checked.data.lines, context.amount)), policy: checked.data }
}

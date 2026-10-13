import { z } from 'zod'
import { fromCents, toCents, toExactNumeric19Scale4Units } from './allocation'

const id = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= BigInt('9223372036854775807'))
const percentage = z.string().refine(value => {
  const units = toExactNumeric19Scale4Units(value)
  return units !== null && units > BigInt(0) && units <= BigInt(1_000_000)
}, 'percentage')
const codingLines = z.array(z.object({ codingLineId: id, percentage })).min(1).superRefine((lines, ctx) => {
  if (lines.reduce((sum, line) => sum + (toExactNumeric19Scale4Units(line.percentage) ?? BigInt(0)), BigInt(0)) !== BigInt(1_000_000)) {
    ctx.addIssue({ code: 'custom', message: 'percentageTotal' })
  }
  if (new Set(lines.map(line => line.codingLineId)).size !== lines.length) ctx.addIssue({ code: 'custom', message: 'duplicateAccount' })
})
const date = z.iso.date()
const currency = z.string().regex(/^[a-z]{3}$/)
export const AgencyCodingSchema = z.object({
  version: z.literal(1).default(1),
  receivableSets: z.array(z.object({ fiscalYearId: id, currency, lines: codingLines })).default([]),
  creditMemoRules: z.array(z.object({ commitmentCodingLineId: id, startDate: date, endDate: date, currency, lines: codingLines })).default([])
}).superRefine((config, ctx) => {
  const keys = config.receivableSets.map(set => `${set.fiscalYearId}:${set.currency}`)
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['receivableSets'], message: 'duplicateYear' })
  config.creditMemoRules.forEach((rule, index) => {
    if (rule.startDate > rule.endDate) ctx.addIssue({ code: 'custom', path: ['creditMemoRules', index, 'endDate'], message: 'dateOrder' })
    if (config.creditMemoRules.slice(0, index).some(other => other.commitmentCodingLineId === rule.commitmentCodingLineId && other.currency === rule.currency && other.startDate <= rule.endDate && rule.startDate <= other.endDate)) {
      ctx.addIssue({ code: 'custom', path: ['creditMemoRules', index], message: 'overlap' })
    }
  })
})
export type AgencyCodingConfig = z.infer<typeof AgencyCodingSchema>
export type AgencyCodingLine = AgencyCodingConfig['receivableSets'][number]['lines'][number]
export const emptyAgencyCodingConfig = (): AgencyCodingConfig => ({ version: 1, receivableSets: [], creditMemoRules: [] })

/** Largest-remainder balancing retains exact percentages, including rounded-zero lines. */
export const splitAgencyCoding = (lines: AgencyCodingLine[], amount: string) => {
  const total = toCents(amount)
  const denominator = BigInt(1_000_000)
  const split = lines.map(line => {
    const numerator = total * (toExactNumeric19Scale4Units(line.percentage) ?? BigInt(0))
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

export const RetainedAgencyCodingSchema = z.object({
  version: z.literal(1), kind: z.enum(['receivable', 'credit-memo']), currency,
  fiscalYearId: id.optional(), effectiveDate: date.optional(), lines: codingLines
})

export const RetainedCreditMemoCodingSchema = z.object({
  version: z.literal(2), kind: z.literal('credit-memo'), currency, effectiveDate: date,
  commitmentId: id, allocationVersionId: id,
  lines: z.array(z.object({ codingLineId: id, weight: z.string().regex(/^[1-9]\d*$/) })).min(1)
    .refine(lines => new Set(lines.map(line => line.codingLineId)).size === lines.length, 'duplicateAccount')
})

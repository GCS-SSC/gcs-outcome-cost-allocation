import { z } from 'zod'
import { MoneySchema } from '@gcs-ssc/extensions/money'
import { parseAllocationPercentage } from '../shared/allocation.ts'

const MAX_POSTGRES_BIGINT_TEXT = '9223372036854775807'

const isPositivePostgresBigintText = (value: string): boolean =>
  /^[1-9]\d*$/.test(value)
  && (value.length < MAX_POSTGRES_BIGINT_TEXT.length
    || (value.length === MAX_POSTGRES_BIGINT_TEXT.length && value <= MAX_POSTGRES_BIGINT_TEXT))

export const AllocationPercentageSchema = z.unknown().transform((value, context) => {
  const percentage = parseAllocationPercentage(value)
  if (percentage === null) {
    context.addIssue({ code: 'custom', message: 'Expected exact percentage text between 0 and 100 with at most four fractional digits.' })
    return z.NEVER
  }
  return percentage
})

/** Canonical positive decimal identity accepted by PostgreSQL signed bigint columns. */
export const PositivePostgresBigintIdSchema = z.preprocess(
  value => {
    if (typeof value === 'string') return value.trim()
    if (typeof value === 'bigint') return String(value)
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
    return value
  },
  z.string().refine(isPositivePostgresBigintText)
)

export const AgreementRouteParamsSchema = z.object({
  agreementId: PositivePostgresBigintIdSchema
})

export const AllocationVersionRouteParamsSchema = AgreementRouteParamsSchema.extend({
  allocationVersionId: PositivePostgresBigintIdSchema
})

const OutcomeAllocationCoordinatesSchema = z.object({
  commitmentType: PositivePostgresBigintIdSchema,
  streamCommitmentId: PositivePostgresBigintIdSchema,
  agreementBudgetFiscalYearId: PositivePostgresBigintIdSchema,
  outcomeId: PositivePostgresBigintIdSchema
})
export const OutcomeAllocationRequestSchema = z.discriminatedUnion('allocationMethod', [
  OutcomeAllocationCoordinatesSchema.extend({ allocationMethod: z.literal('amount'), allocationValue: MoneySchema.refine(value => !value.amount.startsWith('-'), 'Expected nonnegative money.') }),
  OutcomeAllocationCoordinatesSchema.extend({ allocationMethod: z.literal('percentage'), allocationValue: AllocationPercentageSchema })
])

export const SaveAllocationsRequestSchema = z.object({
  allocationVersionId: PositivePostgresBigintIdSchema,
  allocations: z.array(OutcomeAllocationRequestSchema)
}).superRefine((request, context) => {
  const seenCoordinates = new Set<string>()
  request.allocations.forEach((allocation, index) => {
    const coordinate = [
      allocation.commitmentType,
      allocation.streamCommitmentId,
      allocation.agreementBudgetFiscalYearId,
      allocation.outcomeId
    ].join(':')
    if (seenCoordinates.has(coordinate)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocations', index],
        message: 'Duplicate allocation coordinate.'
      })
    }
    seenCoordinates.add(coordinate)
  })
})

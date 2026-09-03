import { z } from 'zod'
import { parseExactNumeric19Scale4, toExactNumeric19Scale4Units } from '../shared/allocation.ts'

const MAX_POSTGRES_BIGINT_TEXT = '9223372036854775807'

const isPositivePostgresBigintText = (value: string): boolean =>
  /^[1-9]\d*$/.test(value)
  && (value.length < MAX_POSTGRES_BIGINT_TEXT.length
    || (value.length === MAX_POSTGRES_BIGINT_TEXT.length && value <= MAX_POSTGRES_BIGINT_TEXT))

const addInvalidNumericIssue = (context: z.RefinementCtx) => {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Expected a non-negative numeric(19,4) value.'
  })
}

export const Numeric19Scale4Schema = z
  .unknown()
  .superRefine((value, context) => {
    if (parseExactNumeric19Scale4(value) === null) {
      addInvalidNumericIssue(context)
    }
  })
  .transform(value => parseExactNumeric19Scale4(value)!)

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

const OutcomeAllocationRequestBaseSchema = z.object({
  commitmentType: PositivePostgresBigintIdSchema,
  streamCommitmentId: PositivePostgresBigintIdSchema,
  agreementBudgetFiscalYearId: PositivePostgresBigintIdSchema,
  outcomeId: PositivePostgresBigintIdSchema,
  allocationMethod: z.enum(['amount', 'percentage']),
  allocationValue: Numeric19Scale4Schema
})

export const OutcomeAllocationRequestSchema = OutcomeAllocationRequestBaseSchema.superRefine((allocation, context) => {
  if (allocation.allocationMethod === 'percentage'
    && (toExactNumeric19Scale4Units(allocation.allocationValue) ?? BigInt(0)) > BigInt(1_000_000)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allocationValue'],
      message: 'Expected a percentage between 0 and 100.'
    })
  }
})

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

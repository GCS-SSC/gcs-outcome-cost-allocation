import { z } from 'zod'
import { parseExactNumeric19Scale4 } from '../shared/allocation'

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
  .transform(value => parseExactNumeric19Scale4(value) as number)

const RequiredIdSchema = z.union([
  z.string().trim().min(1),
  z.number().int().positive()
]).transform(value => String(value))

const OutcomeAllocationRequestBaseSchema = z.object({
  commitmentType: z.enum(['commitment', 'paye', 'paye2', 'pyp']),
  streamCommitmentId: RequiredIdSchema,
  agreementBudgetFiscalYearId: RequiredIdSchema,
  outcomeId: RequiredIdSchema,
  allocationMethod: z.enum(['amount', 'percentage']),
  allocationValue: Numeric19Scale4Schema
})

export const OutcomeAllocationRequestSchema = OutcomeAllocationRequestBaseSchema.superRefine((allocation, context) => {
  if (allocation.allocationMethod === 'percentage' && allocation.allocationValue > 100) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allocationValue'],
      message: 'Expected a percentage between 0 and 100.'
    })
  }
})

export const SaveAllocationsRequestSchema = z.object({
  allocationVersionId: RequiredIdSchema,
  allocations: z.array(OutcomeAllocationRequestSchema)
})

export const CompleteAllocationsRequestSchema = z.object({
  allocations: z.array(OutcomeAllocationRequestSchema)
})

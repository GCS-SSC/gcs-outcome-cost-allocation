import type { z } from 'zod'
import { createOutcomeCostAllocationUserError } from './errors.ts'
import {
  AgreementRouteParamsSchema,
  AllocationVersionRouteParamsSchema,
  SaveAllocationsRequestSchema
} from './allocation-request-schema.ts'

const parseRequest = <TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown
): z.output<TSchema> => {
  const result = schema.safeParse(value)
  if (result.success) return result.data

  const path = result.error.issues[0]?.path
    .map(segment => String(segment))
    .join('.')
  throw createOutcomeCostAllocationUserError(
    'GCS_OUTCOME_COST_ALLOCATION_INVALID',
    path
  )
}

/** Validates and normalizes an Agreement route identity before extension SQL. */
export const parseAgreementRouteParams = (value: unknown) =>
  parseRequest(AgreementRouteParamsSchema, value)

/** Validates and normalizes Agreement/allocation-version route identities before extension SQL. */
export const parseAllocationVersionRouteParams = (value: unknown) =>
  parseRequest(AllocationVersionRouteParamsSchema, value)

/** Validates and normalizes a save request before extension SQL. */
export const parseSaveAllocationsRequest = (value: unknown) =>
  parseRequest(SaveAllocationsRequestSchema, value)

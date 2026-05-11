/* eslint-disable jsdoc/require-jsdoc */
import type { H3Event } from 'h3'
import { z } from 'zod'
import { readBody } from 'h3'
import { asOutcomeCostAllocationDb } from '../db'
import { saveAllocations } from '../allocation-data'

const AllocationSchema = z.object({
  commitmentType: z.enum(['commitment', 'paye', 'paye2', 'pyp']),
  streamCommitmentId: z.string().min(1),
  agreementBudgetFiscalYearId: z.string().min(1),
  outcomeId: z.string().min(1),
  allocationMethod: z.enum(['amount', 'percentage']),
  allocationValue: z.coerce.number().nonnegative()
})

const SaveAllocationsSchema = z.object({
  allocationVersionId: z.string().min(1),
  allocations: z.array(AllocationSchema)
})

type AllocationPutEvent = H3Event & {
  context: {
    $db: unknown
    params?: Record<string, string | undefined>
    gcsExtension?: {
      entity?: {
        streamId?: string
      }
    }
  }
}

export default async (event: AllocationPutEvent) => {
  const body = SaveAllocationsSchema.parse(await readBody(event))
  const agreementId = event.context.params?.agreementId ?? ''
  const db = asOutcomeCostAllocationDb(event.context.$db)

  await saveAllocations(db, agreementId, body.allocationVersionId, body.allocations)

  return {
    ok: true
  }
}

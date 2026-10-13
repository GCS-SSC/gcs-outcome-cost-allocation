import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('loads native server modules and rejects a Payment without a matrix-backed Commitment', async () => {
  const script = `
    const { default: allocator } = await import('./server/allocator.ts');
    await import('./server/plugins/create-hooks.ts');
    const assert = await import('node:assert/strict');
    await assert.rejects(() => allocator({
      output: { kind: 'payment', commitmentTypeId: '1' },
      config: { enabledCommitmentTypes: ['1'], mappings: [] },
      codingLines: [{ codingLineId: '10' }],
      codingAvailableAmounts: [{ codingLineId: '10', amount: '100.00' }],
      amount: '25.00', currency: 'cad'
    }), { code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_MATRIX_REQUIRED' });
    console.log('matrix required');
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url))
  })
  expect(stdout.trim()).toBe('matrix required')
})

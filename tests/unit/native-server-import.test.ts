import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('loads the native server modules and allocates a Payment without bundler import resolution', async () => {
  const script = `
    const { default: allocator } = await import('./server/allocator.ts');
    await import('./server/plugins/create-hooks.ts');
    const result = await allocator({
      output: { kind: 'payment', commitmentTypeId: '1' },
      config: { enabledCommitmentTypes: ['1'], mappings: [] },
      codingLines: [{ codingLineId: '10' }],
      codingAvailableAmounts: [{ codingLineId: '10', amount: '100.00' }],
      amount: '25.00', currency: 'cad'
    });
    console.log(JSON.stringify(result));
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url))
  })
  expect(JSON.parse(stdout)).toEqual([{ codingLineId: '10', amount: '25.00' }])
})

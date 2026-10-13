import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { configureSingleApprovalSubmission, completeAndApprove, deleteUnsubmittedCommitmentDrafts } from './correction-fixture'
import type { AgencyCodingConfig } from '../../shared/agency-coding'

interface Owner { agreementId: string; agencyId: string; programId: string; streamId: string }
interface Dependencies {
  login: (page: Page, email: string) => Promise<void>
  createManagedAgreement: (page: Page, proponentId?: string, financialId?: string) => Promise<Owner>
  createAllocationVersion: (page: Page, agreementId: string) => Promise<string>
}
const read = async <T>(response: APIResponse): Promise<T> => {
  expect(response.ok(), `${response.url()}: ${response.status()} ${await response.text()}`).toBe(true)
  return await response.json() as T
}
interface Id { id: string }
interface CreditMemo {
  id: string; egcs_fc_receiveddate: string; egcs_fc_amount: string
  egcs_fc_lines: Array<{ egcs_fc_creditmemochartofaccount: string; egcs_fc_commitmentchartofaccount: string | null; egcs_fc_amount: string }>
}

/** Runs the owning policy through real host allocation, approval and recovery APIs. */
export const registerAgencyCodingJourney = (deps: Dependencies) => {
  test('Committed matrix coding and dated remaps retain exact cash and offset recovery', async ({ page, browser }) => {
    test.setTimeout(240_000)
    page.setDefaultTimeout(15_000)
    await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }))
    await deps.login(page, 'root@example.com')
    const token = String(Date.now())
    const proponent = await read<Id>(await page.request.post('/api/applicant-recipients', { data: {
      egcs_ar_legalname_en: `Agency coding ${token}`, egcs_ar_legalname_fr: `Codification de l’agence ${token}`,
      egcs_ar_operatingname_en: `Agency coding ${token}`, egcs_ar_description_en: 'Independent automatic coding acceptance.',
      egcs_ar_description_fr: 'Validation indépendante de la codification automatique.', egcs_ar_leadagency: '21', egcs_ar_active: true
    } }))
    const financial = await read<Id>(await page.request.post(`/api/applicant-recipients/${proponent.id}/agency-financial-ids`, { data: {
      egcs_ar_agency: '21', egcs_ar_financialsystemid: token, egcs_ar_active: true
    } }))
    const owner = await deps.createManagedAgreement(page, String(proponent.id), String(financial.id))
    const approver = await browser.newPage()
    await deps.login(approver, 'user03@example.com')
    try {
      const statuses = await read<Array<{ id: string; agencyId: string; nameEn: string }>>(await page.request.get('/api/statuses'))
      const status = (name: string) => {
        const match = statuses.find(item => item.agencyId === owner.agencyId && item.nameEn === name)
        expect(match, `Agency status ${name}`).toBeTruthy()
        return match!.id
      }
      const workflow = async (entityType: string, success: string) => configureSingleApprovalSubmission(page, owner, entityType, status('Draft'), status(success), status('Cancelled'))
      await workflow('fundingcaseagreement', 'Active')
      await completeAndApprove(page, approver, 'fundingcaseagreement', owner.agreementId)
      await deleteUnsubmittedCommitmentDrafts(page, owner)
      await read(await page.request.patch(`/api/extensions/streams/${owner.streamId}`, { data: { extensionKey: 'gcs-automated-payments', enabled: false } }))

      const base = `/api/agreements/${owner.agreementId}`
      const allocationsUrl = `/api/extensions/gcs-outcome-cost-allocation/agreements/${owner.agreementId}/allocations`
      const inputs = await read<{
        commitmentTypes: Id[]; outcomes: Id[]; budgetYears: Array<{ id: string; fiscal_year_id: string; stream_budget_id: string; remaining_funding: string }>;
        streamCommitments: Array<{ id: string; stream_budget_id: string }>
      }>(await page.request.get(allocationsUrl))
      const year = inputs.budgetYears.find(item => item.remaining_funding === '100.00')!
      expect(year).toBeTruthy()
      const code = inputs.streamCommitments.find(item => item.stream_budget_id === year.stream_budget_id)!
      const type = inputs.commitmentTypes[0]!.id
      const outcome = inputs.outcomes[0]!.id
      await read(await page.request.patch(`/api/extensions/streams/${owner.streamId}`, { data: {
        extensionKey: 'gcs-outcome-cost-allocation', enabled: true, config: { enabledCommitmentTypes: [type], mappings: [{ commitmentType: type, streamCommitmentId: code.id, streamBudgetId: year.stream_budget_id, outcomeId: outcome }] }
      } }))
      const version = await deps.createAllocationVersion(page, owner.agreementId)
      await read(await page.request.put(allocationsUrl, { data: { allocationVersionId: version, allocations: [{ commitmentType: type, streamCommitmentId: code.id, agreementBudgetFiscalYearId: year.id, outcomeId: outcome, allocationMethod: 'amount', allocationValue: '100.00' }] } }))
      await workflow('gcs-outcome-cost-allocation:allocation-version', 'Committed')
      await completeAndApprove(page, approver, 'gcs-outcome-cost-allocation:allocation-version', version)
      const commitment = await read<Id>(await page.request.post(`${base}/commitments`, { data: { egcs_fc_type: type, egcs_fc_currency: 'cad', egcs_fc_totalamount: '100.00' } }))
      await workflow('fundingcaseagreementcommitment', 'Committed')
      await completeAndApprove(page, approver, 'fundingcaseagreementcommitment', commitment.id)
      const streamAccounts = await read<{ items: Array<{ id: string; egcs_tp_agencychartofaccount: string }> }>(await page.request.get(`/api/transfer-payments/${owner.programId}/streams/${owner.streamId}/chart-of-accounts?limit=100`))
      const commitmentAccount = String(streamAccounts.items.find(item => String(item.id) === code.id)!.egcs_tp_agencychartofaccount)
      const makeAccount = async (kind: 'account_receivable' | 'credit_memo', fiscalYearId: string, label: string, link: string | null = null) => String((await read<Id>(await page.request.post(`/api/agency/${owner.agencyId}/chart-of-accounts`, { data: {
        egcs_ay_kind: kind, egcs_ay_fiscalyear: fiscalYearId, egcs_ay_currency: 'cad', egcs_ay_commitmentchartofaccount: link,
        egcs_ay_accountingdimensions: [{ label_en: 'Automatic coding', label_fr: 'Codification automatique', value: `${label}-${token}` }]
      } }))).id)
      const arAccount = await makeAccount('account_receivable', year.fiscal_year_id, 'AR')
      const creditAccounts = await read<{ items: Array<{ id: string; egcs_ay_commitmentchartofaccount: string | null; egcs_ay_accountingdimensions: Array<{ label_en: string; value: string }> }> }>(await page.request.get(`/api/agency/${owner.agencyId}/chart-of-accounts?kind=credit_memo&limit=100`))
      const linkedAccounts = creditAccounts.items.filter(account => String(account.egcs_ay_commitmentchartofaccount) === commitmentAccount)
      expect(linkedAccounts).toHaveLength(1)
      const linkedAccount = String(linkedAccounts[0]!.id)
      const linkedLabel = linkedAccounts[0]!.egcs_ay_accountingdimensions.map(dimension => `${dimension.label_en}: ${dimension.value}`).join(', ')
      const commitmentCatalog = await read<{ items: Array<{ id: string; egcs_ay_accountingdimensions: Array<{ label_en: string; value: string }> }> }>(await page.request.get(`/api/agency/${owner.agencyId}/chart-of-accounts?kind=commitment&limit=100`))
      const commitmentLabel = commitmentCatalog.items.find(account => String(account.id) === commitmentAccount)!.egcs_ay_accountingdimensions.map(dimension => `${dimension.label_en}: ${dimension.value}`).join(', ')
      const fiscalYears = await read<{ items: Array<{ id: string }> }>(await page.request.get(`/api/agency/${owner.agencyId}/fiscal-years?limit=100`))
      const streamBudgets = await read<{ items: Array<{ egcs_tp_fiscalyear: string; egcs_tp_currency: string }> }>(await page.request.get(`/api/transfer-payments/${owner.programId}/streams/${owner.streamId}/budgets?limit=100`))
      const otherYear = fiscalYears.items.find(item => String(item.id) !== year.fiscal_year_id && streamBudgets.items.some(budget => String(budget.egcs_tp_fiscalyear) === String(item.id) && budget.egcs_tp_currency === 'cad'))!
      expect(otherYear, 'Catch-all account uses another fiscal year available in the Stream budget').toBeTruthy()
      const catchAll = await makeAccount('credit_memo', String(otherYear.id), 'catch-all')
      const streamAccountsUrl = `/api/transfer-payments/${owner.programId}/streams/${owner.streamId}/chart-of-accounts`
      const selectAccount = async (agencyAccount: string) => String((await read<Id>(await page.request.post(streamAccountsUrl, { data: { egcs_tp_agencychartofaccount: agencyAccount } }))).id)
      const policy: AgencyCodingConfig = { version: 1,
        receivableSets: [{ fiscalYearId: year.fiscal_year_id, currency: 'cad', lines: [{ codingLineId: arAccount, percentage: '100' }] }],
        creditMemoRules: [] }
      const savePolicy = async (config: AgencyCodingConfig) => read(await page.request.patch(`/api/extensions/agency/${owner.agencyId}`, { data: { extensionKey: 'gcs-outcome-cost-allocation', enabled: true, config } }))
      await savePolicy(policy)
      await page.goto(`/en/agencies/${owner.agencyId}?section=extensions`)
      await page.getByRole('button', { name: 'Configure: Outcome cost allocation', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/en/extension/gcs-outcome-cost-allocation/agencies/${owner.agencyId}`))
      await expect(page.getByRole('dialog')).toHaveCount(0)
      const panel = page.getByRole('tabpanel')
      await expect(panel.getByRole('heading', { name: 'Accounts receivable', exact: true })).toBeVisible()
      await expect(panel.getByRole('table')).toBeVisible()
      await expect(panel.getByRole('columnheader', { name: 'Percentage', exact: true })).toBeVisible()
      const arCodingRow = panel.getByRole('row').filter({ has: page.getByRole('button', { name: /^Edit:/ }) })
      await expect(arCodingRow.getByRole('cell').nth(0)).toHaveText(/20\d{2}[–-]20\d{2}/)
      await expect(arCodingRow.getByRole('cell').nth(2)).toHaveText(`Automatic coding: AR-${token}`)
      await expect(arCodingRow.getByRole('cell').nth(3)).toHaveText('100%')
      await expect(panel.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
      await panel.getByRole('button', { name: /^Edit:/ }).click()
      const editor = page.getByRole('dialog')
      await expect(editor.getByLabel('Percentage', { exact: false })).toHaveValue('100')
      await expect(editor.getByLabel('Percentage', { exact: false })).toHaveAttribute('required', '')
      await editor.getByLabel('Percentage', { exact: false }).fill('90')
      await editor.getByRole('button', { name: 'Update', exact: true }).click()
      await expect(editor.getByRole('alert')).toContainText('allocate exactly 100%')
      await expect(editor.getByLabel('Percentage', { exact: false })).toHaveAttribute('aria-invalid', 'true')
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(editor).toHaveCount(0)
      await panel.getByRole('button', { name: /^Edit:/ }).click()
      await expect(editor.getByLabel('Percentage', { exact: false })).toHaveValue('100')
      await editor.getByLabel('Percentage', { exact: false }).fill('100.0000')
      await editor.getByRole('button', { name: 'Update', exact: true }).click()
      await expect(editor).toHaveCount(0)
      await expect(panel.getByRole('status')).toHaveText('Cost allocation settings saved.')
      policy.receivableSets[0]!.lines[0]!.percentage = '100.0000'
      await page.getByRole('tab', { name: 'Credit memos', exact: true }).click()
      await expect(panel.getByRole('heading', { name: 'Credit memos', exact: true })).toBeVisible()
      await expect(panel.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0)
      await expect(panel.getByRole('table')).toBeVisible()
      await expect(panel.getByRole('columnheader', { name: 'Source commitment coding', exact: true })).toBeVisible()
      await expect(panel.getByRole('button', { name: /^Edit:/ })).toHaveCount(0)
      const readPolicy = async () => {
        const registry = await read<{ items: Array<{ extension: { key: string }; config: AgencyCodingConfig }> }>(await page.request.get(`/api/extensions/agency/${owner.agencyId}`))
        return registry.items.find(item => item.extension.key === 'gcs-outcome-cost-allocation')!.config
      }
      await panel.getByRole('button', { name: 'Add remap exception', exact: true }).click()
      await expect(editor.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0)
      await expect(editor.getByRole('button', { name: 'Add coding line', exact: true })).toHaveCount(0)
      await editor.getByLabel('Start date (inclusive)', { exact: false }).fill('2026-10-01')
      await editor.getByLabel('End date (inclusive)', { exact: false }).fill('2027-03-31')
      const selectOption = async (label: string, option: string | RegExp) => {
        const control = editor.getByRole('combobox', { name: label, exact: false })
        await control.click()
        await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click()
        if (await control.getAttribute('aria-expanded') === 'true') await control.press('Escape')
        await expect(page.getByRole('listbox')).toHaveCount(0)
      }
      await selectOption('Currency', 'CAD')
      await selectOption('Source commitment coding', new RegExp(commitmentLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      await selectOption('Target credit memo accounts', new RegExp(`catch-all-${token}`))
      await editor.getByLabel('Percentage', { exact: false }).fill('30')
      await editor.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(editor.getByRole('alert')).toContainText('allocate exactly 100%')
      expect((await readPolicy()).creditMemoRules).toEqual([])
      await editor.getByLabel('Percentage', { exact: false }).fill('100')
      await editor.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(editor).toHaveCount(0)
      policy.creditMemoRules.push({ commitmentCodingLineId: commitmentAccount, currency: 'cad', startDate: '2026-10-01', endDate: '2027-03-31', lines: [{ codingLineId: catchAll, percentage: '100' }] })
      expect(await readPolicy()).toEqual(policy)
      await panel.getByRole('button', { name: 'Edit: 2026-10-01 – 2027-03-31', exact: true }).click()
      await editor.getByLabel('End date (inclusive)', { exact: false }).fill('2027-03-30')
      await editor.getByRole('button', { name: 'Update', exact: true }).click()
      await expect(editor).toHaveCount(0)
      await expect(panel.getByRole('status')).toHaveText('Cost allocation settings saved.')
      expect((await readPolicy()).creditMemoRules[0]!.endDate).toBe('2027-03-30')
      const priorRules = await readPolicy()
      await panel.getByRole('button', { name: 'Add remap exception', exact: true }).click()
      await editor.getByLabel('Start date (inclusive)', { exact: false }).fill('2027-04-01')
      await editor.getByLabel('End date (inclusive)', { exact: false }).fill('2027-09-30')
      await selectOption('Currency', 'CAD')
      await selectOption('Source commitment coding', new RegExp(commitmentLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      await selectOption('Target credit memo accounts', new RegExp(`catch-all-${token}`))
      await selectOption('Target credit memo accounts', new RegExp(linkedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      await editor.getByLabel(new RegExp(`Percentage.*catch-all-${token}`)).fill('30')
      await editor.getByLabel(new RegExp(`Percentage.*${linkedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).fill('70')
      await editor.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(editor).toHaveCount(0)
      expect((await readPolicy()).creditMemoRules).toEqual([...priorRules.creditMemoRules, { commitmentCodingLineId: commitmentAccount, currency: 'cad', startDate: '2027-04-01', endDate: '2027-09-30', lines: [{ codingLineId: catchAll, percentage: '30' }, { codingLineId: linkedAccount, percentage: '70' }] }])
      await panel.getByRole('button', { name: 'Delete: 2027-04-01 – 2027-09-30', exact: true }).click()
      await editor.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(editor).toHaveCount(0)
      expect(await readPolicy()).toEqual(priorRules)
      await page.reload()
      await expect(panel.getByRole('table')).toContainText('2027-03-30')
      await page.getByRole('tab', { name: 'Accounts receivable', exact: true }).click()
      await expect(panel.getByRole('table')).toContainText('100.0000%')
      await expect(panel.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`/fr/extension/gcs-outcome-cost-allocation/agences/${owner.agencyId}?section=credit-memos`)
      await expect(panel.getByRole('heading', { name: 'Notes de crédit', exact: true })).toBeVisible()
      await expect(panel.getByRole('table')).toContainText('2027-03-30')
      await panel.getByRole('button', { name: 'Modifier: 2026-10-01 – 2027-03-30', exact: true }).click()
      await expect(editor.getByLabel('Date de fin (incluse)', { exact: false })).toHaveValue('2027-03-30')
      expect(await editor.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await editor.getByLabel('Date de fin (incluse)', { exact: false }).fill('2027-03-31')
      await editor.getByRole('button', { name: 'Mettre à jour', exact: true }).click()
      await expect(editor).toHaveCount(0)
      await expect(panel.getByRole('status')).toHaveText('Paramètres de répartition des coûts enregistrés.')
      expect(await readPolicy()).toEqual(policy)
      await page.getByRole('button', { name: /Notes de crédit$/ }).click()
      await page.getByRole('tab', { name: 'Comptes débiteurs', exact: true }).filter({ visible: true }).click()
      await expect(panel.getByRole('heading', { name: 'Comptes débiteurs', exact: true })).toBeVisible()
      await page.setViewportSize({ width: 1440, height: 900 })
      expect(streamAccounts.items.some(account => [arAccount, catchAll].includes(String(account.egcs_tp_agencychartofaccount)))).toBe(false)
      const overlap = structuredClone(policy)
      overlap.creditMemoRules.push({ ...overlap.creditMemoRules[0]!, startDate: '2027-03-31', endDate: '2027-04-01' })
      expect((await page.request.patch(`/api/extensions/agency/${owner.agencyId}`, { data: { extensionKey: 'gcs-outcome-cost-allocation', enabled: true, config: overlap } })).status()).toBe(400)

      const paymentInput = { egcs_fc_commitmenttype: type, egcs_fc_fiscalyear: year.id, egcs_fc_paymenttype: 'advance', egcs_fc_periodstart: 0, egcs_fc_periodend: 2, egcs_fc_paymentamount: '80.00', egcs_fc_currency: 'cad', egcs_fc_applicantrecipient: String(proponent.id) }
      const source = await read<Id>(await page.request.post(`${base}/payments`, { data: paymentInput }))
      await workflow('fundingcasepayment', 'Paid')
      await completeAndApprove(page, approver, 'fundingcasepayment', source.id)
      const arType = await read<Id>(await page.request.post(`/api/agency/${owner.agencyId}/account-receivable-types`, { data: {
        egcs_ay_name_en: `Automatic AR ${token}`, egcs_ay_name_fr: `Créance automatique ${token}`, egcs_ay_monitorrequired: false, egcs_ay_advancepaymentrelated: true, egcs_ay_claimrelated: false
      } }))
      const debtInput = {
        egcs_fc_amount: '30.00', egcs_fc_agencyfinancialid: String(financial.id), egcs_fc_applicantrecipient: String(proponent.id), egcs_fc_agencyfiscalyear: year.fiscal_year_id, egcs_fc_type: arType.id,
        egcs_fc_sources: [`advance:${source.id}`], egcs_fc_requesteddate: '2026-10-11', egcs_fc_recoverymethod: 'offset', egcs_fc_narrative_en: 'Automatically coded paid-advance recovery.'
      }
      const debtsBefore = await read<{ items: Id[] }>(await page.request.get(`${base}/account-receivables?limit=100`))
      expect((await page.request.post(`${base}/account-receivables`, { data: debtInput })).status()).toBe(400)
      expect((await read<{ items: Id[] }>(await page.request.get(`${base}/account-receivables?limit=100`))).items).toEqual(debtsBefore.items)
      await selectAccount(arAccount)
      const debt = await read<Id>(await page.request.post(`${base}/account-receivables`, { data: debtInput }))
      const debtUrl = `/api/account-receivables/${debt.id}`
      const automaticDebt = await read<{ egcs_fc_lines: Array<{ egcs_fc_amount: string; egcs_fc_accountreceivablechartofaccount: string }> }>(await page.request.get(debtUrl))
      expect(automaticDebt.egcs_fc_lines).toMatchObject([{ egcs_fc_amount: '30.00', egcs_fc_accountreceivablechartofaccount: arAccount }])
      await workflow('fundingcaseaccountreceivable', 'Receivable established')
      await completeAndApprove(page, approver, 'fundingcaseaccountreceivable', debt.id)
      await workflow('fundingcaseaccountreceivablecreditmemo', 'Issued')
      const cashInput = (date: string, amount: string) => ({ egcs_fc_receivable: debt.id, egcs_fc_receivables: [debt.id], egcs_fc_totalamount: amount, egcs_fc_agency: owner.agencyId, egcs_fc_applicantrecipient: String(proponent.id), egcs_fc_currency: 'cad', egcs_fc_receiveddate: date, egcs_fc_reason: 'Configured Agency coding recovery.' })
      const cashUrl = '/api/account-receivable-credit-memos'
      const memoId = (await read<Id>(await page.request.post(cashUrl, { data: cashInput('2026-09-30', '10.00') }))).id
      const memo = await read<CreditMemo>(await page.request.get(`${cashUrl}/${memoId}`))
      expect(memo.egcs_fc_lines).toMatchObject([{ egcs_fc_creditmemochartofaccount: linkedAccount, egcs_fc_commitmentchartofaccount: commitmentAccount, egcs_fc_amount: '10.00' }])
      const changedPolicy = structuredClone(policy)
      changedPolicy.creditMemoRules[0]!.startDate = '2026-09-30'
      await savePolicy(changedPolicy)
      await read(await page.request.patch(`${cashUrl}/${memo.id}`, { data: cashInput('2026-09-30', '6.00') }))
      const redistributed = await read<CreditMemo>(await page.request.get(`${cashUrl}/${memo.id}`))
      expect(redistributed.egcs_fc_lines).toMatchObject([{ egcs_fc_creditmemochartofaccount: linkedAccount, egcs_fc_amount: '6.00' }])
      // Agency configuration does not make an unselected Stream destination eligible.
      expect((await page.request.patch(`${cashUrl}/${memo.id}`, { data: cashInput('2026-10-01', '6.00') })).status()).toBe(400)
      expect(await read<CreditMemo>(await page.request.get(`${cashUrl}/${memo.id}`))).toMatchObject({ egcs_fc_receiveddate: '2026-09-30', egcs_fc_lines: [{ egcs_fc_creditmemochartofaccount: linkedAccount, egcs_fc_amount: '6.00' }] })
      const catchAllSelection = await selectAccount(catchAll)
      await read(await page.request.patch(`${cashUrl}/${memo.id}`, { data: cashInput('2026-10-01', '6.00') }))
      const dateChanged = await read<CreditMemo>(await page.request.get(`${cashUrl}/${memo.id}`))
      expect(dateChanged.egcs_fc_lines).toMatchObject([{ egcs_fc_creditmemochartofaccount: catchAll, egcs_fc_commitmentchartofaccount: null, egcs_fc_amount: '6.00' }])
      const stableDraft = await deps.createAllocationVersion(page, owner.agreementId)
      await read(await page.request.delete(`/api/extensions/gcs-outcome-cost-allocation/agreements/${owner.agreementId}/allocation-versions/${stableDraft}`))
      await completeAndApprove(page, approver, 'fundingcaseaccountreceivablecreditmemo', memo.id)
      const balances = () => page.request.get(`${base}/commitment-line-balances?egcs_fc_fiscalyear=${year.id}&egcs_fc_commitmenttype=${type}`).then(read<{ lines: Array<{ egcs_fc_paidamount: string; egcs_fc_creditmemoamount: string; egcs_fc_balance: string }> }>)
      expect((await balances()).lines).toMatchObject([{ egcs_fc_paidamount: '80.00', egcs_fc_creditmemoamount: '0.00', egcs_fc_balance: '20.00' }])
      await savePolicy(policy)
      const linked = await read<CreditMemo>(await page.request.post(cashUrl, { data: cashInput('2026-09-30', '5.00') }))
      expect((await page.request.post(`/api/extensions/gcs-outcome-cost-allocation/agreements/${owner.agreementId}/allocation-versions`)).status()).toBe(400)
      await completeAndApprove(page, approver, 'fundingcaseaccountreceivablecreditmemo', linked.id)
      expect((await balances()).lines).toMatchObject([{ egcs_fc_paidamount: '75.00', egcs_fc_creditmemoamount: '5.00', egcs_fc_balance: '25.00' }])
      expect(await read(await page.request.get(debtUrl))).toMatchObject({ egcs_fc_outstanding: '19.00', egcs_fc_recovered: '11.00' })
      // Without a date exception, recovery must resolve the normal linked account.
      await read(await page.request.patch(`/api/agency/${owner.agencyId}/chart-of-accounts/${linkedAccount}`, { data: { egcs_ay_commitmentchartofaccount: null } }))
      const missingLink = await page.request.post(cashUrl, { data: cashInput('2026-09-30', '1.00') })
      expect(missingLink.status()).toBe(400)
      expect(await missingLink.json()).toMatchObject({ data: { code: 'GCS_OUTCOME_COST_ALLOCATION_CODING_CONFIGURATION_INVALID' } })
      expect(await read(await page.request.get(debtUrl))).toMatchObject({ egcs_fc_outstanding: '19.00', egcs_fc_recovered: '11.00' })
      await read(await page.request.patch(`/api/agency/${owner.agencyId}/chart-of-accounts/${linkedAccount}`, { data: { egcs_ay_commitmentchartofaccount: commitmentAccount } }))

      const offsetInput = { ...paymentInput, egcs_fc_paymenttype: 'reimbursement', egcs_fc_paymentamount: '10.00', egcs_fc_periodstart: 3, egcs_fc_periodend: 5 }
      const preview = await read<{ egcs_fc_offsetplanhash: string; egcs_fc_offsetdate: string; egcs_fc_offsetdatetoken: string; egcs_fc_offsetamount: string; egcs_fc_netamount: string; egcs_fc_creditmemos: Array<{ egcs_fc_key: string; egcs_fc_allocationmode: string; egcs_fc_lines: Array<{ egcs_fc_codingaccount: string; egcs_fc_amount: string }> }> }>(await page.request.post(`${base}/payments/preview`, { data: offsetInput }))
      expect(preview).toMatchObject({ egcs_fc_offsetamount: '10.00', egcs_fc_netamount: '0.00', egcs_fc_creditmemos: [{ egcs_fc_allocationmode: 'allocator' }] })
      expect(preview.egcs_fc_creditmemos[0]!.egcs_fc_lines).toMatchObject([{ egcs_fc_codingaccount: catchAllSelection, egcs_fc_amount: '10.00' }])
      const offsetPayment = await read<Id>(await page.request.post(`${base}/payments`, { data: { ...offsetInput, egcs_fc_offsetplanhash: preview.egcs_fc_offsetplanhash, egcs_fc_offsetdate: preview.egcs_fc_offsetdate, egcs_fc_offsetdatetoken: preview.egcs_fc_offsetdatetoken, egcs_fc_offsetcreditmemos: preview.egcs_fc_creditmemos.map(memo => ({ egcs_fc_key: memo.egcs_fc_key, egcs_fc_lines: memo.egcs_fc_lines })) } }))
      await completeAndApprove(page, approver, 'fundingcasepayment', offsetPayment.id)
      expect(await read(await page.request.get(debtUrl))).toMatchObject({ egcs_fc_outstanding: '9.00', egcs_fc_recovered: '21.00' })
      expect((await balances()).lines).toMatchObject([{ egcs_fc_paidamount: '85.00', egcs_fc_creditmemoamount: '5.00', egcs_fc_balance: '15.00' }])
    } finally { await approver.close() }
  })
}

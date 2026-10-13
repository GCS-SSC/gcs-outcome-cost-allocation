import type { AgencyCodingConfig } from '../shared/agency-coding'
import { emptyAgencyCodingConfig } from '../shared/agency-coding'
import { EXTENSION_KEY } from '../shared/allocation'
import type { ManagedDemoRequest, ManagedDemoResponse } from './managed-demo-seed'

export type ManagedAgencyCodingRequest = ManagedDemoRequest & {
  patch: (url: string, options: { data: unknown }) => Promise<ManagedDemoResponse>
}
const json = async <T>(response: ManagedDemoResponse): Promise<T> => {
  if (!response.ok()) throw new Error(`Agency coding fixture failed: ${response.status()} ${await response.text()}`)
  return await response.json() as T
}

/** Seeds disposable Agency configuration and explicitly selects eligible coding on its owning Streams. */
export const seedManagedAgencyCoding = async (request: ManagedAgencyCodingRequest, agencyId: string, owningStreams: Array<{ programId: string; streamId: string }>): Promise<AgencyCodingConfig> => {
  const list = async <T>(path: string) => {
    const items: T[] = []
    for (let page = 1; ; page += 1) {
      const response = await json<{ items: T[]; total: number }>(await request.get(`${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=100`))
      items.push(...response.items)
      if (response.items.length < 100 || items.length >= response.total) return items
    }
  }
  const years = await list<{ id: string }>(`/api/agency/${agencyId}/fiscal-years`)
  const commitments = await list<{ id: string; egcs_ay_fiscalyear: string; egcs_ay_currency: string }>(`/api/agency/${agencyId}/chart-of-accounts?kind=commitment`)
  const creditMemoAccounts = await list<{ id: string; egcs_ay_fiscalyear: string; egcs_ay_currency: string; egcs_ay_commitmentchartofaccount: string | null }>(`/api/agency/${agencyId}/chart-of-accounts?kind=credit_memo`)
  const nativeCommitments = commitments.filter(account => account.egcs_ay_currency === 'cad')
  for (const commitment of nativeCommitments) {
    const linked = creditMemoAccounts.filter(account => String(account.egcs_ay_commitmentchartofaccount) === String(commitment.id))
    if (linked.length > 1) throw new Error(`Ambiguous Credit Memo coding for Commitment account ${commitment.id}`)
    if (linked.some(account => account.egcs_ay_currency !== 'cad' || String(account.egcs_ay_fiscalyear) !== String(commitment.egcs_ay_fiscalyear))) throw new Error(`Invalid Credit Memo coding link for Commitment account ${commitment.id}`)
  }
  const createAccount = async (kind: 'account_receivable' | 'credit_memo', fiscalYearId: string, link: string | null = null) => {
    const account = await json<{ id: string }>(await request.post(`/api/agency/${agencyId}/chart-of-accounts`, { data: {
      egcs_ay_kind: kind, egcs_ay_fiscalyear: fiscalYearId, egcs_ay_currency: 'cad', egcs_ay_commitmentchartofaccount: link,
      egcs_ay_accountingdimensions: [{ label_en: 'Managed receivable coding', label_fr: 'Codification des créances d’essai', value: `${kind}-${fiscalYearId}-${link ?? 'catch-all'}` }]
    } }))
    return String(account.id)
  }
  const selectedAccounts: Array<{ id: string; fiscalYearId: string; currency: string }> = []
  const config = emptyAgencyCodingConfig()
  for (const year of years) {
    const id = await createAccount('account_receivable', String(year.id))
    config.receivableSets.push({ fiscalYearId: String(year.id), currency: 'cad', lines: [{ codingLineId: id, percentage: '100' }] })
    selectedAccounts.push({ id, fiscalYearId: String(year.id), currency: 'cad' })
  }
  for (const commitment of nativeCommitments) {
    const existing = creditMemoAccounts.find(account => String(account.egcs_ay_commitmentchartofaccount) === String(commitment.id))
    const id = existing ? String(existing.id) : await createAccount('credit_memo', String(commitment.egcs_ay_fiscalyear), String(commitment.id))
    selectedAccounts.push({ id, fiscalYearId: String(commitment.egcs_ay_fiscalyear), currency: commitment.egcs_ay_currency })
  }
  for (const stream of owningStreams) {
    const base = `/api/transfer-payments/${stream.programId}/streams/${stream.streamId}`
    const budgets = await list<{ egcs_tp_fiscalyear: string; egcs_tp_currency: string }>(`${base}/budgets`)
    const selections = await list<{ egcs_tp_agencychartofaccount: string }>(`${base}/chart-of-accounts`)
    for (const account of selectedAccounts) {
      if (!budgets.some(budget => String(budget.egcs_tp_fiscalyear) === account.fiscalYearId && budget.egcs_tp_currency === account.currency)
        || selections.some(selection => String(selection.egcs_tp_agencychartofaccount) === account.id)) continue
      await json(await request.post(`${base}/chart-of-accounts`, { data: { egcs_tp_agencychartofaccount: account.id } }))
    }
  }
  await json(await request.patch(`/api/extensions/agency/${agencyId}`, { data: { extensionKey: EXTENSION_KEY, enabled: true, config } }))
  return config
}

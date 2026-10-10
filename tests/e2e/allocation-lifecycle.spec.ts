import { expect, test, type APIResponse, type Page } from '@playwright/test'
import { fromCents, sumMoney, toCents } from '../../shared/allocation'
import { completeAndApprove, configureSingleApprovalSubmission, deleteUnsubmittedCommitmentDrafts, postNegativeCorrection } from './correction-fixture'

const EXTENSION_KEY = 'gcs-outcome-cost-allocation'
const ALLOCATION_VERSION_ENTITY_TYPE = `${EXTENSION_KEY}:allocation-version`
const openAllocation = async (page: Page, agreementId: string, locale: 'en' | 'fr' = 'en') => {
  await page.goto(`/${locale}/${locale === 'fr' ? 'ententes' : 'agreements'}/${agreementId}`)
  if ((page.viewportSize()?.width ?? 1280) < 768) {
    await page.getByRole('button', { name: locale === 'fr' ? 'Basculer la navigation' : 'Toggle navigation' }).click()
  }
  await page.getByRole('tab', { name: locale === 'fr' ? 'Repartition des couts' : 'Cost Allocation', exact: true }).last().click()
}


type ShowcaseAgreement = {
  agreementId: string
  agencyId: string
  programId: string
  streamId: string
}

type QualifiedWorkflowRuntime = {
  current: { runtimeId: string, runtimeState: string } | null
  recommendations: Array<{
    id: string
    runtimeState: string
    egcs_cn_revision: number
    egcs_cn_outcome?: string | null
  }>
}

type WorkflowTopology = {
  base: string
  agencyBase: string
  approvalTemplateId: string
  recommendationSetIds: string[]
  recommendationSchemaIds: string[]
  workflowIds: {
    direct: string
    nested: string
  }
}

const responseJson = async <T>(response: APIResponse): Promise<T> => {
  const contentType = response.headers()['content-type'] || ''
  if (!contentType.includes('application/json')) {
    throw new Error(`Expected JSON response but got content-type: ${contentType}`)
  }
  return await response.json() as T
}

const login = async (page: Page, email: string) => {
  await page.goto('/en/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Login', exact: true }).click()
  await page.waitForURL(url => !url.pathname.endsWith('/login'))
}

const expectOk = async (response: APIResponse, label: string): Promise<void> => {
  if (!response.ok()) throw new Error(`${label}: ${response.status()} ${await response.text()}`)
}

// Each case owns a fresh Agreement; the final NCIA snapshot supplies only public catalogs.
const createManagedAgreement = async (page: Page): Promise<ShowcaseAgreement> => {
  const referenceTitle = 'Aurora Community Kitchen Renewal'
  const response = await page.request.get(`/api/agreements?limit=100&search=${encodeURIComponent(referenceTitle)}`)
  await expectOk(response, 'Read the NCIA reference Agreement')
  const references = await responseJson<{ items: Array<{ id: string; egcs_fc_title_en: string }> }>(response)
  const reference = references.items.find(item => item.egcs_fc_title_en === referenceTitle)
  expect(reference, 'The managed NCIA snapshot contains the reference Agreement').toBeTruthy()
  const profileResponse = await page.request.get(`/api/agreements/${reference!.id}`)
  await expectOk(profileResponse, 'Read NCIA native Agreement configuration')
  const profile = await responseJson<{
    agency_id: string; program_id: string; egcs_fc_transferpaymentstream: string
    egcs_fc_agreementsubtype: string; egcs_fc_holdbackbasis: string
  }>(profileResponse)
  const token = String(Date.now())
  const createInput = {
    egcs_fc_transferpaymentstream: String(profile.egcs_fc_transferpaymentstream),
    egcs_fc_agreementnumber: `OCA${token.slice(-10)}`,
    egcs_fc_financialsystemnumber: token,
    egcs_fc_currency: 'cad',
    egcs_fc_title_en: `Outcome allocator journey ${token}`,
    egcs_fc_title_fr: `Parcours de repartition ${token}`,
    egcs_fc_description_en: `Independent package-owned unpaid funding test ${token}.`,
    egcs_fc_description_fr: `Essai independant du financement non paye ${token}.`,
    egcs_fc_agreementsubtype: String(profile.egcs_fc_agreementsubtype),
    egcs_fc_furtherdistribution: false, egcs_fc_holdback: 0,
    egcs_fc_holdbackbasis: String(profile.egcs_fc_holdbackbasis),
    egcs_fc_authorizedassistancestartdate: '2026-04-01', egcs_fc_authorizedassistanceenddate: '2027-03-31',
    egcs_fc_applicantrecipients: [{ egcs_fc_applicantrecipient: '171', egcs_fc_applicantrecipientsubtype: '21', egcs_fc_agencyfinancialid: '2' }]
  }
  let createdResponse = await page.request.post('/api/agreements', { data: createInput })
  if (createdResponse.status() === 409) {
    const conflict = await responseJson<{ data: { code: string; warnings: Array<{ fingerprint: string }> } }>(createdResponse)
    expect(conflict.data.code).toBe('FUNDING_HISTORY_SIMILARITY_CONFIRMATION_REQUIRED')
    createdResponse = await page.request.post('/api/agreements', { data: {
      ...createInput, confirmations: conflict.data.warnings.map(warning => warning.fingerprint)
    } })
  }
  await expectOk(createdResponse, 'Create an isolated NCIA outcome allocation Agreement')
  const agreementId = String((await responseJson<{ id: string }>(createdResponse)).id)
  const owner = { agreementId, agencyId: String(profile.agency_id), programId: String(profile.program_id), streamId: String(profile.egcs_fc_transferpaymentstream) }
  await expectOk(await page.request.patch(`/api/extensions/agency/${owner.agencyId}`, { data: { extensionKey: EXTENSION_KEY, enabled: true } }), 'Enable the allocation Agency')
  await expectOk(await page.request.patch(`/api/extensions/streams/${owner.streamId}`, { data: { extensionKey: EXTENSION_KEY, enabled: true } }), 'Enable the allocation Stream')
  const outcomeResponse = await page.request.post(`/api/transfer-payments/${owner.programId}/outcomes`, { data: {
    egcs_tp_name_en: `Unpaid allocation outcome ${token}`, egcs_tp_name_fr: `Resultat de repartition ${token}`,
    egcs_tp_description_en: 'Package-owned outcome.', egcs_tp_description_fr: 'Resultat du module.'
  } })
  await expectOk(outcomeResponse, 'Create an allocation outcome')
  const outcomeId = String((await responseJson<{ id: string }>(outcomeResponse)).id)
  const parties = await responseJson<{ items: Array<{ id: string }> }>(await page.request.get(`/api/agreements/${agreementId}/activities/lookups/responsible-parties?limit=100`))
  await expectOk(await page.request.post(`/api/agreements/${agreementId}/activities`, { data: {
    egcs_fc_name_en: 'Outcome allocation activity', egcs_fc_name_fr: 'Activite de repartition',
    egcs_fc_description_en: 'Allocate unpaid funding.', egcs_fc_description_fr: 'Repartir le financement non paye.',
    egcs_fc_expectedresults_en: 'Preserve paid coding.', egcs_fc_expectedresults_fr: 'Conserver le codage paye.',
    egcs_fc_startdate: '2026-04-01', egcs_fc_enddate: '2027-03-31',
    outcome_ids: [outcomeId], responsible_party_ids: [String(parties.items[0]!.id)]
  } }), 'Reference the outcome in an Agreement activity')
  const yearResponse = await page.request.post(`/api/agreements/${agreementId}/budget-fiscal-years`, { data: { egcs_fc_fiscalyear: '41' } })
  await expectOk(yearResponse, 'Add the NCIA 2026 fiscal year')
  const budgetYearId = String((await responseJson<{ id: string }>(yearResponse)).id)
  await expectOk(await page.request.post(`/api/agreements/${agreementId}/budget-line-items`, { data: {
    egcs_fc_fundingagreementbudgetfiscalyear: budgetYearId, egcs_fc_organizationcostcategory: '89',
    egcs_fc_costsubsection: 'Unpaid allocation', egcs_fc_description: 'Independent allocation funding basis.',
    egcs_fc_totalamount: '100.00', egcs_fc_programfunding: '100.00', egcs_fc_currency: 'cad'
  } }), 'Fund the allocation with exactly one hundred dollars')
  const chartResponse = await page.request.post(`/api/agency/${owner.agencyId}/chart-of-accounts`, { data: {
    egcs_ay_kind: 'commitment', egcs_ay_fiscalyear: '41', egcs_ay_currency: 'cad',
    egcs_ay_accountingdimensions: [{ value: `OCA-${token}`, label_en: 'Outcome allocation account', label_fr: 'Compte de repartition' }]
  } })
  await expectOk(chartResponse, 'Create a second fiscal-year Commitment code')
  const chartId = String((await responseJson<{ id: string }>(chartResponse)).id)
  await expectOk(await page.request.post(`/api/transfer-payments/${owner.programId}/streams/${owner.streamId}/chart-of-accounts`, { data: { egcs_tp_agencychartofaccount: chartId } }), 'Select the second Commitment code')
  return owner
}

const createAllocationVersion = async (page: Page, agreementId: string): Promise<string> => {
  const response = await page.request.post(
    `/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocation-versions`
  )
  await expectOk(response, 'Create qualified Workflow allocation version')
  return String((await responseJson<{ version: { id: string } }>(response)).version.id)
}

const readQualifiedWorkflow = async (
  page: Page,
  entityId: string
): Promise<QualifiedWorkflowRuntime> => {
  const response = await page.request.get(
    `/api/workflows/runtime?entityType=${encodeURIComponent(ALLOCATION_VERSION_ENTITY_TYPE)}&entityId=${entityId}&purpose=standard`
  )
  await expectOk(response, 'Read qualified standard Workflow')
  return await responseJson<QualifiedWorkflowRuntime>(response)
}

const createRecommendationSet = async (
  page: Page,
  base: string,
  name: string,
  approvalTemplateId?: string
): Promise<{ recommendationSetId: string, recommendationSchemaId: string }> => {
  const setResponse = await page.request.post(`${base}/recommendation-sets`, { data: {
    egcs_cn_name_en: name,
    egcs_cn_name_fr: `${name} FR`,
    egcs_cn_description_en: 'Managed qualified Workflow recommendation.',
    egcs_cn_description_fr: 'Recommandation geree du flux de travail qualifie.',
    members: []
  } })
  await expectOk(setResponse, `Create ${name}`)
  const recommendationSetId = String((await responseJson<{ id: string }>(setResponse)).id)
  const schemaResponse = await page.request.post(
    `${base}/recommendation-sets/${recommendationSetId}/items/create-schema`,
    { data: {
      egcs_cn_order: 1,
      ...(approvalTemplateId ? { egcs_cn_approvaltemplate: approvalTemplateId } : {}),
      egcs_cn_failonnotrecommended: true
    } }
  )
  await expectOk(schemaResponse, `Create ${name} schema`)
  const recommendationSchemaId = String(
    (await responseJson<{ schemaId: string }>(schemaResponse)).schemaId
  )
  const schemaRead = await page.request.get(`${base}/recommendation-schemas/${recommendationSchemaId}`)
  await expectOk(schemaRead, `Read ${name} schema`)
  const schema = await responseJson<{
    egcs_cn_result: Record<string, unknown>
    egcs_cn_recommendationschema: Record<string, unknown>
  }>(schemaRead)
  await expectOk(await page.request.patch(`${base}/recommendation-schemas/${recommendationSchemaId}`, {
    data: {
      egcs_cn_name_en: name,
      egcs_cn_name_fr: `${name} FR`,
      egcs_cn_result: schema.egcs_cn_result,
      egcs_cn_recommendationschema: schema.egcs_cn_recommendationschema
    }
  }), `Name ${name} schema`)
  await expectOk(
    await page.request.post(`${base}/recommendation-schemas/${recommendationSchemaId}/publish`),
    `Publish ${name} schema`
  )
  await expectOk(
    await page.request.post(`${base}/recommendation-sets/${recommendationSetId}/publish`),
    `Publish ${name}`
  )
  return { recommendationSetId, recommendationSchemaId }
}

const provisionQualifiedWorkflowTopology = async (
  page: Page,
  agreement: ShowcaseAgreement
): Promise<WorkflowTopology> => {
  const base = `/api/transfer-payments/${agreement.programId}/streams/${agreement.streamId}`
  const agencyBase = `/api/agency/${agreement.agencyId}`
  const usersResponse = await page.request.get('/api/users/lookups?status=active&limit=100')
  await expectOk(usersResponse, 'Read qualified Workflow users')
  const users = await responseJson<{ items: Array<{ id: string, egcs_cn_email: string }> }>(usersResponse)
  const rootUserId = String(users.items.find(user => user.egcs_cn_email === 'root@example.com')?.id ?? '')
  expect(rootUserId).not.toBe('')

  const templateResponse = await page.request.post(`${agencyBase}/approval-templates`, { data: {
    egcs_cn_name_en: 'Qualified allocation recommendation approval',
    egcs_cn_name_fr: 'Approbation de la recommandation de repartition qualifiee',
    egcs_cn_description_en: 'Managed nested Recommendation approval.',
    egcs_cn_description_fr: 'Approbation geree de la recommandation imbriquee.',
    steps: [{
      egcs_cn_sequence: 1,
      egcs_cn_name_en: 'Qualified recommendation decision',
      egcs_cn_name_fr: 'Decision de recommandation qualifiee',
      egcs_cn_description_en: 'Approve the managed Recommendation.',
      egcs_cn_description_fr: 'Approuver la recommandation geree.',
      egcs_cn_defaultuser: rootUserId,
      egcs_cn_approvertitle: 'Director',
      certifications: []
    }]
  } })
  await expectOk(templateResponse, 'Create qualified Recommendation approval template')
  const approvalTemplateId = String((await responseJson<{ id: string }>(templateResponse)).id)
  await expectOk(
    await page.request.post(`${agencyBase}/approval-templates/${approvalTemplateId}/publish`),
    'Publish qualified Recommendation approval template'
  )

  const direct = await createRecommendationSet(page, agencyBase, 'Qualified allocation recommendation')
  const nested = await createRecommendationSet(
    page,
    agencyBase,
    'Qualified allocation recommendation with approval',
    approvalTemplateId
  )
  const statusesResponse = await page.request.get(`/api/agency/${agreement.agencyId}/statuses`)
  await expectOk(statusesResponse, 'Read qualified Workflow Agency statuses')
  const statuses = await responseJson<Array<{ id: string, isDraft: boolean, deleted: boolean }>>(statusesResponse)
  const draftStatusId = String(statuses.find(status => status.isDraft && !status.deleted)?.id ?? '')
  expect(draftStatusId).not.toBe('')

  const createWorkflow = async (
    nameEn: string,
    nameFr: string,
    recommendationSetId: string
  ): Promise<string> => {
    const response = await page.request.post(`${agencyBase}/workflows`, { data: {
      egcs_cn_entitytype: ALLOCATION_VERSION_ENTITY_TYPE,
      egcs_cn_name_en: nameEn,
      egcs_cn_name_fr: nameFr,
      egcs_cn_description_en: 'Managed standard qualified Workflow.',
      egcs_cn_description_fr: 'Flux de travail standard qualifie gere.',
      egcs_cn_purpose: 'standard',
      egcs_cn_allowedstartstatuses: [draftStatusId],
      egcs_cn_cancellationstatus: draftStatusId,
      egcs_cn_executionfailurestatus: draftStatusId,
      egcs_cn_allowretry: true
    } })
    await expectOk(response, `Create ${nameEn}`)
    const workflowId = String((await responseJson<{ id: string }>(response)).id)
    await expectOk(await page.request.post(`${agencyBase}/workflows/${workflowId}/members`, { data: {
      egcs_cn_sequence: 1,
      egcs_cn_kind: 'recommendation_set',
      egcs_cn_recommendationset: recommendationSetId,
      egcs_cn_failurestatus: draftStatusId,
      egcs_cn_allowownerredirect: false,
      owners: []
    } }), `Create ${nameEn} member`)
    await expectOk(
      await page.request.post(`${agencyBase}/workflows/${workflowId}/publish`),
      `Publish ${nameEn}`
    )
    await expectOk(await page.request.post(`${base}/workflows`, { data: {
      egcs_tp_workflow: workflowId
    } }), `Link ${nameEn} to Stream`)
    return workflowId
  }

  return {
    base,
    agencyBase,
    approvalTemplateId,
    recommendationSetIds: [direct.recommendationSetId, nested.recommendationSetId],
    recommendationSchemaIds: [direct.recommendationSchemaId, nested.recommendationSchemaId],
    workflowIds: {
      direct: await createWorkflow(
        'Qualified allocation recommendation workflow',
        'Flux de recommandation de repartition qualifiee',
        direct.recommendationSetId
      ),
      nested: await createWorkflow(
        'Qualified allocation nested approval workflow',
        'Flux de repartition qualifie avec approbation imbriquee',
        nested.recommendationSetId
      )
    }
  }
}

const startQualifiedWorkflow = async (
  page: Page,
  entityId: string,
  workflowSetupId: string
): Promise<APIResponse> => await page.request.post('/api/workflows/start', { data: {
  entityType: ALLOCATION_VERSION_ENTITY_TYPE,
  entityId,
  purpose: 'standard',
  workflowSetupId
} })

const recommendationResponses = (outcome: 'recommended' | 'not_recommended', revision: number) => ({
  revision,
  responses: [{ questionKey: 'result', value: outcome === 'recommended' ? 'recommended' : 'not-recommended' }]
})

const currentRecommendationRevision = async (page: Page, entityId: string): Promise<number> => {
  const runtime = await readQualifiedWorkflow(page, entityId)
  const recommendation = runtime.recommendations.find(item => item.runtimeState === 'active')
  expect(recommendation).toBeTruthy()
  return recommendation!.egcs_cn_revision
}

const recommendationRoute = (
  entityId: string,
  submit = false
) => `/api/workflows/recommendation${submit ? '/submit' : ''}?entityType=${encodeURIComponent(ALLOCATION_VERSION_ENTITY_TYPE)}&entityId=${entityId}&purpose=standard`

const deleteDraftVersion = async (
  page: Page,
  agreementId: string,
  versionId: string
): Promise<void> => {
  await expectOk(await page.request.delete(
    `/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocation-versions/${versionId}`
  ), 'Delete qualified Workflow draft version')
}

const approveNestedRecommendation = async (
  page: Page,
  recommendationId: string
): Promise<void> => {
  const response = await page.request.get(
    `/api/approvals/runtime?entityType=commonrecommendation&entityId=${recommendationId}`
  )
  await expectOk(response, 'Read nested qualified Recommendation approval')
  const runtime = await responseJson<{
    routingSlips?: Array<{ steps: Array<{
      id: string
      can_action: boolean
      certifications: Array<{ id: string, egcs_cn_optional: boolean }>
    }> }>
  }>(response)
  const step = runtime.routingSlips?.flatMap(slip => slip.steps).find(candidate => candidate.can_action)
  expect(step).toBeTruthy()
  await expectOk(await page.request.post('/api/approvals/approve', { data: {
    approvalId: step!.id,
    certifications: step!.certifications.map(certification => ({
      id: certification.id,
      egcs_cn_value: !certification.egcs_cn_optional
    }))
  } }), 'Approve nested qualified Recommendation')
}

test('saves and submits qualified standard Workflow Recommendations across terminal branches', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page, 'root@example.com')
  const agreement = await createManagedAgreement(page)
  const topology = await provisionQualifiedWorkflowTopology(page, agreement)

  const positiveVersionId = await createAllocationVersion(page, agreement.agreementId)
  await openAllocation(page, agreement.agreementId)
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add workflow' }).click()
  await page.getByRole('button', { name: /Qualified allocation recommendation workflow/ }).click()
  const startResponse = page.waitForResponse(response =>
    response.url().endsWith('/api/workflows/start') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Start Workflow' }).click()
  expect((await startResponse).status()).toBe(200)
  await page.getByRole('radio', { name: 'Recommended', exact: true }).check()
  const saveResponse = page.waitForResponse(response =>
    response.url().includes('/api/workflows/recommendation?') && response.request().method() === 'PUT')
  await page.getByRole('button', { name: 'Submit recommendation' }).locator('..')
    .getByRole('button', { name: 'Save', exact: true }).click()
  const savedRecommendation = await saveResponse
  expect(savedRecommendation.status(), await savedRecommendation.text()).toBe(200)

  await page.reload()
  await page.getByRole('tab', { name: 'Cost Allocation', exact: true }).last().click()
  await expect(page.getByRole('radio', { name: 'Recommended', exact: true })).toBeChecked()
  const submitResponse = page.waitForResponse(response =>
    response.url().includes('/api/workflows/recommendation/submit?') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Submit recommendation' }).click()
  expect((await submitResponse).status()).toBe(200)
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: 'Cost Allocation', exact: true }).last().click()
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible()
  const duplicateAfterTerminal = await page.request.post(
    recommendationRoute(positiveVersionId, true),
    { data: recommendationResponses('recommended', 1) }
  )
  expect([403, 404, 409]).toContain(duplicateAfterTerminal.status())

  const negativeVersionId = await createAllocationVersion(page, agreement.agreementId)
  await expectOk(
    await startQualifiedWorkflow(page, negativeVersionId, topology.workflowIds.direct),
    'Start qualified negative Workflow'
  )
  await expectOk(await page.request.post(recommendationRoute(negativeVersionId, true), {
    data: recommendationResponses('not_recommended', await currentRecommendationRevision(page, negativeVersionId))
  }), 'Submit qualified negative Recommendation')
  expect((await readQualifiedWorkflow(page, negativeVersionId)).current?.runtimeState).toBe('unsuccessful')
  await openAllocation(page, agreement.agreementId)
  await expect(page.getByText('Unsuccessful', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Not recommended', { exact: true }).first()).toBeVisible()
  await deleteDraftVersion(page, agreement.agreementId, negativeVersionId)

  const unassignedVersionId = await createAllocationVersion(page, agreement.agreementId)
  await expectOk(
    await startQualifiedWorkflow(page, unassignedVersionId, topology.workflowIds.direct),
    'Start qualified missing-assignment Workflow'
  )
  const unassignedRuntime = await readQualifiedWorkflow(page, unassignedVersionId)
  const unassignedRecommendation = unassignedRuntime.recommendations.find(item => item.runtimeState === 'active')
  expect(unassignedRecommendation).toBeTruthy()
  const rosterBase = `/api/entity-assignments/commonrecommendation/${unassignedRecommendation!.id}`
  const rosterResponse = await page.request.get(rosterBase)
  await expectOk(rosterResponse, 'Read qualified Recommendation roster')
  const roster = await responseJson<{
    assignments: Array<{ user_id: string, is_primary: boolean }>
  }>(rosterResponse)
  const rootAssignment = roster.assignments.find(assignment => assignment.is_primary)
  expect(rootAssignment).toBeTruthy()
  const candidatesResponse = await page.request.get(`${rosterBase}/users`)
  await expectOk(candidatesResponse, 'Read qualified Recommendation assignee candidates')
  const candidates = await responseJson<Array<{ id: string }>>(candidatesResponse)
  const replacement = candidates.find(candidate =>
    !roster.assignments.some(assignment => assignment.user_id === candidate.id))
  expect(replacement).toBeTruthy()
  await expectOk(await page.request.post(rosterBase, {
    data: { userId: replacement!.id }
  }), 'Add replacement qualified Recommendation assignee')
  await expectOk(await page.request.patch(`${rosterBase}/primary`, {
    data: { userId: replacement!.id }
  }), 'Promote replacement qualified Recommendation assignee')
  await expectOk(
    await page.request.delete(`${rosterBase}/${rootAssignment!.user_id}`),
    'Remove current qualified Recommendation actor'
  )
  expect((await page.request.put(recommendationRoute(unassignedVersionId), {
    data: recommendationResponses('recommended', 1)
  })).status()).toBe(403)
  expect((await page.request.post(recommendationRoute(unassignedVersionId, true), {
    data: recommendationResponses('recommended', 1)
  })).status()).toBe(403)
  await expectOk(await page.request.post(rosterBase, {
    data: { userId: rootAssignment!.user_id }
  }), 'Restore qualified Recommendation actor')
  await expectOk(await page.request.patch(`${rosterBase}/primary`, {
    data: { userId: rootAssignment!.user_id }
  }), 'Restore qualified Recommendation primary')
  await expectOk(
    await page.request.delete(`${rosterBase}/${replacement!.id}`),
    'Remove replacement qualified Recommendation assignee'
  )
  await expectOk(await page.request.post('/api/workflows/cancel', { data: {
    entityType: ALLOCATION_VERSION_ENTITY_TYPE,
    entityId: unassignedVersionId,
    purpose: 'standard',
    runtimeId: unassignedRuntime.current!.runtimeId
  } }), 'Cancel restored qualified Recommendation Workflow')
  await deleteDraftVersion(page, agreement.agreementId, unassignedVersionId)

  const duplicateVersionId = await createAllocationVersion(page, agreement.agreementId)
  await expectOk(
    await startQualifiedWorkflow(page, duplicateVersionId, topology.workflowIds.direct),
    'Start duplicate qualified Recommendation Workflow'
  )
  const duplicateResponses = await Promise.all([
    page.request.post(recommendationRoute(duplicateVersionId, true), {
      data: recommendationResponses('recommended', 1)
    }),
    page.request.post(recommendationRoute(duplicateVersionId, true), {
      data: recommendationResponses('recommended', 1)
    })
  ])
  expect(duplicateResponses.filter(response => response.ok())).toHaveLength(1)
  expect(duplicateResponses.filter(response => !response.ok())).toHaveLength(1)
  expect((await readQualifiedWorkflow(page, duplicateVersionId)).current?.runtimeState).toBe('succeeded')

  const cancelledVersionId = await createAllocationVersion(page, agreement.agreementId)
  await expectOk(
    await startQualifiedWorkflow(page, cancelledVersionId, topology.workflowIds.direct),
    'Start qualified cancellation Workflow'
  )
  await expectOk(await page.request.put(recommendationRoute(cancelledVersionId), {
    data: recommendationResponses('recommended', await currentRecommendationRevision(page, cancelledVersionId))
  }), 'Save qualified Recommendation before cancellation')
  const cancellationRuntime = await readQualifiedWorkflow(page, cancelledVersionId)
  await expectOk(await page.request.post('/api/workflows/cancel', { data: {
    entityType: ALLOCATION_VERSION_ENTITY_TYPE,
    entityId: cancelledVersionId,
    purpose: 'standard',
    runtimeId: cancellationRuntime.current!.runtimeId
  } }), 'Cancel qualified Recommendation Workflow')
  const staleSubmit = await page.request.post(recommendationRoute(cancelledVersionId, true), {
    data: recommendationResponses('recommended', 1)
  })
  expect([403, 404, 409]).toContain(staleSubmit.status())
  expect((await page.request.post('/api/workflows/cancel', { data: {
    entityType: ALLOCATION_VERSION_ENTITY_TYPE,
    entityId: cancelledVersionId,
    purpose: 'standard',
    runtimeId: cancellationRuntime.current!.runtimeId
  } })).status()).toBe(409)
  expect((await readQualifiedWorkflow(page, cancelledVersionId)).current?.runtimeState).toBe('cancelled')
  await deleteDraftVersion(page, agreement.agreementId, cancelledVersionId)

  const nestedVersionId = await createAllocationVersion(page, agreement.agreementId)
  await page.setViewportSize({ width: 390, height: 844 })
  await openAllocation(page, agreement.agreementId, 'fr')
  await expect(page.getByRole('heading', { name: 'Flux de travail', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Ajouter un flux de travail' }).click()
  await page.getByRole('button', { name: /Flux de repartition qualifie avec approbation imbriquee/ }).click()
  await page.getByRole('button', { name: 'Démarrer le processus' }).click()
  await page.getByRole('radio', { name: 'Recommandé', exact: true }).check()
  const nestedSubmitResponse = page.waitForResponse(response =>
    response.url().includes('/api/workflows/recommendation/submit?') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Soumettre la recommandation' }).click()
  expect((await nestedSubmitResponse).status()).toBe(200)
  const nestedRuntime = await readQualifiedWorkflow(page, nestedVersionId)
  expect(nestedRuntime.current?.runtimeState).toBe('active')
  const nestedRecommendation = nestedRuntime.recommendations.find(item => item.runtimeState === 'awaiting_action')
  expect(nestedRecommendation).toBeTruthy()
  await expect(page.getByText('Decision de recommandation qualifiee', { exact: true })).toBeVisible()
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await approveNestedRecommendation(page, nestedRecommendation!.id)
  await page.reload()
  await page.getByRole('button', { name: 'Basculer la navigation' }).click()
  await page.getByRole('tab', { name: 'Repartition des couts', exact: true }).last().click()
  await expect(page.getByText('Approuvé', { exact: true }).first()).toBeVisible()
  expect((await readQualifiedWorkflow(page, nestedVersionId)).current?.runtimeState).toBe('approved')

  const missing = await page.request.post(
    recommendationRoute('9223372036854775807', true),
    { data: recommendationResponses('recommended', 1) }
  )
  expect(missing.status()).toBe(404)
})

test('executes allocation draft, access, localization, and disable gates', async ({ page, browser }) => {
  test.setTimeout(90_000)
  await login(page, 'root@example.com')

  const { agreementId, agencyId } = await createManagedAgreement(page)

  const createResponse = await page.request.post(
    `/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocation-versions`
  )
  expect(createResponse.ok()).toBe(true)
  const created = await createResponse.json() as { version: { id: string, versionNumber: number } }

  await openAllocation(page, agreementId)
  await expect(page.getByRole('heading', { name: 'Cost allocation', exact: true })).toBeVisible()
  await expect(page.getByText(`Version ${created.version.versionNumber}`, { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: 'Cost Allocation', exact: true }).last().click()
  await expect(page.getByText(`Version ${created.version.versionNumber}`, { exact: true })).toBeVisible()

  const other = await browser.newPage()
  await login(other, 'user03@example.com')
  expect((await other.request.put(`/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocations`, {
    data: { allocationVersionId: created.version.id, allocations: [] }
  })).status()).toBe(403)
  await other.close()

  await page.setViewportSize({ width: 390, height: 844 })
  await openAllocation(page, agreementId, 'fr')
  await expect(page.getByRole('heading', { name: 'Repartition des couts', exact: true })).toBeVisible()

  const deleteResponse = await page.request.delete(
    `/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocation-versions/${created.version.id}`
  )
  expect(deleteResponse.ok()).toBe(true)
  expect([400, 403, 404]).toContain((await page.request.delete(
    `/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocation-versions/${created.version.id}`
  )).status())

  const disableResponse = await page.request.patch(`/api/extensions/agency/${agencyId}`, {
    data: { extensionKey: EXTENSION_KEY, enabled: false }
  })
  expect(disableResponse.status()).toBe(200)
  await page.goto(`/en/agreements/${agreementId}`)
  const discoveryResponse = await page.request.get(`/api/extensions/entity-tabs?target=agreement&agreementId=${agreementId}`)
  await expectOk(discoveryResponse, 'Discover tabs after Agency disablement')
  const discovery = await responseJson<{ items: Array<{ extensionKey: string }> }>(discoveryResponse)
  expect(discovery.items.some(item => item.extensionKey === EXTENSION_KEY)).toBe(false)
  expect([403, 404]).toContain((await page.request.get(
    `/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocations`
  )).status())

  for (const id of ['not-a-number', '9223372036854775808']) {
    expect([400, 404]).toContain((await page.request.get(
      `/api/extensions/${EXTENSION_KEY}/agreements/${id}/allocations`
    )).status())
  }
})

test('allocates unpaid funds and uses posted Corrections as shared Payment capacity while preserving immutable snapshots', async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000)
  await login(page, 'root@example.com')
  const owner = await createManagedAgreement(page)
  const approver = await browser.newPage()
  await login(approver, 'user03@example.com')
  try {
    const statuses = await responseJson<Array<{ id: string; agencyId: string; nameEn: string; isDraft: boolean; terminal: boolean }>>(await page.request.get('/api/statuses'))
    const agencyStatuses = statuses.filter(status => status.agencyId === owner.agencyId)
    const draft = agencyStatuses.find(status => status.isDraft)!.id
    const approved = agencyStatuses.find(status => status.nameEn === 'Committed')!.id
    const paid = agencyStatuses.find(status => status.nameEn === 'Paid' && status.terminal)!.id
    const denied = agencyStatuses.find(status => status.nameEn === 'Returned for revision')!.id
    const active = agencyStatuses.find(status => status.nameEn === 'Active')!.id
    await configureSingleApprovalSubmission(page, owner, 'fundingcaseagreement', draft, active, denied)
    await completeAndApprove(page, approver, 'fundingcaseagreement', owner.agreementId)
    const payments = await responseJson<{ payments: Array<{ id: string; egcs_fc_status: string }> }>(await page.request.get(`/api/agreements/${owner.agreementId}/payments-overview`))
    for (const payment of payments.payments.filter(item => item.egcs_fc_status === draft)) {
      await expectOk(await page.request.delete(`/api/agreements/${owner.agreementId}/payments/${payment.id}`), 'Remove an eligible seeded Payment draft')
    }
    await deleteUnsubmittedCommitmentDrafts(page, owner)
    await expectOk(await page.request.patch(`/api/extensions/agency/${owner.agencyId}`, { data: { extensionKey: EXTENSION_KEY, enabled: true } }), 'Enable allocation interoperability')
    await expectOk(await page.request.patch(`/api/extensions/streams/${owner.streamId}`, { data: { extensionKey: EXTENSION_KEY, enabled: true } }), 'Enable allocation stream interoperability')
    // Reimbursement amounts stay manual; the host allocator persists outcome-based coding.
    await expectOk(await page.request.patch(`/api/extensions/streams/${owner.streamId}`, { data: {
      extensionKey: 'gcs-automated-payments', enabled: true, config: { enabledPaymentTypes: ['advance'] }
    } }), 'Select manual reimbursement amounts')
    type Inputs = { outcomes: Array<{ id: string }>; commitmentTypes: Array<{ id: string }>;
      budgetYears: Array<{ id: string; fiscal_year_id: string; stream_budget_id: string; program_funding: string }>;
      streamCommitments: Array<{ id: string; stream_budget_id: string }>;
      allocations: Array<{ allocationVersionId: string }>; versions: Array<{ id: string; status: string }> }
    const allocationsUrl = `/api/extensions/${EXTENSION_KEY}/agreements/${owner.agreementId}/allocations`
    const inputs = await responseJson<Inputs>(await page.request.get(allocationsUrl))
    const commitmentType = inputs.commitmentTypes[0]!.id
    const outcomeId = inputs.outcomes[0]!.id
    const mappings = inputs.budgetYears.flatMap(year => inputs.streamCommitments.filter(line => line.stream_budget_id === year.stream_budget_id)
      .map(line => ({ commitmentType, outcomeId, streamBudgetId: year.stream_budget_id, streamCommitmentId: line.id })))
    await expectOk(await page.request.patch(`/api/extensions/streams/${owner.streamId}`, { data: {
      extensionKey: EXTENSION_KEY, enabled: true, config: { enabledCommitmentTypes: [commitmentType], mappings }
    } }), 'Configure package-owned allocation mappings')
    const versionId = await createAllocationVersion(page, owner.agreementId)
    const allocations = inputs.budgetYears.flatMap(year => {
      const lines = mappings.filter(mapping => mapping.streamBudgetId === year.stream_budget_id)
      const total = toCents(year.program_funding)
      const first = lines.length > 1 ? total * BigInt(4) / BigInt(5) : total
      return lines.map((line, index) => ({ commitmentType, streamCommitmentId: line.streamCommitmentId,
        agreementBudgetFiscalYearId: year.id, outcomeId, allocationMethod: 'amount',
        allocationValue: fromCents(index === 0 ? first : index === 1 ? total - first : BigInt(0)) }))
    })
    await expectOk(await page.request.put(allocationsUrl, { data: { allocationVersionId: versionId, allocations } }), 'Save immutable allocation basis')
    await configureSingleApprovalSubmission(page, owner, ALLOCATION_VERSION_ENTITY_TYPE, draft, approved, denied)
    await completeAndApprove(page, approver, ALLOCATION_VERSION_ENTITY_TYPE, versionId)
    const commitmentTotal = sumMoney(inputs.budgetYears.map(year => year.program_funding))
    await page.goto(`/en/agreements/${owner.agreementId}?section=commitments`)
    await page.getByRole('button', { name: 'Add Commitment', exact: true }).click()
    const modal = page.getByRole('dialog', { name: 'Add Commitment' })
    await expect(modal.getByLabel('Total amount')).toBeVisible()
    await expect(modal.getByLabel('Commitment type')).toBeVisible()
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
    const commitmentResponse = await page.request.post(`/api/agreements/${owner.agreementId}/commitments`, { data: {
      egcs_fc_type: commitmentType, egcs_fc_currency: 'cad', egcs_fc_totalamount: commitmentTotal
    } })
    await expectOk(commitmentResponse, 'Generate a Commitment from approved allocation weights')
    let commitmentId = String((await responseJson<{ id: string }>(commitmentResponse)).id)
    await configureSingleApprovalSubmission(page, owner, 'fundingcaseagreementcommitment', draft, approved, denied)
    await completeAndApprove(page, approver, 'fundingcaseagreementcommitment', commitmentId)
    type Commitment = { egcs_fc_active: boolean; lines: Array<{
      id: string; egcs_fc_transferpaymentstreamchartofaccount: string; egcs_fc_amount: string
    }> }
    let commitmentUrl = `/api/agreements/${owner.agreementId}/commitments/${commitmentId}`
    let commitmentBefore = await responseJson<Commitment>(await page.request.get(commitmentUrl))
    expect(commitmentBefore.egcs_fc_active).toBe(true)
    const year = inputs.budgetYears.find(item => toCents(item.program_funding) > BigInt(0))!
    const createPayment = (amount: string) => page.request.post(`/api/agreements/${owner.agreementId}/payments`, { data: {
      egcs_fc_commitmenttype: commitmentType, egcs_fc_fiscalyear: year.id, egcs_fc_paymenttype: 'reimbursement',
      egcs_fc_periodstart: 0, egcs_fc_periodend: 2, egcs_fc_paymentamount: amount, egcs_fc_currency: 'cad', egcs_fc_applicantrecipient: '171'
    } })
    type Payment = { lines: Array<{ egcs_fc_fundingagreementcommitmentline: string; egcs_fc_amount: string }> }
    const partialAmount = fromCents(toCents(year.program_funding) / BigInt(2))
    const partialResponse = await createPayment(partialAmount)
    await expectOk(partialResponse, 'Pay part of the original allocation')
    const partialId = String((await responseJson<{ id: string }>(partialResponse)).id)
    const partialPayment = await responseJson<Payment>(await page.request.get(`/api/agreements/${owner.agreementId}/payments/${partialId}`))
    await configureSingleApprovalSubmission(page, owner, 'fundingcasepayment', draft, paid, denied)
    await completeAndApprove(page, approver, 'fundingcasepayment', partialId)
    const previousSnapshot = await responseJson<Inputs>(await page.request.get(allocationsUrl))
    const changedVersionId = await createAllocationVersion(page, owner.agreementId)
    const changedAllocations = inputs.budgetYears.flatMap(budgetYear => {
      const lines = mappings.filter(mapping => mapping.streamBudgetId === budgetYear.stream_budget_id)
      const total = toCents(budgetYear.program_funding)
      const first = lines.length > 1 ? total / BigInt(5) : total
      return lines.map((line, index) => ({ commitmentType, streamCommitmentId: line.streamCommitmentId,
        agreementBudgetFiscalYearId: budgetYear.id, outcomeId, allocationMethod: 'amount',
        allocationValue: fromCents(index === 0 ? first : index === 1 ? total - first : BigInt(0)) }))
    })
    await expectOk(await page.request.put(allocationsUrl, { data: {
      allocationVersionId: changedVersionId, allocations: changedAllocations
    } }), 'Change weights for the remaining unpaid funds')
    await completeAndApprove(page, approver, ALLOCATION_VERSION_ENTITY_TYPE, changedVersionId)
    const replacementResponse = await page.request.post(`/api/agreements/${owner.agreementId}/commitments`, { data: {
      egcs_fc_type: commitmentType, egcs_fc_currency: 'cad', egcs_fc_totalamount: commitmentTotal
    } })
    await expectOk(replacementResponse, 'Allocate a replacement Commitment without moving paid coding')
    commitmentId = String((await responseJson<{ id: string }>(replacementResponse)).id)
    commitmentUrl = `/api/agreements/${owner.agreementId}/commitments/${commitmentId}`
    const replacement = await responseJson<Commitment>(await page.request.get(commitmentUrl))
    const unpaidCents = toCents(commitmentTotal) - toCents(partialAmount)
    const paidByCode = new Map<string, bigint>()
    for (const line of replacement.lines) {
      const code = String(line.egcs_fc_transferpaymentstreamchartofaccount)
      const priorIds = commitmentBefore.lines.filter(prior => String(prior.egcs_fc_transferpaymentstreamchartofaccount) === code).map(prior => String(prior.id))
      const retainedPaid = partialPayment.lines.filter(paymentLine => priorIds.includes(String(paymentLine.egcs_fc_fundingagreementcommitmentline)))
        .reduce((sum, paymentLine) => sum + toCents(paymentLine.egcs_fc_amount), BigInt(0))
      paidByCode.set(code, retainedPaid)
      const weight = changedAllocations.filter(allocation => allocation.streamCommitmentId === code)
        .reduce((sum, allocation) => sum + toCents(allocation.allocationValue), BigInt(0))
      const actualUnpaid = toCents(line.egcs_fc_amount) - retainedPaid
      const expectedUnpaid = unpaidCents * weight / toCents(commitmentTotal)
      expect(actualUnpaid >= BigInt(0)).toBe(true)
      expect(actualUnpaid - expectedUnpaid >= BigInt(0) && actualUnpaid - expectedUnpaid <= BigInt(1)).toBe(true)
    }
    expect(sumMoney(replacement.lines.map(line => line.egcs_fc_amount))).toBe(commitmentTotal)
    await completeAndApprove(page, approver, 'fundingcaseagreementcommitment', commitmentId)
    commitmentBefore = await responseJson<Commitment>(await page.request.get(commitmentUrl))
    const changedSnapshot = await responseJson<Inputs>(await page.request.get(allocationsUrl))
    expect(previousSnapshot.allocations.filter(allocation => allocation.allocationVersionId === versionId).length).toBeGreaterThan(0)
    expect(changedSnapshot.allocations.filter(allocation => allocation.allocationVersionId === versionId))
      .toEqual(previousSnapshot.allocations.filter(allocation => allocation.allocationVersionId === versionId))
    const yearCodes = new Set(mappings.filter(mapping => mapping.streamBudgetId === year.stream_budget_id).map(mapping => mapping.streamCommitmentId))
    const remainingYearAmount = fromCents(commitmentBefore.lines.filter(line => yearCodes.has(String(line.egcs_fc_transferpaymentstreamchartofaccount)))
      .reduce((sum, line) => sum + toCents(line.egcs_fc_amount), BigInt(0)) - toCents(partialAmount))
    const paymentResponse = await createPayment(remainingYearAmount)
    await expectOk(paymentResponse, 'Consume the remaining fiscal-year capacity using the new unpaid split')
    const paymentId = String((await responseJson<{ id: string }>(paymentResponse)).id)
    const paymentUrl = `/api/agreements/${owner.agreementId}/payments/${paymentId}`
    const generated = await responseJson<Payment>(await page.request.get(paymentUrl))
    expect(generated.lines.filter(line => toCents(line.egcs_fc_amount) > BigInt(0)).length).toBeGreaterThan(1)
    expect(sumMoney(generated.lines.map(line => line.egcs_fc_amount))).toBe(remainingYearAmount)
    for (const code of yearCodes) {
      const replacementLines = commitmentBefore.lines.filter(line => String(line.egcs_fc_transferpaymentstreamchartofaccount) === code)
      const replacementIds = replacementLines.map(line => String(line.id))
      const expectedUnpaid = replacementLines.reduce((sum, line) => sum + toCents(line.egcs_fc_amount), BigInt(0))
        - (paidByCode.get(code) ?? BigInt(0))
      const allocated = generated.lines.filter(line => replacementIds.includes(String(line.egcs_fc_fundingagreementcommitmentline)))
        .reduce((sum, line) => sum + toCents(line.egcs_fc_amount), BigInt(0))
      expect(allocated, `Payment must consume unpaid capacity on coding ${code}`).toBe(expectedUnpaid)
    }
    await configureSingleApprovalSubmission(page, owner, 'fundingcasepayment', draft, paid, denied)
    await completeAndApprove(page, approver, 'fundingcasepayment', paymentId)
    const frozenAllocations = await responseJson<Inputs>(await page.request.get(allocationsUrl))
    expect(frozenAllocations.versions.find(version => version.id === changedVersionId)?.status).toBe('active')
    const correction = await postNegativeCorrection(page, approver, owner, commitmentId, paymentId)
    expect(await responseJson(await page.request.get(allocationsUrl))).toEqual(frozenAllocations)
    expect(await responseJson(await page.request.get(commitmentUrl))).toEqual(commitmentBefore)
    const overdraw = await createPayment('1.01')
    expect(overdraw.status(), await overdraw.text()).toBe(400)
    expect(await overdraw.text()).toContain('GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING')
    const restored = await createPayment('1.00')
    await expectOk(restored, 'Generate another Payment using corrected shared capacity')
    const restoredId = String((await responseJson<{ id: string }>(restored)).id)
    const restoredDetail = await responseJson<Payment>(await page.request.get(`/api/agreements/${owner.agreementId}/payments/${restoredId}`))
    expect(sumMoney(restoredDetail.lines.map(line => line.egcs_fc_amount))).toBe('1.00')
    const correctedLine = correction.egcs_fc_lines.find(line => line.egcs_fc_adjustment === '-1.00')!.egcs_fc_commitmentline
    expect(restoredDetail.lines.filter(line => toCents(line.egcs_fc_amount) > BigInt(0)).map(line => line.egcs_fc_fundingagreementcommitmentline)).toEqual([correctedLine])
    expect(await responseJson(await page.request.get(allocationsUrl))).toEqual(frozenAllocations)
    await page.goto(`/en/agreements/${owner.agreementId}/corrections/${correction.id}?section=completion`)
    await expect(page.getByRole('heading', { name: 'Correction Completion', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('posted-correction-shared-allocation-capacity.png'), fullPage: true })
    await page.goto(`/en/agreements/${owner.agreementId}/payments/${restoredId}?section=completion`)
    await expect(page.getByRole('heading', { name: 'Payment completion', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('correction-aware-allocated-payment.png'), fullPage: true })
  } finally {
    await approver.close()
  }
})

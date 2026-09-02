import { expect, test, type APIResponse, type Page } from '@playwright/test'

const EXTENSION_KEY = 'gcs-outcome-cost-allocation'
const ALLOCATION_VERSION_ENTITY_TYPE = `${EXTENSION_KEY}:allocation-version`

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

const readShowcaseAgreement = async (page: Page): Promise<ShowcaseAgreement> => {
  const agreementsResponse = await page.request.get(
    '/api/agreements?page=1&limit=10&search=Health%20Canada%20Cost%20Agreement%201%20-%20Showcase'
  )
  await expectOk(agreementsResponse, 'Read managed outcome-allocation Agreement')
  const agreements = await responseJson<{
    items: Array<{ id: string | number, egcs_fc_title_en: string }>
  }>(agreementsResponse)
  const matches = agreements.items.filter(item =>
    item.egcs_fc_title_en === 'Health Canada Cost Agreement 1 - Showcase')
  if (matches.length !== 1) {
    throw new Error(`Expected one managed outcome-allocation agreement, found ${matches.length}.`)
  }
  const agreementId = String(matches[0]!.id)
  const detailResponse = await page.request.get(`/api/agreements/${agreementId}`)
  await expectOk(detailResponse, 'Read managed outcome-allocation Agreement detail')
  const detail = await responseJson<{
    agency_id: string | number
    program_id: string | number
    egcs_fc_transferpaymentstream: string | number
  }>(detailResponse)
  return {
    agreementId,
    agencyId: String(detail.agency_id),
    programId: String(detail.program_id),
    streamId: String(detail.egcs_fc_transferpaymentstream)
  }
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
  const setResponse = await page.request.post(`${base}/recommendation-setups`, { data: {
    egcs_cn_name_en: name,
    egcs_cn_name_fr: `${name} FR`,
    egcs_cn_description_en: 'Managed qualified Workflow recommendation.',
    egcs_cn_description_fr: 'Recommandation geree du flux de travail qualifie.',
    members: []
  } })
  await expectOk(setResponse, `Create ${name}`)
  const recommendationSetId = String((await responseJson<{ id: string }>(setResponse)).id)
  const schemaResponse = await page.request.post(
    `${base}/recommendation-setups/${recommendationSetId}/items/create-schema`,
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
    await page.request.post(`${base}/recommendation-setups/${recommendationSetId}/publish`),
    `Publish ${name}`
  )
  return { recommendationSetId, recommendationSchemaId }
}

const provisionQualifiedWorkflowTopology = async (
  page: Page,
  agreement: ShowcaseAgreement
): Promise<WorkflowTopology> => {
  const base = `/api/transfer-payments/${agreement.programId}/streams/${agreement.streamId}`
  const usersResponse = await page.request.get('/api/users/lookups?status=active&limit=100')
  await expectOk(usersResponse, 'Read qualified Workflow users')
  const users = await responseJson<{ items: Array<{ id: string, egcs_cn_email: string }> }>(usersResponse)
  const rootUserId = String(users.items.find(user => user.egcs_cn_email === 'root@example.com')?.id ?? '')
  expect(rootUserId).not.toBe('')

  const templateResponse = await page.request.post('/api/approval-templates', { data: {
    scopeType: 'transferpaymentstream',
    scopeId: agreement.streamId,
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
    await page.request.post(`/api/approval-templates/${approvalTemplateId}/publish`),
    'Publish qualified Recommendation approval template'
  )

  const direct = await createRecommendationSet(page, base, 'Qualified allocation recommendation')
  const nested = await createRecommendationSet(
    page,
    base,
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
    const response = await page.request.post(`${base}/workflow-setups`, { data: {
      egcs_cn_scopetype: 'transferpaymentstream',
      egcs_cn_scopeid: agreement.streamId,
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
    await expectOk(await page.request.post(`${base}/workflow-setups/${workflowId}/members`, { data: {
      egcs_cn_sequence: 1,
      egcs_cn_kind: 'recommendation_set',
      egcs_cn_recommendationset: recommendationSetId,
      egcs_cn_failurestatus: draftStatusId,
      egcs_cn_allowownerredirect: false,
      owners: []
    } }), `Create ${nameEn} member`)
    await expectOk(
      await page.request.post(`${base}/workflow-setups/${workflowId}/publish`),
      `Publish ${nameEn}`
    )
    return workflowId
  }

  return {
    base,
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
  const agreement = await readShowcaseAgreement(page)
  const topology = await provisionQualifiedWorkflowTopology(page, agreement)

  const positiveVersionId = await createAllocationVersion(page, agreement.agreementId)
  await page.goto(`/en/agreements/${agreement.agreementId}`)
  await page.getByRole('tab', { name: 'Cost Allocation' }).click()
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
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await saveResponse).status()).toBe(200)

  await page.reload()
  await page.getByRole('tab', { name: 'Cost Allocation' }).click()
  await expect(page.getByRole('radio', { name: 'Recommended', exact: true })).toBeChecked()
  const submitResponse = page.waitForResponse(response =>
    response.url().includes('/api/workflows/recommendation/submit?') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Submit recommendation' }).click()
  expect((await submitResponse).status()).toBe(200)
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: 'Cost Allocation' }).click()
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
  await page.goto(`/en/agreements/${agreement.agreementId}`)
  await page.getByRole('tab', { name: 'Cost Allocation' }).click()
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
  await page.goto(`/fr/ententes/${agreement.agreementId}`)
  await page.getByRole('button', { name: 'Basculer la navigation' }).click()
  await page.getByRole('tab', { name: 'Repartition des couts' }).last().click()
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
  await page.getByRole('tab', { name: 'Repartition des couts' }).last().click()
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

  const agreementsResponse = await page.request.get(
    '/api/agreements?page=1&limit=10&search=Health%20Canada%20Cost%20Agreement%201%20-%20Showcase'
  )
  expect(agreementsResponse.ok(), await agreementsResponse.text()).toBe(true)
  const agreements = await responseJson<{
    items: Array<{ id: string | number, egcs_fc_title_en: string }>
  }>(agreementsResponse)
  const matches = agreements.items.filter(item =>
    item.egcs_fc_title_en === 'Health Canada Cost Agreement 1 - Showcase')
  if (matches.length !== 1) {
    throw new Error(`Expected one managed outcome-allocation agreement, found ${matches.length}.`)
  }
  const agreementId = String(matches[0]!.id)
  const detailResponse = await page.request.get(`/api/agreements/${agreementId}`)
  expect(detailResponse.ok(), await detailResponse.text()).toBe(true)
  const agreement = await responseJson<{ agency_id: string | number }>(detailResponse)
  const agencyId = String(agreement.agency_id)

  const createResponse = await page.request.post(
    `/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocation-versions`
  )
  expect(createResponse.ok()).toBe(true)
  const created = await createResponse.json() as { version: { id: string, versionNumber: number } }

  await page.goto(`/en/agreements/${agreementId}`)
  await page.getByRole('tab', { name: 'Cost Allocation' }).click()
  await expect(page.getByRole('heading', { name: 'Cost allocation', exact: true })).toBeVisible()
  await expect(page.getByText(`Version ${created.version.versionNumber}`, { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: 'Cost Allocation' }).click()
  await expect(page.getByText(`Version ${created.version.versionNumber}`, { exact: true })).toBeVisible()

  const other = await browser.newPage()
  await login(other, 'user11@example.com')
  expect((await other.request.put(`/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocations`, {
    data: { allocationVersionId: created.version.id, allocations: [] }
  })).status()).toBe(403)
  await other.close()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/fr/ententes/${agreementId}`)
  await page.getByRole('button', { name: 'Basculer la navigation' }).click()
  await page.getByRole('tab', { name: 'Repartition des couts' }).last().click()
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
  await page.getByRole('button', { name: 'Toggle navigation' }).click()
  await expect(page.getByRole('tab', { name: 'Cost Allocation' })).toHaveCount(0)
  expect([403, 404]).toContain((await page.request.get(
    `/api/extensions/${EXTENSION_KEY}/agreements/${agreementId}/allocations`
  )).status())

  for (const id of ['not-a-number', '9223372036854775808']) {
    expect([400, 404]).toContain((await page.request.get(
      `/api/extensions/${EXTENSION_KEY}/agreements/${id}/allocations`
    )).status())
  }
})

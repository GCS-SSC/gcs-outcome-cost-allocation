import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely'
import { Pool } from 'pg'
import type {
  GcsExtensionAgreementDeleteGuardHookPayload,
  GcsExtensionAgreementStreamChangeGuardHookPayload,
  GcsExtensionAgreementLifecycleLockHookPayload,
  GcsExtensionAgreementPaymentMutationGuardHookPayload,
  GcsExtensionDisableGuardHookPayload
} from '@gcs-ssc/extensions/server'
import {
  completeAllocationVersion as completeAllocationVersionWithExpectedScope,
  completeAllocationVersionInTransaction as completeAllocationVersionInTransactionWithExpectedScope,
  createDraftAllocationVersion as createDraftAllocationVersionWithExpectedScope,
  getAgreementBudgetYears,
  getGeneratedCommitmentLines,
  getGeneratedPaymentLines,
  getSavedAllocations,
  lockAndGetOutcomeCostAllocationConfig,
  lockAgreementAllocationAdvisory,
  lockAgreementAllocationLifecycle,
  lockOutcomeCostAllocationScope,
  saveAllocations as saveAllocationsWithExpectedScope,
  saveAndCompleteAllocationVersionWithCurrentConfiguration
} from '../../server/allocation-data'
import type { OutcomeCostAllocationDb, OutcomeCostAllocationHostDatabase } from '../../server/db'
import migration0001 from '../../server/migrations/0001_outcome_cost_allocation'
import migration0002 from '../../server/migrations/0002_versioned_allocations'
import migration0003 from '../../server/migrations/0003_scoped_allocations'

const postgresTestUrl = process.env.OUTCOME_ALLOCATION_POSTGRES_TEST_URL

const requireDisposablePostgresUrl = (): string => {
  if (!postgresTestUrl) {
    throw new Error(
      'OUTCOME_ALLOCATION_POSTGRES_TEST_URL is required for the opt-in PostgreSQL integration suite.'
    )
  }

  const databaseName = new URL(postgresTestUrl).pathname.slice(1)
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      'OUTCOME_ALLOCATION_POSTGRES_TEST_URL must target a disposable database whose name ends in _test.'
    )
  }

  return postgresTestUrl
}

const disposablePostgresUrl = requireDisposablePostgresUrl()

const createPostgresDb = (connectionString: string) => new Kysely<OutcomeCostAllocationHostDatabase>({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString,
      max: 1
    })
  })
})

const createLatch = () => {
  let release = () => {}
  const promise = new Promise<void>(resolve => {
    release = resolve
  })

  return {
    promise,
    release
  }
}

const resolveExpectedAgreementScope = async (
  db: OutcomeCostAllocationDb,
  agreementId: string
) => {
  const scope = await db
    .selectFrom('Funding_Case_Agreement_Profile')
    .innerJoin(
      'Transfer_Payment_Stream',
      'Transfer_Payment_Stream.id',
      'Funding_Case_Agreement_Profile.egcs_fc_transferpaymentstream'
    )
    .innerJoin(
      'Transfer_Payment_Profile',
      'Transfer_Payment_Profile.id',
      'Transfer_Payment_Stream.egcs_tp_transferpaymentprofile'
    )
    .where('Funding_Case_Agreement_Profile.id', '=', agreementId)
    .select([
      'Funding_Case_Agreement_Profile.egcs_fc_transferpaymentstream as stream_id',
      'Transfer_Payment_Profile.egcs_tp_agency as agency_id'
    ])
    .executeTakeFirstOrThrow()

  return {
    agencyId: String(scope.agency_id),
    streamId: String(scope.stream_id)
  }
}

const createDraftAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string
) => await createDraftAllocationVersionWithExpectedScope(
  db,
  agreementId,
  await resolveExpectedAgreementScope(db, agreementId)
)

const saveAllocations = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  allocationVersionId: string,
  allocations: Parameters<typeof saveAllocationsWithExpectedScope>[3]
) => await saveAllocationsWithExpectedScope(
  db,
  agreementId,
  allocationVersionId,
  allocations,
  await resolveExpectedAgreementScope(db, agreementId)
)

const completeAllocationVersion = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  allocationVersionId: string,
  config: unknown
) => await completeAllocationVersionWithExpectedScope(
  db,
  agreementId,
  streamId,
  allocationVersionId,
  config,
  await resolveExpectedAgreementScope(db, agreementId)
)

const completeAllocationVersionInTransaction = async (
  db: OutcomeCostAllocationDb,
  agreementId: string,
  streamId: string,
  allocationVersionId: string,
  config: unknown
) => await completeAllocationVersionInTransactionWithExpectedScope(
  db,
  agreementId,
  streamId,
  allocationVersionId,
  config,
  await resolveExpectedAgreementScope(db, agreementId)
)

const waitForLatchOrTask = async (
  latch: Promise<void>,
  task: Promise<unknown>,
  label: string
) => await Promise.race([
  latch,
  task.then(
    () => {
      throw new Error(`${label} completed before reaching its test latch.`)
    },
    (error: unknown) => {
      throw error
    }
  )
])

const managedMutation = async <T>(
  db: Kysely<OutcomeCostAllocationHostDatabase>,
  agreementId: string,
  mutate: (trx: Transaction<OutcomeCostAllocationHostDatabase>) => Promise<T>
): Promise<T> => await db.transaction().execute(async trx => {
  await lockAgreementAllocationLifecycle(trx, agreementId)
  return await mutate(trx)
})

const budgetYearStableId = (budgetYearId: number): string =>
  String(1_000_000 + budgetYearId)

const applyMigrationsUp = async (db: Kysely<OutcomeCostAllocationHostDatabase>) => {
  await migration0001.up(db)
  await migration0002.up(db)
  await migration0003.up(db)
}

const seedDraftScenario = async (
  db: Kysely<OutcomeCostAllocationHostDatabase>,
  agreementId: number,
  activityId: number,
  budgetYearId: number,
  budgetLineId: number
) => {
  const budgetVersionId = budgetYearId + 10_000
  const stableBudgetYearId = budgetYearStableId(budgetYearId)
  await sql`
    INSERT INTO "Funding_Case_Agreement_Profile" (
      id,
      egcs_fc_transferpaymentstream
    ) VALUES (${agreementId}, 2)
  `.execute(db)
  await sql`
    INSERT INTO "Funding_Case_Agreement_Activity" (
      id,
      egcs_fc_fundingagreement
    ) VALUES (${activityId}, ${agreementId})
  `.execute(db)
  await sql`
    INSERT INTO "Funding_Case_Agreement_Outcome_Activity" (
      egcs_fc_activity,
      egcs_fc_outcomes
    ) VALUES (${activityId}, 30)
  `.execute(db)
  await sql`
    INSERT INTO "Funding_Case_Agreement_Budget_Version" (
      id,
      egcs_fc_fundingagreement,
      egcs_fc_iscurrent
    ) VALUES (${budgetVersionId}, ${agreementId}, true)
  `.execute(db)
  await sql`
    INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" (
      id,
      egcs_fc_fundingagreement,
      egcs_fc_fiscalyear,
      egcs_fc_budgetversion
    ) VALUES (${stableBudgetYearId}, ${agreementId}, 50, ${budgetVersionId})
  `.execute(db)
  await sql`
    INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" (
      id,
      egcs_fc_fundingagreementbudgetfiscalyear,
      egcs_fc_programfunding
    ) VALUES (${budgetLineId}, ${stableBudgetYearId}, 100)
  `.execute(db)

  const version = await createDraftAllocationVersion(db, String(agreementId))
  const allocation = {
    commitmentType: '1' as const,
    streamCommitmentId: '10',
    agreementBudgetFiscalYearId: stableBudgetYearId,
    outcomeId: '30',
    allocationMethod: 'amount' as const,
    allocationValue: 100
  }
  await saveAllocations(db, String(agreementId), version.id, [allocation])

  return {
    allocation,
    version
  }
}

const streamTwoAllocationConfig = {
  enabledCommitmentTypes: ['1'],
  mappings: [{
    commitmentType: '1',
    outcomeId: '30',
    streamBudgetId: '70',
    streamCommitmentId: '10'
  }]
}

const loadAgreementStreamChangeGuard = async () => {
  const hooks: Array<(
    payload: GcsExtensionAgreementStreamChangeGuardHookPayload
  ) => Promise<void> | void> = []
  const plugin = (await import('../../server/plugins/create-hooks')).default as unknown as (
    nitroApp: {
      hooks: {
        hook: (
          name: string,
          handler: (
            payload: GcsExtensionAgreementStreamChangeGuardHookPayload
          ) => Promise<void> | void
        ) => void
      }
    }
  ) => void
  plugin({
    hooks: {
      hook: (name, handler) => {
        if (name === 'gcs:extension:agreement-stream-change-guard') {
          hooks.push(handler)
        }
      }
    }
  })

  const guard = hooks[0]
  if (!guard) {
    throw new Error('Agreement stream change guard was not registered.')
  }

  return guard
}

const loadAgreementDeleteGuard = async () => {
  const hooks: Array<(
    payload: GcsExtensionAgreementDeleteGuardHookPayload
  ) => Promise<void> | void> = []
  const plugin = (await import('../../server/plugins/create-hooks')).default as unknown as (
    nitroApp: {
      hooks: {
        hook: (
          name: string,
          handler: (
            payload: GcsExtensionAgreementDeleteGuardHookPayload
          ) => Promise<void> | void
        ) => void
      }
    }
  ) => void
  plugin({
    hooks: {
      hook: (name, handler) => {
        if (name === 'gcs:extension:agreement-delete-guard') {
          hooks.push(handler)
        }
      }
    }
  })

  const guard = hooks[0]
  if (!guard) {
    throw new Error('Agreement delete guard was not registered.')
  }

  return guard
}

const loadAgreementLifecycleLock = async () => {
  const hooks: Array<(
    payload: GcsExtensionAgreementLifecycleLockHookPayload
  ) => Promise<void> | void> = []
  const plugin = (await import('../../server/plugins/create-hooks')).default as unknown as (
    nitroApp: {
      hooks: {
        hook: (
          name: string,
          handler: (
            payload: GcsExtensionAgreementLifecycleLockHookPayload
          ) => Promise<void> | void
        ) => void
      }
    }
  ) => void
  plugin({
    hooks: {
      hook: (name, handler) => {
        if (name === 'gcs:extension:agreement-lifecycle-lock') {
          hooks.push(handler)
        }
      }
    }
  })

  const hook = hooks[0]
  if (!hook) {
    throw new Error('Agreement lifecycle lock was not registered.')
  }

  return hook
}

const loadAgreementPaymentMutationGuard = async () => {
  const hooks: Array<(
    payload: GcsExtensionAgreementPaymentMutationGuardHookPayload
  ) => Promise<void> | void> = []
  const plugin = (await import('../../server/plugins/create-hooks')).default as unknown as (
    nitroApp: {
      hooks: {
        hook: (
          name: string,
          handler: (
            payload: GcsExtensionAgreementPaymentMutationGuardHookPayload
          ) => Promise<void> | void
        ) => void
      }
    }
  ) => void
  plugin({
    hooks: {
      hook: (name, handler) => {
        if (name === 'gcs:extension:agreement-payment-mutation-guard') {
          hooks.push(handler)
        }
      }
    }
  })

  const guard = hooks[0]
  if (!guard) {
    throw new Error('Agreement payment mutation guard was not registered.')
  }

  return guard
}

describe('outcome allocation PostgreSQL concurrency', () => {
  let holderDb: Kysely<OutcomeCostAllocationHostDatabase>
  let observerDb: Kysely<OutcomeCostAllocationHostDatabase>
  let waiterDb: Kysely<OutcomeCostAllocationHostDatabase>
  let inserterDb: Kysely<OutcomeCostAllocationHostDatabase>

  beforeAll(async () => {
    holderDb = createPostgresDb(disposablePostgresUrl)
    observerDb = createPostgresDb(disposablePostgresUrl)
    waiterDb = createPostgresDb(disposablePostgresUrl)
    inserterDb = createPostgresDb(disposablePostgresUrl)

    await sql`DROP SCHEMA IF EXISTS extensions CASCADE`.execute(observerDb)
    await sql`
      DROP TABLE IF EXISTS
        "Common_Completion",
        "Common_Workflow_Run",
        "Common_Runtime",
        "Common_Status",
        "Common_Entity",
        "Common_Entity_Type",
        "Funding_Case_Agreement_Payment_Line",
        "Funding_Case_Agreement_Payment",
        "Funding_Case_Agreement_Commitment_Line",
        "Funding_Case_Agreement_Commitment",
        "Transfer_Payment_Stream_Commitment_Type",
        "Transfer_Payment_Stream_Chart_of_Account",
        "Transfer_Payment_Stream_Budget",
        "Transfer_Payment_Stream",
        "Transfer_Payment_Fiscal_Year_Budget",
        "Funding_Case_Agreement_Budget_Line_Item",
        "Funding_Case_Agreement_Budget_Fiscal_Year",
        "Funding_Case_Agreement_Budget_Version",
        "Agency_Fiscal_Year",
        "Funding_Case_Agreement_Outcome_Activity",
        "Funding_Case_Agreement_Activity",
        "Transfer_Payment_Outcome",
        "Transfer_Payment_Profile",
        "Funding_Case_Agreement_Profile"
      CASCADE
    `.execute(observerDb)
    await sql`CREATE SCHEMA extensions`.execute(observerDb)
    await sql`CREATE TABLE "Common_Entity_Type" (
      egcs_cn_type text PRIMARY KEY,
      egcs_cn_ownerkind text,
      _deleted boolean NOT NULL DEFAULT false
    )`.execute(observerDb)
    await sql`INSERT INTO "Common_Entity_Type" (egcs_cn_type, egcs_cn_ownerkind)
      VALUES
        ('fundingcaseagreement', NULL),
        ('gcs-outcome-cost-allocation:allocation-version', 'agreement')`.execute(observerDb)
    await sql`CREATE TABLE "Common_Entity" (
      id bigserial PRIMARY KEY,
      egcs_cn_entitytype text NOT NULL,
      UNIQUE (id, egcs_cn_entitytype)
    )`.execute(observerDb)
    await sql`CREATE OR REPLACE FUNCTION register_entity() RETURNS trigger AS $$
      BEGIN
        IF NEW.id IS NULL OR EXISTS (SELECT 1 FROM "Common_Entity" WHERE id = NEW.id) THEN
          NEW.id := nextval(pg_get_serial_sequence('"Common_Entity"', 'id'));
        END IF;
        INSERT INTO "Common_Entity" (id, egcs_cn_entitytype) VALUES (NEW.id, TG_ARGV[0]);
        PERFORM setval(pg_get_serial_sequence('"Common_Entity"', 'id'), (SELECT max(id) FROM "Common_Entity"), true);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`.execute(observerDb)
    await sql`CREATE TABLE "Common_Extension_Entity_Owner" (
      egcs_cn_entityid bigint NOT NULL,
      egcs_cn_entitytype text NOT NULL,
      egcs_cn_ownerid bigint NOT NULL,
      egcs_cn_ownertype text NOT NULL,
      CONSTRAINT cn_pk_extensionentityowner PRIMARY KEY (egcs_cn_entityid, egcs_cn_entitytype),
      CONSTRAINT cn_chk_extensionentityownertype CHECK (egcs_cn_ownertype IN ('fundingcaseagreement', 'applicantrecipient')),
      CONSTRAINT cn_ref_extensionentityowner_target FOREIGN KEY (egcs_cn_entityid, egcs_cn_entitytype) REFERENCES "Common_Entity" (id, egcs_cn_entitytype) ON DELETE RESTRICT,
      CONSTRAINT cn_ref_extensionentityowner_owner FOREIGN KEY (egcs_cn_ownerid, egcs_cn_ownertype) REFERENCES "Common_Entity" (id, egcs_cn_entitytype) ON DELETE RESTRICT
    )`.execute(observerDb)
    await sql`CREATE OR REPLACE FUNCTION bind_extension_entity_owner() RETURNS trigger AS $$
      DECLARE target_id bigint; owner_id bigint;
      BEGIN
        target_id := (to_jsonb(NEW) ->> TG_ARGV[1])::bigint;
        owner_id := (to_jsonb(NEW) ->> TG_ARGV[3])::bigint;
        INSERT INTO "Common_Extension_Entity_Owner" (egcs_cn_entityid, egcs_cn_entitytype, egcs_cn_ownerid, egcs_cn_ownertype)
        VALUES (target_id, TG_ARGV[0], owner_id, TG_ARGV[2]);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`.execute(observerDb)
    await sql`CREATE OR REPLACE FUNCTION lock_extension_entity_owner_column() RETURNS trigger AS $$
      BEGIN
        IF (to_jsonb(NEW) -> TG_ARGV[0]) IS DISTINCT FROM (to_jsonb(OLD) -> TG_ARGV[0]) THEN
          RAISE EXCEPTION 'Extension lifecycle entity owner identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'cn_chk_extensionentityownercolumnimmutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`.execute(observerDb)
    await sql`CREATE OR REPLACE FUNCTION lock_extension_entity_owner_binding() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Extension lifecycle entity owner binding is immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'cn_chk_extensionentityownerbindingimmutable';
      END;
      $$ LANGUAGE plpgsql`.execute(observerDb)
    await sql`CREATE TRIGGER trg_lock_extension_entity_owner_binding
      BEFORE UPDATE OR DELETE ON "Common_Extension_Entity_Owner"
      FOR EACH ROW EXECUTE FUNCTION lock_extension_entity_owner_binding()`.execute(observerDb)
    await sql`CREATE OR REPLACE FUNCTION trg_fn_soft_delete_entity_assignments() RETURNS trigger AS $$
      BEGIN RETURN NEW; END;
      $$ LANGUAGE plpgsql`.execute(observerDb)
    await sql`CREATE TABLE "Common_Status" (
      id bigserial PRIMARY KEY,
      egcs_cn_agency bigint NOT NULL,
      egcs_cn_isdraft boolean NOT NULL DEFAULT false,
      egcs_cn_readonly boolean NOT NULL DEFAULT false,
      egcs_cn_terminal boolean NOT NULL DEFAULT false,
      _deleted boolean NOT NULL DEFAULT false
    )`.execute(observerDb)
    await sql`INSERT INTO "Common_Status" (
      id, egcs_cn_agency, egcs_cn_isdraft, egcs_cn_readonly, egcs_cn_terminal
    ) VALUES
      (1, 1, true, false, false),
      (2, 1, false, true, true),
      (3, 1, false, true, true),
      (4, 1, false, false, false),
      (5, 1, false, false, false)`.execute(observerDb)
    await sql`SELECT setval(pg_get_serial_sequence('"Common_Status"', 'id'), 5)`.execute(observerDb)
    await sql`CREATE TABLE "Common_Completion" (
      id bigserial PRIMARY KEY,
      egcs_cn_entitytype text NOT NULL,
      egcs_cn_entityid bigint NOT NULL,
      _deleted boolean NOT NULL DEFAULT false
    )`.execute(observerDb)
    await sql`CREATE TABLE "Common_Runtime" (
      id bigint PRIMARY KEY,
      egcs_cn_attempt integer NOT NULL,
      egcs_cn_state text NOT NULL,
      _deleted boolean NOT NULL DEFAULT false
    )`.execute(observerDb)
    await sql`CREATE TABLE "Common_Workflow_Run" (
      id bigint PRIMARY KEY REFERENCES "Common_Runtime" (id),
      egcs_cn_completion bigint NOT NULL REFERENCES "Common_Completion" (id)
    )`.execute(observerDb)
    await sql`
      CREATE TABLE "Transfer_Payment_Profile" (
        id bigint PRIMARY KEY,
        egcs_tp_agency bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`CREATE OR REPLACE FUNCTION test_bootstrap_agency_draft_status() RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM "Common_Status"
          WHERE egcs_cn_agency = NEW.egcs_tp_agency AND egcs_cn_isdraft = true AND _deleted = false
        ) THEN
          INSERT INTO "Common_Status" (egcs_cn_agency, egcs_cn_isdraft)
          VALUES (NEW.egcs_tp_agency, true);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`.execute(observerDb)
    await sql`CREATE TRIGGER test_bootstrap_agency_draft_status
      AFTER INSERT ON "Transfer_Payment_Profile"
      FOR EACH ROW EXECUTE FUNCTION test_bootstrap_agency_draft_status()`.execute(observerDb)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Profile" (
        id bigint PRIMARY KEY,
        egcs_fc_transferpaymentstream bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`CREATE OR REPLACE FUNCTION test_register_agreement_entity() RETURNS trigger AS $$
      BEGIN
        INSERT INTO "Common_Entity" (id, egcs_cn_entitytype) VALUES (NEW.id, 'fundingcaseagreement');
        PERFORM setval(pg_get_serial_sequence('"Common_Entity"', 'id'), (SELECT max(id) FROM "Common_Entity"), true);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`.execute(observerDb)
    await sql`CREATE TRIGGER test_register_agreement_entity
      AFTER INSERT ON "Funding_Case_Agreement_Profile"
      FOR EACH ROW EXECUTE FUNCTION test_register_agreement_entity()`.execute(observerDb)
    await sql`
      CREATE TABLE "Transfer_Payment_Outcome" (
        id bigint PRIMARY KEY,
        egcs_tp_transferpaymentprofile bigint NOT NULL,
        egcs_tp_name_en text NOT NULL,
        egcs_tp_name_fr text NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Activity" (
        id bigint PRIMARY KEY,
        egcs_fc_fundingagreement bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Outcome_Activity" (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        egcs_fc_activity bigint NOT NULL,
        egcs_fc_outcomes bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Agency_Fiscal_Year" (
        id bigint PRIMARY KEY,
        egcs_ay_fiscalyeardisplay text NOT NULL,
        egcs_ay_fiscalyear integer NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Budget_Version" (
        id bigint PRIMARY KEY,
        egcs_fc_fundingagreement bigint NOT NULL,
        egcs_fc_iscurrent boolean NOT NULL DEFAULT false,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Budget_Fiscal_Year" (
        id bigint PRIMARY KEY,
        egcs_fc_fundingagreement bigint NOT NULL,
        egcs_fc_fiscalyear bigint NOT NULL,
        egcs_fc_budgetversion bigint,
        egcs_fc_originalbudgetfiscalyear bigint,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Budget_Line_Item" (
        id bigint PRIMARY KEY,
        egcs_fc_fundingagreementbudgetfiscalyear bigint NOT NULL,
        egcs_fc_programfunding numeric(19, 2) NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Transfer_Payment_Stream" (
        id bigint PRIMARY KEY,
        egcs_tp_transferpaymentprofile bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Transfer_Payment_Fiscal_Year_Budget" (
        id bigint PRIMARY KEY,
        egcs_tp_transferpaymentprofile bigint NOT NULL,
        egcs_tp_fiscalyear bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Transfer_Payment_Stream_Budget" (
        id bigint PRIMARY KEY,
        egcs_tp_transferpaymentbudget bigint NOT NULL,
        egcs_tp_transferpaymentstream bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Transfer_Payment_Stream_Chart_of_Account" (
        id bigint PRIMARY KEY,
        egcs_tp_streambudget bigint NOT NULL,
        egcs_tp_transferpaymentstream bigint NOT NULL,
        egcs_tp_gl integer NOT NULL,
        egcs_tp_gldescription text NOT NULL,
        egcs_tp_accountingdimensions jsonb NOT NULL DEFAULT '[]'::jsonb,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Transfer_Payment_Stream_Commitment_Type" (
        id bigint PRIMARY KEY,
        egcs_tp_name_en text NOT NULL,
        egcs_tp_name_fr text NOT NULL,
        egcs_tp_transferpaymentstream bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      INSERT INTO "Transfer_Payment_Stream_Commitment_Type" (
        id, egcs_tp_name_en, egcs_tp_name_fr, egcs_tp_transferpaymentstream
      ) VALUES
        (1, 'Grant', 'Subvention', 2),
        (2, 'Contribution', 'Contribution', 2),
        (3, 'Grant', 'Subvention', 3),
        (4, 'Grant', 'Subvention', 4),
        (5, 'Grant', 'Subvention', 5),
        (6, 'Contribution', 'Contribution', 5),
        (7, 'Grant', 'Subvention', 6),
        (10, 'Grant', 'Subvention', 10),
        (11, 'Grant', 'Subvention', 11),
        (12, 'Grant', 'Subvention', 12)
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Commitment" (
        id bigint PRIMARY KEY,
        egcs_fc_fundingagreement bigint NOT NULL,
        egcs_fc_type bigint NOT NULL,
        egcs_fc_status bigint NOT NULL,
        egcs_fc_financialsystemnumber bigint,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Commitment_Line" (
        id bigint PRIMARY KEY,
        egcs_fc_commitment bigint NOT NULL,
        egcs_fc_commitmentlinenumber smallint NOT NULL,
        egcs_fc_transferpaymentstreamchartofaccount bigint NOT NULL,
        egcs_fc_amount numeric(19, 2) NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Payment" (
        id bigint PRIMARY KEY,
        egcs_fc_fundingagreementcommitment bigint NOT NULL,
        egcs_fc_fiscalyear bigint NOT NULL,
        egcs_fc_paymentamount numeric(19, 2) NOT NULL,
        egcs_fc_status bigint NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE "Funding_Case_Agreement_Payment_Line" (
        id bigint PRIMARY KEY,
        egcs_fc_fundingagreementpayment bigint NOT NULL,
        egcs_fc_fundingagreementcommitmentline bigint NOT NULL,
        egcs_fc_amount numeric(19, 2) NOT NULL,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)

    await applyMigrationsUp(observerDb)

    await sql`
      CREATE TABLE extensions.agency_enablement (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        agency_id bigint NOT NULL,
        extension_key text NOT NULL,
        enabled boolean NOT NULL,
        config jsonb NOT NULL DEFAULT '{}'::jsonb,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await sql`
      CREATE TABLE extensions.stream_configuration (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        stream_id bigint NOT NULL,
        extension_key text NOT NULL,
        enabled boolean NOT NULL,
        config jsonb NOT NULL DEFAULT '{}'::jsonb,
        _deleted boolean NOT NULL DEFAULT false
      )
    `.execute(observerDb)
    await migration0001.down(observerDb)
    const downState = await sql<{ version_table: string | null, host_trigger_count: string }>`
      SELECT
        to_regclass('extensions.gcs_outcome_cost_allocation_versions')::text AS version_table,
        (
          SELECT COUNT(*)::text
          FROM pg_trigger
          WHERE tgname LIKE 'gcs_outcome_cost_allocation_%'
            AND NOT tgisinternal
        ) AS host_trigger_count
    `.execute(observerDb)
    expect(downState.rows[0]).toEqual({
      version_table: null,
      host_trigger_count: '0'
    })
    await applyMigrationsUp(observerDb)

    await sql`
      INSERT INTO "Transfer_Payment_Profile" (
        id,
        egcs_tp_agency
      ) VALUES
        (100, 1000),
        (200, 2000),
        (300, 3000),
        (400, 4000),
        (500, 5000),
        (600, 6000)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Profile" (
        id,
        egcs_fc_transferpaymentstream
      ) VALUES
        (1, 1),
        (2, 2),
        (3, 3),
        (4, 4),
        (5, 5),
        (6, 6)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Transfer_Payment_Outcome" (
        id,
        egcs_tp_transferpaymentprofile,
        egcs_tp_name_en,
        egcs_tp_name_fr
      ) VALUES
        (30, 200, 'Outcome', 'Resultat'),
        (31, 300, 'Outcome 2', 'Resultat 2'),
        (32, 400, 'Outcome 3', 'Resultat 3'),
        (33, 500, 'Outcome 4', 'Resultat 4'),
        (34, 600, 'Outcome 5', 'Resultat 5')
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Activity" (
        id,
        egcs_fc_fundingagreement
      ) VALUES
        (40, 2),
        (41, 3),
        (42, 4),
        (43, 5),
        (44, 6)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Outcome_Activity" (
        egcs_fc_activity,
        egcs_fc_outcomes
      ) VALUES
        (40, 30),
        (41, 31),
        (42, 32),
        (43, 33),
        (44, 34)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Agency_Fiscal_Year" (
        id,
        egcs_ay_fiscalyeardisplay,
        egcs_ay_fiscalyear
      ) VALUES (50, '2026-2027', 2026)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Budget_Version" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_iscurrent
      ) VALUES
        (120, 2, true),
        (122, 3, true),
        (124, 4, true),
        (126, 5, true),
        (128, 6, true)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_fiscalyear,
        egcs_fc_budgetversion
      ) VALUES
        ('00000000-0000-4000-8000-000000000020', 2, 50, 120),
        ('00000000-0000-4000-8000-000000000022', 3, 50, 122),
        ('00000000-0000-4000-8000-000000000024', 4, 50, 124),
        ('00000000-0000-4000-8000-000000000026', 5, 50, 126),
        ('00000000-0000-4000-8000-000000000028', 6, 50, 128)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" (
        id,
        egcs_fc_fundingagreementbudgetfiscalyear,
        egcs_fc_programfunding
      ) VALUES
        (21, '00000000-0000-4000-8000-000000000020', 100),
        (23, '00000000-0000-4000-8000-000000000022', 100),
        (25, '00000000-0000-4000-8000-000000000024', 100),
        (27, '00000000-0000-4000-8000-000000000026', 100),
        (29, '00000000-0000-4000-8000-000000000028', 100)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Transfer_Payment_Stream" (
        id,
        egcs_tp_transferpaymentprofile
      ) VALUES
        (1, 100),
        (2, 200),
        (3, 300),
        (4, 400),
        (5, 500),
        (6, 600)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Transfer_Payment_Fiscal_Year_Budget" (
        id,
        egcs_tp_transferpaymentprofile,
        egcs_tp_fiscalyear
      ) VALUES
        (60, 200, 50),
        (61, 300, 50),
        (62, 400, 50),
        (63, 500, 50),
        (64, 600, 50)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Transfer_Payment_Stream_Budget" (
        id,
        egcs_tp_transferpaymentbudget,
        egcs_tp_transferpaymentstream
      ) VALUES
        (70, 60, 2),
        (71, 61, 3),
        (72, 62, 4),
        (73, 63, 5),
        (74, 64, 6)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Transfer_Payment_Stream_Chart_of_Account" (
        id,
        egcs_tp_streambudget,
        egcs_tp_transferpaymentstream,
        egcs_tp_gl,
        egcs_tp_gldescription
      ) VALUES
        (10, 70, 2, 5000, 'Program'),
        (11, 71, 3, 5001, 'Program 2'),
        (12, 72, 4, 5002, 'Program 3'),
        (13, 73, 5, 5003, 'Program 4'),
        (14, 74, 6, 5004, 'Program 5')
    `.execute(observerDb)
    await sql`
      INSERT INTO extensions.agency_enablement (
        agency_id,
        extension_key,
        enabled,
        config
      ) VALUES
        (2000, 'gcs-outcome-cost-allocation', true, '{}'::jsonb),
        (6000, 'gcs-outcome-cost-allocation', true, '{}'::jsonb)
    `.execute(observerDb)
    await sql`
      INSERT INTO extensions.stream_configuration (
        stream_id,
        extension_key,
        enabled,
        config
      ) VALUES
        (
          2,
          'gcs-outcome-cost-allocation',
          true,
          ${JSON.stringify(streamTwoAllocationConfig)}::jsonb
        ),
        (
          6,
          'gcs-outcome-cost-allocation',
          true,
          ${JSON.stringify({
            enabledCommitmentTypes: ['1'],
            mappings: [{
              commitmentType: '1',
              outcomeId: '34',
              streamBudgetId: '74',
              streamCommitmentId: '14'
            }]
          })}::jsonb
        )
    `.execute(observerDb)
    await sql`
      ALTER TABLE "Funding_Case_Agreement_Profile"
        ADD CONSTRAINT test_fc_agreement_stream_fk
        FOREIGN KEY (egcs_fc_transferpaymentstream)
        REFERENCES "Transfer_Payment_Stream" (id) ON DELETE RESTRICT;
      ALTER TABLE "Transfer_Payment_Outcome"
        ADD CONSTRAINT test_tp_outcome_profile_fk
        FOREIGN KEY (egcs_tp_transferpaymentprofile)
        REFERENCES "Transfer_Payment_Profile" (id) ON DELETE RESTRICT;
      ALTER TABLE "Funding_Case_Agreement_Activity"
        ADD CONSTRAINT test_fc_activity_agreement_fk
        FOREIGN KEY (egcs_fc_fundingagreement)
        REFERENCES "Funding_Case_Agreement_Profile" (id) ON DELETE RESTRICT;
      ALTER TABLE "Funding_Case_Agreement_Outcome_Activity"
        ADD CONSTRAINT test_fc_outcome_activity_activity_fk
        FOREIGN KEY (egcs_fc_activity)
        REFERENCES "Funding_Case_Agreement_Activity" (id) ON DELETE RESTRICT,
        ADD CONSTRAINT test_fc_outcome_activity_outcome_fk
        FOREIGN KEY (egcs_fc_outcomes)
        REFERENCES "Transfer_Payment_Outcome" (id) ON DELETE RESTRICT;
      ALTER TABLE "Funding_Case_Agreement_Budget_Fiscal_Year"
        ADD CONSTRAINT test_fc_budget_year_agreement_fk
        FOREIGN KEY (egcs_fc_fundingagreement)
        REFERENCES "Funding_Case_Agreement_Profile" (id) ON DELETE RESTRICT,
        ADD CONSTRAINT test_fc_budget_year_fiscal_year_fk
        FOREIGN KEY (egcs_fc_fiscalyear)
        REFERENCES "Agency_Fiscal_Year" (id) ON DELETE RESTRICT;
      ALTER TABLE "Funding_Case_Agreement_Budget_Line_Item"
        ADD CONSTRAINT test_fc_budget_line_year_fk
        FOREIGN KEY (egcs_fc_fundingagreementbudgetfiscalyear)
        REFERENCES "Funding_Case_Agreement_Budget_Fiscal_Year" (id) ON DELETE RESTRICT;
      ALTER TABLE "Transfer_Payment_Stream"
        ADD CONSTRAINT test_tp_stream_profile_fk
        FOREIGN KEY (egcs_tp_transferpaymentprofile)
        REFERENCES "Transfer_Payment_Profile" (id) ON DELETE RESTRICT;
      ALTER TABLE "Transfer_Payment_Fiscal_Year_Budget"
        ADD CONSTRAINT test_tp_fiscal_budget_profile_fk
        FOREIGN KEY (egcs_tp_transferpaymentprofile)
        REFERENCES "Transfer_Payment_Profile" (id) ON DELETE RESTRICT,
        ADD CONSTRAINT test_tp_fiscal_budget_year_fk
        FOREIGN KEY (egcs_tp_fiscalyear)
        REFERENCES "Agency_Fiscal_Year" (id) ON DELETE RESTRICT;
      ALTER TABLE "Transfer_Payment_Stream_Budget"
        ADD CONSTRAINT test_tp_stream_budget_fiscal_budget_fk
        FOREIGN KEY (egcs_tp_transferpaymentbudget)
        REFERENCES "Transfer_Payment_Fiscal_Year_Budget" (id) ON DELETE RESTRICT,
        ADD CONSTRAINT test_tp_stream_budget_stream_fk
        FOREIGN KEY (egcs_tp_transferpaymentstream)
        REFERENCES "Transfer_Payment_Stream" (id) ON DELETE RESTRICT;
      ALTER TABLE "Transfer_Payment_Stream_Chart_of_Account"
        ADD CONSTRAINT test_tp_stream_commitment_budget_fk
        FOREIGN KEY (egcs_tp_streambudget)
        REFERENCES "Transfer_Payment_Stream_Budget" (id) ON DELETE RESTRICT,
        ADD CONSTRAINT test_tp_stream_commitment_stream_fk
        FOREIGN KEY (egcs_tp_transferpaymentstream)
        REFERENCES "Transfer_Payment_Stream" (id) ON DELETE RESTRICT;
      ALTER TABLE "Funding_Case_Agreement_Commitment"
        ADD CONSTRAINT test_fc_commitment_agreement_fk
        FOREIGN KEY (egcs_fc_fundingagreement)
        REFERENCES "Funding_Case_Agreement_Profile" (id) ON DELETE RESTRICT;
      ALTER TABLE "Funding_Case_Agreement_Commitment_Line"
        ADD CONSTRAINT test_fc_commitment_line_commitment_fk
        FOREIGN KEY (egcs_fc_commitment)
        REFERENCES "Funding_Case_Agreement_Commitment" (id) ON DELETE RESTRICT,
        ADD CONSTRAINT test_fc_commitment_line_stream_commitment_fk
        FOREIGN KEY (egcs_fc_transferpaymentstreamchartofaccount)
        REFERENCES "Transfer_Payment_Stream_Chart_of_Account" (id) ON DELETE RESTRICT;
      ALTER TABLE "Funding_Case_Agreement_Payment"
        ADD CONSTRAINT test_fc_payment_commitment_fk
        FOREIGN KEY (egcs_fc_fundingagreementcommitment)
        REFERENCES "Funding_Case_Agreement_Commitment" (id) ON DELETE RESTRICT,
        ADD CONSTRAINT test_fc_payment_budget_year_fk
        FOREIGN KEY (egcs_fc_fiscalyear)
        REFERENCES "Funding_Case_Agreement_Budget_Fiscal_Year" (id) ON DELETE RESTRICT;
      ALTER TABLE "Funding_Case_Agreement_Payment_Line"
        ADD CONSTRAINT test_fc_payment_line_payment_fk
        FOREIGN KEY (egcs_fc_fundingagreementpayment)
        REFERENCES "Funding_Case_Agreement_Payment" (id) ON DELETE RESTRICT,
        ADD CONSTRAINT test_fc_payment_line_commitment_line_fk
        FOREIGN KEY (egcs_fc_fundingagreementcommitmentline)
        REFERENCES "Funding_Case_Agreement_Commitment_Line" (id) ON DELETE RESTRICT
    `.execute(observerDb)
  })

  afterAll(async () => {
    await Promise.all([
      holderDb.destroy(),
      observerDb.destroy(),
      waiterDb.destroy(),
      inserterDb.destroy()
    ])
  })

  it('applies migrations 0001 through 0003 with the canonical coordinate index', async () => {
    const indexes = await sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'extensions'
        AND indexname IN (
          'gcs_outcome_cost_allocation_version_allocation',
          'gcs_outcome_cost_allocation_scoped_allocation'
        )
    `.execute(observerDb)

    expect(indexes.rows).toEqual([{
      indexname: 'gcs_outcome_cost_allocation_version_allocation'
    }])

    await sql`
      SELECT set_config(
        'gcs_outcome_cost_allocation.managed_agreement_id',
        '3',
        false
      )
    `.execute(observerDb)
    await expect(observerDb
      .insertInto('extensions.gcs_outcome_cost_allocation_versions')
      .values({
        agreement_id: '3',
        version_number: 1,
        status: 'draft'
      })
      .execute()).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_managed_mutation_guard'
    })
  })

  it('atomically binds each allocation version to its exact Agreement owner and rejects owner drift', async () => {
    const created = await managedMutation(observerDb, '3', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_versions')
      .values({
        id: '90001',
        agreement_id: '3',
        version_number: 90001,
        status: 'draft'
      })
      .returning('id')
      .executeTakeFirstOrThrow())

    const binding = await sql<{
      entity_id: string
      entity_type: string
      owner_id: string
      owner_type: string
    }>`
      SELECT
        egcs_cn_entityid::text AS entity_id,
        egcs_cn_entitytype AS entity_type,
        egcs_cn_ownerid::text AS owner_id,
        egcs_cn_ownertype AS owner_type
      FROM "Common_Extension_Entity_Owner"
      WHERE egcs_cn_entityid = ${String(created.id)}::bigint
        AND egcs_cn_entitytype = 'gcs-outcome-cost-allocation:allocation-version'
    `.execute(observerDb)
    expect(binding.rows).toEqual([{
      entity_id: '90001',
      entity_type: 'gcs-outcome-cost-allocation:allocation-version',
      owner_id: '3',
      owner_type: 'fundingcaseagreement'
    }])

    await expect(managedMutation(observerDb, '3', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({ agreement_id: '4' })
      .where('id', '=', '90001')
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_version_identity_guard'
    })
    await expect(sql`
      UPDATE "Common_Extension_Entity_Owner"
      SET egcs_cn_ownerid = 4
      WHERE egcs_cn_entityid = 90001
        AND egcs_cn_entitytype = 'gcs-outcome-cost-allocation:allocation-version'
    `.execute(observerDb)).rejects.toMatchObject({
      code: '23514',
      constraint: 'cn_chk_extensionentityownerbindingimmutable'
    })

    await sql`DELETE FROM "Common_Entity" WHERE id = 4 AND egcs_cn_entitytype = 'fundingcaseagreement'`.execute(observerDb)
    await expect(managedMutation(observerDb, '4', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_versions')
      .values({
        id: '90002',
        agreement_id: '4',
        version_number: 90002,
        status: 'draft'
      })
      .execute())).rejects.toMatchObject({
      code: '23503',
      constraint: 'cn_ref_extensionentityowner_owner'
    })
    await expect(observerDb
      .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
      .select('id')
      .where('id', '=', '90002')
      .executeTakeFirst()).resolves.toBeUndefined()
    await expect(sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM "Common_Entity"
      WHERE id = 90002
        AND egcs_cn_entitytype = 'gcs-outcome-cost-allocation:allocation-version'
    `.execute(observerDb)).resolves.toMatchObject({ rows: [{ count: '0' }] })
    await sql`INSERT INTO "Common_Entity" (id, egcs_cn_entitytype) VALUES (4, 'fundingcaseagreement')`.execute(observerDb)

    await managedMutation(observerDb, '3', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({ _deleted: true })
      .where('id', '=', '90001')
      .execute())
  })

  it('uses only the requested stream profile fiscal-year budget when profiles share a fiscal year', async () => {
    const budgetYears = await getAgreementBudgetYears(observerDb, '4', '4')
    expect(budgetYears).toEqual([{
      id: budgetYearStableId(24),
      fiscal_year_id: '50',
      fiscal_year_display: '2026-2027',
      program_funding: '100.00',
      stream_budget_id: '72'
    }])

    const version = await managedMutation(observerDb, '4', async trx => {
      const createdVersion = await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_versions')
        .values({
          agreement_id: '4',
          version_number: 1,
          status: 'draft'
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
        .values({
          allocation_version_id: String(createdVersion.id),
          agreement_id: '4',
          commitment_type: '4',
          stream_commitment_id: '12',
          agreement_budget_fiscal_year_id: budgetYearStableId(24),
          outcome_id: '32',
          allocation_method: 'amount',
          allocation_value: '100.0000'
        })
        .execute()
      return createdVersion
    })

    await expect(completeAllocationVersion(
      observerDb,
      '4',
      '4',
      String(version.id),
      {
        enabledCommitmentTypes: ['4'],
        mappings: [{
          commitmentType: '4',
          outcomeId: '32',
          streamBudgetId: '72',
          streamCommitmentId: '12'
        }]
      }
    )).resolves.toMatchObject({
      agreementId: '4',
      status: 'active'
    })

    await sql`
      UPDATE "Funding_Case_Agreement_Budget_Line_Item"
      SET egcs_fc_programfunding = 250
      WHERE id = 25
    `.execute(observerDb)
    const completedAllocations = await getSavedAllocations(
      observerDb,
      '4',
      String(version.id)
    )
    expect(completedAllocations).toEqual([
      expect.objectContaining({
        resolvedAmount: '100.00',
        fundingBasisAmount: '100.00'
      })
    ])
    await expect(getGeneratedCommitmentLines(
      observerDb,
      '4',
      '4',
      '4',
      {
        enabledCommitmentTypes: ['4'],
        mappings: [{
          commitmentType: '4',
          outcomeId: '32',
          streamBudgetId: '72',
          streamCommitmentId: '12'
        }]
      }
    )).resolves.toMatchObject({
      status: 'handled',
      issues: [],
      lines: [{
        allocation: {
          amount: '100.00',
          resolvedAmount: '100.00',
          fundingBasisAmount: '100.00'
        }
      }]
    })
    await sql`
      UPDATE "Funding_Case_Agreement_Budget_Line_Item"
      SET egcs_fc_programfunding = 100
      WHERE id = 25
    `.execute(observerDb)
  })

  it('loads only current budget-version funding under the stable original fiscal-year identity', async () => {
    const historicalYearId = budgetYearStableId(9801)
    const currentCopyId = budgetYearStableId(9802)
    await sql`INSERT INTO "Funding_Case_Agreement_Profile" (id, egcs_fc_transferpaymentstream) VALUES (98, 4)`.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Budget_Version" (
        id, egcs_fc_fundingagreement, egcs_fc_iscurrent
      ) VALUES (9801, 98, false), (9802, 98, true)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_fiscalyear,
        egcs_fc_budgetversion,
        egcs_fc_originalbudgetfiscalyear
      ) VALUES
        (${historicalYearId}, 98, 50, 9801, NULL),
        (${currentCopyId}, 98, 50, 9802, ${historicalYearId})
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" (
        id, egcs_fc_fundingagreementbudgetfiscalyear, egcs_fc_programfunding
      ) VALUES (9801, ${historicalYearId}, 25), (9802, ${currentCopyId}, 175)
    `.execute(observerDb)

    await expect(getAgreementBudgetYears(observerDb, '98', '4')).resolves.toEqual([{
      id: historicalYearId,
      fiscal_year_id: '50',
      fiscal_year_display: '2026-2027',
      program_funding: '175.00',
      stream_budget_id: '72'
    }])
  })

  it('locks one funding view through validation and snapshot under READ COMMITTED', async () => {
    const allocation = {
      commitmentType: '4' as const,
      streamCommitmentId: '12',
      agreementBudgetFiscalYearId: budgetYearStableId(24),
      outcomeId: '32',
      allocationMethod: 'percentage' as const,
      allocationValue: 100
    }
    const config = {
      enabledCommitmentTypes: ['4'],
      mappings: [{
        commitmentType: '4',
        outcomeId: '32',
        streamBudgetId: '72',
        streamCommitmentId: '12'
      }]
    }
    const version = await createDraftAllocationVersion(observerDb, '4')
    await saveAllocations(observerDb, '4', version.id, [allocation])
    const completionReady = createLatch()
    const releaseCompletion = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const waiterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const inserterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(inserterDb)
      .then(result => result.rows[0]?.pid)

    const completion = holderDb.transaction().execute(async trx => {
      const completed = await completeAllocationVersionInTransaction(
        trx,
        '4',
        '4',
        version.id,
        config
      )
      completionReady.release()
      await releaseCompletion.promise
      return completed
    })
    let fundingUpdate: Promise<unknown> | undefined
    let budgetLineInsert: Promise<unknown> | undefined
    try {
      await waitForLatchOrTask(completionReady.promise, completion, 'Allocation completion')
      fundingUpdate = sql`
        UPDATE "Funding_Case_Agreement_Budget_Line_Item"
        SET egcs_fc_programfunding = 250
        WHERE id = 25
      `.execute(waiterDb)
      budgetLineInsert = sql`
        INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" (
          id,
          egcs_fc_fundingagreementbudgetfiscalyear,
          egcs_fc_programfunding
        ) VALUES (250, '00000000-0000-4000-8000-000000000024', 50)
      `.execute(inserterDb)

      await vi.waitFor(async () => {
        const result = await sql<{
          update_blocker_pids: number[]
          insert_blocker_pids: number[]
        }>`
          SELECT
            pg_blocking_pids(${waiterPid})::integer[] AS update_blocker_pids,
            pg_blocking_pids(${inserterPid})::integer[] AS insert_blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.update_blocker_pids).toContain(holderPid)
        expect(result.rows[0]?.insert_blocker_pids).toContain(holderPid)
      })

      releaseCompletion.release()
      const completedVersion = await completion
      expect(completedVersion).toMatchObject({
        id: version.id,
        status: 'active'
      })
      await expect(fundingUpdate).resolves.toBeDefined()
      await expect(budgetLineInsert).resolves.toBeDefined()

      const snapshots = await getSavedAllocations(observerDb, '4', version.id)
      expect(snapshots).toEqual([
        expect.objectContaining({
          resolvedAmount: completedVersion.fundingBasisAmount,
          fundingBasisAmount: completedVersion.fundingBasisAmount
        })
      ])
      const liveFunding = await getAgreementBudgetYears(observerDb, '4', '4')
      expect(liveFunding[0]?.program_funding).toBe('300.00')
    } finally {
      releaseCompletion.release()
      await Promise.allSettled([
        completion,
        ...(fundingUpdate ? [fundingUpdate] : []),
        ...(budgetLineInsert ? [budgetLineInsert] : [])
      ])
      await sql`
        UPDATE "Funding_Case_Agreement_Budget_Line_Item"
        SET egcs_fc_programfunding = CASE WHEN id = 25 THEN 100 ELSE egcs_fc_programfunding END,
          _deleted = CASE WHEN id = 250 THEN true ELSE _deleted END
        WHERE id IN (25, 250)
      `.execute(observerDb)
    }
  })

  it('enforces allocation lifecycle, coordinate, and provenance invariants in PostgreSQL', async () => {
    const version = await managedMutation(observerDb, '5', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_versions')
      .values({
        agreement_id: '5',
        version_number: 1,
        status: 'draft'
      })
      .returning('id')
      .executeTakeFirstOrThrow())
    const otherVersion = await managedMutation(observerDb, '6', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_versions')
      .values({
        agreement_id: '6',
        version_number: 1,
        status: 'draft'
      })
      .returning('id')
      .executeTakeFirstOrThrow())
    const allocation = await managedMutation(observerDb, '5', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
      .values({
        allocation_version_id: String(version.id),
        agreement_id: '5',
        commitment_type: '5',
        stream_commitment_id: '13',
        agreement_budget_fiscal_year_id: budgetYearStableId(26),
        outcome_id: '33',
        allocation_method: 'amount',
        allocation_value: '100.0000'
      })
      .returning('id')
      .executeTakeFirstOrThrow())

    await expect(managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({ allocation_value: '99.0000' })
      .where('id', '=', String(allocation.id))
      .execute())).resolves.toBeDefined()
    await managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({ allocation_value: '100.0000' })
      .where('id', '=', String(allocation.id))
      .execute())

    const removableAllocation = await managedMutation(observerDb, '5', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
      .values({
        allocation_version_id: String(version.id),
        agreement_id: '5',
        commitment_type: '6',
        stream_commitment_id: '13',
        agreement_budget_fiscal_year_id: budgetYearStableId(26),
        outcome_id: '33',
        allocation_method: 'amount',
        allocation_value: '0.0000'
      })
      .returning('id')
      .executeTakeFirstOrThrow())
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .deleteFrom('extensions.gcs_outcome_cost_allocation_allocations')
      .where('id', '=', String(removableAllocation.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_allocation_soft_delete_guard'
    })
    await managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({ _deleted: true })
      .where('id', '=', String(removableAllocation.id))
      .execute())

    await expect(managedMutation(observerDb, '6', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
      .values({
        allocation_version_id: String(version.id),
        agreement_id: '6',
        commitment_type: '6',
        stream_commitment_id: '13',
        agreement_budget_fiscal_year_id: budgetYearStableId(26),
        outcome_id: '33',
        allocation_method: 'amount',
        allocation_value: '0.0000'
      })
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_allocation_coordinate_guard'
    })
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
      .values({
        allocation_version_id: String(version.id),
        agreement_id: '5',
        commitment_type: '6',
        stream_commitment_id: '14',
        agreement_budget_fiscal_year_id: budgetYearStableId(28),
        outcome_id: '34',
        allocation_method: 'amount',
        allocation_value: '0.0000'
      })
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_allocation_coordinate_guard'
    })
    await expect(managedMutation(observerDb, '6', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({
        allocation_version_id: String(otherVersion.id),
        agreement_id: '6'
      })
      .where('id', '=', String(allocation.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_allocation_identity_guard'
    })
    await expect(managedMutation(observerDb, '6', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({ status: 'inactive' })
      .where('id', '=', String(otherVersion.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_version_transition_guard'
    })

    await managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({
        outcome_label_en: 'Outcome 4',
        outcome_label_fr: 'Resultat 4',
        commitment_label_en: 'GL 5003 - Program 4',
        commitment_label_fr: 'GL 5003 - Program 4',
        fiscal_year_display: '2026-2027',
        resolved_amount: '100.00',
        funding_basis_amount: '100.00'
      })
      .where('id', '=', String(allocation.id))
      .execute())
    const completedAt = new Date('2026-07-25T00:00:00.000Z')

    await managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({ resolved_amount: '99.00' })
      .where('id', '=', String(allocation.id))
      .execute())
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({
        status: 'active',
        completed_at: completedAt,
        funding_basis_amount: '100.00'
      })
      .where('id', '=', String(version.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_snapshot_economics_guard'
    })

    await managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({ resolved_amount: '100.00', funding_basis_amount: '99.00' })
      .where('id', '=', String(allocation.id))
      .execute())
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({
        status: 'active',
        completed_at: completedAt,
        funding_basis_amount: '100.00'
      })
      .where('id', '=', String(version.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_snapshot_economics_guard'
    })

    await managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({ funding_basis_amount: '100.00' })
      .where('id', '=', String(allocation.id))
      .execute())
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({
        status: 'active',
        completed_at: completedAt,
        funding_basis_amount: '99.00'
      })
      .where('id', '=', String(version.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_snapshot_economics_guard'
    })

    const rejectedVersion = await observerDb
      .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
      .where('id', '=', String(version.id))
      .select(['status', 'completed_at', 'funding_basis_amount'])
      .executeTakeFirstOrThrow()
    expect(rejectedVersion).toMatchObject({
      status: 'draft',
      completed_at: null,
      funding_basis_amount: null
    })

    await expect(managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({
        status: 'active',
        completed_at: completedAt,
        funding_basis_amount: '100.00'
      })
      .where('id', '=', String(version.id))
      .execute())).resolves.toBeDefined()

    const immutableAllocationOperations = [
      () => managedMutation(observerDb, '5', async trx => await trx
        .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
        .set({ allocation_value: '90.0000' })
        .where('id', '=', String(allocation.id))
        .execute()),
      () => managedMutation(observerDb, '5', async trx => await trx
        .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
        .set({ _deleted: true })
        .where('id', '=', String(allocation.id))
        .execute()),
      () => managedMutation(observerDb, '5', async trx => await trx
        .deleteFrom('extensions.gcs_outcome_cost_allocation_allocations')
        .where('id', '=', String(allocation.id))
        .execute())
    ]
    for (const operation of immutableAllocationOperations) {
      await expect(operation()).rejects.toMatchObject({
        code: '23514',
        constraint: expect.stringMatching(
          /^gcs_outcome_cost_allocation_allocation_(draft|soft_delete)_guard$/
        )
      })
    }

    await expect(managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({ version_number: 2 })
      .where('id', '=', String(version.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_version_identity_guard'
    })
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({ _deleted: true })
      .where('id', '=', String(version.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_version_transition_guard'
    })
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .deleteFrom('extensions.gcs_outcome_cost_allocation_versions')
      .where('id', '=', String(version.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_version_transition_guard'
    })

    await observerDb
      .insertInto('Funding_Case_Agreement_Commitment')
      .values({
        id: '100',
        egcs_fc_fundingagreement: '5',
        egcs_fc_type: '5',
        egcs_fc_status: '1',
        egcs_fc_financialsystemnumber: null,
        _deleted: false
      })
      .execute()
    await observerDb
      .insertInto('Funding_Case_Agreement_Commitment_Line')
      .values({
        id: '100',
        egcs_fc_commitment: '100',
        egcs_fc_commitmentlinenumber: 1,
        egcs_fc_transferpaymentstreamchartofaccount: '13',
        egcs_fc_amount: '100.00',
        _deleted: false
      })
      .execute()
    await observerDb
      .insertInto('Funding_Case_Agreement_Commitment')
      .values({
        id: '102',
        egcs_fc_fundingagreement: '5',
        egcs_fc_type: '5',
        egcs_fc_status: '1',
        egcs_fc_financialsystemnumber: null,
        _deleted: false
      })
      .execute()
    await observerDb
      .insertInto('Funding_Case_Agreement_Commitment_Line')
      .values({
        id: '102',
        egcs_fc_commitment: '102',
        egcs_fc_commitmentlinenumber: 1,
        egcs_fc_transferpaymentstreamchartofaccount: '13',
        egcs_fc_amount: '99.00',
        _deleted: false
      })
      .execute()
    await observerDb
      .insertInto('Funding_Case_Agreement_Commitment')
      .values({
        id: '101',
        egcs_fc_fundingagreement: '6',
        egcs_fc_type: '7',
        egcs_fc_status: '1',
        egcs_fc_financialsystemnumber: null,
        _deleted: false
      })
      .execute()
    await observerDb
      .insertInto('Funding_Case_Agreement_Commitment_Line')
      .values({
        id: '101',
        egcs_fc_commitment: '101',
        egcs_fc_commitmentlinenumber: 1,
        egcs_fc_transferpaymentstreamchartofaccount: '14',
        egcs_fc_amount: '100.00',
        _deleted: false
      })
      .execute()

    await expect(managedMutation(observerDb, '5', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_commitment_lines')
      .values({
        allocation_version_id: String(version.id),
        generated_commitment_id: '101',
        commitment_line_id: '101',
        agreement_id: '5',
        agreement_budget_fiscal_year_id: budgetYearStableId(26),
        outcome_id: '33',
        stream_commitment_id: '13',
        generated_amount: '100.00',
        _deleted: false
      })
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_commitment_line_provenance_coordinate_guard'
    })
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_commitment_lines')
      .values({
        allocation_version_id: String(version.id),
        generated_commitment_id: '102',
        commitment_line_id: '102',
        agreement_id: '5',
        agreement_budget_fiscal_year_id: budgetYearStableId(26),
        outcome_id: '33',
        stream_commitment_id: '13',
        generated_amount: '99.00',
        _deleted: false
      })
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_commitment_line_provenance_coordinate_guard'
    })
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_commitment_lines')
      .values({
        allocation_version_id: String(version.id),
        generated_commitment_id: '100',
        commitment_line_id: '100',
        agreement_id: '5',
        agreement_budget_fiscal_year_id: budgetYearStableId(26),
        outcome_id: '33',
        stream_commitment_id: '13',
        generated_amount: '100.00',
        _deleted: true
      })
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_commitment_line_provenance_coordinate_guard'
    })

    const provenance = await managedMutation(observerDb, '5', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_commitment_lines')
      .values({
        allocation_version_id: String(version.id),
        generated_commitment_id: '100',
        commitment_line_id: '100',
        agreement_id: '5',
        agreement_budget_fiscal_year_id: budgetYearStableId(26),
        outcome_id: '33',
        stream_commitment_id: '13',
        generated_amount: '100.00',
        _deleted: false
      })
      .returning('id')
      .executeTakeFirstOrThrow())
    await expect(observerDb
      .updateTable('extensions.gcs_outcome_cost_allocation_commitment_lines')
      .set({ generated_amount: '99.00' })
      .where('id', '=', String(provenance.id))
      .execute()).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_commitment_line_provenance_guard'
    })
    await expect(observerDb
      .deleteFrom('extensions.gcs_outcome_cost_allocation_commitment_lines')
      .where('id', '=', String(provenance.id))
      .execute()).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_commitment_line_provenance_guard'
    })

    await expect(managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({ status: 'inactive' })
      .where('id', '=', String(version.id))
      .execute())).resolves.toBeDefined()
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({ status: 'draft' })
      .where('id', '=', String(version.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_version_transition_guard'
    })
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .deleteFrom('extensions.gcs_outcome_cost_allocation_versions')
      .where('id', '=', String(version.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_version_transition_guard'
    })
    await expect(managedMutation(observerDb, '5', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
      .set({ allocation_value: '90.0000' })
      .where('id', '=', String(allocation.id))
      .execute())).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_allocation_draft_guard'
    })

    await expect(managedMutation(observerDb, '6', async trx => await trx
      .updateTable('extensions.gcs_outcome_cost_allocation_versions')
      .set({ _deleted: true })
      .where('id', '=', String(otherVersion.id))
      .execute())).resolves.toBeDefined()
    await expect(observerDb
      .deleteFrom('extensions.gcs_outcome_cost_allocation_versions')
      .where('id', '=', String(otherVersion.id))
      .execute()).rejects.toMatchObject({
      code: '23514',
      constraint: 'gcs_outcome_cost_allocation_version_transition_guard'
    })
  })

  it('activates an exact version funding aggregate larger than one numeric(19,2) row', async () => {
    const firstYearId = '1000050'
    const secondYearId = '1000051'
    const perYearAmount = '60000000000000000.00'
    const aggregateAmount = '120000000000000000.00'

    await sql`
      INSERT INTO "Funding_Case_Agreement_Profile" (
        id,
        egcs_fc_transferpaymentstream
      ) VALUES (50, 5)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Budget_Version" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_iscurrent
      ) VALUES (150, 50, true)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_fiscalyear,
        egcs_fc_budgetversion
      ) VALUES
        (${firstYearId}::bigint, 50, 50, 150),
        (${secondYearId}::bigint, 50, 50, 150)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" (
        id,
        egcs_fc_fundingagreementbudgetfiscalyear,
        egcs_fc_programfunding
      ) VALUES
        (150, ${firstYearId}::bigint, ${perYearAmount}::numeric),
        (151, ${secondYearId}::bigint, ${perYearAmount}::numeric)
    `.execute(observerDb)

    const versionId = await managedMutation(observerDb, '50', async trx => {
      const version = await sql<{ id: string }>`
        INSERT INTO extensions.gcs_outcome_cost_allocation_versions (
          agreement_id,
          version_number,
          status
        ) VALUES (50, 1, 'draft')
        RETURNING id::text
      `.execute(trx)
      const id = version.rows[0]?.id
      if (!id) throw new Error('Expected an allocation version id.')

      await sql`
        INSERT INTO extensions.gcs_outcome_cost_allocation_allocations (
          allocation_version_id,
          agreement_id,
          commitment_type,
          stream_commitment_id,
          agreement_budget_fiscal_year_id,
          outcome_id,
          allocation_method,
          allocation_value,
          resolved_amount,
          funding_basis_amount,
          outcome_label_en,
          outcome_label_fr,
          commitment_label_en,
          commitment_label_fr,
          fiscal_year_display
        ) VALUES
          (${id}::bigint, 50, 5, 13, ${firstYearId}::bigint, 33, 'percentage', 100,
            ${perYearAmount}::numeric, ${perYearAmount}::numeric, 'Outcome', 'Resultat', 'Commitment', 'Engagement', '2026-2027'),
          (${id}::bigint, 50, 5, 13, ${secondYearId}::bigint, 33, 'percentage', 100,
            ${perYearAmount}::numeric, ${perYearAmount}::numeric, 'Outcome', 'Resultat', 'Commitment', 'Engagement', '2026-2027')
      `.execute(trx)
      await sql`
        UPDATE extensions.gcs_outcome_cost_allocation_versions
        SET status = 'active',
          completed_at = now(),
          funding_basis_amount = ${aggregateAmount}::numeric
        WHERE id = ${id}::bigint
      `.execute(trx)
      return id
    })

    const stored = await sql<{ funding_basis_amount: string, data_type: string }>`
      SELECT
        version.funding_basis_amount::text AS funding_basis_amount,
        format_type(attribute.atttypid, attribute.atttypmod) AS data_type
      FROM extensions.gcs_outcome_cost_allocation_versions version
      JOIN pg_attribute attribute
        ON attribute.attrelid = 'extensions.gcs_outcome_cost_allocation_versions'::regclass
       AND attribute.attname = 'funding_basis_amount'
      WHERE version.id = ${versionId}::bigint
    `.execute(observerDb)
    expect(stored.rows).toEqual([{
      funding_basis_amount: aggregateAmount,
      data_type: 'numeric'
    }])
  })

  it('serializes disable scope scanning with newly generated agreement work', async () => {
    const hooks: Array<(payload: GcsExtensionDisableGuardHookPayload) => Promise<void> | void> = []
    const plugin = (await import('../../server/plugins/create-hooks')).default as unknown as (
      nitroApp: {
        hooks: {
          hook: (
            name: string,
            handler: (payload: GcsExtensionDisableGuardHookPayload) => Promise<void> | void
          ) => void
        }
      }
    ) => void
    plugin({
      hooks: {
        hook: (name, handler) => {
          if (name === 'gcs:extension:disable-guard') {
            hooks.push(handler)
          }
        }
      }
    })
    const guard = hooks[0]
    expect(guard).toBeDefined()

    const disableScanned = createLatch()
    const releaseDisable = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const waiterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const disabling = holderDb.transaction().execute(async trx => {
      await guard?.({
        extensionKey: 'gcs-outcome-cost-allocation',
        scope: 'stream',
        event: {},
        db: trx as unknown as GcsExtensionDisableGuardHookPayload['db'],
        agencyId: '6000',
        streamId: '6'
      })
      disableScanned.release()
      await releaseDisable.promise
      await trx
        .updateTable('extensions.stream_configuration')
        .set({ enabled: false })
        .where('stream_id', '=', '6')
        .where('extension_key', '=', 'gcs-outcome-cost-allocation')
        .execute()
    })
    let generating: Promise<unknown> | undefined
    try {
      await waitForLatchOrTask(disableScanned.promise, disabling, 'Disable guard')
      generating = waiterDb.transaction().execute(async trx => {
        await trx
          .insertInto('Funding_Case_Agreement_Profile')
          .values({
            id: '25',
            egcs_fc_transferpaymentstream: '6',
            _deleted: false
          })
          .execute()
        const config = await lockAndGetOutcomeCostAllocationConfig(
          trx,
          '6000',
          '6'
        )
        if (config !== null) {
          await lockAgreementAllocationLifecycle(trx, '25')
          await trx
            .insertInto('Funding_Case_Agreement_Commitment')
            .values({
              id: '250',
              egcs_fc_fundingagreement: '25',
              egcs_fc_type: '1',
              egcs_fc_status: '1',
              egcs_fc_financialsystemnumber: null,
              _deleted: false
            })
            .execute()
        }
        return config
      })
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${waiterPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })

      releaseDisable.release()
      await expect(disabling).resolves.toBeUndefined()
      await expect(generating).resolves.toBeNull()
      const generatedCommitments = await observerDb
        .selectFrom('Funding_Case_Agreement_Commitment')
        .where('egcs_fc_fundingagreement', '=', '25')
        .select(eb => eb.fn.count('id').as('count'))
        .executeTakeFirstOrThrow()
      expect(Number(generatedCommitments.count)).toBe(0)
    } finally {
      releaseDisable.release()
      await Promise.allSettled([disabling, ...(generating ? [generating] : [])])
      await observerDb
        .updateTable('extensions.stream_configuration')
        .set({ enabled: true })
        .where('stream_id', '=', '6')
        .where('extension_key', '=', 'gcs-outcome-cost-allocation')
        .execute()
    }
  })

  it('serializes agreement stream reassignment with allocation creation and rejects later history moves', async () => {
    await sql`
      INSERT INTO "Transfer_Payment_Profile" (id, egcs_tp_agency)
      VALUES (700, 7000)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Transfer_Payment_Stream" (
        id,
        egcs_tp_transferpaymentprofile
      ) VALUES
        (8, 700),
        (9, 700)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Profile" (
        id,
        egcs_fc_transferpaymentstream
      ) VALUES (8, 8)
    `.execute(observerDb)

    const guard = await loadAgreementStreamChangeGuard()
    const preRowLifecycleLock = await loadAgreementLifecycleLock()
    const reassignmentGuarded = createLatch()
    const releaseReassignment = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const waiterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const reassigning = holderDb.transaction().execute(async trx => {
      const payload = {
        event: {},
        db: trx as unknown as GcsExtensionAgreementLifecycleLockHookPayload['db'],
        agreementId: '8',
        agencyId: '7000',
        currentStreamId: '8',
        targetStreamIds: ['8', '9']
      }
      await lockOutcomeCostAllocationScope(trx, '7000', '8')
      await lockOutcomeCostAllocationScope(trx, '7000', '9')
      await preRowLifecycleLock(payload)
      await trx
        .selectFrom('Funding_Case_Agreement_Profile')
        .where('id', '=', '8')
        .select('id')
        .forUpdate()
        .executeTakeFirstOrThrow()
      await guard({
        ...payload,
        db: trx as unknown as GcsExtensionAgreementStreamChangeGuardHookPayload['db'],
        nextStreamId: '9'
      })
      reassignmentGuarded.release()
      await releaseReassignment.promise
      await trx
        .updateTable('Funding_Case_Agreement_Profile')
        .set({ egcs_fc_transferpaymentstream: '9' })
        .where('id', '=', '8')
        .execute()
    })
    let creatingHistory: Promise<string> | undefined
    try {
      await waitForLatchOrTask(
        reassignmentGuarded.promise,
        reassigning,
        'Agreement stream reassignment guard'
      )
      creatingHistory = waiterDb.transaction().execute(async trx => {
        await lockOutcomeCostAllocationScope(trx, '7000', '8')
        const lockedStreamId = await lockAgreementAllocationLifecycle(trx, '8')
        if (lockedStreamId === '8') {
          await trx
            .insertInto('extensions.gcs_outcome_cost_allocation_versions')
            .values({
              agreement_id: '8',
              version_number: 1,
              status: 'draft'
            })
            .execute()
        }
        return lockedStreamId
      })
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${waiterPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })

      releaseReassignment.release()
      await expect(reassigning).resolves.toBeUndefined()
      await expect(creatingHistory).resolves.toBe('9')
    } finally {
      releaseReassignment.release()
      await Promise.allSettled([reassigning, ...(creatingHistory ? [creatingHistory] : [])])
    }

    const history = await createDraftAllocationVersion(observerDb, '8')
    await expect(observerDb.transaction().execute(async trx => {
      await guard({
        event: {},
        db: trx as unknown as GcsExtensionAgreementStreamChangeGuardHookPayload['db'],
        agreementId: '8',
        agencyId: '7000',
        currentStreamId: '9',
        nextStreamId: '8'
      })
    })).rejects.toMatchObject({
      code: 'GCS_OUTCOME_COST_ALLOCATION_AGREEMENT_STREAM_CHANGE_BLOCKED',
      statusCode: 409
    })
    expect(history.status).toBe('draft')
    const agreement = await observerDb
      .selectFrom('Funding_Case_Agreement_Profile')
      .where('id', '=', '8')
      .select('egcs_fc_transferpaymentstream')
      .executeTakeFirstOrThrow()
    expect(String(agreement.egcs_fc_transferpaymentstream)).toBe('9')
  })

  it('rejects the first draft when an independently committed reassignment wins after route authorization', async () => {
    await sql`
      INSERT INTO "Transfer_Payment_Profile" (id, egcs_tp_agency)
      VALUES (780, 7800)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Transfer_Payment_Stream" (
        id,
        egcs_tp_transferpaymentprofile
      ) VALUES
        (78, 780),
        (79, 780)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Profile" (
        id,
        egcs_fc_transferpaymentstream
      ) VALUES (78, 78)
    `.execute(observerDb)

    const authorizedScope = await resolveExpectedAgreementScope(observerDb, '78')
    const guard = await loadAgreementStreamChangeGuard()
    const preRowLifecycleLock = await loadAgreementLifecycleLock()
    const reassignmentWritten = createLatch()
    const releaseReassignment = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const waiterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const reassigning = holderDb.transaction().execute(async trx => {
      const payload = {
        event: {},
        db: trx as unknown as GcsExtensionAgreementLifecycleLockHookPayload['db'],
        agreementId: '78',
        agencyId: '7800',
        currentStreamId: '78',
        targetStreamIds: ['78', '79']
      }
      await lockOutcomeCostAllocationScope(trx, '7800', '78')
      await lockOutcomeCostAllocationScope(trx, '7800', '79')
      await preRowLifecycleLock(payload)
      await trx
        .selectFrom('Funding_Case_Agreement_Profile')
        .where('id', '=', '78')
        .select('id')
        .forUpdate()
        .executeTakeFirstOrThrow()
      await guard?.({
        event: {},
        db: trx as unknown as GcsExtensionAgreementStreamChangeGuardHookPayload['db'],
        agreementId: '78',
        agencyId: '7800',
        currentStreamId: '78',
        nextStreamId: '79'
      })
      await trx
        .updateTable('Funding_Case_Agreement_Profile')
        .set({ egcs_fc_transferpaymentstream: '79' })
        .where('id', '=', '78')
        .execute()
      reassignmentWritten.release()
      await releaseReassignment.promise
    })
    let creatingDraft: Promise<unknown> | undefined

    try {
      await waitForLatchOrTask(reassignmentWritten.promise, reassigning, 'Agreement reassignment')
      creatingDraft = createDraftAllocationVersionWithExpectedScope(
        waiterDb,
        '78',
        authorizedScope
      )
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${waiterPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })

      releaseReassignment.release()
      await expect(reassigning).resolves.toBeUndefined()
      await expect(creatingDraft).rejects.toMatchObject({
        code: 'GCS_OUTCOME_COST_ALLOCATION_DATABASE_CONFLICT'
      })
    } finally {
      releaseReassignment.release()
      await Promise.allSettled([reassigning, ...(creatingDraft ? [creatingDraft] : [])])
    }

    const agreement = await observerDb
      .selectFrom('Funding_Case_Agreement_Profile')
      .where('id', '=', '78')
      .select('egcs_fc_transferpaymentstream')
      .executeTakeFirstOrThrow()
    const draft = await observerDb
      .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
      .where('agreement_id', '=', '78')
      .where('_deleted', '=', false)
      .select('id')
      .executeTakeFirst()
    expect(String(agreement.egcs_fc_transferpaymentstream)).toBe('79')
    expect(draft).toBeUndefined()
  })

  it('uses the configuration committed ahead of allocation completion', async () => {
    const { allocation, version } = await seedDraftScenario(observerDb, 20, 120, 120, 120)
    const configUpdated = createLatch()
    const releaseConfig = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const waiterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const updatingConfig = holderDb.transaction().execute(async trx => {
      await lockOutcomeCostAllocationScope(trx, '2000', '2')
      await trx
        .updateTable('extensions.stream_configuration')
        .set({
          config: {
            enabledCommitmentTypes: [],
            mappings: []
          }
        })
        .where('stream_id', '=', '2')
        .where('extension_key', '=', 'gcs-outcome-cost-allocation')
        .execute()
      configUpdated.release()
      await releaseConfig.promise
    })
    let completing: ReturnType<typeof saveAndCompleteAllocationVersionWithCurrentConfiguration> | undefined
    try {
      await waitForLatchOrTask(configUpdated.promise, updatingConfig, 'Configuration update')
      completing = saveAndCompleteAllocationVersionWithCurrentConfiguration(
        waiterDb,
        '20',
        '2000',
        '2',
        version.id,
        [allocation]
      )
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${waiterPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })

      releaseConfig.release()
      await expect(updatingConfig).resolves.toBeUndefined()
      await expect(completing).rejects.toMatchObject({
        issues: [{
          code: 'GCS_OUTCOME_COST_ALLOCATION_COMMITMENT_TYPE_DISABLED'
        }]
      })
      const draft = await observerDb
        .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
        .where('id', '=', version.id)
        .select('status')
        .executeTakeFirstOrThrow()
      expect(draft.status).toBe('draft')
    } finally {
      releaseConfig.release()
      await Promise.allSettled([updatingConfig, ...(completing ? [completing] : [])])
      await observerDb
        .updateTable('extensions.stream_configuration')
        .set({ config: streamTwoAllocationConfig })
        .where('stream_id', '=', '2')
        .where('extension_key', '=', 'gcs-outcome-cost-allocation')
        .execute()
    }
  })

  it('rolls back the entire completion write when locked authorization is revoked while waiting', async () => {
    const { allocation, version } = await seedDraftScenario(observerDb, 30, 130, 130, 130)
    await sql`
      DROP TABLE IF EXISTS extensions.gcs_outcome_cost_allocation_test_authorization;
      CREATE TABLE extensions.gcs_outcome_cost_allocation_test_authorization (
        id bigint PRIMARY KEY,
        allowed boolean NOT NULL
      );
      INSERT INTO extensions.gcs_outcome_cost_allocation_test_authorization (id, allowed)
      VALUES (1, true)
    `.execute(observerDb)
    const originalAllocation = await observerDb
      .selectFrom('extensions.gcs_outcome_cost_allocation_allocations')
      .where('allocation_version_id', '=', version.id)
      .where('_deleted', '=', false)
      .select(['id', 'allocation_value'])
      .executeTakeFirstOrThrow()
    const authorizationRevoked = createLatch()
    const releaseAuthorization = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const completionPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const revocation = holderDb.transaction().execute(async trx => {
      await sql`
        UPDATE extensions.gcs_outcome_cost_allocation_test_authorization
        SET allowed = false
        WHERE id = 1
      `.execute(trx)
      authorizationRevoked.release()
      await releaseAuthorization.promise
    })
    let allowed = true
    let completing: ReturnType<typeof saveAndCompleteAllocationVersionWithCurrentConfiguration> | undefined

    try {
      await waitForLatchOrTask(authorizationRevoked.promise, revocation, 'Authorization revocation')
      completing = saveAndCompleteAllocationVersionWithCurrentConfiguration(
        waiterDb,
        '30',
        '2000',
        '2',
        version.id,
        [allocation],
        {
          lockAuthState: async trx => {
            const result = await sql<{ allowed: boolean }>`
              SELECT allowed
              FROM extensions.gcs_outcome_cost_allocation_test_authorization
              WHERE id = 1
              FOR UPDATE
            `.execute(trx as OutcomeCostAllocationDb)
            allowed = result.rows[0]?.allowed === true
          },
          authorizeCurrentEntity: async () => {
            if (!allowed) {
              throw new Error('completion authorization revoked')
            }
          }
        }
      )
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${completionPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })

      releaseAuthorization.release()
      await expect(revocation).resolves.toBeUndefined()
      await expect(completing).rejects.toThrow('completion authorization revoked')

      const persistedVersion = await observerDb
        .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
        .where('id', '=', version.id)
        .select(['status', 'completed_at'])
        .executeTakeFirstOrThrow()
      const persistedAllocations = await observerDb
        .selectFrom('extensions.gcs_outcome_cost_allocation_allocations')
        .where('allocation_version_id', '=', version.id)
        .where('_deleted', '=', false)
        .select(['id', 'allocation_value'])
        .execute()
      const generatedCommitmentLines = await observerDb
        .selectFrom('extensions.gcs_outcome_cost_allocation_commitment_lines')
        .where('allocation_version_id', '=', version.id)
        .where('_deleted', '=', false)
        .select('id')
        .execute()

      expect(persistedVersion).toEqual({
        status: 'draft',
        completed_at: null
      })
      expect(persistedAllocations).toEqual([originalAllocation])
      expect(generatedCommitmentLines).toEqual([])
    } finally {
      releaseAuthorization.release()
      await Promise.allSettled([revocation, ...(completing ? [completing] : [])])
      await sql`
        DROP TABLE IF EXISTS extensions.gcs_outcome_cost_allocation_test_authorization
      `.execute(observerDb)
    }
  })

  it('observes a payment status committed while completion waits for coverage locks', async () => {
    const { version } = await seedDraftScenario(observerDb, 21, 121, 121, 121)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Commitment" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_type,
        egcs_fc_status,
        egcs_fc_financialsystemnumber
      ) VALUES (210, 21, '1', 1, NULL)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Commitment_Line" (
        id,
        egcs_fc_commitment,
        egcs_fc_commitmentlinenumber,
        egcs_fc_transferpaymentstreamchartofaccount,
        egcs_fc_amount
      ) VALUES (210, 210, 1, 10, 100)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Payment" (
        id,
        egcs_fc_fundingagreementcommitment,
        egcs_fc_fiscalyear,
        egcs_fc_paymentamount,
        egcs_fc_status
      ) VALUES (210, 210, ${budgetYearStableId(121)}, 100.02, 3)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Payment_Line" (
        id,
        egcs_fc_fundingagreementpayment,
        egcs_fc_fundingagreementcommitmentline,
        egcs_fc_amount
      ) VALUES (210, 210, 210, 100.02)
    `.execute(observerDb)

    const paymentUpdated = createLatch()
    const releasePayment = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const waiterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const approvingPayment = holderDb.transaction().execute(async trx => {
      await trx
        .updateTable('Funding_Case_Agreement_Payment')
        .set({ egcs_fc_status: '2' })
        .where('id', '=', '210')
        .execute()
      paymentUpdated.release()
      await releasePayment.promise
    })
    let completing: ReturnType<typeof completeAllocationVersion> | undefined
    try {
      await waitForLatchOrTask(paymentUpdated.promise, approvingPayment, 'Payment status update')
      completing = completeAllocationVersion(
        waiterDb,
        '21',
        '2',
        version.id,
        streamTwoAllocationConfig
      )
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${waiterPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })

      releasePayment.release()
      await expect(approvingPayment).resolves.toBeUndefined()
      await expect(completing).rejects.toMatchObject({
        issues: [{
          code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_GENERATED_LINE'
        }]
      })
    } finally {
      releasePayment.release()
      await Promise.allSettled([approvingPayment, ...(completing ? [completing] : [])])
    }
  })

  it('re-reads a denied status after waiting for generated payment creation and rechecks committed coverage', async () => {
    await sql`
      INSERT INTO "Transfer_Payment_Profile" (id, egcs_tp_agency)
      VALUES (1200, 12000);
      INSERT INTO "Transfer_Payment_Stream" (id, egcs_tp_transferpaymentprofile)
      VALUES (12, 1200);
      INSERT INTO "Funding_Case_Agreement_Profile" (id, egcs_fc_transferpaymentstream)
      VALUES (12, 12);
      INSERT INTO "Transfer_Payment_Outcome" (
        id,
        egcs_tp_transferpaymentprofile,
        egcs_tp_name_en,
        egcs_tp_name_fr
      ) VALUES (38, 1200, 'Outcome 8', 'Resultat 8');
      INSERT INTO "Funding_Case_Agreement_Budget_Version" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_iscurrent
      ) VALUES (12035, 12, true);
      INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_fiscalyear,
        egcs_fc_budgetversion
      ) VALUES ('00000000-0000-4000-8000-000000000035', 12, 50, 12035);
      INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" (
        id,
        egcs_fc_fundingagreementbudgetfiscalyear,
        egcs_fc_programfunding
      ) VALUES (120350, '00000000-0000-4000-8000-000000000035', 100);
      INSERT INTO "Transfer_Payment_Fiscal_Year_Budget" (
        id,
        egcs_tp_transferpaymentprofile,
        egcs_tp_fiscalyear
      ) VALUES (68, 1200, 50);
      INSERT INTO "Transfer_Payment_Stream_Budget" (
        id,
        egcs_tp_transferpaymentbudget,
        egcs_tp_transferpaymentstream
      ) VALUES (78, 68, 12);
      INSERT INTO "Transfer_Payment_Stream_Chart_of_Account" (
        id,
        egcs_tp_streambudget,
        egcs_tp_transferpaymentstream,
        egcs_tp_gl,
        egcs_tp_gldescription
      ) VALUES (20, 78, 12, 5009, 'Program 9');
      INSERT INTO "Funding_Case_Agreement_Commitment" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_type,
        egcs_fc_status
      ) VALUES (190, 12, 12, 4);
      INSERT INTO "Funding_Case_Agreement_Commitment_Line" (
        id,
        egcs_fc_commitment,
        egcs_fc_commitmentlinenumber,
        egcs_fc_transferpaymentstreamchartofaccount,
        egcs_fc_amount
      ) VALUES (190, 190, 1, 20, 100)
    `.execute(observerDb)

    await managedMutation(observerDb, '12', async trx => {
      const version = await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_versions')
        .values({ agreement_id: '12', version_number: 1, status: 'draft' })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
        .values({
          allocation_version_id: String(version.id),
          agreement_id: '12',
          commitment_type: '12',
          stream_commitment_id: '20',
          agreement_budget_fiscal_year_id: budgetYearStableId(35),
          outcome_id: '38',
          allocation_method: 'amount',
          allocation_value: '100.0000',
          resolved_amount: '100.00',
          funding_basis_amount: '100.00',
          outcome_label_en: 'Outcome 8',
          outcome_label_fr: 'Resultat 8',
          commitment_label_en: 'GL 5009 - Program 9',
          commitment_label_fr: 'GL 5009 - Program 9',
          fiscal_year_display: '2026-2027'
        })
        .execute()
      await trx
        .updateTable('extensions.gcs_outcome_cost_allocation_versions')
        .set({ status: 'active', completed_at: sql`now()`, funding_basis_amount: '100.00' })
        .where('id', '=', String(version.id))
        .execute()
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_commitment_lines')
        .values({
          allocation_version_id: String(version.id),
          generated_commitment_id: '190',
          commitment_line_id: '190',
          agreement_id: '12',
          agreement_budget_fiscal_year_id: budgetYearStableId(35),
          outcome_id: '38',
          stream_commitment_id: '20',
          generated_amount: '100.00'
        })
        .execute()
      await trx
        .insertInto('Funding_Case_Agreement_Payment')
        .values({
          id: '190',
          egcs_fc_fundingagreementcommitment: '190',
          egcs_fc_fiscalyear: budgetYearStableId(35),
          egcs_fc_paymentamount: '60.00',
          egcs_fc_status: '1'
        })
        .execute()
      await trx
        .insertInto('Funding_Case_Agreement_Payment_Line')
        .values({
          id: '190',
          egcs_fc_fundingagreementpayment: '190',
          egcs_fc_fundingagreementcommitmentline: '190',
          egcs_fc_amount: '60.00'
        })
        .execute()
      await trx
        .updateTable('Funding_Case_Agreement_Payment')
        .set({ egcs_fc_status: '3' })
        .where('id', '=', '190')
        .execute()
      const completion = await sql<{ id: string }>`
        INSERT INTO "Common_Completion" (egcs_cn_entitytype, egcs_cn_entityid)
        VALUES ('fundingcasepayment', 190)
        RETURNING id
      `.execute(trx)
      await sql`
        INSERT INTO "Common_Runtime" (id, egcs_cn_attempt, egcs_cn_state)
        VALUES (1900, 1, 'denied')
      `.execute(trx)
      await sql`
        INSERT INTO "Common_Workflow_Run" (id, egcs_cn_completion)
        VALUES (1900, ${completion.rows[0]?.id})
      `.execute(trx)
    })

    const paymentCreated = createLatch()
    const releaseCreator = createLatch()
    const creatorPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const resurrectionPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const creatingPayment = holderDb.transaction().execute(async trx => {
      await lockAgreementAllocationLifecycle(trx, '12')
      const generated = await getGeneratedPaymentLines(
        trx,
        '12',
        '12',
        '190',
        budgetYearStableId(35),
        50,
        {}
      )
      if (generated.status !== 'handled' || generated.issues.length > 0 || generated.lines.length !== 1) {
        throw new Error('Expected one valid generated payment line before resurrection.')
      }
      await trx
        .insertInto('Funding_Case_Agreement_Payment')
        .values({
          id: '191',
          egcs_fc_fundingagreementcommitment: '190',
          egcs_fc_fiscalyear: budgetYearStableId(35),
          egcs_fc_paymentamount: '50.00',
          egcs_fc_status: '1'
        })
        .execute()
      await trx
        .insertInto('Funding_Case_Agreement_Payment_Line')
        .values(generated.lines.map(line => ({
          id: '191',
          egcs_fc_fundingagreementpayment: '191',
          egcs_fc_fundingagreementcommitmentline: line.commitmentLineId,
          egcs_fc_amount: sql`${line.amount}::numeric`
        })))
        .execute()
      await trx
        .updateTable('Funding_Case_Agreement_Payment')
        .set({ egcs_fc_status: '4' })
        .where('id', '=', '191')
        .execute()
      paymentCreated.release()
      await releaseCreator.promise
    })
    const guard = await loadAgreementPaymentMutationGuard()
    let resurrecting: Promise<unknown> | undefined
    try {
      await waitForLatchOrTask(paymentCreated.promise, creatingPayment, 'Generated payment creation')
      resurrecting = waiterDb.transaction().execute(async trx => {
        await guard({
          operation: 'payment.status-change',
          event: {},
          db: trx as unknown as GcsExtensionAgreementPaymentMutationGuardHookPayload['db'],
          agreementId: '12',
          paymentId: '190',
          currentStatusId: '4',
          nextStatusId: '5'
        })
        await trx
          .updateTable('Funding_Case_Agreement_Payment')
          .set({ egcs_fc_status: '5' })
          .where('id', '=', '190')
          .execute()
      })
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${resurrectionPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(creatorPid)
      })

      releaseCreator.release()
      await expect(creatingPayment).resolves.toBeUndefined()
      await expect(resurrecting).rejects.toMatchObject({
        code: 'GCS_OUTCOME_COST_ALLOCATION_PAYMENT_EXCEEDS_REMAINING',
        statusCode: 409
      })
    } finally {
      releaseCreator.release()
      await Promise.allSettled([creatingPayment, ...(resurrecting ? [resurrecting] : [])])
    }

    const statuses = await observerDb
      .selectFrom('Funding_Case_Agreement_Payment')
      .where('id', 'in', ['190', '191'])
      .select(['id', 'egcs_fc_status'])
      .orderBy('id', 'asc')
      .execute()
    expect(statuses.map(payment => payment.egcs_fc_status)).toEqual(['3', '4'])
  })

  it('observes an outcome unlink committed while completion waits for reference locks', async () => {
    const { version } = await seedDraftScenario(observerDb, 22, 122, 122, 122)
    const outcomeUnlinked = createLatch()
    const releaseOutcome = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const waiterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const unlinkingOutcome = holderDb.transaction().execute(async trx => {
      await trx
        .updateTable('Funding_Case_Agreement_Outcome_Activity')
        .set({ _deleted: true })
        .where('egcs_fc_activity', '=', '122')
        .execute()
      outcomeUnlinked.release()
      await releaseOutcome.promise
    })
    let completing: ReturnType<typeof completeAllocationVersion> | undefined
    try {
      await waitForLatchOrTask(outcomeUnlinked.promise, unlinkingOutcome, 'Outcome unlink')
      completing = completeAllocationVersion(
        waiterDb,
        '22',
        '2',
        version.id,
        streamTwoAllocationConfig
      )
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${waiterPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })

      releaseOutcome.release()
      await expect(unlinkingOutcome).resolves.toBeUndefined()
      await expect(completing).rejects.toMatchObject({
        issues: [{
          code: 'GCS_OUTCOME_COST_ALLOCATION_STALE_OUTCOME'
        }]
      })
    } finally {
      releaseOutcome.release()
      await Promise.allSettled([unlinkingOutcome, ...(completing ? [completing] : [])])
    }
  })

  it('follows payment-line then payment lock order without deadlocking deletion', async () => {
    const { version } = await seedDraftScenario(observerDb, 24, 124, 124, 124)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Commitment" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_type,
        egcs_fc_status,
        egcs_fc_financialsystemnumber
      ) VALUES (240, 24, 1, 1, NULL)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Commitment_Line" (
        id,
        egcs_fc_commitment,
        egcs_fc_commitmentlinenumber,
        egcs_fc_transferpaymentstreamchartofaccount,
        egcs_fc_amount
      ) VALUES (240, 240, 1, 10, 100)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Payment" (
        id,
        egcs_fc_fundingagreementcommitment,
        egcs_fc_fiscalyear,
        egcs_fc_paymentamount,
        egcs_fc_status
      ) VALUES (240, 240, ${budgetYearStableId(124)}, 100, 2)
    `.execute(observerDb)
    await sql`
      INSERT INTO "Funding_Case_Agreement_Payment_Line" (
        id,
        egcs_fc_fundingagreementpayment,
        egcs_fc_fundingagreementcommitmentline,
        egcs_fc_amount
      ) VALUES (240, 240, 240, 100)
    `.execute(observerDb)

    const paymentLineDeleted = createLatch()
    const releaseDeletion = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const waiterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const deletingPayment = holderDb.transaction().execute(async trx => {
      await trx
        .updateTable('Funding_Case_Agreement_Payment_Line')
        .set({ _deleted: true })
        .where('id', '=', '240')
        .execute()
      paymentLineDeleted.release()
      await releaseDeletion.promise
      await trx
        .updateTable('Funding_Case_Agreement_Payment')
        .set({ _deleted: true })
        .where('id', '=', '240')
        .execute()
    })
    let completing: ReturnType<typeof completeAllocationVersion> | undefined
    try {
      await waitForLatchOrTask(paymentLineDeleted.promise, deletingPayment, 'Payment deletion')
      completing = completeAllocationVersion(
        waiterDb,
        '24',
        '2',
        version.id,
        streamTwoAllocationConfig
      )
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${waiterPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })

      releaseDeletion.release()
      await expect(deletingPayment).resolves.toBeUndefined()
      await expect(completing).resolves.toMatchObject({
        status: 'active'
      })
    } finally {
      releaseDeletion.release()
      await Promise.allSettled([deletingPayment, ...(completing ? [completing] : [])])
      await managedMutation(observerDb, '24', async trx => await trx
        .updateTable('extensions.gcs_outcome_cost_allocation_versions')
        .set({ status: 'inactive' })
        .where('id', '=', version.id)
        .where('status', '=', 'active')
        .execute())
    }
  })

  it('prevents a stream enable from overtaking an agency disable', async () => {
    const agencyDisabled = createLatch()
    const releaseAgencyDisable = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const waiterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const disablingAgency = holderDb.transaction().execute(async trx => {
      await lockOutcomeCostAllocationScope(trx, '6000')
      await trx
        .updateTable('extensions.agency_enablement')
        .set({ enabled: false })
        .where('agency_id', '=', '6000')
        .where('extension_key', '=', 'gcs-outcome-cost-allocation')
        .execute()
      await trx
        .updateTable('extensions.stream_configuration')
        .set({ enabled: false })
        .where('stream_id', '=', '6')
        .where('extension_key', '=', 'gcs-outcome-cost-allocation')
        .execute()
      agencyDisabled.release()
      await releaseAgencyDisable.promise
    })
    let enablingStream: Promise<boolean> | undefined
    try {
      await waitForLatchOrTask(agencyDisabled.promise, disablingAgency, 'Agency disable')
      enablingStream = waiterDb.transaction().execute(async trx => {
        await lockOutcomeCostAllocationScope(trx, '6000', '6')
        const agencyEnabled = await trx
          .selectFrom('extensions.agency_enablement')
          .where('agency_id', '=', '6000')
          .where('extension_key', '=', 'gcs-outcome-cost-allocation')
          .where('enabled', '=', true)
          .where('_deleted', '=', false)
          .select('agency_id')
          .executeTakeFirst()
        if (agencyEnabled) {
          await trx
            .updateTable('extensions.stream_configuration')
            .set({ enabled: true })
            .where('stream_id', '=', '6')
            .where('extension_key', '=', 'gcs-outcome-cost-allocation')
            .execute()
        }
        return Boolean(agencyEnabled)
      })
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${waiterPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })

      releaseAgencyDisable.release()
      await expect(disablingAgency).resolves.toBeUndefined()
      await expect(enablingStream).resolves.toBe(false)
      const state = await sql<{ agency_enabled: boolean, stream_enabled: boolean }>`
        SELECT
          agency.enabled AS agency_enabled,
          stream.enabled AS stream_enabled
        FROM extensions.agency_enablement agency
        JOIN extensions.stream_configuration stream
          ON stream.extension_key = agency.extension_key
        WHERE agency.agency_id = 6000
          AND stream.stream_id = 6
          AND agency.extension_key = 'gcs-outcome-cost-allocation'
      `.execute(observerDb)
      expect(state.rows[0]).toEqual({
        agency_enabled: false,
        stream_enabled: false
      })
    } finally {
      releaseAgencyDisable.release()
      await Promise.allSettled([disablingAgency, ...(enablingStream ? [enablingStream] : [])])
      await observerDb
        .updateTable('extensions.agency_enablement')
        .set({ enabled: true })
        .where('agency_id', '=', '6000')
        .where('extension_key', '=', 'gcs-outcome-cost-allocation')
        .execute()
      await observerDb
        .updateTable('extensions.stream_configuration')
        .set({ enabled: true })
        .where('stream_id', '=', '6')
        .where('extension_key', '=', 'gcs-outcome-cost-allocation')
        .execute()
    }
  })

  it('snapshots commitment descriptions longer than five hundred characters', async () => {
    const { version } = await seedDraftScenario(observerDb, 23, 123, 123, 123)
    const description = 'Long allocation commitment description '.repeat(20)
    try {
      await observerDb
        .updateTable('Transfer_Payment_Stream_Chart_of_Account')
        .set({ egcs_tp_accountingdimensions: JSON.stringify([{ label_en: 'G/L', label_fr: 'G/L', value: '5000' }, { label_en: 'Description', label_fr: 'Description', value: description }]) as never })
        .where('id', '=', '10')
        .execute()
      await expect(completeAllocationVersion(
        observerDb,
        '23',
        '2',
        version.id,
        streamTwoAllocationConfig
      )).resolves.toMatchObject({
        status: 'active'
      })
      const [saved] = await getSavedAllocations(observerDb, '23', version.id)
      const commitmentLabel = saved?.commitmentLabelEn
      expect(commitmentLabel).toBe(`G/L: 5000 · Description: ${description}`)
      expect(commitmentLabel?.length).toBeGreaterThan(500)
    } finally {
      await managedMutation(observerDb, '23', async trx => await trx
        .updateTable('extensions.gcs_outcome_cost_allocation_versions')
        .set({ status: 'inactive' })
        .where('id', '=', version.id)
        .where('status', '=', 'active')
        .execute())
      await observerDb
        .updateTable('Transfer_Payment_Stream_Chart_of_Account')
        .set({ egcs_tp_accountingdimensions: JSON.stringify([{ label_en: 'G/L', label_fr: 'G/L', value: '5000' }]) as never })
        .where('id', '=', '10')
        .execute()
    }
  })

  it.each([
    {
      scope: 'stream' as const,
      agencyId: '5000',
      streamId: '5'
    },
    {
      scope: 'agency' as const,
      agencyId: '5000'
    }
  ])('rejects $scope disable through the registered lifecycle guard when provenance exists', async disableScope => {
    const hooks: Array<(payload: GcsExtensionDisableGuardHookPayload) => Promise<void> | void> = []
    const plugin = (await import('../../server/plugins/create-hooks')).default as unknown as (
      nitroApp: {
        hooks: {
          hook: (
            name: string,
            handler: (payload: GcsExtensionDisableGuardHookPayload) => Promise<void> | void
          ) => void
        }
      }
    ) => void
    plugin({
      hooks: {
        hook: (name, handler) => {
          if (name === 'gcs:extension:disable-guard') {
            hooks.push(handler)
          }
        }
      }
    })
    const guard = hooks[0]
    expect(guard).toBeDefined()

    await expect(observerDb.transaction().execute(async trx => {
      await guard?.({
        extensionKey: 'gcs-outcome-cost-allocation',
        event: {},
        db: trx as unknown as GcsExtensionDisableGuardHookPayload['db'],
        ...disableScope
      })
    })).rejects.toMatchObject({
      name: 'GcsExtensionUserError',
      code: 'GCS_OUTCOME_COST_ALLOCATION_DISABLE_BLOCKED',
      statusCode: 409,
      localizedMessage: {
        en: expect.stringContaining('future payments'),
        fr: expect.stringContaining('paiements futurs')
      }
    })
  })

  it('blocks on the agreement row and observes rollback before creating the draft', async () => {
    const holderLocked = createLatch()
    const releaseHolder = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const waiterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)

    expect(holderPid).toBeTypeOf('number')
    expect(waiterPid).toBeTypeOf('number')

    const holder = holderDb.transaction().execute(async trx => {
      await lockAgreementAllocationLifecycle(trx, '1')
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_versions')
        .values({
          agreement_id: '1',
          version_number: 1,
          status: 'draft'
        })
        .execute()
      holderLocked.release()
      await releaseHolder.promise
      throw new Error('intentional rollback')
    })
    let waiter: ReturnType<typeof createDraftAllocationVersion> | undefined
    try {
      await waitForLatchOrTask(holderLocked.promise, holder, 'Lock holder')
      waiter = createDraftAllocationVersion(waiterDb, '1')
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${waiterPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })

      const invisibleDraft = await observerDb
        .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
        .where('agreement_id', '=', '1')
        .select(eb => eb.fn.count('id').as('count'))
        .executeTakeFirstOrThrow()
      expect(Number(invisibleDraft.count)).toBe(0)

      releaseHolder.release()
      await expect(holder).rejects.toThrow('intentional rollback')
      await expect(waiter).resolves.toMatchObject({
        agreementId: '1',
        status: 'draft',
        versionNumber: 1
      })

      const committedDrafts = await observerDb
        .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
        .where('agreement_id', '=', '1')
        .where('status', '=', 'draft')
        .where('_deleted', '=', false)
        .select(eb => eb.fn.count('id').as('count'))
        .executeTakeFirstOrThrow()
      expect(Number(committedDrafts.count)).toBe(1)
    } finally {
      releaseHolder.release()
      await Promise.allSettled([holder, ...(waiter ? [waiter] : [])])
    }
  })

  it('serializes draft edits and deletion against completion without lock inversion', async () => {
    const allocationConfig = {
      enabledCommitmentTypes: ['4'],
      mappings: [{
        commitmentType: '4',
        outcomeId: '32',
        streamBudgetId: '72',
        streamCommitmentId: '12'
      }]
    }
    const allocation = {
      commitmentType: '4' as const,
      streamCommitmentId: '12',
      agreementBudgetFiscalYearId: budgetYearStableId(24),
      outcomeId: '32',
      allocationMethod: 'amount' as const,
      allocationValue: 100
    }
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const waiterPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)

    expect(holderPid).toBeTypeOf('number')
    expect(waiterPid).toBeTypeOf('number')

    const editVersion = await createDraftAllocationVersion(observerDb, '4')
    await saveAllocations(observerDb, '4', editVersion.id, [allocation])
    const editStarted = createLatch()
    const releaseEdit = createLatch()
    const editing = holderDb.transaction().execute(async trx => {
      await lockAgreementAllocationLifecycle(trx, '4')
      await trx
        .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
        .set({ allocation_value: '100.0000' })
        .where('allocation_version_id', '=', editVersion.id)
        .where('_deleted', '=', false)
        .execute()
      editStarted.release()
      await releaseEdit.promise
    })
    let completingEdit: ReturnType<typeof completeAllocationVersion> | undefined
    try {
      await waitForLatchOrTask(editStarted.promise, editing, 'Draft edit')
      completingEdit = completeAllocationVersion(
        waiterDb,
        '4',
        '4',
        editVersion.id,
        allocationConfig
      )
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${waiterPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })
      releaseEdit.release()
      await expect(editing).resolves.toBeUndefined()
      await expect(completingEdit).resolves.toMatchObject({
        id: editVersion.id,
        status: 'active'
      })
    } finally {
      releaseEdit.release()
      await Promise.allSettled([editing, ...(completingEdit ? [completingEdit] : [])])
    }

    const deleteVersion = await createDraftAllocationVersion(observerDb, '4')
    await saveAllocations(observerDb, '4', deleteVersion.id, [allocation])
    const deleteStarted = createLatch()
    const releaseDelete = createLatch()
    const deleting = holderDb.transaction().execute(async trx => {
      await lockAgreementAllocationLifecycle(trx, '4')
      await trx
        .updateTable('extensions.gcs_outcome_cost_allocation_allocations')
        .set({ _deleted: true })
        .where('allocation_version_id', '=', deleteVersion.id)
        .where('_deleted', '=', false)
        .execute()
      await trx
        .updateTable('extensions.gcs_outcome_cost_allocation_versions')
        .set({ _deleted: true })
        .where('id', '=', deleteVersion.id)
        .execute()
      deleteStarted.release()
      await releaseDelete.promise
    })
    let completingDelete: ReturnType<typeof completeAllocationVersion> | undefined
    try {
      await waitForLatchOrTask(deleteStarted.promise, deleting, 'Draft deletion')
      completingDelete = completeAllocationVersion(
        waiterDb,
        '4',
        '4',
        deleteVersion.id,
        allocationConfig
      )
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${waiterPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })
      releaseDelete.release()
      await expect(deleting).resolves.toBeUndefined()
      await expect(completingDelete).rejects.toMatchObject({
        code: 'GCS_OUTCOME_COST_ALLOCATION_DRAFT_COMPLETE_REQUIRED'
      })
    } finally {
      releaseDelete.release()
      await Promise.allSettled([deleting, ...(completingDelete ? [completingDelete] : [])])
    }
  })

  it('serializes completion with stream-commitment deletion and preserves an active-version reference', async () => {
    const version = await managedMutation(observerDb, '2', async trx => {
      const createdVersion = await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_versions')
        .values({
          agreement_id: '2',
          version_number: 1,
          status: 'draft'
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
        .values({
          allocation_version_id: String(createdVersion.id),
          agreement_id: '2',
          commitment_type: '1',
          stream_commitment_id: '10',
          agreement_budget_fiscal_year_id: budgetYearStableId(20),
          outcome_id: '30',
          allocation_method: 'amount',
          allocation_value: '100.0000'
        })
        .execute()
      return createdVersion
    })

    const allocationConfig = {
      enabledCommitmentTypes: ['1'],
      mappings: [{
        commitmentType: '1',
        outcomeId: '30',
        streamBudgetId: '70',
        streamCommitmentId: '10'
      }]
    }
    await observerDb
      .updateTable('Transfer_Payment_Stream_Chart_of_Account')
      .set({ egcs_tp_streambudget: '71' })
      .where('id', '=', '10')
      .execute()
    await expect(completeAllocationVersion(
      observerDb,
      '2',
      '2',
      String(version.id),
      allocationConfig
    )).rejects.toMatchObject({
      issues: [{
        code: 'GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_BUDGET_MISMATCH'
      }]
    })
    await observerDb
      .updateTable('Transfer_Payment_Stream_Chart_of_Account')
      .set({ egcs_tp_streambudget: '70' })
      .where('id', '=', '10')
      .execute()

    const deleteStarted = createLatch()
    const releaseDelete = createLatch()
    const deletePid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const completionPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)

    expect(deletePid).toBeTypeOf('number')
    expect(completionPid).toBeTypeOf('number')

    const deleting = holderDb.transaction().execute(async trx => {
      await trx
        .updateTable('Transfer_Payment_Stream_Chart_of_Account')
        .set({ _deleted: true })
        .where('id', '=', '10')
        .execute()
      deleteStarted.release()
      await releaseDelete.promise
    })
    let completing: ReturnType<typeof completeAllocationVersion> | undefined
    try {
      await waitForLatchOrTask(deleteStarted.promise, deleting, 'Stream-commitment deletion')
      completing = completeAllocationVersion(
        waiterDb,
        '2',
        '2',
        String(version.id),
        allocationConfig
      )
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${completionPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(deletePid)
      })

      releaseDelete.release()
      await expect(deleting).resolves.toBeUndefined()
      await expect(completing).rejects.toMatchObject({
        issues: [{
          code: 'GCS_OUTCOME_COST_ALLOCATION_STREAM_COMMITMENT_INACTIVE'
        }]
      })

      const rejectedVersion = await observerDb
        .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
        .where('id', '=', String(version.id))
        .select('status')
        .executeTakeFirstOrThrow()
      expect(rejectedVersion.status).toBe('draft')

      await observerDb
        .updateTable('Transfer_Payment_Stream_Chart_of_Account')
        .set({ _deleted: false })
        .where('id', '=', '10')
        .execute()
      await expect(completeAllocationVersion(
        observerDb,
        '2',
        '2',
        String(version.id),
        allocationConfig
      )).resolves.toMatchObject({
        status: 'active'
      })

      await expect(observerDb
        .updateTable('Transfer_Payment_Stream_Chart_of_Account')
        .set({ egcs_tp_streambudget: '71' })
        .where('id', '=', '10')
        .execute()).rejects.toMatchObject({
        code: '23514',
        constraint: 'gcs_outcome_cost_allocation_active_stream_commitment_guard'
      })
      await expect(observerDb
        .updateTable('Transfer_Payment_Stream_Chart_of_Account')
        .set({ egcs_tp_accountingdimensions: JSON.stringify([{ label_en: 'G/L', label_fr: 'G/L', value: '5000' }, { label_en: 'Description', label_fr: 'Description', value: 'Updated program description' }]) as never })
        .where('id', '=', '10')
        .execute()).resolves.toBeDefined()
      await observerDb
        .updateTable('Transfer_Payment_Outcome')
        .set({
          egcs_tp_name_en: 'Renamed outcome',
          egcs_tp_name_fr: 'Résultat renommé',
          _deleted: true
        })
        .where('id', '=', '30')
        .execute()
      await expect(getSavedAllocations(
        observerDb,
        '2',
        String(version.id)
      )).resolves.toEqual([
        expect.objectContaining({
          outcomeLabelEn: 'Outcome',
          outcomeLabelFr: 'Resultat',
          commitmentLabelEn: 'G/L: 5000',
          commitmentLabelFr: 'G/L : 5000',
          fiscalYearDisplay: '2026-2027'
        })
      ])

      await expect(observerDb
        .updateTable('Transfer_Payment_Stream_Chart_of_Account')
        .set({ _deleted: true })
        .where('id', '=', '10')
        .execute()).rejects.toMatchObject({
        code: '23514',
        constraint: 'gcs_outcome_cost_allocation_active_stream_commitment_guard'
      })
    } finally {
      releaseDelete.release()
      await Promise.allSettled([deleting, ...(completing ? [completing] : [])])
    }
  })

  it('serializes activation with fiscal-budget and stream-budget mapping mutations', async () => {
    await sql`
      INSERT INTO "Transfer_Payment_Profile" (id, egcs_tp_agency)
      VALUES (800, 8000);
      INSERT INTO "Transfer_Payment_Stream" (id, egcs_tp_transferpaymentprofile)
      VALUES (10, 800);
      INSERT INTO "Funding_Case_Agreement_Profile" (id, egcs_fc_transferpaymentstream)
      VALUES (910000, 10);
      INSERT INTO "Transfer_Payment_Outcome" (
        id,
        egcs_tp_transferpaymentprofile,
        egcs_tp_name_en,
        egcs_tp_name_fr
      ) VALUES (36, 800, 'Outcome 6', 'Resultat 6');
      INSERT INTO "Funding_Case_Agreement_Activity" (id, egcs_fc_fundingagreement)
      VALUES (46, 910000);
      INSERT INTO "Funding_Case_Agreement_Outcome_Activity" (
        egcs_fc_activity,
        egcs_fc_outcomes
      ) VALUES (46, 36);
      INSERT INTO "Funding_Case_Agreement_Budget_Version" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_iscurrent
      ) VALUES (10032, 910000, true);
      INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_fiscalyear,
        egcs_fc_budgetversion
      ) VALUES ('00000000-0000-4000-8000-000000000032', 910000, 50, 10032);
      INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" (
        id,
        egcs_fc_fundingagreementbudgetfiscalyear,
        egcs_fc_programfunding
      ) VALUES (33, '00000000-0000-4000-8000-000000000032', 100);
      INSERT INTO "Transfer_Payment_Fiscal_Year_Budget" (
        id,
        egcs_tp_transferpaymentprofile,
        egcs_tp_fiscalyear
      ) VALUES (66, 800, 50);
      INSERT INTO "Transfer_Payment_Stream_Budget" (
        id,
        egcs_tp_transferpaymentbudget,
        egcs_tp_transferpaymentstream
      ) VALUES (76, 66, 10);
      INSERT INTO "Transfer_Payment_Stream_Chart_of_Account" (
        id,
        egcs_tp_streambudget,
        egcs_tp_transferpaymentstream,
        egcs_tp_gl,
        egcs_tp_gldescription
      ) VALUES (17, 76, 10, 5006, 'Program 6')
    `.execute(observerDb)

    const version = await managedMutation(observerDb, '910000', async trx => {
      const createdVersion = await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_versions')
        .values({
          agreement_id: '910000',
          version_number: 1,
          status: 'draft'
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
        .values({
          allocation_version_id: String(createdVersion.id),
          agreement_id: '910000',
          commitment_type: '10',
          stream_commitment_id: '17',
          agreement_budget_fiscal_year_id: budgetYearStableId(32),
          outcome_id: '36',
          allocation_method: 'amount',
          allocation_value: '100.0000'
        })
        .execute()
      return createdVersion
    })
    const config = {
      enabledCommitmentTypes: ['10'],
      mappings: [{
        commitmentType: '10',
        outcomeId: '36',
        streamBudgetId: '76',
        streamCommitmentId: '17'
      }]
    }

    const fiscalBudgetChanged = createLatch()
    const releaseFiscalBudget = createLatch()
    const fiscalMutationPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const completionPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const changingFiscalBudget = holderDb.transaction().execute(async trx => {
      await trx
        .updateTable('Transfer_Payment_Fiscal_Year_Budget')
        .set({ _deleted: true })
        .where('id', '=', '66')
        .execute()
      fiscalBudgetChanged.release()
      await releaseFiscalBudget.promise
    })
    let completingAfterFiscalMutation: ReturnType<typeof completeAllocationVersion> | undefined
    try {
      await waitForLatchOrTask(
        fiscalBudgetChanged.promise,
        changingFiscalBudget,
        'Fiscal-budget mutation'
      )
      completingAfterFiscalMutation = completeAllocationVersion(
        waiterDb,
        '910000',
        '10',
        String(version.id),
        config
      )
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${completionPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(fiscalMutationPid)
      })

      releaseFiscalBudget.release()
      await expect(changingFiscalBudget).resolves.toBeUndefined()
      await expect(completingAfterFiscalMutation).rejects.toMatchObject({
        issues: [{
          code: 'GCS_OUTCOME_COST_ALLOCATION_STREAM_BUDGET_MISSING'
        }]
      })
    } finally {
      releaseFiscalBudget.release()
      await Promise.allSettled([
        changingFiscalBudget,
        ...(completingAfterFiscalMutation ? [completingAfterFiscalMutation] : [])
      ])
    }
    await observerDb
      .updateTable('Transfer_Payment_Fiscal_Year_Budget')
      .set({ _deleted: false })
      .where('id', '=', '66')
      .execute()

    const activationReady = createLatch()
    const releaseActivation = createLatch()
    const activationPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const streamMutationPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const activating = holderDb.transaction().execute(async trx => {
      const completed = await completeAllocationVersionInTransaction(
        trx,
        '910000',
        '10',
        String(version.id),
        config
      )
      activationReady.release()
      await releaseActivation.promise
      return completed
    })
    let changingStreamBudget: Promise<unknown> | undefined
    try {
      await waitForLatchOrTask(activationReady.promise, activating, 'Allocation activation')
      changingStreamBudget = waiterDb
        .updateTable('Transfer_Payment_Stream_Budget')
        .set({ egcs_tp_transferpaymentbudget: '64' })
        .where('id', '=', '76')
        .execute()
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${streamMutationPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(activationPid)
      })

      releaseActivation.release()
      await expect(activating).resolves.toMatchObject({
        agreementId: '910000',
        status: 'active'
      })
      await expect(changingStreamBudget).rejects.toMatchObject({
        code: '23514',
        constraint: 'gcs_outcome_cost_allocation_active_budget_mapping_guard'
      })
    } finally {
      releaseActivation.release()
      await Promise.allSettled([
        activating,
        ...(changingStreamBudget ? [changingStreamBudget] : [])
      ])
    }
  })

  it('orders recorded commitment lines deterministically before assigning a residual cent', async () => {
    await sql`
      INSERT INTO "Transfer_Payment_Profile" (id, egcs_tp_agency)
      VALUES (900, 9000);
      INSERT INTO "Transfer_Payment_Stream" (id, egcs_tp_transferpaymentprofile)
      VALUES (11, 900);
      INSERT INTO "Funding_Case_Agreement_Profile" (id, egcs_fc_transferpaymentstream)
      VALUES (920000, 11);
      INSERT INTO "Transfer_Payment_Outcome" (
        id,
        egcs_tp_transferpaymentprofile,
        egcs_tp_name_en,
        egcs_tp_name_fr
      ) VALUES (37, 900, 'Outcome 7', 'Resultat 7');
      INSERT INTO "Funding_Case_Agreement_Budget_Version" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_iscurrent
      ) VALUES (11034, 920000, true);
      INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_fiscalyear,
        egcs_fc_budgetversion
      ) VALUES ('00000000-0000-4000-8000-000000000034', 920000, 50, 11034);
      INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" (
        id,
        egcs_fc_fundingagreementbudgetfiscalyear,
        egcs_fc_programfunding
      ) VALUES (110340, '00000000-0000-4000-8000-000000000034', 100);
      INSERT INTO "Transfer_Payment_Fiscal_Year_Budget" (
        id,
        egcs_tp_transferpaymentprofile,
        egcs_tp_fiscalyear
      ) VALUES (67, 900, 50);
      INSERT INTO "Transfer_Payment_Stream_Budget" (
        id,
        egcs_tp_transferpaymentbudget,
        egcs_tp_transferpaymentstream
      ) VALUES (77, 67, 11);
      INSERT INTO "Transfer_Payment_Stream_Chart_of_Account" (
        id,
        egcs_tp_streambudget,
        egcs_tp_transferpaymentstream,
        egcs_tp_gl,
        egcs_tp_gldescription
      ) VALUES
        (18, 77, 11, 5007, 'Program 7'),
        (19, 77, 11, 5008, 'Program 8');
      INSERT INTO "Funding_Case_Agreement_Commitment" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_type,
        egcs_fc_status
      ) VALUES (180, 920000, 11, 4);
      INSERT INTO "Funding_Case_Agreement_Commitment_Line" (
        id,
        egcs_fc_commitment,
        egcs_fc_commitmentlinenumber,
        egcs_fc_transferpaymentstreamchartofaccount,
        egcs_fc_amount
      ) VALUES
        (181, 180, 2, 19, 50),
        (179, 180, 1, 18, 50)
    `.execute(observerDb)
    await managedMutation(observerDb, '920000', async trx => {
      const version = await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_versions')
        .values({
          agreement_id: '920000',
          version_number: 1,
          status: 'draft'
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
        .values([
          {
            allocation_version_id: String(version.id),
            agreement_id: '920000',
            commitment_type: '11',
            stream_commitment_id: '18',
            agreement_budget_fiscal_year_id: budgetYearStableId(34),
            outcome_id: '37',
            allocation_method: 'amount',
            allocation_value: '50.0000',
            resolved_amount: '50.00',
            funding_basis_amount: '100.00',
            outcome_label_en: 'Outcome 7',
            outcome_label_fr: 'Resultat 7',
            commitment_label_en: 'GL 5007 - Program 7',
            commitment_label_fr: 'GL 5007 - Program 7',
            fiscal_year_display: '2026-2027'
          },
          {
            allocation_version_id: String(version.id),
            agreement_id: '920000',
            commitment_type: '11',
            stream_commitment_id: '19',
            agreement_budget_fiscal_year_id: budgetYearStableId(34),
            outcome_id: '37',
            allocation_method: 'amount',
            allocation_value: '50.0000',
            resolved_amount: '50.00',
            funding_basis_amount: '100.00',
            outcome_label_en: 'Outcome 7',
            outcome_label_fr: 'Resultat 7',
            commitment_label_en: 'GL 5008 - Program 8',
            commitment_label_fr: 'GL 5008 - Program 8',
            fiscal_year_display: '2026-2027'
          }
        ])
        .execute()
      await trx
        .updateTable('extensions.gcs_outcome_cost_allocation_versions')
        .set({
          status: 'active',
          completed_at: sql`now()`,
          funding_basis_amount: '100.00'
        })
        .where('id', '=', String(version.id))
        .execute()
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_commitment_lines')
        .values([
          {
            allocation_version_id: String(version.id),
            generated_commitment_id: '180',
            commitment_line_id: '181',
            agreement_id: '920000',
            agreement_budget_fiscal_year_id: budgetYearStableId(34),
            outcome_id: '37',
            stream_commitment_id: '19',
            generated_amount: '50.00'
          },
          {
            allocation_version_id: String(version.id),
            generated_commitment_id: '180',
            commitment_line_id: '179',
            agreement_id: '920000',
            agreement_budget_fiscal_year_id: budgetYearStableId(34),
            outcome_id: '37',
            stream_commitment_id: '18',
            generated_amount: '50.00'
          }
        ])
        .execute()
    })

    const generated = await observerDb.transaction().execute(async trx =>
      await getGeneratedPaymentLines(
        trx,
        '920000',
        '11',
        '180',
        budgetYearStableId(34),
        0.01,
        {}
      )
    )
    expect(generated).toEqual({
      status: 'handled',
      issues: [],
      lines: [{
        commitmentLineId: '179',
        amount: '0.01'
      }]
    })

    await observerDb.transaction().execute(async trx => {
      if (generated.status !== 'handled') throw new Error('Expected Outcome allocation payment lines.')
      await lockAgreementAllocationLifecycle(trx, '920000')
      await trx.insertInto('Funding_Case_Agreement_Payment').values({
        id: '181', egcs_fc_fundingagreementcommitment: '180',
        egcs_fc_fiscalyear: budgetYearStableId(34), egcs_fc_paymentamount: '0.01', egcs_fc_status: '1'
      }).execute()
      await trx.insertInto('Funding_Case_Agreement_Payment_Line').values(generated.lines.map(line => ({
        id: '181', egcs_fc_fundingagreementpayment: '181',
        egcs_fc_fundingagreementcommitmentline: line.commitmentLineId, egcs_fc_amount: sql`${line.amount}::numeric`
      }))).execute()
    })
    expect(Number((await observerDb.selectFrom('Funding_Case_Agreement_Payment_Line')
      .select(eb => eb.fn.count('id').as('count'))
      .where('egcs_fc_fundingagreementpayment', '=', '181').executeTakeFirstOrThrow()).count)).toBe(1)

    await expect(observerDb.transaction().execute(async trx => {
      await lockAgreementAllocationLifecycle(trx, '920000')
      await trx.insertInto('Funding_Case_Agreement_Payment').values({
        id: '182', egcs_fc_fundingagreementcommitment: '180',
        egcs_fc_fiscalyear: budgetYearStableId(34), egcs_fc_paymentamount: '0.01', egcs_fc_status: '1'
      }).execute()
      await trx.insertInto('Funding_Case_Agreement_Payment_Line').values({
        id: '182', egcs_fc_fundingagreementpayment: '182',
        egcs_fc_fundingagreementcommitmentline: '179', egcs_fc_amount: '0.01'
      }).execute()
      throw new Error('later payment create hook failed')
    })).rejects.toThrow('later payment create hook failed')
    expect(Number((await observerDb.selectFrom('Funding_Case_Agreement_Payment')
      .select(eb => eb.fn.count('id').as('count')).where('id', '=', '182').executeTakeFirstOrThrow()).count)).toBe(0)
    expect(Number((await observerDb.selectFrom('Funding_Case_Agreement_Payment_Line')
      .select(eb => eb.fn.count('id').as('count'))
      .where('egcs_fc_fundingagreementpayment', '=', '182').executeTakeFirstOrThrow()).count)).toBe(0)
  })

  it('blocks activation-first deletion and observes the committed active allocation', async () => {
    const version = await managedMutation(observerDb, '3', async trx => {
      const createdVersion = await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_versions')
        .values({
          agreement_id: '3',
          version_number: 1,
          status: 'draft'
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_allocations')
        .values({
          allocation_version_id: String(createdVersion.id),
          agreement_id: '3',
          commitment_type: '3',
          stream_commitment_id: '11',
          agreement_budget_fiscal_year_id: budgetYearStableId(22),
          outcome_id: '31',
          allocation_method: 'amount',
          allocation_value: '100.0000'
        })
        .execute()
      return createdVersion
    })

    const activationReady = createLatch()
    const releaseActivation = createLatch()
    const activationPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const deletePid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)

    expect(activationPid).toBeTypeOf('number')
    expect(deletePid).toBeTypeOf('number')

    const activating = holderDb.transaction().execute(async trx => {
      const completed = await completeAllocationVersionInTransaction(
        trx,
        '3',
        '3',
        String(version.id),
        {
          enabledCommitmentTypes: ['3'],
          mappings: [{
            commitmentType: '3',
            outcomeId: '31',
            streamBudgetId: '71',
            streamCommitmentId: '11'
          }]
        }
      )
      activationReady.release()
      await releaseActivation.promise
      return completed
    })
    let deleting: Promise<unknown> | undefined
    try {
      await waitForLatchOrTask(activationReady.promise, activating, 'Allocation activation')
      deleting = waiterDb
        .updateTable('Transfer_Payment_Stream_Chart_of_Account')
        .set({ _deleted: true })
        .where('id', '=', '11')
        .execute()
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${deletePid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(activationPid)
      })

      releaseActivation.release()
      await expect(activating).resolves.toMatchObject({
        agreementId: '3',
        status: 'active'
      })
      await expect(deleting).rejects.toMatchObject({
        code: '23514',
        constraint: 'gcs_outcome_cost_allocation_active_stream_commitment_guard'
      })
    } finally {
      releaseActivation.release()
      await Promise.allSettled([activating, ...(deleting ? [deleting] : [])])
    }
  })

  it('prevents allocation history creation after agreement deletion wins the lifecycle lock', async () => {
    const guard = await loadAgreementDeleteGuard()
    await sql`
      INSERT INTO "Funding_Case_Agreement_Profile" (id, egcs_fc_transferpaymentstream)
      VALUES (1001, 2)
    `.execute(observerDb)
    const deletionReady = createLatch()
    const releaseDeletion = createLatch()
    const deletionPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const historyPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)

    const deleting = holderDb.transaction().execute(async trx => {
      await guard({
        event: {},
        db: trx as unknown as Transaction<unknown>,
        agreementId: '1001',
        agencyId: '2000',
        streamId: '2'
      })
      await trx
        .updateTable('Funding_Case_Agreement_Profile')
        .set({ _deleted: true })
        .where('id', '=', '1001')
        .execute()
      deletionReady.release()
      await releaseDeletion.promise
    })
    await waitForLatchOrTask(deletionReady.promise, deleting, 'Agreement deletion')

    const creatingHistory = managedMutation(waiterDb, '1001', async trx => await trx
      .insertInto('extensions.gcs_outcome_cost_allocation_versions')
      .values({
        agreement_id: '1001',
        version_number: 1,
        status: 'draft'
      })
      .execute())

    try {
      await vi.waitFor(async () => {
        const blockers = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${historyPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(blockers.rows[0]?.blocker_pids).toContain(deletionPid)
      })
      releaseDeletion.release()
      await expect(deleting).resolves.toBeUndefined()
      await expect(creatingHistory).rejects.toMatchObject({
        code: 'GCS_OUTCOME_COST_ALLOCATION_INVALID'
      })
    } finally {
      releaseDeletion.release()
      await Promise.allSettled([deleting, creatingHistory])
    }

    const history = await observerDb
      .selectFrom('extensions.gcs_outcome_cost_allocation_versions')
      .where('agreement_id', '=', '1001')
      .select('id')
      .execute()
    expect(history).toEqual([])
  })

  it('blocks agreement deletion after allocation history wins the lifecycle lock', async () => {
    const guard = await loadAgreementDeleteGuard()
    await sql`
      INSERT INTO "Funding_Case_Agreement_Profile" (id, egcs_fc_transferpaymentstream)
      VALUES (1002, 2)
    `.execute(observerDb)
    const historyReady = createLatch()
    const releaseHistory = createLatch()
    const historyPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const deletionPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)

    const creatingHistory = managedMutation(holderDb, '1002', async trx => {
      await trx
        .insertInto('extensions.gcs_outcome_cost_allocation_versions')
        .values({
          agreement_id: '1002',
          version_number: 1,
          status: 'draft'
        })
        .execute()
      historyReady.release()
      await releaseHistory.promise
    })
    await waitForLatchOrTask(historyReady.promise, creatingHistory, 'Allocation history creation')

    const deleting = waiterDb.transaction().execute(async trx => {
      await guard({
        event: {},
        db: trx as unknown as Transaction<unknown>,
        agreementId: '1002',
        agencyId: '2000',
        streamId: '2'
      })
      await trx
        .updateTable('Funding_Case_Agreement_Profile')
        .set({ _deleted: true })
        .where('id', '=', '1002')
        .execute()
    })

    try {
      await vi.waitFor(async () => {
        const blockers = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${deletionPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(blockers.rows[0]?.blocker_pids).toContain(historyPid)
      })
      releaseHistory.release()
      await expect(creatingHistory).resolves.toBeUndefined()
      await expect(deleting).rejects.toMatchObject({
        code: 'GCS_OUTCOME_COST_ALLOCATION_AGREEMENT_DELETE_BLOCKED'
      })
    } finally {
      releaseHistory.release()
      await Promise.allSettled([creatingHistory, deleting])
    }

    const agreement = await observerDb
      .selectFrom('Funding_Case_Agreement_Profile')
      .where('id', '=', '1002')
      .select('_deleted')
      .executeTakeFirstOrThrow()
    expect(agreement._deleted).toBe(false)
  })

  it('locks the current stream before the agreement advisory lock during allocation completion', async () => {
    await sql`
      INSERT INTO "Funding_Case_Agreement_Profile" (id, egcs_fc_transferpaymentstream)
      VALUES (99, 2);
      INSERT INTO "Funding_Case_Agreement_Activity" (id, egcs_fc_fundingagreement)
      VALUES (299, 99);
      INSERT INTO "Transfer_Payment_Outcome" (
        id,
        egcs_tp_transferpaymentprofile,
        egcs_tp_name_en,
        egcs_tp_name_fr
      ) VALUES (299, 200, 'Lock order outcome', 'Resultat ordre verrouillage');
      INSERT INTO "Funding_Case_Agreement_Outcome_Activity" (egcs_fc_activity, egcs_fc_outcomes)
      VALUES (299, 299);
      INSERT INTO "Funding_Case_Agreement_Budget_Version" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_iscurrent
      ) VALUES (990299, 99, true);
      INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" (
        id,
        egcs_fc_fundingagreement,
        egcs_fc_fiscalyear,
        egcs_fc_budgetversion
      ) VALUES ('00000000-0000-4000-8000-000000000299', 99, 50, 990299);
      INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" (
        id,
        egcs_fc_fundingagreementbudgetfiscalyear,
        egcs_fc_programfunding
      ) VALUES (299, '00000000-0000-4000-8000-000000000299', 100);
      INSERT INTO "Transfer_Payment_Stream_Chart_of_Account" (
        id,
        egcs_tp_streambudget,
        egcs_tp_transferpaymentstream,
        egcs_tp_gl,
        egcs_tp_gldescription
      ) VALUES (299, 70, 2, 5299, 'Lock order')
    `.execute(observerDb)
    const version = await createDraftAllocationVersion(observerDb, '99')
    const config = {
      enabledCommitmentTypes: ['1'],
      mappings: [{
        commitmentType: '1',
        outcomeId: '299',
        streamBudgetId: '70',
        streamCommitmentId: '299'
      }]
    }
    await observerDb
      .updateTable('extensions.stream_configuration')
      .set({ config })
      .where('stream_id', '=', '2')
      .where('extension_key', '=', 'gcs-outcome-cost-allocation')
      .execute()
    await saveAllocations(observerDb, '99', version.id, [{
      commitmentType: '1',
      streamCommitmentId: '299',
      agreementBudgetFiscalYearId: budgetYearStableId(299),
      outcomeId: '299',
      allocationMethod: 'amount',
      allocationValue: 100
    }])
    const streamLocked = createLatch()
    const continueHostWrite = createLatch()
    const holderPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(holderDb)
      .then(result => result.rows[0]?.pid)
    const completionPid = await sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
      .execute(waiterDb)
      .then(result => result.rows[0]?.pid)
    const hostLikeWrite = holderDb.transaction().execute(async trx => {
      await trx
        .selectFrom('Transfer_Payment_Stream')
        .where('id', '=', '2')
        .where('_deleted', '=', false)
        .select('id')
        .forUpdate()
        .executeTakeFirstOrThrow()
      streamLocked.release()
      await continueHostWrite.promise
      await lockAgreementAllocationAdvisory(trx, '99')
      await trx
        .selectFrom('Funding_Case_Agreement_Profile')
        .where('id', '=', '99')
        .where('_deleted', '=', false)
        .select('id')
        .forUpdate()
        .executeTakeFirstOrThrow()
      await trx
        .updateTable('Funding_Case_Agreement_Profile')
        .set({ egcs_fc_transferpaymentstream: '2' })
        .where('id', '=', '99')
        .execute()
    })
    let completing: ReturnType<typeof completeAllocationVersion> | undefined

    try {
      await waitForLatchOrTask(streamLocked.promise, hostLikeWrite, 'Host-like stream write')
      completing = completeAllocationVersion(
        waiterDb,
        '99',
        '2',
        version.id,
        config
      )
      await vi.waitFor(async () => {
        const result = await sql<{ blocker_pids: number[] }>`
          SELECT pg_blocking_pids(${completionPid})::integer[] AS blocker_pids
        `.execute(observerDb)
        expect(result.rows[0]?.blocker_pids).toContain(holderPid)
      })

      continueHostWrite.release()
      await expect(hostLikeWrite).resolves.toBeUndefined()
      await expect(completing).resolves.toMatchObject({
        agreementId: '99',
        status: 'active'
      })
    } finally {
      continueHostWrite.release()
      await Promise.allSettled([hostLikeWrite, ...(completing ? [completing] : [])])
    }
  })

  it('refuses rollback after completed allocation history exists', async () => {
    await expect(migration0001.down(observerDb)).rejects.toThrow(
      'Cannot uninstall outcome cost allocation while generated provenance or completed allocation history exists.'
    )
    await expect(sql`
      SELECT to_regclass('extensions.gcs_outcome_cost_allocation_versions')::text AS version_table
    `.execute(observerDb)).resolves.toMatchObject({
      rows: [{
        version_table: 'extensions.gcs_outcome_cost_allocation_versions'
      }]
    })
  })
})

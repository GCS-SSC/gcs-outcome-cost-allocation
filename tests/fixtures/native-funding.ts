import { sql } from 'kysely'
import type { Kysely } from 'kysely'

/** Independent reduced owning source fixture; no host arithmetic or core mutation policy is mocked as a currency oracle. */
export const createNativeFundingSourceFixture = async (db: Kysely<Record<string, Record<string, unknown>>>) => {
  const source = `
    CREATE TABLE "Funding_Case_Agreement_Profile" (id bigint PRIMARY KEY, egcs_fc_currency text NOT NULL, _deleted boolean DEFAULT false);
    CREATE TABLE "Agency_Fiscal_Year" (id bigint PRIMARY KEY, egcs_ay_fiscalyear integer, egcs_ay_fiscalyeardisplay text, _deleted boolean DEFAULT false);
    CREATE TABLE "Funding_Case_Agreement_Budget_Version" (id bigint PRIMARY KEY, egcs_fc_fundingagreement bigint, egcs_fc_iscurrent boolean, _deleted boolean DEFAULT false);
    CREATE TABLE "Funding_Case_Agreement_Budget_Fiscal_Year" (id bigint PRIMARY KEY, egcs_fc_originalbudgetfiscalyear bigint, egcs_fc_fundingagreement bigint, egcs_fc_budgetversion bigint, egcs_fc_fiscalyear bigint, _deleted boolean DEFAULT false);
    CREATE TABLE "Funding_Case_Agreement_Budget_Line_Item" (id bigint PRIMARY KEY, egcs_fc_fundingagreementbudgetfiscalyear bigint, egcs_fc_programfunding numeric(19,2), egcs_fc_currency text, _deleted boolean DEFAULT false);
    CREATE TABLE "Transfer_Payment_Stream" (id bigint PRIMARY KEY, egcs_tp_transferpaymentprofile bigint, _deleted boolean DEFAULT false);
    CREATE TABLE "Transfer_Payment_Fiscal_Year_Budget" (id bigint PRIMARY KEY, egcs_tp_transferpaymentprofile bigint, egcs_tp_fiscalyear bigint, egcs_tp_currency text, _deleted boolean DEFAULT false);
    CREATE TABLE "Transfer_Payment_Stream_Budget" (id bigint PRIMARY KEY, egcs_tp_transferpaymentbudget bigint, egcs_tp_transferpaymentstream bigint, _deleted boolean DEFAULT false);
    CREATE TABLE "Agency_Chart_of_Account" (id bigint PRIMARY KEY, egcs_ay_fiscalyear bigint, egcs_ay_currency text, egcs_ay_kind text DEFAULT 'commitment', egcs_ay_accountingdimensions jsonb DEFAULT '[]', _deleted boolean DEFAULT false);
    CREATE TABLE "Transfer_Payment_Stream_Chart_of_Account" (id bigint PRIMARY KEY, egcs_tp_agencychartofaccount bigint, egcs_tp_transferpaymentstream bigint, _deleted boolean DEFAULT false);
    INSERT INTO "Funding_Case_Agreement_Profile" VALUES (1,'cad',false);
    INSERT INTO "Agency_Fiscal_Year" VALUES (1,2026,'2026–2027',false);
    INSERT INTO "Funding_Case_Agreement_Budget_Version" VALUES (1,1,true,false);
    INSERT INTO "Funding_Case_Agreement_Budget_Fiscal_Year" VALUES (10,NULL,1,1,1,false);
    INSERT INTO "Funding_Case_Agreement_Budget_Line_Item" VALUES (101,10,125.55,'cad',false);
    INSERT INTO "Transfer_Payment_Stream" VALUES (2,1,false);
    INSERT INTO "Transfer_Payment_Fiscal_Year_Budget" VALUES (201,1,1,'cad',false),(202,1,1,'usd',false);
    INSERT INTO "Transfer_Payment_Stream_Budget" VALUES (301,201,2,false),(302,202,2,false);
    INSERT INTO "Agency_Chart_of_Account" VALUES (401,1,'cad','commitment','[]',false),(402,1,'usd','commitment','[]',false);
    INSERT INTO "Transfer_Payment_Stream_Chart_of_Account" VALUES (501,401,2,false),(502,402,2,false);
  `
  for (const statement of source.split(';').filter(statement => statement.trim())) await sql.raw(statement).execute(db)
}

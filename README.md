# gcs-outcome-cost-allocation

Standalone GCS-SSC extension that allocates agreement program funding across referenced outcomes and supplies Commitment, Payment, Accounts Receivable and Credit Memo coding through the host allocator interface.

## PostgreSQL concurrency integration test

PGlite uses a single backend and cannot demonstrate independent sessions waiting on PostgreSQL locks. The opt-in integration suite uses three real PostgreSQL connections to verify the canonical transaction advisory lock, rollback visibility, lock release, migration ordering, and serialization between allocation completion and stream-commitment deletion.

Run it only against a disposable database whose name ends in `_test`:

```bash
docker run -d --rm --name outcome-allocation-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=outcome_allocation_test \
  -p 55432:5432 \
  postgres:17

OUTCOME_ALLOCATION_POSTGRES_TEST_URL=postgresql://postgres:postgres@localhost:55432/outcome_allocation_test \
  bun run test:integration:postgres

docker stop outcome-allocation-postgres
```

The integration setup replaces the `extensions` schema and all named host fixture tables used by the suite, including agreement, budget, outcome, stream, commitment, and payment tables. Never point it at a shared or persistent database; the `_test` database-name check is only a final safety guard.

## Development

```sh
bun install
bun run test:unit
bun run typecheck
```

The host loads the extension from `extensions/gcs-outcome-cost-allocation` and applies the extension migration when the extension is enabled for an agency.

Completed versions snapshot each allocation's resolved amount and remaining fiscal-year funding basis, plus the version's total remaining agreement funding basis. Historical displays and later Commitment allocation use those immutable values even when the current agreement budget changes.

The host calculates the remaining basis under financial locks. Database guards require consistent captured yearly pools, matching resolved totals and a matching version total; they do not compare the remaining snapshot to gross funding.

The Agreement Cost Allocation section is a shared resource table of allocation
versions, with search, column controls, pagination, exact totals, status and drill-down
links. New draft creates a row in this collection; View opens that version's own page.
The page uses the SDK's shared detail shell and URL-backed sections in this order:
Summary, Allocation, Supplementary, Workflows and Allocation completion. Summary
shows current funding/effective-paid/remaining balances and paid coding once per
account/year. Allocation contains the existing grouped editable matrix, with modal
editing and an explicit Save. Completed versions retain immutable matrix evidence.

Allocation completion renders the shared Completion panel and its approval-submission
workflow, including already-active runs after reload, Current/Previous attempts and
step execution. Saving the matrix is required before submission; unsaved edits survive
section changes and show a warning on Completion. Completing submission freezes matrix
edits while the approval workflow remains executable. Supplementary and Workflows use
the exact allocation-version identity, never the parent Agreement identity.

Agreement Viewers can read the collection and individual details. The host supplies
independent Contributor/Manager role flags and an inherited Agreement assignment flag;
role-permitted write actions stay visible and warn on activation when assignment or
lifecycle prerequisites fail. Approval actions remain governed by their own host runtime
capabilities. Server handlers retain their existing read/update/delete authorization.

Agency Workflow authoring selects the registered Outcome cost allocation version
entity. The Stream extension editor uses `ExtensionStreamWorkflowLinks` to link
published Agency workflows for that exact entity, including standard and approval
submission workflows. Add and unlink persist the host's Stream workflow links
immediately; these links are separate from the extension's association configuration
and its Save action. Runtime Workflows and Allocation completion use those same host links.

The matrix shows current funding, effective paid and remaining amounts per year, plus
paid amounts once per coding account/year even when there is no new outcome allocation.
Percentages and fixed amounts allocate only the remaining pool. With $1,000 funding and
$200 paid, the $800 pool splits $400/$400 at 50%/50%; a fixed $300 row leaves $500.
Pending Payments, Journal Vouchers, Corrections and linked Credit Memos block matrix
creation, editing, Completion/activation and new managed Commitment allocation under
host financial locks. ARs, manual Adjustments and unlinked catch-all memos do not block
solely by existing. No pending/reserved matrix column is added.

Financial source queries and SDK coverage amounts use exact decimal text. Percentage,
cent balancing and weighted Payment calculations use scaled integer/BigInt arithmetic.
Persisted rows obey their PostgreSQL NUMERIC precision, while aggregate funding retains
its full exact decimal value. Legacy numeric inputs are accepted only when their scaled
units remain safely representable; they do not limit exact string transport.

## Host coding allocator

Requires SDK `^0.3.17` and the `coding-allocator` capability. The extension supplies
`server/allocator.ts`; the host owns authorization, financial locks, validation and
persistence. The standard host Commitment modal declares the total and native currency.
The extension no longer replaces that modal or inserts Commitment/Payment lines through
creation hooks. New coding has no extension-generated provenance and follows ordinary
host editing rules.

For a mapped Commitment type, the active completed allocation supplies weights at creation.
The selected version is retained in host-managed extension KV under the Commitment identity;
permitted edits reuse that version after another matrix activates. Activation never recodes
existing Commitments. Already-paid
amounts remain on their existing accounting codes. The allocator subtracts the host paid
floors from the declared total and applies the new weights only to the remaining unpaid
funds, then adds each paid floor back. For example, a $100 total with $20 already paid
on code A and a new 75:25 split produces $80 on A and $20 on B: the remaining $80
splits $60/$20, while the paid $20 stays on A.

Payments require the completed matrix version retained by the selected active Commitment.
Missing, draft, deleted, foreign or empty matrix evidence blocks creation, even when another
matrix is active on the Agreement. The retained fiscal-year matrix supplies coding weights;
the host's remaining unpaid capacities, including Journal Vouchers, Corrections and credits,
cap each result. A completed historical matrix remains valid for its pinned Commitment.
Largest-remainder cent balancing distributes rounding across codes deterministically,
keeping each proportional share within one cent; the host validates the complete batch
against both individual lines and shared accounting-code ceilings before saving it.

Unmapped Commitment types and their Payments use the host's manual coding flow.
Original Accounts Receivable receive automatic Agency coding from Manager-authored
sets per fiscal year/currency. AR Adjustments remain manual and bypass the allocator.
Cash and offset Credit Memos instead follow the latest active committed Commitment
managed by this extension and its retained allocation matrix. Activating another matrix
has no effect until a new Commitment uses it and becomes committed. Default recovery
uses the matrix's source-account weights and each source account's unique linked Agency
Credit Memo account. No Credit Memo rule is required for this default. Missing or
ambiguous links fail explicitly; they never select an account arbitrarily.

Managers can add inclusive date-range remap exceptions for a source Commitment coding
account and currency. Each exception selects one or more Credit Memo accounts with
exact percentages totaling 100%, redistributing only that source's matrix share.
Ranges for the same source/currency cannot overlap; different sources may use the same
dates. Gaps use default linked coding. Cash uses received date; offsets use the retained
creation date. These dates select exceptions without comparing the originating AR's
date or fiscal year. Target accounts determine coding year and their optional Commitment
account links control balance restoration in the recovered AR's Agreement. Unlinked
catch-all coding clears debt without restoring funding. Agency catalogues validate
configuration and supply authoring metadata only. Every runtime AR and Credit Memo
account must also be selected in the recovered Agreement's Stream. Agency settings
never expand Stream availability. Automatic Credit Memos may use selected accounts
across fiscal years; manual Credit Memo year restrictions remain unchanged.

Configuration and retained policy IDs identify Agency accounts. The allocator maps
each identity through the host's eligible catalogue to a unique Stream selection ID
for returned lines. Missing or ambiguous matches block allocation. Retained weights,
dimensions and optional links preserve the captured decision without waiving current
Stream membership, including previously captured Agency-scope evidence.

Configure opens the extension's dedicated Agency workspace, following Portal's page
and URL-backed navigation pattern, with Accounts receivable and Credit memos tabs.
Both tabs use the shared resource table with search, pagination and row Edit/Delete
actions, with Add in the table toolbar. Tables show fiscal-year display values and
bilingual coding dimensions, with percentages in their own column. The Credit memos
table also identifies the source Commitment coding and each target's fiscal year.
Rows appear after metadata loads; missing metadata never falls back to raw identifiers.
Fiscal-year labels come from the Agency fiscal-year catalogue independently of account
availability. Table row identity uses the saved year/currency or source/date-range
fields; the editor generates no client-side record IDs.
Add/Edit opens a copied modal draft; submitting validates and persists the whole
candidate policy before updating the table. Cancel/dismiss discards it. Confirmed
Delete also persists immediately. Failed writes retain the draft or row for retry.
The remap modal uses shared source and target selectors, including multiple target
selection with a contextual percentage field for each account. New modal actions are
Add/Cancel, without separate line buttons or a page Save. Opening a tab reloads persisted
settings, and mutations preserve the other tab's policy.

AR evidence retains authored percentages, including lines rounding to zero. Credit
Memo evidence retains the selected Commitment and matrix identities, effective date,
resolved target accounts and exact combined weights before cent rounding. Amount-only
draft changes reuse those retained weights and accounts; explicit cash received-date
changes resolve the current committed matrix and matching exceptions for the edited
date. Later matrix or configuration edits never recode existing drafts or posted
evidence. Previously captured percentage evidence remains immutable on amount-only
changes. Missing or invalid allocation evidence fails explicitly.

The disposable managed fixture creates yearly AR sets and ensures a unique linked
Credit Memo account exists for every CAD Commitment account across all fiscal years.
It reuses existing unique links, fails on ambiguous links and authors no remap exceptions.
Callers explicitly provide the fixture's Streams, and the fixture selects its AR and
Credit Memo accounts in each supplied Stream where its fiscal-year/currency budgets
permit them, before those accounts can be allocated.

Historical generated-line provenance remains intact. Existing disablement and mutation
guards still protect those records; newly allocated host-owned rows do not create new
provenance or extend those legacy guards.

## Translation ownership

Interface catalogs live in this package's `i18n/` directory.
Define matching English/French keys and named placeholders with
`defineGcsExtensionMessages`, then use `useExtensionI18n(catalog)` in UI or
`translateGcsExtensionMessage` in shared/server code. There is no host message
lookup or fallback. Keep extension-authored common labels and validation text in
this package; treat bilingual domain values and already-localized errors as data.
The package owns translation tests and includes catalogs in its coverage inventory.

## Audit ownership

Allocation versions, allocations and commitment links follow `agreement_id` through the Agreement’s Program stream to its Agency. Host commitment/payment rows retain their host audit ownership.

The manifest explicitly declares its dedicated tables. Extension migration journals remain
global infrastructure.

Run `bun run test:audit` from this extension inside a GCS-SSC host checkout with
`tooling/gcs-ssc` available. The extension owns its concrete fixtures; the private
host adapter exercises the real audit migrations, declaration publication, row
triggers, both ownership interpreters, rollback and immutable historical audiences.
These reduced-schema ownership fixtures complement the extension’s normal tests.
Set `AUDIT_EXTENSION_POSTGRES_URL` to a disposable PostgreSQL database URL ending
in `_test` to run the same suite on PostgreSQL; the adapter creates and removes an
isolated database. Without that variable, the suite uses in-memory PGlite.

The package-owned managed browser journey uses public host APIs and the standard
Commitment creation flow. Run `bun run test:e2e` from this package.

## Native currency contract

Each Agreement has exactly one immutable native currency. Different currencies require
separate Agreements; the allocator applies no FX conversion. Allocation lookup returns
that currency even when funding lines are empty. Active Budget lines must match it.
Program fiscal budgets are joined by both fiscal year and currency, and Stream accounting
lines resolve through their Chart currency to the matching Program budget.

The host allocator supplies the authoritative currency and eligible accounting catalog.
Requested Commitment/Payment currency must match the Agreement. Invalid imported mixed
Budget lines fail explicitly with `GCS_OUTCOME_COST_ALLOCATION_MIXED_CURRENCY_UNSUPPORTED`;
a foreign-only basis fails with `GCS_OUTCOME_COST_ALLOCATION_CURRENCY_MISMATCH`.
Existing completed snapshots and historical provenance are not rewritten.

The public allocation write payload, lifecycle authorization, locks, conflicts and retry
rules remain unchanged. Native SQL fixtures and allocator tests cover the source and SDK
boundaries. Set `GCS_PAYMENT_AUDIT_DIR` when running PostgreSQL tests to emit
`outcome-native-source-scenarios.csv` with independently asserted native source amounts.

## Matrix editing

The matrix table displays the resulting monetary amounts and unallocated funding,
with Outcome beneath Commitment line and fiscal year only in the group heading.
Method and input value appear in the edit dialog. Each editable
row opens the shared modal with its coding line, outcome and fiscal year context,
method and exact decimal value, plus a live amount and unallocated funding preview.
Update applies the copied row to the local matrix; Save persists the matrix. Cancel,
dismissal, detail identity changes and refreshed data discard the modal draft. Invalid or
excessive values show a field error without changing the matrix. On narrow screens the
review table scrolls horizontally in a named, keyboard-focusable group. Completed versions
retain their read-only evidence; pending financial effects retain the existing gate.

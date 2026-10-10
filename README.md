# gcs-outcome-cost-allocation

Standalone GCS-SSC extension that allocates agreement program funding across referenced outcomes and supplies Commitment and Payment coding through the host allocator interface.

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

Completed versions snapshot each allocation's resolved amount and fiscal-year funding basis, plus the version's total agreement funding basis. Historical displays and later Commitment allocation use those immutable values even when the current agreement budget changes.

Financial source queries and SDK coverage amounts use exact decimal text. Percentage,
cent balancing and weighted Payment calculations use scaled integer/BigInt arithmetic.
Persisted rows obey their PostgreSQL NUMERIC precision, while aggregate funding retains
its full exact decimal value. Legacy numeric inputs are accepted only when their scaled
units remain safely representable; they do not limit exact string transport.

## Host coding allocator

Requires SDK `^0.3.10` and the `coding-allocator` capability. The extension supplies
`server/allocator.ts`; the host owns authorization, financial locks, validation and
persistence. The standard host Commitment modal declares the total and native currency.
The extension no longer replaces that modal or inserts Commitment/Payment lines through
creation hooks. New coding has no extension-generated provenance and follows ordinary
host editing rules.

For a mapped Commitment type, the active completed allocation supplies weights. Already-paid
amounts remain on their existing accounting codes. The allocator subtracts the host paid
floors from the declared total and applies the new weights only to the remaining unpaid
funds, then adds each paid floor back. For example, a $100 total with $20 already paid
on code A and a new 75:25 split produces $80 on A and $20 on B: the remaining $80
splits $60/$20, while the paid $20 stays on A.

Payments split against the selected Commitment's remaining unpaid capacity, including
host-applied Journal Vouchers, Corrections and credits. Paid amounts are not weighted again.
Largest-remainder cent balancing distributes rounding across codes deterministically,
keeping each proportional share within one cent; the host validates the complete batch
against both individual lines and shared accounting-code ceilings before saving it.

Unmapped Commitment types and their Payments use the host's manual coding flow. Receivables
and Credit Memos also retain manual coding. Missing or invalid allocation evidence for a
mapped type fails explicitly rather than silently switching to manual coding.

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

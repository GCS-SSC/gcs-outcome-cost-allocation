# gcs-outcome-cost-allocation

Standalone GCS-SSC extension that allocates agreement program funding across referenced outcomes and generates commitment lines from those allocations.

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

Completed versions snapshot each allocation's resolved amount and fiscal-year funding basis, plus the version's total agreement funding basis. Historical displays and later commitment generation use those immutable values even when the current agreement budget changes.

Financial source queries and SDK coverage amounts use exact decimal text. Percentage,
cent balancing and weighted Payment calculations use scaled integer/BigInt arithmetic.
Persisted rows obey their PostgreSQL NUMERIC precision, while aggregate funding retains
its full exact decimal value. Legacy numeric inputs are accepted only when their scaled
units remain safely representable; they do not limit exact string transport.

Agency or stream disablement is blocked once the extension has generated commitment provenance. Those commitments need the extension's payment handler for their remaining lifecycle, so the extension must stay enabled.

## Translation ownership

Requires SDK 0.3.0. Interface catalogs live in this package's `i18n/` directory.
Define matching English/French keys and named placeholders with
`defineGcsExtensionMessages`, then use `useExtensionI18n(catalog)` in UI or
`translateGcsExtensionMessage` in shared/server code. There is no host message
lookup or fallback. Keep extension-authored common labels and validation text in
this package; treat bilingual domain values and already-localized errors as data.
The package owns translation tests and includes catalogs in its coverage inventory.

## Audit ownership

Allocation versions, allocations and commitment links follow `agreement_id` through the Agreement’s Program stream to its Agency. Host commitment/payment rows retain their host audit ownership.

The manifest targets SDK ^0.3.7 and explicitly declares its dedicated tables (an empty
list when there are none). Extension migration journals remain global infrastructure.

Run `bun run test:audit` from this extension inside a GCS-SSC host checkout with
`tooling/gcs-ssc` available. The extension owns its concrete fixtures; the private
host adapter exercises the real audit migrations, declaration publication, row
triggers, both ownership interpreters, rollback and immutable historical audiences.
These reduced-schema ownership fixtures complement the extension’s normal tests.
Set `AUDIT_EXTENSION_POSTGRES_URL` to a disposable PostgreSQL database URL ending
in `_test` to run the same suite on PostgreSQL; the adapter creates and removes an
isolated database. Without that variable, the suite uses in-memory PGlite.

SDK 0.3.7 `agreement-payment-capacity` supplies post-JV paid floors for Payment line generation. Generated allocation weights and provenance remain extension-owned; current paid coverage comes from `agreementFinancials.getCommitmentLinePaymentCoverage`. Before inserting the batch in the host write transaction, the extension invokes `validatePaymentAllocations` so duplicate coding rows cannot overdraw a shared Agency chart balance. Denied-Payment restoration uses the same host batch validator with the restored Payment excluded. JVs do not rewrite saved allocation versions, mappings or generated-line weights.

Posted Corrections contribute through that same host coverage and batch-validation boundary. Run `bun run test:e2e` in this package for the managed browser journey: it publishes allocation and financial approval routes through public host APIs, fully covers a generated Commitment, posts a signed Correction, rejects an overdraw, and generates a subsequent Payment against the restored shared capacity. The saved allocation snapshot, generated Commitment weights and source Payment remain unchanged. Screenshots retain the posted Correction and resulting Payment.

## Native currency contract

Requires SDK `^0.3.7`; older hosts cannot safely honor selected-currency financial calls.
The Commitment creation action submits both `egcs_fc_type` and the required lowercase
`egcs_fc_currency`. The allocation lookup now returns `currency`, read from the required,
immutable Agreement profile even when funding lines are empty. The bilingual required
currency control displays that fixed value and is disabled; it cannot choose a different
native unit. Creation stays blocked while lookup is pending, on missing currency or a
source error. An earlier Agreement lookup cannot replace the current native value.

Previously the budget source joined every Program fiscal budget for the same year and
combined native amounts. It now joins the Program budget with the Budget line currency,
returns `budgetYears[].currency`, and maps each Stream accounting line through its Chart
currency to the matching native Program fiscal budget. Active Budget lines must match the
owning Agreement currency. The same currency is passed into Commitment generation,
Payment generation, SDK exact-line paid coverage and batch allocation validation,
including denied-Payment restoration. Requested Commitment/Payment currency must match
the Agreement, and Payment Commitments must have that same currency; no FX conversion
is applied.

Each Agreement has exactly one currency. Different currencies require separate Agreements.
The immutable allocation version retains its scalar funding basis. Invalid imported mixed
Budget lines fail explicitly with `GCS_OUTCOME_COST_ALLOCATION_MIXED_CURRENCY_UNSUPPORTED`;
a foreign-only basis fails with `GCS_OUTCOME_COST_ALLOCATION_CURRENCY_MISMATCH`. These are
corruption defenses, not supported mixed-Agreement flows. Existing completed snapshots,
generated amounts, provenance and payment weighting are retained; historical evidence is
not rewritten.

The public allocation write payload, lifecycle authorization, locks, conflicts and retry
rules are unchanged. The package-owned browser caller supplies the required Commitment
currency. Native SQL fixtures, creation-hook tests, rendered English/French control tests
and immutable-weight Payment tests cover the new source and SDK boundaries. Set
`GCS_PAYMENT_AUDIT_DIR` when running PostgreSQL tests to emit
`outcome-native-source-scenarios.csv` with independently asserted native source amounts.

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

The host SDK exposes financial values as JavaScript numbers. To prevent silent precision loss while preserving that API contract, allocation, funding, commitment, and payment calculations accept values only through `900,719,925,474.0991`, the largest non-negative scale-four decimal whose scaled units fit within `Number.MAX_SAFE_INTEGER`. Percentage, cent balancing, and weighted payment math use scaled integer/BigInt arithmetic internally.

Agency or stream disablement is blocked once the extension has generated commitment provenance. Those commitments need the extension's payment handler for their remaining lifecycle, so the extension must stay enabled.

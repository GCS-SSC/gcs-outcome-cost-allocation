# gcs-outcome-cost-allocation

Standalone GCS-SSC extension that allocates agreement program funding across referenced outcomes and generates commitment lines from those allocations.

## Development

```sh
bun install
bun run test:unit
bun run typecheck
```

The host loads the extension from `extensions/gcs-outcome-cost-allocation` and applies the extension migration when the extension is enabled for an agency.

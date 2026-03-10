# Benchmark Scorecard (2026-03-09)

## Scope

This scorecard tracks repo-visible performance and reliability checks tied to launch readiness.

## Build Performance (Pages)

Command:

```bash
npm -C pages run build
```

| Metric | Before (2026-03-09) | After (2026-03-09) | Delta |
|---|---:|---:|---:|
| Dashboard route chunk (`DashboardPage-*.js`, minified) | 2,127.79 kB | 131.32 kB | -1,996.47 kB |
| Dashboard route chunk (`DashboardPage-*.js`, gzip) | 682.21 kB | 40.68 kB | -641.53 kB |
| Chunk warning (`>500 kB`) | Present | Cleared | Fixed |

After-build notable chunks:

- `vendor-echarts-core`: 384.69 kB (minified)
- `vendor-antd`: 466.84 kB (minified)
- `DashboardPage`: 131.32 kB (minified)

## Reliability Checks

### Unit test suite

Command:

```bash
npm run test:unit
```

Result:

- `pass`: 154
- `fail`: 0
- `skipped`: 4

### Access config consistency

Command:

```bash
npm run test:access-config
```

Result:

- Access config tests: all pass
- Query/Alert wrangler access checks: pass

## Notes

- This scorecard is intentionally command-output based so results are reproducible from CI or local runs.
- Add new dated scorecards for future releases instead of overwriting this file.

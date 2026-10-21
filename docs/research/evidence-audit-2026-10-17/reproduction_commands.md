# Reproduction commands

Run from `tn-farming-assistant`:

```powershell
npm ci --legacy-peer-deps
npm run eval -- --date=YYYY-MM-DD
npm test
npm run manuscript:numbers
```

Run from `tn-farming-assistant-frontend`:

```powershell
npm ci
npm test -- --run
npm run typecheck
npm run contract:check
```

Required follow-up: pin and record the Node version used to generate the published artifacts (`v26.7.0` in the existing summary) or regenerate under the current supported version. Investigate the observed Vitest/evaluation stall before reporting a new test or benchmark result.


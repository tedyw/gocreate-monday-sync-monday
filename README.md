# GoCreate → monday.com Customer Sync (monday code, apps-sdk@3.2.1) — rotation-friendly

This version improves “option 1 rotation”:
- you rotate by updating `MONDAY_ACCESS_TOKEN` in Developer Center / CLI
- app detects auth failures (401/403 or auth-like GraphQL errors) and logs a clear message
- app will NOT advance last-run storage when auth fails (so you don’t miss customers)

## Cron: 23:59 Stockholm time (DST-safe)
Create a scheduler job that hits the cron endpoint **every minute**, and the code only executes when Stockholm time is exactly 23:59.

Cron endpoint: `POST /mndy-cronjob/sync-customers`

## Configure env vars (non-secret)
```bash
mapps code:env -m set -k MONDAY_BOARD_ID -v "<boardId>"
mapps code:env -m set -k MONDAY_GROUP_ID -v "<groupId>"
mapps code:env -m set -k MONDAY_COL_EMAIL -v "<emailColumnId>"
mapps code:env -m set -k MONDAY_COL_TELEFON -v "<telefonColumnId>"
mapps code:env -m set -k MONDAY_COL_FORETAG -v "<foretagColumnId>"
```

Optional knobs:
```bash
mapps code:env -m set -k DRY_RUN -v "false"
mapps code:env -m set -k UPDATE_EXISTING -v "true"
mapps code:env -m set -k LOOKBACK_DAYS -v "1"
```

## Configure Secrets (Developer Center → Hosting → Secrets)
Create these secrets:
- `MONDAY_ACCESS_TOKEN`
- `GOCREATE_USERNAME`
- `GOCREATE_PASSWORD`
- `GOCREATE_AUTH_TOKEN`
- (optional) `GOCREATE_BASE_URL`

## Deploy
```bash
npm install
npm run build
mapps code:push
```

## Create the scheduled job
```bash
mapps scheduler:create -a <APP_ID> -s "* * * * *" -u "/sync-customers" -n "GoCreate nightly sync" -d "Runs nightly at 23:59 Europe/Stockholm (gated in code)." -r 3
```

## Manual run endpoint (optional)
Enable:
```bash
mapps code:env -m set -k MANUAL_RUN_KEY -v "<random-long-string>"
```

Call:
```bash
curl -X POST "<YOUR_CODE_URL>/manual/run" -H "x-manual-run-key: <random-long-string>"
```

## Rotation runbook (Option 1)
1) Generate a new token (reinstall/re-authorize your app in monday).
2) Update the secret `MONDAY_ACCESS_TOKEN` (Dev Center or CLI).
3) Trigger `/manual/run` to verify.
4) Next cron run will succeed automatically.

If the token breaks, logs will include:
`MONDAY AUTH ERROR - rotate MONDAY_ACCESS_TOKEN secret`

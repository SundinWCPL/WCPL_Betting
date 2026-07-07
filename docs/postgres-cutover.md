# PostgreSQL cutover runbook

The JSON database remains the production source of truth until every item below passes.

## Provisioning

1. Add an empty PostgreSQL service to the existing Railway project.
2. The private `DATABASE_URL` reference may be attached to the web service early; it is inert while `STORAGE_BACKEND=json`.
3. Use `DATABASE_PUBLIC_URL` only from the local operator machine. The deployed web service must use Railway's private `DATABASE_URL` reference to avoid public egress.

## Rehearsal

Set `DATABASE_URL` only in the operator shell, then run:

```text
npm run db:migrate
npm run db:import -- "C:\path\to\betting.json" --replace --full-verify
npm run db:verify -- "C:\path\to\betting.json" --full
npm run db:export -- "C:\path\to\postgres-export.json"
npm run db:verify-runtime
npm run db:verify-wut-runtime
npm run db:verify-wut-onboarding
npm run db:verify-horse-runtime
npm run db:verify-arena-runtime
npm run db:verify-draft-runtime
```

The runtime verifiers exercise real PostgreSQL transactions across the sportsbook, casino, WUT, Arena, Draft Events, Admin controls, timers, scoring and prize paths, then roll them back and confirm persistent rehearsal state is unchanged.

`--replace` is intentionally mandatory when the target contains data. Never use it after PostgreSQL becomes the live source of truth.

## Final cutover

1. Deploy this migration build with `STORAGE_BACKEND=json`. Confirm `/health` reports `storage: json`.
2. Enable Website Maintenance Mode in Admin.
3. Confirm `/health` reports `storage: json` and `maintenance: true`.
4. Wait at least ten seconds for any request that began before maintenance to finish, then create and download the final JSON backup.
5. Record its byte size and SHA-256 from the importer output.
6. From the operator machine, point `DATABASE_URL` at the public rehearsal endpoint and import with `--replace --full-verify`.
7. Run every verifier listed above and create a PostgreSQL-to-JSON export.
8. Compare manifests and retain all three files: source JSON, verification output, and exported JSON.
9. In Railway, confirm the web service's `DATABASE_URL` is the private Postgres reference, set `STORAGE_BACKEND=postgres`, and redeploy.
10. Confirm `/health` reports `storage: postgres` and `maintenance: true`. The imported maintenance flag keeps users and background clocks frozen through the redeploy.
11. While maintenance remains enabled, smoke-test Admin balances and configuration, betting, Slots, Puck IQ, Horse Racing, WUT Shop/Collection, Arena, Admin Debug Game, and Draft Events.
12. Create and download one PostgreSQL backup from Admin, then reopen the website through Admin Maintenance Mode.

Once public PostgreSQL writes begin, the old JSON is stale. Re-enable maintenance and fix forward; do not point the live service back at the frozen JSON without first exporting current PostgreSQL state.

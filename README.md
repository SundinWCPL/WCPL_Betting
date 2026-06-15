# WCPL Betting

WCPL weekly betting / pick'em site prototype.

## Local setup

```cmd
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

## Local environment

Copy `.env.example` to `.env` for local testing:

```cmd
copy .env.example .env
```

The app currently uses local JSON storage for development. On first run it creates `betting.json` and seeds demo users.

## Demo users

| Username | Password | Role |
|---|---|---|
| logan | password | admin |
| jay | password | user |
| dane | password | user |
| josh | password | user |

## Important files not committed

These are intentionally ignored by Git:

```text
node_modules/
.env
betting.json
```

`betting.json` contains local users, balances, bets, and transactions. Do not commit it once real users exist.

## Current behavior

- Reads WCPL data from `data/<season>/...`
- Supports old single-folder seasons like `data/S2/*.csv`
- Supports divided seasons like `data/S3/D1/*.csv` and `data/S3/D2/*.csv`
- Series bets, prop bets, admin controls, week locking, settlement, history, and odds adjustments

## Railway plan

Before real launch, move app storage from local JSON to Railway Postgres. The WCPL league CSVs should remain read-only and come from the main WCPL GitHub repo.

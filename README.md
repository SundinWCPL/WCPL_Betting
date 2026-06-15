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

The app currently uses local JSON storage for development. On first run it creates `betting.json` and seeds the Sundin admin user.

## Default admin user

| Username | Password | Role |
|---|---|---|
| Sundin | cactusgoat13 | admin |

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

For Season 3 launch, use Railway with a mounted volume for JSON storage:

```env
JSON_DB_PATH=/app/data-store/betting.json
BACKUP_DIR=/app/data-store/backups
```

For live WCPL data, switch to GitHub read mode:

```env
DATA_MODE=github
WCPL_DATA_BASE_URL=https://raw.githubusercontent.com/SundinWCPL/WCPL/main/data
SEASON_ID=S3
AVAILABLE_SEASONS=S2,S3
DIVISIONS=D1,D2
```

The betting app only reads WCPL CSV data. It does not write to the main WCPL repo.

Recommended Railway setting: keep the app at one instance/replica while using JSON storage.

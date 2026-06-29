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

## WUT configuration

WUT defaults can be changed with environment variables:

```env
WUT_JOIN_FEE=100
ARENA_TIME_ZONE=America/Los_Angeles
ARENA_MAX_ACTIVE_MATCHES=3
ARENA_TURN_HOURS=24
```

Entering the WUT matchmaking queue is free and each match awards 50 Mushybux to the winner. First-time membership costs 100 Mushybux by default and can be changed with `WUT_JOIN_FEE`. Matchmaking runs at the top of every hour; unmatched players remain in the queue for the next run.

Flat boost values are editable in the existing Cards section of the admin page. Admins also get a collapsed testing panel directly on the WUT page for running matchmaking immediately.

S3 player cards remain in the catalog but do not appear in starter or shop packs until the player has recorded at least 6 GP. Existing S1/S2 eligibility and mythic-card availability are unchanged.

Base fantasy-stat values, Save% thresholds and multipliers, and same-team chemistry percentages are editable in the Cards section of the admin panel. Chemistry is applied to each matching teammate after stat and boost scoring.

Horse names, ownership, career statistics, claimable owner rewards, and race economy settings are persisted in the main JSON database under `casino.horseRacing`. A horse costs 5,000 Mushybux by default; owner rewards are 5% of final stakes placed on that horse plus 200 Mushybux for a win. Max bet, purchase cost, owner cut, and win bonus are editable in the admin panel; environment variables provide only the initial defaults.

The nightly horse-racing card posts at 7:00, 8:00, and 9:00 PM Pacific. Race-one betting and chat open at 6:30 PM; each later betting window opens after the preceding race settles. Chat becomes read-only 15 minutes after race three and its history is retained until the next card opens at 6:30 PM.

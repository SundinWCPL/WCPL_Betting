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

Entering the WUT matchmaking queue is free and each match awards 50 Mushybux to the winner. First-time membership costs 100 Mushybux by default and can be changed with `WUT_JOIN_FEE`. Matchmaking runs every 30 minutes or immediately when the queue reaches 10 players. Pairing prefers the closest available ELO ratings, while unmatched players remain prioritized for the next run.

Flat boost values are editable in the existing Cards section of the admin page. Admins also get a collapsed testing panel directly on the WUT page for running matchmaking immediately.

S3 player cards remain in the catalog but do not appear in starter or shop packs until the player has recorded at least 6 GP. Existing S1/S2 eligibility and mythic-card availability are unchanged.

Base fantasy-stat values, Save% thresholds and multipliers, and same-team chemistry percentages are editable in the Cards section of the admin panel. Chemistry is applied to each matching teammate after stat and boost scoring.

Horse names, ownership, career statistics, claimable owner rewards, and race economy settings are persisted in the main JSON database under `casino.horseRacing`. A horse costs 5,000 Mushybux by default; owner rewards are 5% of final stakes placed on that horse plus 200 Mushybux for a win. Max bet, purchase cost, owner cut, and win bonus are editable in the admin panel; environment variables provide only the initial defaults.

The nightly horse-racing card posts at 7:00, 8:00, and 9:00 PM Pacific. Race-one betting and chat open at 6:30 PM; each later betting window opens after the preceding race settles. Chat becomes read-only 15 minutes after race three and its history is retained until the next card opens at 6:30 PM.
# WUT 2.0 migration notes

WUT data is migrated idempotently when the JSON database loads (`ensureCardsState`). Existing cards remain owned, cooldown values are cleared, Hit/Block Boosts become same-rarity Grit Boosts, and users with a recorded five-card starter set receive an overlapping Starter Deck/Safety Bench. Queue entries created before deck snapshots are cancelled without cost so their owner can choose a deck again.

New WUT starter bundles contain five unique Common players in a 2F / 2D / 1G split, two random Common trinkets, and a free Standard pack that opens through the normal shop reveal flow on the user's next visit.

WUT missions provide two fixed dailies, one eligibility-filtered rotating daily, two sportsbook weeklies, and one rotating betting/casino weekly. The Cover the Board weekly treats each available series matchup or prop card as one option, regardless of how many outcomes it contains, and freezes the eligible board when betting locks. Progress is derived from resolved matches, irreversible casino records, locked sportsbook wagers, and settled payouts. Rewards must be claimed from the WUT hub and are recorded in the WUT Coin transaction ledger.

Admins can inspect every active/scoring WUT match and filter completed, ready, or voided history by user at `/admin/cards/matches`. Admin voids are restricted to unfinished matches, release committed boosts, cancel the source queue entries, record an audit reason, and award no WUT Coins or ELO.

The WUT admin controls expose pack and trinket economy, shop rarity weights, match limits and rewards, deck-slot costs, mission rewards, scoring and boost values, plus rarity-specific numeric trinket effects. Mode-only trinket behavior such as Journeyman remains read-only. Saved trinket values update owned inventory and unsold offers; already-snapshotted matches retain their original rules.

Active matches that existed before this overhaul are marked `rules_version: 1` and finish with legacy placement/scoring rules. Newly matched games use `rules_version: 2`, WUT Coins, immutable deck/trinket snapshots, Power locks, Boost Load, timeout forfeits, and the paused overnight clock. Booster Draft is intentionally not implemented.

Permanent S1 arena rows live at `data/S1/s1_wut_synthetic_games.csv`. Regenerate this checked-in source deliberately with `npm run wut:s1-games`; match scoring only reads it and never regenerates S1 games dynamically.

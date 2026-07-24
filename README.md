# PokeCardHunter

See [pokemon-alert-agent-brief.md](./pokemon-alert-agent-brief.md) for the full brief.

## Status

Live and running on schedule. Build order (per brief):

1. [x] eBay search module (`src/poller/ebaySearch.js`) — standalone via `npm run poll`
2. [x] Rule-based matcher (`src/matcher/match.js`) — standalone via `npm run match`
3. [x] Storage layer (`src/storage/db.js`, `schema.sql`) — hosted on Turso
4. [x] ntfy notification hook (`src/notifier/notify.js`)
5. [x] GitHub Actions workflow (`.github/workflows/scan.yml`) — runs every 15 min
6. [x] Results screen (`src/server/server.js`, `public/`) — `npm run results`, http://localhost:3000

## Architecture

Two independent pieces run per scheduled tick, no LLM involved anywhere:

1. **Poller** (`src/poller/ebaySearch.js`) — eBay Browse API search + a second
   per-candidate call for full item detail.
2. **Matcher** (`src/matcher/match.js`) — deterministic checks against each
   surviving candidate: card name/set/number all present in the title,
   condition signal from the eBay aspect (or a title keyword as a fallback),
   and listing price under `targetPrice × priceThresholdPct` (configurable in
   `config/settings.json`). All three passing is an alert. Every alert is
   manually reviewed before acting on it, so false positives here are cheap —
   this step deliberately doesn't try to be clever about parsing free text.

This keeps the whole stack (eBay API, GitHub Actions, Turso, ntfy) on free
tiers at this scale, with no ongoing API cost.

## Results screen

`npm run results` starts a small Express server (`src/server/server.js`) at
http://localhost:3000, reading directly from the same Turso database the
scheduled pipeline writes to — no separate sync step. Plain HTML/CSS/JS in
`public/`, no build step or framework, since this is a single-user local
tool. Filter by card, status, alerted, date range, and price range; click a
row's status badge to change it (`found` → `offered` → `bought` → `sold` →
`flipped`) directly against the database.

## Setup

```
npm install
cp .env.example .env   # fill in credentials
```

### Database: Turso

Storage is hosted SQLite via [Turso](https://turso.tech) rather than a local
file, decided over the alternatives:

- **Commit the `.db` file to git** — ruled out. A binary SQLite file changing
  every 10–15 min bloats repo history, and it still doesn't answer "what does
  the results screen read from" without exporting elsewhere.
- **`actions/cache`** — ruled out. It's a best-effort *build* cache, not a
  system of record — entries get evicted after 7 days unused, and losing
  purchase-tracking history to an eviction would be a bad time.
- **Turso** — same SQLite schema/queries already designed here, survives
  ephemeral runners by design, and is reachable directly from the results
  screen later too (one connection string, not a migration).

Local dev doesn't require a Turso account: leaving `TURSO_DATABASE_URL` blank
falls back to a local file at `./data/pokecardhunter.db`.

To set up Turso for real runs (CI + eventually the results screen):

```
turso auth login          # or: turso auth signup
turso db create pokecardhunter
turso db show pokecardhunter --url      # -> TURSO_DATABASE_URL
turso db tokens create pokecardhunter   # -> TURSO_AUTH_TOKEN
```

Put both values in `.env` locally and as repo secrets
(`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`) for the GitHub Actions workflow.

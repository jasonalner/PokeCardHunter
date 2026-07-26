# PokeCardHunter

See [pokemon-alert-agent-brief.md](./pokemon-alert-agent-brief.md) for the full brief.

## Status

Live and running on an hourly schedule. Build order (per brief):

1. [x] eBay search module (`src/poller/ebaySearch.js`) — standalone via `npm run poll`
2. [x] Rule-based matcher (`src/matcher/match.js`) — standalone via `npm run match`
3. [x] Storage layer (`src/storage/db.js`, `schema.sql`) — hosted on Turso
4. [x] ntfy notification hook (`src/notifier/notify.js`)
5. [x] GitHub Actions workflow (`.github/workflows/scan.yml`) — runs hourly
6. [x] Results screen (`src/server/server.js`, `public/`) — `npm run results`, http://localhost:3000

## Architecture

No LLM involved anywhere, and — as of the market-average refactor — no manually
guessed prices either. Per scheduled tick, for each target card:

1. **Poller** (`src/poller/ebaySearch.js`) — one eBay Browse API search
   (raw/ungraded only, GB-located, fixed-price/best-offer, junk-title-filtered).
2. **Market average** (`src/index.js`'s `runPipeline`) — the same search
   results are filtered to genuinely-matching listings (`isCardMatch` in
   `src/matcher/match.js`) and turned into a live average/min/max, upserted
   into the `market_stats` table. This is the reference price used below —
   there is no manually-entered target price anywhere in the system anymore.
   It's an average of eBay's **current active listings**, not sold comps
   (eBay's Marketplace Insights API for that is restricted/approval-only) —
   worth knowing since asking prices typically run a bit above what things
   actually sell for.
   - Each listing is compared against a **leave-one-out** average (excluding
     its own price from the average it's judged against), so a genuinely
     cheap listing doesn't partially cancel its own "underpriced" signal.
   - If fewer than `minSampleSizeForAverage` (default 3, in
     `config/settings.json`) matching listings turn up, candidates are still
     recorded — with verdict `insufficient_data` — rather than silently
     skipped, so a low-liquidity card stays reviewable instead of quietly
     never alerting. If *zero* matching listings turn up, nothing is recorded
     for that card that cycle (nothing to reference).
   - A listing whose title doesn't match the target card at all (`isCardMatch`
     false) is skipped entirely, never stored as a candidate — it's noise
     from eBay's own loose search relevance, not a near-miss worth reviewing,
     and its "margin" against a card it isn't would be meaningless anyway.
3. **Matcher** (`src/matcher/match.js`) — deterministic checks against each
   candidate: card name/number/set in the title, a condition signal (eBay's
   aspect field or an NM/mint title keyword), and price under
   `average × priceThresholdPct`. All three passing is an alert. Every alert
   is manually reviewed before acting on it, so false positives here are
   cheap — this step deliberately doesn't try to be clever about parsing
   free text.
   - Name and number are matched space/boundary-bound, not as raw
     substrings — `"Charizard V"` must not match inside `"Charizard VMAX"`
     (a materially different, usually far more valuable card).
   - **Set is only required for plain mainline numbers** (`"125/197"`-style,
     which restart from 1 every set and are genuinely ambiguous without
     it). For letter-prefix promo numbers (`"SWSH260"`, `"MEP027"`-style),
     set is not required at all — the prefix already makes the number close
     to globally unique, and requiring set text too just loses real
     listings when sellers omit or misname it.
4. **Notifier** (`src/notifier/notify.js`) — ntfy.sh push for `alert` verdicts only.

This keeps the whole stack (eBay API, GitHub Actions, Turso, ntfy) on free
tiers at this scale, with no ongoing API cost.

## Results screen

`npm run results` starts a small Express server (`src/server/server.js`) at
http://localhost:3000, reading directly from the same Turso database the
scheduled pipeline writes to — no separate sync step. Plain HTML/CSS/JS in
`public/`, no build step or framework, since this is a single-user local
tool. A tab bar (All / Found / Offered / Bought / Sold / Flipped) is the
primary status view; filter further by card, set, alerted, date range,
price range, and minimum margin %. Click a row's status badge to change it
directly against the database — the row moves to its new tab immediately,
since a status change triggers a fresh fetch rather than patching in place.

The margin filter defaults to `config/settings.json`'s `priceThresholdPct`
(the same bar that triggers a push alert), so the page opens showing only
listings actually worth acting on rather than every candidate ever stored.
Clear the filter to see everything, including the near-misses.

The **"Target Cards"** section lists, adds, edits, and deletes cards on the
watch list — name/set/number/currency plus optional **set aliases**
(comma-separated) for sets sellers spell inconsistently, e.g. `set: "MEP"`
with aliases `"Mega Evolution, Mega Evolution Promo"` — a listing matches if
it contains the primary set name OR any alias. Be careful aliasing to the
name of a genuinely different real set (e.g. don't alias a promo set to
"Evolutions" just because sellers sometimes mislabel it that way — that's
the name of an actual, different 2016 set and would match the wrong card).

The Set field autocompletes against `config/pokemon-sets.json` (all 177
English-language Pokémon TCG sets, 1999–2026) and, on blur, suggests a
correction if what you typed is close-but-not-quite a real set name — e.g.
typing "Temporal Froces" prompts "Did you mean 'Temporal Forces'?". This is
assistive, not validating: informal terms (like "MEP" above) that aren't in
the list are never flagged, since real sellers and this tool's own aliasing
use them too. The list is a point-in-time snapshot and will need occasional
updates as new sets release (~4×/year).

Adding or editing a card triggers an immediate rescan of just that card
(a few real seconds — it's a live eBay search) before the request returns,
so the shown market average is never stale after a change — no need to
wait for the next scheduled run. Shows each card's live market
average/range/sample size/last-checked time, sourced from `market_stats`.
This all lives in Turso, not `config/*.json`, so a change here takes effect
on the very next scheduled run too, no commit/push required. Deleting a
target card stops it being scanned and clears its unacted-on `found`
candidates (no longer of interest once it's off the watch list), but
anything you've moved to `offered`/`bought`/`sold`/`flipped` is real
tracked history and is never touched by a delete.

The **"Run Now"** button triggers an immediate pipeline run from the page
itself (`POST /api/run-now`), for when you don't want to wait for the next
hourly tick. It's guarded by a simple in-memory lock against double-clicks;
it isn't guarded against overlapping with the hourly GitHub Actions run,
which is accepted as a low-probability, undocumented-consequence-free edge
case rather than solved.

## Setup

```
npm install
cp .env.example .env   # fill in credentials
```

### Database: Turso

Storage is hosted SQLite via [Turso](https://turso.tech) rather than a local
file, decided over the alternatives:

- **Commit the `.db` file to git** — ruled out. A binary SQLite file changing
  on every scheduled run bloats repo history, and it still doesn't answer
  "what does the results screen read from" without exporting elsewhere.
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

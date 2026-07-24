# Project brief: eBay undervalued Pokémon card alert agent

## Goal
Build a tool that automatically scans eBay UK for a list of target Pokémon TCG
cards, identifies listings priced meaningfully under fair market value, and
sends a push notification to my phone so I can act on it (offer/buy) — including
while I'm asleep. Also needs a way to track what's been found and what I've
actually done about it (offered / bought / sold / flipped).

## Environment
- Node.js, built in VS Code with Claude Code
- Already have eBay production API credentials
- No server/laptop kept running 24/7 — scheduling should happen via GitHub
  Actions cron (or similar free scheduled runner), not a persistent local process

## Architecture
Three independent pieces, run in sequence on a schedule:

1. **Poller** — plain Node.js script hitting the eBay Browse API. No LLM
   involved here, just an HTTP call + filtering.
2. **Valuator** — for each candidate listing that survives the poller's
   filters, call the Claude API with the listing's title/description/price
   and my target price for that card. Claude judges: (a) is this actually a
   match for the target card, (b) does the condition genuinely look Near
   Mint or better based on the text (not just eBay's structured field, which
   is unreliable), (c) is it underpriced enough to be worth an alert.
3. **Notifier** — if Claude's verdict is "alert", POST to ntfy.sh (topic-based,
   free, gives real push notifications on iOS via the ntfy app — no account
   needed). Fallback options if ntfy doesn't fit: Pushover (~$5 one-time) or
   a Discord webhook.

All three run per scheduled tick (target: every 10–15 min) via a GitHub
Actions workflow with a cron trigger.

## eBay Browse API search spec
- Marketplace header: `X-EBAY-C-MARKETPLACE-ID: EBAY_GB`
- `filter=itemLocationCountry:GB` — item must actually be located in the UK
  (marketplace alone doesn't guarantee this; overseas sellers list on the UK
  site too)
- `filter=buyingOptions:{FIXED_PRICE|BEST_OFFER}` — exclude pure auctions;
  only listings I can act on immediately
- Category locked to **183454** (Individual Trading Card Games)
- `aspect_filter=categoryId:183454,Card Condition:{Near Mint or Better}` as a
  first-pass narrower — but don't rely on this alone, since many sellers
  leave the aspect blank and only describe condition in the title. The
  Claude valuation step should double-check condition from the free text.
- **Scope for v1: raw (ungraded) cards only** — no PSA/CGC/BGS graded cards.
  Graded valuation is a different pricing model and is explicitly out of
  scope for now.
- Pre-filter out obvious junk before it reaches Claude (saves API calls):
  exclude titles containing "lot", "bundle", "job lot", "collection",
  "proxy", "custom", "fake", "replica"
- Consider a minimum seller feedback score as a basic trust filter

## Target card list
Needs a config (JSON/CSV) of target cards with a reference/target price per
card, in the same shape as my existing resale tracking spreadsheet. This is
the "fair value" the valuator compares against — not a live sold-comps API
(eBay's Marketplace Insights API is restricted/approval-only, so don't
assume access to it).

## Tracking / results storage
Every candidate that passes the valuator (alerted or not) should be stored,
not just the alerts, so I can review misses later. Minimum fields:

- item ID (for de-duplication — don't re-alert on the same listing)
- date/time found
- card name
- listing price
- target/reference price at time of find
- status: `found`, `offered`, `bought`, `sold`, `flipped`
- link to the listing

Use SQLite for this (simple, file-based, no server needed) — this same store
will back a results screen later with filters by date, card name, and status,
so design the schema with that in mind now even though the UI comes after the
core pipeline works.

## Build order
1. eBay search module alone — get it returning clean, correctly-filtered
   candidate listings, testable standalone before anything else is wired up
2. Claude valuation call — match/condition/verdict on those candidates
3. SQLite storage layer
4. ntfy notification hook
5. GitHub Actions workflow to run it on a schedule
6. Results screen with filters (built once the above is stable)

## Open items to flag if they come up
- No public API for Whatnot — out of scope, don't attempt to scrape it
- eBay Marketplace Insights API is not guaranteed access — don't build
  against it as if it's available; fair value comes from my own reference
  price list for now
- Browse API free tier is 5,000 calls/day — keep the target card list and
  poll frequency within that budget

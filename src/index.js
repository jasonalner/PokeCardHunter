import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import {
  openDb, initSchema, runMigrations, getCandidateByItemId, updateCandidateFromRecheck,
  insertCandidate, listTargetCardsForPipeline, upsertMarketStats,
} from './storage/db.js';
import { searchListings } from './poller/ebaySearch.js';
import { matchListing, isCardMatch } from './matcher/match.js';
import { sendAlert } from './notifier/notify.js';

export async function loadSettings() {
  const raw = await readFile(new URL('../config/settings.json', import.meta.url), 'utf8');
  return JSON.parse(raw);
}

function median(prices) {
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Generous backstop for the rare bundle/box listing that doesn't repeat
// enough sibling numbers in its title for isCardMatch's bundle check to
// catch — that check is the primary defense. Price alone can't reliably
// tell a moderately-priced bundle from a genuinely expensive single card
// (verified against real data: a tight cutoff excluded a real £312 single
// while still missing several £135-215 bundles), so this is deliberately
// loose — 10x the median only catches something like a real "Case of 4
// Sealed Boxes" listing priced ~60x a single card, not ordinary variance.
const PRICE_OUTLIER_MULTIPLIER = 10;

// Scans a single target card: recomputes its market average and inserts any
// new candidates. Exported separately from runPipeline() so the results
// server can call it for just one card right after it's added or edited —
// otherwise the displayed average stays stale until the next scheduled run.
export async function scanTargetCard(db, targetCard, minSampleSizeForAverage) {
  const listings = await searchListings(targetCard); // one call, reused below for both stats and candidates

  // Averaging pool: card-match only, not also requiring a condition signal.
  // Requiring both would push sampleCount to 0 far more often for
  // lower-liquidity cards, silently defeating the point of this feature for
  // exactly the cards where manual pricing was previously a guess anyway.
  // Per-listing alert verdicts still require isConditionOk, via the
  // unchanged matchListing() call below.
  const eligible = listings.filter((l) => isCardMatch(l, targetCard));

  // See PRICE_OUTLIER_MULTIPLIER above — excludes only the rare extreme
  // outlier from the averaging pool itself; an excluded listing is still
  // stored as a candidate below (via `eligible`, unaffected), it just isn't
  // allowed to skew the reference price everything else is judged against.
  const medianPrice = median(eligible.map((l) => l.price));
  const forAveraging = medianPrice === null
    ? eligible
    : eligible.filter((l) => l.price <= medianPrice * PRICE_OUTLIER_MULTIPLIER);
  const averagingItemIds = new Set(forAveraging.map((l) => l.itemId));

  const sampleCount = forAveraging.length;
  const sum = forAveraging.reduce((s, l) => s + l.price, 0);
  const averagePrice = sampleCount > 0 ? sum / sampleCount : null;
  const minPrice = sampleCount > 0 ? Math.min(...forAveraging.map((l) => l.price)) : null;
  const maxPrice = sampleCount > 0 ? Math.max(...forAveraging.map((l) => l.price)) : null;

  await upsertMarketStats(db, targetCard.id, {
    sampleCount, averagePrice, minPrice, maxPrice, currency: targetCard.currency,
  });

  if (sampleCount === 0) return; // nothing to reference this cycle for this card

  const hasReliableAverage = sampleCount >= minSampleSizeForAverage;

  for (const listing of listings) {
    const existing = await getCandidateByItemId(db, listing.itemId);

    // Once a candidate has moved past 'found' (offered/bought/sold/flipped)
    // it's tracked purchase history, not a live listing to keep re-checking
    // — never touch it here, same rule as everywhere else in this app.
    // If it's still 'found' and the price hasn't moved, there's nothing new
    // to record.
    if (existing && (existing.status !== 'found' || existing.listing_price === listing.price)) {
      continue;
    }

    // A listing whose title doesn't even name this card isn't a near-miss
    // worth reviewing — it's noise from eBay's own loose search relevance.
    // Its numeric "margin" against this card's average would be meaningless
    // (and often looks deceptively great, since unrelated cheap listings —
    // stickers, other cards, damaged copies — have no reason to be priced
    // anywhere near this card's real value). Skip it entirely rather than
    // storing it as a reviewable candidate. Not re-checked for an existing
    // row below — its title hasn't changed since it was first matched.
    if (!existing && !isCardMatch(listing, targetCard)) continue;

    // Leave-one-out: exclude the listing's own price from its comparison
    // average. Without this, a genuinely underpriced listing partially
    // cancels its own "underpriced" signal by dragging the average down —
    // worst exactly when the sample is smallest and the deal most real.
    // A listing excluded from the averaging pool (the rare extreme price
    // outlier) was never part of `sum` to begin with, so it's compared
    // straight against averagePrice instead — same as everything else.
    const referencePrice = averagingItemIds.has(listing.itemId) && sampleCount > 1
      ? (sum - listing.price) / (sampleCount - 1)
      : averagePrice;

    const result = hasReliableAverage
      ? await matchListing(listing, { ...targetCard, targetPrice: referencePrice })
      : {
          verdict: 'insufficient_data',
          reasoning: `Only ${sampleCount} matching listing(s) this scan — need ${minSampleSizeForAverage}+ for a confident average (avg so far: £${averagePrice.toFixed(2)})`,
        };

    if (existing) {
      await updateCandidateFromRecheck(db, listing.itemId, {
        listingPrice: listing.price,
        targetPrice: referencePrice,
        verdict: result.verdict,
        verdictReasoning: result.reasoning,
        alerted: existing.alerted || (result.verdict === 'alert' ? 1 : 0),
      });

      // Only notify on a genuine new crossing into 'alert' — not on every
      // price tick while it stays alerted, and not on a flip back out.
      if (result.verdict === 'alert' && existing.verdict !== 'alert') {
        await sendAlert({
          cardName: targetCard.cardName,
          listingPrice: listing.price,
          targetPrice: referencePrice,
          listingUrl: listing.url,
          verdictReasoning: result.reasoning,
        });
      }
      continue;
    }

    await insertCandidate(db, {
      itemId: listing.itemId,
      cardName: targetCard.cardName,
      cardSet: targetCard.set,
      listingPrice: listing.price,
      targetPrice: referencePrice,
      currency: targetCard.currency ?? 'GBP',
      listingUrl: listing.url,
      verdict: result.verdict,
      verdictReasoning: result.reasoning,
      alerted: result.verdict === 'alert' ? 1 : 0,
    });

    if (result.verdict === 'alert') {
      await sendAlert({
        cardName: targetCard.cardName,
        listingPrice: listing.price,
        targetPrice: referencePrice,
        listingUrl: listing.url,
        verdictReasoning: result.reasoning,
      });
    }
  }
}

// Takes an already-open db connection and never closes it — the caller owns
// the connection lifecycle. This matters because the results server's
// "Run Now" button calls this reusing its own long-lived connection; closing
// it here would break every request after the first run-now click.
export async function runPipeline(db) {
  const { minSampleSizeForAverage } = await loadSettings();
  const targetCards = await listTargetCardsForPipeline(db);

  // One card's failure (a transient eBay error, a rate-limit blip) must not
  // cost every other card its scan this cycle — each is isolated, and
  // failures are collected rather than surfaced immediately, so a bad card
  // doesn't starve the rest of the list. Still thrown as an aggregate error
  // at the end so a failing run doesn't look identical to a clean one (CLI
  // exit code, Run Now's response) — successful cards' data is already
  // written by that point regardless.
  const failures = [];
  for (const targetCard of targetCards) {
    try {
      await scanTargetCard(db, targetCard, minSampleSizeForAverage);
    } catch (err) {
      console.error(`[${targetCard.cardName}] scan failed, continuing with remaining cards: ${err.message}`);
      failures.push({ cardName: targetCard.cardName, error: err.message });
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length}/${targetCards.length} card(s) failed to scan: ${failures.map((f) => f.cardName).join(', ')}`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  await initSchema(db);
  await runMigrations(db);
  try {
    await runPipeline(db);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import {
  openDb, initSchema, runMigrations, itemExists, insertCandidate,
  listTargetCardsForPipeline, upsertMarketStats,
} from './storage/db.js';
import { searchListings } from './poller/ebaySearch.js';
import { matchListing, isCardMatch } from './matcher/match.js';
import { sendAlert } from './notifier/notify.js';

async function loadSettings() {
  const raw = await readFile(new URL('../config/settings.json', import.meta.url), 'utf8');
  return JSON.parse(raw);
}

// Takes an already-open db connection and never closes it — the caller owns
// the connection lifecycle. This matters because the results server's
// "Run Now" button calls this reusing its own long-lived connection; closing
// it here would break every request after the first run-now click.
export async function runPipeline(db) {
  const { minSampleSizeForAverage } = await loadSettings();
  const targetCards = await listTargetCardsForPipeline(db);

  for (const targetCard of targetCards) {
    const listings = await searchListings(targetCard); // one call, reused below for both stats and candidates

    // Averaging pool: card-match only, not also requiring a condition
    // signal. Requiring both would push sampleCount to 0 far more often for
    // lower-liquidity cards, silently defeating the point of this feature
    // for exactly the cards where manual pricing was previously a guess
    // anyway. Per-listing alert verdicts still require isConditionOk, via
    // the unchanged matchListing() call below.
    const eligible = listings.filter((l) => isCardMatch(l, targetCard));
    const sampleCount = eligible.length;
    const sum = eligible.reduce((s, l) => s + l.price, 0);
    const averagePrice = sampleCount > 0 ? sum / sampleCount : null;
    const minPrice = sampleCount > 0 ? Math.min(...eligible.map((l) => l.price)) : null;
    const maxPrice = sampleCount > 0 ? Math.max(...eligible.map((l) => l.price)) : null;

    await upsertMarketStats(db, targetCard.id, {
      sampleCount, averagePrice, minPrice, maxPrice, currency: targetCard.currency,
    });

    if (sampleCount === 0) continue; // nothing to reference this cycle for this card

    const hasReliableAverage = sampleCount >= minSampleSizeForAverage;

    for (const listing of listings) {
      if (await itemExists(db, listing.itemId)) continue;

      const isEligible = isCardMatch(listing, targetCard);
      // Leave-one-out: exclude the listing's own price from its comparison
      // average. Without this, a genuinely underpriced listing partially
      // cancels its own "underpriced" signal by dragging the average down —
      // worst exactly when the sample is smallest and the deal most real.
      const referencePrice = isEligible && sampleCount > 1
        ? (sum - listing.price) / (sampleCount - 1)
        : averagePrice;

      const result = hasReliableAverage
        ? await matchListing(listing, { ...targetCard, targetPrice: referencePrice })
        : {
            verdict: 'insufficient_data',
            reasoning: `Only ${sampleCount} matching listing(s) this scan — need ${minSampleSizeForAverage}+ for a confident average (avg so far: £${averagePrice.toFixed(2)})`,
          };

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

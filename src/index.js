import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { openDb, initSchema, itemExists, insertCandidate } from './storage/db.js';
import { searchListings } from './poller/ebaySearch.js';
import { matchListing } from './matcher/match.js';
import { sendAlert } from './notifier/notify.js';

async function run() {
  const targetCards = JSON.parse(
    await readFile(new URL('../config/target-cards.json', import.meta.url), 'utf8')
  );
  const db = openDb();
  await initSchema(db);

  for (const targetCard of targetCards) {
    const listings = await searchListings(targetCard);

    for (const listing of listings) {
      if (await itemExists(db, listing.itemId)) continue;

      const result = await matchListing(listing, targetCard);

      await insertCandidate(db, {
        itemId: listing.itemId,
        cardName: targetCard.cardName,
        listingPrice: listing.price,
        targetPrice: targetCard.targetPrice,
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
          targetPrice: targetCard.targetPrice,
          listingUrl: listing.url,
          verdictReasoning: result.reasoning,
        });
      }
    }
  }

  db.close();
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

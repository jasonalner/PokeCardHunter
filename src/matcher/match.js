// Step 2 of the build order: rule-based match / condition / price-threshold
// check on candidates that survive the poller's filters. No external API
// call, no network dependency — every alert gets manually reviewed, so
// false positives here are cheap. Don't overengineer this.

import { readFile } from 'node:fs/promises';

const CONDITION_KEYWORDS = ['nm', 'near mint', 'mint'];

async function loadSettings() {
  const raw = await readFile(new URL('../../config/settings.json', import.meta.url), 'utf8');
  return JSON.parse(raw);
}

// Collapses punctuation differences (hyphens vs spaces, colons, extra
// whitespace, casing) that otherwise break substring matching even when a
// title is obviously the right card — e.g. seller writes "XY Ancient
// Origins", target card is stored as "Xy-Ancient Origins".
function normalize(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleContainsPhrase(normalizedTitle, phrase) {
  return Boolean(phrase) && normalizedTitle.includes(normalize(phrase));
}

// Padding both sides with spaces makes this a whole-token check, not a raw
// substring one — without it, number "21" would wrongly match inside "121/98"
// (a different card) once normalize() turns the "/" into a space.
function titleContainsToken(paddedNormalizedTitle, token) {
  return Boolean(token) && paddedNormalizedTitle.includes(` ${normalize(token)} `);
}

// Sellers routinely drop the "/98" (total-in-set) half of a card number and
// just write the card's own number, e.g. "21" instead of "21/98" — missing
// that match is a false negative, which matters more here than the small
// extra false-positive risk from a looser number check.
function primaryNumberToken(number) {
  return number ? String(number).split('/')[0] : number;
}

function titleHasConditionKeyword(title) {
  const lower = title.toLowerCase();
  return CONDITION_KEYWORDS.some((keyword) => lower.includes(keyword));
}

// Does this listing's title genuinely identify the target card? Used both by
// matchListing() below and by the pipeline to decide which listings count
// toward the live market-average computation.
export function isCardMatch(listing, targetCard) {
  const title = ` ${normalize(listing.title)} `;
  if (!titleContainsPhrase(title, targetCard.name)) return false;

  const numberToken = primaryNumberToken(targetCard.number);
  // targetCard.set is the primary/canonical name (used to build the eBay
  // search query); setAliases covers other spellings sellers actually use
  // for the same set (e.g. "MEP" vs "Mega Evolution Promo") — a title
  // matches if it contains the primary name OR any alias.
  const setCandidates = [targetCard.set, ...(targetCard.setAliases ?? [])].filter(Boolean);

  const standardMatch = setCandidates.some((set) => titleContainsPhrase(title, set)) && titleContainsToken(title, numberToken);
  // Sellers often fuse a short set abbreviation directly against the number
  // with no separator — "MEP 027" becomes "MEP027" — which the checks above
  // correctly don't treat as containing "027" as its own word. Catch that
  // pattern explicitly rather than loosening the general number check (which
  // would reintroduce numbers matching inside unrelated longer numbers).
  const fusedMatch = setCandidates.some((set) => titleContainsToken(title, `${set}${numberToken}`));

  return standardMatch || fusedMatch;
}

// listing.condition is eBay's Card Condition aspect value, already used by
// the poller's aspect_filter to narrow the search — its presence is the
// primary condition signal. The title keyword check is a secondary,
// best-effort signal only, not a replacement for it.
export function isConditionOk(listing) {
  return Boolean(listing.condition) || titleHasConditionKeyword(listing.title);
}

export async function matchListing(listing, targetCard, { priceThresholdPct } = {}) {
  const threshold = priceThresholdPct ?? (await loadSettings()).priceThresholdPct;

  const cardMatch = isCardMatch(listing, targetCard);
  const conditionOk = isConditionOk(listing);
  const priceCutoff = targetCard.targetPrice * threshold;
  const priceOk = listing.price < priceCutoff;

  const verdict = cardMatch && conditionOk && priceOk ? 'alert' : 'no_alert';

  const reasons = [];
  if (!cardMatch) reasons.push('title missing card name/set/number');
  if (!conditionOk) reasons.push('no condition signal (aspect or title keyword)');
  if (!priceOk) reasons.push(`price ${listing.price} not under threshold (${priceCutoff.toFixed(2)})`);
  if (verdict === 'alert') reasons.push('card match, condition signal, and price threshold all pass');

  return { match: cardMatch, conditionOk, priceOk, verdict, reasoning: reasons.join('; ') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await matchListing(
    {
      title: 'Pokemon Charizard ex 125/197 Obsidian Flames Holo NM',
      price: 28.5,
      condition: 'Near Mint or Better',
    },
    {
      cardName: 'Charizard ex - Obsidian Flames - 125/197',
      name: 'Charizard ex',
      set: 'Obsidian Flames',
      number: '125/197',
      targetPrice: 45.0,
    }
  );
  console.log(result);
}

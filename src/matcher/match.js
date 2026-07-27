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

// For a letter-prefix numbering style (promo numbers like "SWSH260"),
// sellers are inconsistent about the space — "SWSH260" and "SWSH 260" both
// show up for the same card. Whatever form the number is stored in, this
// returns the other one too, so either is accepted.
function numberSpacingVariants(numberToken) {
  const variants = [numberToken];
  const fused = /^([a-zA-Z]+)(\d+)$/.exec(numberToken);
  if (fused) variants.push(`${fused[1]} ${fused[2]}`);
  const spaced = /^([a-zA-Z]+)\s+(\d+)$/.exec(numberToken);
  if (spaced) variants.push(`${spaced[1]}${spaced[2]}`);
  return variants;
}

// A title that states a denominator for the number and gets it wrong (e.g.
// target is "169/165", title says "169/210") names a genuinely different
// print — a real listing used "169/210" for the same numerator because the
// Japanese convention counts secret rares into the set total (210) where
// English convention doesn't (165); same card number, different product.
// Only flags it when the title actually states a (wrong) denominator —
// sellers who drop it entirely and just write "169" are still accepted,
// per primaryNumberToken's existing leniency above.
//
// Operates on the raw (non-normalized) title and requires a literal "/"
// between the two numbers — a real listing titled "...#169 151 Illustration
// Rare Eng Mint..." has the numeric set name "151" sitting right after the
// number with no slash, and normalize() collapsing both "#" and "/" to a
// plain space made that indistinguishable from a real "169/151" denominator
// when this checked the normalized title, wrongly rejecting a genuine
// English listing.
function titleHasWrongDenominator(rawTitle, fullNumber) {
  const [numerator, denominator] = String(fullNumber ?? '').split('/');
  if (!denominator) return false;
  const regex = new RegExp(`\\b${numerator}\\s*/\\s*(\\d+)\\b`, 'g');
  let match;
  while ((match = regex.exec(rawTitle))) {
    if (match[1] !== denominator) return true;
  }
  return false;
}

function titleHasConditionKeyword(title) {
  const lower = title.toLowerCase();
  return CONDITION_KEYWORDS.some((keyword) => lower.includes(keyword));
}

// A letter-prefix number (promo-style: "SWSH260", "SVP057"...) is close to
// globally unique on its own — the prefix already encodes set-specific
// context, so requiring the set text too just costs real matches when
// sellers omit or word the set differently. A plain mainline number
// ("125/197"-style) restarts from 1 in every set and is genuinely
// ambiguous without set to disambiguate — keep requiring it there.
function isPromoStyleNumber(numberToken) {
  return /^[a-zA-Z]+\s?\d+$/.test(numberToken);
}

// A title naming three-plus numbers from the same promo family (e.g.
// "SWSH260, SWSH261, SWSH262") is very likely a multi-card bundle/box
// listing, not a single-card listing for just this one — a real £5,085
// "Case of 4 Sealed Boxes" listing named all three SWSH Black Star Promo
// numbers together and would otherwise be treated as a single-card match,
// massively distorting the market average. Sellers don't reliably use any
// particular bundle-indicating word ("sealed", "full set", "case" all show
// up, none consistently), so a title keyword can't catch this — multiple
// sibling numbers in the same title is the one signal that held up across
// every real bundle listing checked. Threshold is 3, not 2: some promo-style
// numbers are themselves a "this card/total in subset" fraction with a
// letter prefix on both halves (e.g. Crown Zenith's "GG10/GG70" — 70 cards
// in the Galarian Gallery subset), which always shows up as exactly 2 same-
// prefix numbers and isn't a bundle at all — a real Mew GG10 listing titled
// "...GG10/GG70..." was being wrongly rejected before this was 3.
function mentionsMultiplePromoNumbers(paddedNormalizedTitle, numberToken) {
  const prefixMatch = /^([a-zA-Z]+)\d+$/.exec(numberToken);
  if (!prefixMatch) return false;
  const prefix = prefixMatch[1].toLowerCase();
  const matches = paddedNormalizedTitle.match(new RegExp(`\\b${prefix}\\s?\\d+\\b`, 'g')) ?? [];
  const distinctNumbers = new Set(matches.map((m) => m.replace(/\s+/g, '')));
  return distinctNumbers.size > 2;
}

// Does this listing's title genuinely identify the target card? Used both by
// matchListing() below and by the pipeline to decide which listings count
// toward the live market-average computation.
export function isCardMatch(listing, targetCard) {
  const title = ` ${normalize(listing.title)} `;

  // Token-bounded, not a raw substring — "Charizard V" must not match
  // inside "Charizard VMAX" or "Charizard VSTAR" (different, usually far
  // more valuable cards), which an unbounded substring check would allow.
  if (!titleContainsToken(title, targetCard.name)) return false;

  const numberToken = primaryNumberToken(targetCard.number);

  if (isPromoStyleNumber(numberToken) && mentionsMultiplePromoNumbers(title, numberToken)) {
    return false;
  }

  if (titleHasWrongDenominator(listing.title, targetCard.number)) return false;

  const numberForms = numberSpacingVariants(numberToken);
  const numberMatch = numberForms.some((form) => titleContainsToken(title, form));

  // targetCard.set is the primary/canonical name (used to build the eBay
  // search query); setAliases covers other spellings sellers actually use
  // for the same set (e.g. "MEP" vs "Mega Evolution Promo") — a title
  // matches if it contains the primary name OR any alias.
  const setCandidates = [targetCard.set, ...(targetCard.setAliases ?? [])].filter(Boolean);

  if (numberMatch) {
    if (isPromoStyleNumber(numberToken)) return true;
    if (setCandidates.some((set) => titleContainsPhrase(title, set))) return true;
  }

  // Sellers often fuse a short set abbreviation directly against the number
  // with no separator — "MEP 027" becomes "MEP027" — which the standalone
  // number-token check above correctly doesn't treat as containing "027" as
  // its own word. This is an independent fallback, not gated behind
  // numberMatch above, since the whole point is the number never appears on
  // its own in these titles.
  return setCandidates.some((set) => titleContainsToken(title, `${set}${numberToken}`));
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

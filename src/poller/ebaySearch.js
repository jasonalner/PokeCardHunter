// Step 1 of the build order: get this returning clean, correctly-filtered
// candidate listings, testable standalone (`npm run poll`) before anything
// else is wired up.

import 'dotenv/config';

// "binder" catches binder art inserts/accessory products that mention a
// card by name/number without being the card itself — a real listing
// slipped through as a genuine match: "Haunter MEP027 ... Extended Binder
// Art Inserts". Not adding the more generic "insert" — that word also
// legitimately describes real insert-rarity trading cards.
// "upc" catches Ultra Premium Collection multi-card promo bundles — a real
// listing titled "...UPC SWSH260, SWSH261, SWSH262 Full Set" (three cards,
// not one) matched as a single-card SWSH262 listing and, priced as a bundle,
// dragged that card's average up by roughly 2x.
const JUNK_TITLE_TERMS = ['lot', 'bundle', 'job lot', 'collection', 'proxy', 'custom', 'fake', 'replica', 'binder', 'upc'];

// eBay's own structured condition field is unreliable for graded-vs-raw too,
// not just NM-vs-not: a real listing titled "...PSA 10 Ace 10 Contender,
// Gem Mint..." had condition: "Ungraded" from eBay itself, and slipped
// through the condition-field-only graded filter, single-handedly dragging
// a market average from ~£65 to ~£120. Title text is the fallback signal.
const GRADING_KEYWORDS = ['psa', 'cgc', 'bgs', 'ace grade', 'ace 10', 'ace 9', 'beckett', 'gem mint'];

const CATEGORY_ID = '183454'; // Individual Trading Card Games
const MARKETPLACE_ID = 'EBAY_GB';
const DEFAULT_MIN_SELLER_FEEDBACK_SCORE = Number(process.env.MIN_SELLER_FEEDBACK_SCORE ?? 10);

const EBAY_OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE_URL = 'https://api.ebay.com/buy/browse/v1';

function isJunkTitle(title) {
  const lower = title.toLowerCase();
  return JUNK_TITLE_TERMS.some((term) => lower.includes(term));
}

function looksGradedFromTitle(title) {
  const lower = title.toLowerCase();
  return GRADING_KEYWORDS.some((term) => lower.includes(term));
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

let cachedToken = null; // { token, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const credentials = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(EBAY_OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
  });

  if (!res.ok) {
    throw new Error(`eBay OAuth token request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

async function ebayGet(path, params) {
  const token = await getAccessToken();
  const url = new URL(`${EBAY_BROWSE_URL}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
    },
  });

  if (!res.ok) {
    throw new Error(`eBay Browse API request failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

// Returns clean candidate summaries: junk titles and low-feedback sellers
// already filtered out. `condition` here is eBay's structured field/aspect,
// which the matcher treats as its primary condition signal.
export async function searchListings(targetCard, { minSellerFeedbackScore = DEFAULT_MIN_SELLER_FEEDBACK_SCORE } = {}) {
  const data = await ebayGet('/item_summary/search', {
    q: targetCard.searchQuery,
    category_ids: CATEGORY_ID,
    filter: 'itemLocationCountry:GB,buyingOptions:{FIXED_PRICE|BEST_OFFER}',
    aspect_filter: `categoryId:${CATEGORY_ID},Card Condition:{Near Mint or Better}`,
    limit: '50',
  });

  return (data.itemSummaries ?? [])
    .filter((item) => !isJunkTitle(item.title))
    .filter((item) => (item.seller?.feedbackScore ?? 0) >= minSellerFeedbackScore)
    .filter((item) => Number.isFinite(Number(item.price?.value)))
    // v1 scope is raw/ungraded cards only — graded (PSA/CGC/BGS/ACE) is a
    // different pricing model entirely and out of scope per the brief.
    // Checking both: eBay's structured condition field usually says Graded,
    // but not always (see GRADING_KEYWORDS above) — title text is the
    // fallback for when eBay's own field is wrong.
    .filter((item) => item.condition !== 'Graded' && !looksGradedFromTitle(item.title))
    .map((item) => ({
      itemId: item.itemId,
      title: item.title,
      price: Number(item.price?.value),
      currency: item.price?.currency,
      url: item.itemWebUrl,
      condition: item.condition,
      sellerFeedbackScore: item.seller?.feedbackScore,
    }));
}

// Not currently called by the pipeline (the matcher only needs the title) —
// kept as a utility since item summaries don't include the full description
// and it's a cheap follow-up call if free-text detail is ever needed again.
export async function getItemDescription(itemId) {
  const data = await ebayGet(`/item/${encodeURIComponent(itemId)}`);
  return stripHtml(data.description ?? '');
}

export { isJunkTitle, CATEGORY_ID };

if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDb, listTargetCardsForPipeline } = await import('../storage/db.js');
  const db = openDb();
  const targetCards = await listTargetCardsForPipeline(db);
  for (const card of targetCards) {
    const listings = await searchListings(card);
    console.log(`\n${card.cardName}: ${listings.length} candidate(s)`);
    console.table(listings.map(({ itemId, title, price, condition, sellerFeedbackScore }) =>
      ({ itemId, title, price, condition, sellerFeedbackScore })));
  }
}

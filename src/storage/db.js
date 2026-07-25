import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Points at a hosted Turso database in CI/production. Falls back to a local
// SQLite file (via libSQL's local-file support) when no Turso URL is set, so
// you can develop without a Turso account.
export function openDb() {
  const url = process.env.TURSO_DATABASE_URL || `file:${path.join(process.cwd(), 'data/pokecardhunter.db')}`;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (url.startsWith('file:')) {
    fs.mkdirSync(path.dirname(url.slice('file:'.length)), { recursive: true });
  }
  return createClient({ url, authToken });
}

export async function initSchema(db) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = schema.split(';').map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) {
    await db.execute(statement);
  }
}

// Brings a database created before the market-average refactor up to the
// current schema. Idempotent (checks PRAGMA table_info before altering) —
// safe to call on every process start, both the cron job and the results
// server. ALTERs are wrapped in try/catch since the check-then-alter isn't
// atomic across two HTTP round trips to Turso; a concurrent migration from
// another process could win the race, and that's fine as long as this one
// doesn't crash on "duplicate column name".
export async function runMigrations(db) {
  await db.execute('PRAGMA foreign_keys = ON');

  const targetCardsInfo = await db.execute('PRAGMA table_info(target_cards)');
  if (targetCardsInfo.rows.some((r) => r.name === 'target_price')) {
    try {
      await db.execute('ALTER TABLE target_cards DROP COLUMN target_price');
    } catch (err) {
      if (!/no such column|duplicate column/i.test(err.message)) throw err;
    }
  }

  const candidatesInfo = await db.execute('PRAGMA table_info(candidates)');
  if (!candidatesInfo.rows.some((r) => r.name === 'card_set')) {
    try {
      await db.execute("ALTER TABLE candidates ADD COLUMN card_set TEXT NOT NULL DEFAULT ''");
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
    // COALESCE guards against a candidate whose card_name has no matching
    // target_cards row (a target card can be deleted independently) — without
    // it this UPDATE throws a NOT NULL violation and aborts for every row.
    await db.execute(`
      UPDATE candidates
      SET card_set = COALESCE(
        (SELECT set_name FROM target_cards WHERE target_cards.card_name = candidates.card_name),
        ''
      )
      WHERE card_set = ''
    `);
  }

  if (!targetCardsInfo.rows.some((r) => r.name === 'set_aliases')) {
    try {
      await db.execute("ALTER TABLE target_cards ADD COLUMN set_aliases TEXT NOT NULL DEFAULT '[]'");
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }
}

export async function itemExists(db, itemId) {
  const result = await db.execute({
    sql: 'SELECT 1 FROM candidates WHERE item_id = ?',
    args: [itemId],
  });
  return result.rows.length > 0;
}

export async function insertCandidate(db, candidate) {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO candidates (
      item_id, card_name, card_set, listing_price, target_price, currency,
      listing_url, found_at, updated_at, verdict, verdict_reasoning, alerted, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'found')`,
    args: [
      candidate.itemId,
      candidate.cardName,
      candidate.cardSet,
      candidate.listingPrice,
      candidate.targetPrice,
      candidate.currency,
      candidate.listingUrl,
      now,
      now,
      candidate.verdict,
      candidate.verdictReasoning,
      candidate.alerted,
    ],
  });
}

export async function updateStatus(db, itemId, status) {
  await db.execute({
    sql: 'UPDATE candidates SET status = ?, updated_at = ? WHERE item_id = ?',
    args: [status, new Date().toISOString(), itemId],
  });
}

export const VALID_STATUSES = ['found', 'offered', 'bought', 'sold', 'flipped'];

// found_at is stored as an ISO timestamp; date-only filter values (from an
// <input type="date">) are normalized to the start/end of that day so a
// single day's candidates aren't excluded by a bare string comparison.
export async function listCandidates(db, filters = {}) {
  const conditions = [];
  const args = [];

  if (filters.cardName) {
    conditions.push('card_name = ?');
    args.push(filters.cardName);
  }
  if (filters.set) {
    conditions.push('card_set = ?');
    args.push(filters.set);
  }
  if (filters.status) {
    conditions.push('status = ?');
    args.push(filters.status);
  }
  if (filters.alerted === '1' || filters.alerted === '0') {
    conditions.push('alerted = ?');
    args.push(Number(filters.alerted));
  }
  if (filters.dateFrom) {
    conditions.push('found_at >= ?');
    args.push(filters.dateFrom.includes('T') ? filters.dateFrom : `${filters.dateFrom}T00:00:00.000Z`);
  }
  if (filters.dateTo) {
    conditions.push('found_at <= ?');
    args.push(filters.dateTo.includes('T') ? filters.dateTo : `${filters.dateTo}T23:59:59.999Z`);
  }
  if (filters.priceMin) {
    conditions.push('listing_price >= ?');
    args.push(Number(filters.priceMin));
  }
  if (filters.priceMax) {
    conditions.push('listing_price <= ?');
    args.push(Number(filters.priceMax));
  }
  if (filters.minMarginPct) {
    // margin % = how far under target_price the listing is, as a percentage
    conditions.push('((target_price - listing_price) * 100.0 / target_price) >= ?');
    args.push(Number(filters.minMarginPct));
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.execute({
    sql: `SELECT * FROM candidates ${where} ORDER BY found_at DESC`,
    args,
  });
  return result.rows;
}

export async function listCardNames(db) {
  const result = await db.execute('SELECT DISTINCT card_name FROM candidates ORDER BY card_name');
  return result.rows.map((row) => row.card_name);
}

export async function listSetNames(db) {
  const result = await db.execute("SELECT DISTINCT card_set FROM candidates WHERE card_set != '' ORDER BY card_set");
  return result.rows.map((row) => row.card_set);
}

export async function listTargetCards(db) {
  const result = await db.execute('SELECT * FROM target_cards ORDER BY card_name');
  return result.rows;
}

// Single target card in the same shape listTargetCardsForPipeline() uses —
// for triggering an immediate rescan of just one card right after it's
// added or edited, rather than waiting for the next scheduled run.
export async function getTargetCardForPipeline(db, id) {
  const result = await db.execute({ sql: 'SELECT * FROM target_cards WHERE id = ?', args: [id] });
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    cardName: row.card_name,
    name: row.name,
    set: row.set_name,
    number: row.number,
    searchQuery: row.search_query,
    currency: row.currency,
    setAliases: JSON.parse(row.set_aliases),
  };
}

// Target cards joined with their latest market_stats snapshot, for the
// results-screen display. LEFT JOIN so a card with no run yet still appears
// (with null stats) rather than being silently omitted.
export async function listTargetCardsWithStats(db) {
  const result = await db.execute(`
    SELECT tc.*, ms.sample_count, ms.average_price, ms.min_price, ms.max_price, ms.computed_at
    FROM target_cards tc
    LEFT JOIN market_stats ms ON ms.target_card_id = tc.id
    ORDER BY tc.card_name
  `);
  return result.rows.map((row) => ({ ...row, set_aliases: JSON.parse(row.set_aliases) }));
}

// Same rows as listTargetCards, reshaped into what searchListings() and
// matchListing() expect (name/set/number/searchQuery/currency/setAliases).
// No targetPrice here anymore — that's computed fresh each pipeline run from
// live listings, not stored on the target card itself.
export async function listTargetCardsForPipeline(db) {
  const rows = await listTargetCards(db);
  return rows.map((row) => ({
    id: row.id,
    cardName: row.card_name,
    name: row.name,
    set: row.set_name,
    number: row.number,
    searchQuery: row.search_query,
    currency: row.currency,
    setAliases: JSON.parse(row.set_aliases),
  }));
}

// Throws with a libSQL "UNIQUE constraint failed" message if the same
// name/set/number combo already exists — callers should surface that as a
// 409, not a generic 500. card.setAliases is an array of strings.
export async function addTargetCard(db, card) {
  const now = new Date().toISOString();
  const result = await db.execute({
    sql: `INSERT INTO target_cards (
      card_name, name, set_name, number, search_query, currency, set_aliases, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      card.cardName,
      card.name,
      card.set,
      card.number,
      card.searchQuery,
      card.currency,
      JSON.stringify(card.setAliases ?? []),
      now,
    ],
  });
  return Number(result.lastInsertRowid);
}

// Same UNIQUE-constraint-throws-409 contract as addTargetCard.
export async function updateTargetCard(db, id, card) {
  await db.execute({
    sql: `UPDATE target_cards
          SET card_name = ?, name = ?, set_name = ?, number = ?, search_query = ?, currency = ?, set_aliases = ?
          WHERE id = ?`,
    args: [card.cardName, card.name, card.set, card.number, card.searchQuery, card.currency, JSON.stringify(card.setAliases ?? []), id],
  });
}

// market_stats.target_card_id has ON DELETE CASCADE, so its row for this
// card goes with it. Candidates still sitting at status 'found' (never
// acted on) are no longer of interest once the card is off the watch list,
// so they're cleared too. Anything with a different status — offered,
// bought, sold, flipped — is real tracked history and must never be
// deleted here, regardless of what happens to the target card.
export async function deleteTargetCard(db, id) {
  const { rows } = await db.execute({ sql: 'SELECT card_name FROM target_cards WHERE id = ?', args: [id] });
  const cardName = rows[0]?.card_name;
  if (cardName) {
    await db.execute({
      sql: "DELETE FROM candidates WHERE card_name = ? AND status = 'found'",
      args: [cardName],
    });
  }
  await db.execute({ sql: 'DELETE FROM target_cards WHERE id = ?', args: [id] });
}

export async function upsertMarketStats(db, targetCardId, stats) {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO market_stats (
      target_card_id, sample_count, average_price, min_price, max_price, currency, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(target_card_id) DO UPDATE SET
      sample_count = excluded.sample_count,
      average_price = excluded.average_price,
      min_price = excluded.min_price,
      max_price = excluded.max_price,
      currency = excluded.currency,
      computed_at = excluded.computed_at`,
    args: [
      targetCardId,
      stats.sampleCount,
      stats.averagePrice,
      stats.minPrice,
      stats.maxPrice,
      stats.currency,
      now,
    ],
  });
}

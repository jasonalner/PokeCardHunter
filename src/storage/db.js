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
      item_id, card_name, listing_price, target_price, currency,
      listing_url, found_at, updated_at, verdict, verdict_reasoning, alerted, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'found')`,
    args: [
      candidate.itemId,
      candidate.cardName,
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

// Step 6 of the build order: a results screen backed by the same Turso
// database the scheduled pipeline writes to.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  initSchema,
  runMigrations,
  listCandidates,
  listCardNames,
  listSetNames,
  updateStatus,
  VALID_STATUSES,
  listTargetCardsWithStats,
  addTargetCard,
  updateTargetCard,
  deleteTargetCard,
} from '../storage/db.js';
import { runPipeline } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = openDb();
await initSchema(db);
await runMigrations(db);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../public')));

app.get('/api/candidates', async (req, res) => {
  const rows = await listCandidates(db, req.query);
  res.json(rows);
});

app.get('/api/card-names', async (req, res) => {
  const names = await listCardNames(db);
  res.json(names);
});

app.get('/api/set-names', async (req, res) => {
  const names = await listSetNames(db);
  res.json(names);
});

// Exposes config/settings.json so the frontend can default its "good margin"
// filter to the same priceThresholdPct the matcher uses to trigger alerts,
// rather than a second hardcoded number that could drift out of sync.
app.get('/api/settings', async (req, res) => {
  const raw = await readFile(path.join(__dirname, '../../config/settings.json'), 'utf8');
  res.json(JSON.parse(raw));
});

app.patch('/api/candidates/:itemId', async (req, res) => {
  const { status } = req.body ?? {};
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `invalid status: ${status}` });
  }
  await updateStatus(db, req.params.itemId, status);
  res.json({ ok: true });
});

app.get('/api/target-cards', async (req, res) => {
  const rows = await listTargetCardsWithStats(db);
  res.json(rows);
});

function parseCardFromBody(body) {
  const { name, set, number, currency } = body ?? {};
  if (!name?.trim() || !set?.trim() || !number?.trim()) {
    return { error: 'name, set, and number are required' };
  }
  const card = {
    name: name.trim(),
    set: set.trim(),
    number: number.trim(),
    currency: currency?.trim() || 'GBP',
  };
  card.cardName = `${card.name} - ${card.set} - ${card.number}`;
  card.searchQuery = `${card.name} ${card.number} ${card.set}`;
  return { card };
}

app.post('/api/target-cards', async (req, res) => {
  const { card, error } = parseCardFromBody(req.body);
  if (error) return res.status(400).json({ error });

  try {
    await addTargetCard(db, card);
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'that card is already on the target list' });
    }
    throw err;
  }
});

app.patch('/api/target-cards/:id', async (req, res) => {
  const { card, error } = parseCardFromBody(req.body);
  if (error) return res.status(400).json({ error });

  try {
    await updateTargetCard(db, req.params.id, card);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'that card is already on the target list' });
    }
    throw err;
  }
});

app.delete('/api/target-cards/:id', async (req, res) => {
  await deleteTargetCard(db, req.params.id);
  res.json({ ok: true });
});

// Reuses the server's own long-lived db connection — runPipeline() never
// closes it. A simple in-memory lock is enough protection against double
// clicks; overlapping with the hourly GitHub Actions cron is lower
// probability and not solved here.
let runInProgress = false;

app.post('/api/run-now', async (req, res) => {
  if (runInProgress) {
    return res.status(409).json({ error: 'a run is already in progress' });
  }
  runInProgress = true;
  try {
    await runPipeline(db);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    runInProgress = false;
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Results screen running at http://localhost:${PORT}`);
});

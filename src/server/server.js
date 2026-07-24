// Step 6 of the build order: a results screen backed by the same Turso
// database the scheduled pipeline writes to.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  listCandidates,
  listCardNames,
  updateStatus,
  VALID_STATUSES,
  listTargetCards,
  addTargetCard,
} from '../storage/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = openDb();

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
  const rows = await listTargetCards(db);
  res.json(rows);
});

app.post('/api/target-cards', async (req, res) => {
  const { name, set, number, targetPrice, currency } = req.body ?? {};

  if (!name?.trim() || !set?.trim() || !number?.trim()) {
    return res.status(400).json({ error: 'name, set, and number are required' });
  }
  const price = Number(targetPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'targetPrice must be a positive number' });
  }

  const card = {
    name: name.trim(),
    set: set.trim(),
    number: number.trim(),
    targetPrice: price,
    currency: currency?.trim() || 'GBP',
  };
  card.cardName = `${card.name} - ${card.set} - ${card.number}`;
  card.searchQuery = `${card.name} ${card.number} ${card.set}`;

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Results screen running at http://localhost:${PORT}`);
});

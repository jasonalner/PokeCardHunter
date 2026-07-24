// Step 6 of the build order: a results screen backed by the same Turso
// database the scheduled pipeline writes to.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, listCandidates, listCardNames, updateStatus, VALID_STATUSES } from '../storage/db.js';

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

app.patch('/api/candidates/:itemId', async (req, res) => {
  const { status } = req.body ?? {};
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `invalid status: ${status}` });
  }
  await updateStatus(db, req.params.itemId, status);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Results screen running at http://localhost:${PORT}`);
});

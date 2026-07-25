const els = {
  card: document.getElementById('filter-card'),
  set: document.getElementById('filter-set'),
  status: document.getElementById('filter-status'),
  alerted: document.getElementById('filter-alerted'),
  dateFrom: document.getElementById('filter-date-from'),
  dateTo: document.getElementById('filter-date-to'),
  priceMin: document.getElementById('filter-price-min'),
  priceMax: document.getElementById('filter-price-max'),
  minMargin: document.getElementById('filter-min-margin'),
  apply: document.getElementById('apply-filters'),
  clear: document.getElementById('clear-filters'),
  body: document.getElementById('results-body'),
  count: document.getElementById('results-count'),
  empty: document.getElementById('empty-state'),
  table: document.getElementById('results-table'),
  targetCardsBody: document.getElementById('target-cards-body'),
  addCardForm: document.getElementById('add-card-form'),
  addCardError: document.getElementById('add-card-error'),
  newCardName: document.getElementById('new-card-name'),
  newCardSet: document.getElementById('new-card-set'),
  newCardNumber: document.getElementById('new-card-number'),
  newCardCurrency: document.getElementById('new-card-currency'),
  addCardSubmit: document.getElementById('add-card-submit'),
  addCardCancel: document.getElementById('add-card-cancel'),
  runNow: document.getElementById('run-now'),
  runNowStatus: document.getElementById('run-now-status'),
};

const CURRENCY_SYMBOLS = { GBP: '£', USD: '$', EUR: '€' };
const STATUSES = ['found', 'offered', 'bought', 'sold', 'flipped'];

// The margin % (below market average) that config/settings.json's
// priceThresholdPct treats as "good enough to alert on" — reused here so the
// results screen's default view and the push-notification bar agree, rather
// than a second hardcoded number that could drift out of sync.
let goodMarginPct = 0;
let editingTargetCardId = null;

async function loadSettings() {
  const res = await fetch('/api/settings');
  const settings = await res.json();
  goodMarginPct = Math.round((1 - settings.priceThresholdPct) * 100);
  els.minMargin.value = goodMarginPct;
}

function marginPct(targetPrice, listingPrice) {
  return ((targetPrice - listingPrice) / targetPrice) * 100;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatMoney(value, currency) {
  if (value === null || value === undefined) return '—';
  const symbol = CURRENCY_SYMBOLS[currency] ?? '';
  return `${symbol}${Number(value).toFixed(2)}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadCardNames() {
  const res = await fetch('/api/card-names');
  const names = await res.json();
  els.card.querySelectorAll('option:not(:first-child)').forEach((o) => o.remove());
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    els.card.appendChild(opt);
  }
}

async function loadSetNames() {
  const res = await fetch('/api/set-names');
  const names = await res.json();
  els.set.querySelectorAll('option:not(:first-child)').forEach((o) => o.remove());
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    els.set.appendChild(opt);
  }
}

function buildQuery() {
  const params = new URLSearchParams();
  if (els.card.value) params.set('cardName', els.card.value);
  if (els.set.value) params.set('set', els.set.value);
  if (els.status.value) params.set('status', els.status.value);
  if (els.alerted.value) params.set('alerted', els.alerted.value);
  if (els.dateFrom.value) params.set('dateFrom', els.dateFrom.value);
  if (els.dateTo.value) params.set('dateTo', els.dateTo.value);
  if (els.priceMin.value) params.set('priceMin', els.priceMin.value);
  if (els.priceMax.value) params.set('priceMax', els.priceMax.value);
  if (els.minMargin.value) params.set('minMarginPct', els.minMargin.value);
  return params.toString();
}

function renderRows(rows) {
  els.body.innerHTML = '';
  els.count.textContent = `${rows.length} result${rows.length === 1 ? '' : 's'}`;
  els.table.hidden = rows.length === 0;
  els.empty.hidden = rows.length > 0;

  for (const row of rows) {
    const isLowConfidence = row.verdict === 'insufficient_data';
    const margin = marginPct(row.target_price, row.listing_price);
    const marginCell = isLowConfidence
      ? `<td class="margin-poor" title="${escapeHtml(row.verdict_reasoning ?? '')}">low data</td>`
      : `<td class="${margin >= goodMarginPct ? 'margin-good' : margin > 0 ? 'margin-ok' : 'margin-poor'}">${margin.toFixed(0)}%</td>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.card_name)}</td>
      <td>${formatMoney(row.listing_price, row.currency)}</td>
      <td title="${escapeHtml(row.verdict_reasoning ?? '')}">${formatMoney(row.target_price, row.currency)}</td>
      ${marginCell}
      <td>${formatDate(row.found_at)}</td>
      <td>
        <select class="badge status-select ${row.status}" data-item-id="${row.item_id}" data-current-status="${row.status}">
          ${STATUSES.map((s) => `<option value="${s}" ${s === row.status ? 'selected' : ''}>${capitalize(s)}</option>`).join('')}
        </select>
      </td>
      <td><a href="${row.listing_url}" target="_blank" rel="noopener">View ↗</a></td>
    `;
    els.body.appendChild(tr);
  }
}

async function loadResults() {
  const res = await fetch(`/api/candidates?${buildQuery()}`);
  renderRows(await res.json());
}

function renderTargetCardRows(rows) {
  els.targetCardsBody.innerHTML = '';
  for (const row of rows) {
    const hasStats = row.sample_count !== null && row.sample_count !== undefined;
    const range = hasStats && row.average_price !== null
      ? `${formatMoney(row.min_price, row.currency)}–${formatMoney(row.max_price, row.currency)}`
      : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.name)}</td>
      <td>${escapeHtml(row.set_name)}</td>
      <td>${escapeHtml(row.number)}</td>
      <td>${hasStats ? formatMoney(row.average_price, row.currency) : 'no data yet'}</td>
      <td>${range}</td>
      <td>${hasStats ? row.sample_count : '—'}</td>
      <td>${hasStats ? formatDate(row.computed_at) : '—'}</td>
      <td class="actions-cell">
        <button type="button" class="link-button edit-target-card" data-id="${row.id}">Edit</button>
        <button type="button" class="link-button delete-target-card" data-id="${row.id}">Delete</button>
      </td>
    `;
    els.targetCardsBody.appendChild(tr);
  }
}

let targetCardsCache = [];

async function loadTargetCards() {
  const res = await fetch('/api/target-cards');
  targetCardsCache = await res.json();
  renderTargetCardRows(targetCardsCache);
}

function enterEditMode(card) {
  editingTargetCardId = card.id;
  els.newCardName.value = card.name;
  els.newCardSet.value = card.set_name;
  els.newCardNumber.value = card.number;
  els.newCardCurrency.value = card.currency;
  els.addCardSubmit.textContent = 'Update Card';
  els.addCardCancel.hidden = false;
  els.newCardName.focus();
}

function exitEditMode() {
  editingTargetCardId = null;
  els.addCardForm.reset();
  els.newCardCurrency.value = 'GBP';
  els.addCardSubmit.textContent = 'Add Card';
  els.addCardCancel.hidden = true;
}

els.addCardForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.addCardError.hidden = true;
  els.addCardSubmit.disabled = true;

  const isEditing = editingTargetCardId !== null;
  const url = isEditing ? `/api/target-cards/${editingTargetCardId}` : '/api/target-cards';

  try {
    const res = await fetch(url, {
      method: isEditing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: els.newCardName.value,
        set: els.newCardSet.value,
        number: els.newCardNumber.value,
        currency: els.newCardCurrency.value,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `request failed: ${res.status}`);

    exitEditMode();
    await loadTargetCards();
  } catch (err) {
    els.addCardError.textContent = err.message;
    els.addCardError.hidden = false;
  } finally {
    els.addCardSubmit.disabled = false;
  }
});

els.addCardCancel.addEventListener('click', () => {
  exitEditMode();
  els.addCardError.hidden = true;
});

els.targetCardsBody.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('.edit-target-card');
  if (editBtn) {
    const card = targetCardsCache.find((c) => String(c.id) === editBtn.dataset.id);
    if (card) enterEditMode(card);
    return;
  }

  const deleteBtn = e.target.closest('.delete-target-card');
  if (deleteBtn) {
    const card = targetCardsCache.find((c) => String(c.id) === deleteBtn.dataset.id);
    if (!card || !confirm(`Remove "${card.card_name}" from the target list? This won't delete its past candidate history.`)) return;

    deleteBtn.disabled = true;
    try {
      const res = await fetch(`/api/target-cards/${deleteBtn.dataset.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
      if (editingTargetCardId === card.id) exitEditMode();
      await loadTargetCards();
    } catch (err) {
      alert('Failed to delete — please try again.');
      deleteBtn.disabled = false;
    }
  }
});

els.body.addEventListener('change', async (e) => {
  const select = e.target.closest('select.status-select');
  if (!select) return;

  const itemId = select.dataset.itemId;
  const previousStatus = select.dataset.currentStatus;
  const newStatus = select.value;

  select.disabled = true;
  try {
    const res = await fetch(`/api/candidates/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (!res.ok) throw new Error(`update failed: ${res.status}`);

    select.classList.remove(previousStatus);
    select.classList.add(newStatus);
    select.dataset.currentStatus = newStatus;
  } catch (err) {
    console.error(err);
    select.value = previousStatus;
    alert('Failed to update status — please try again.');
  } finally {
    select.disabled = false;
  }
});

els.runNow.addEventListener('click', async () => {
  els.runNow.disabled = true;
  els.runNowStatus.textContent = 'Running…';
  els.runNowStatus.className = 'run-now-status';

  try {
    const res = await fetch('/api/run-now', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `request failed: ${res.status}`);

    els.runNowStatus.textContent = 'Done';
    await Promise.all([loadTargetCards(), loadResults(), loadCardNames(), loadSetNames()]);
  } catch (err) {
    els.runNowStatus.textContent = err.message;
    els.runNowStatus.className = 'run-now-status run-now-error';
  } finally {
    els.runNow.disabled = false;
  }
});

els.apply.addEventListener('click', loadResults);
els.clear.addEventListener('click', () => {
  els.card.value = '';
  els.set.value = '';
  els.status.value = '';
  els.alerted.value = '';
  els.dateFrom.value = '';
  els.dateTo.value = '';
  els.priceMin.value = '';
  els.priceMax.value = '';
  els.minMargin.value = '';
  loadResults();
});

loadCardNames();
loadSetNames();
loadTargetCards();
loadSettings().then(loadResults);

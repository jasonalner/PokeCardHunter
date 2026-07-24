const els = {
  card: document.getElementById('filter-card'),
  status: document.getElementById('filter-status'),
  alerted: document.getElementById('filter-alerted'),
  dateFrom: document.getElementById('filter-date-from'),
  dateTo: document.getElementById('filter-date-to'),
  priceMin: document.getElementById('filter-price-min'),
  priceMax: document.getElementById('filter-price-max'),
  apply: document.getElementById('apply-filters'),
  clear: document.getElementById('clear-filters'),
  body: document.getElementById('results-body'),
  count: document.getElementById('results-count'),
  empty: document.getElementById('empty-state'),
  table: document.querySelector('.results-table'),
  targetCardsBody: document.getElementById('target-cards-body'),
  addCardForm: document.getElementById('add-card-form'),
  addCardError: document.getElementById('add-card-error'),
  newCardName: document.getElementById('new-card-name'),
  newCardSet: document.getElementById('new-card-set'),
  newCardNumber: document.getElementById('new-card-number'),
  newCardPrice: document.getElementById('new-card-price'),
  newCardCurrency: document.getElementById('new-card-currency'),
};

const CURRENCY_SYMBOLS = { GBP: '£', USD: '$', EUR: '€' };
const STATUSES = ['found', 'offered', 'bought', 'sold', 'flipped'];

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatMoney(value, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] ?? '';
  return `${symbol}${Number(value).toFixed(2)}`;
}

function formatDate(iso) {
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
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    els.card.appendChild(opt);
  }
}

function buildQuery() {
  const params = new URLSearchParams();
  if (els.card.value) params.set('cardName', els.card.value);
  if (els.status.value) params.set('status', els.status.value);
  if (els.alerted.value) params.set('alerted', els.alerted.value);
  if (els.dateFrom.value) params.set('dateFrom', els.dateFrom.value);
  if (els.dateTo.value) params.set('dateTo', els.dateTo.value);
  if (els.priceMin.value) params.set('priceMin', els.priceMin.value);
  if (els.priceMax.value) params.set('priceMax', els.priceMax.value);
  return params.toString();
}

function renderRows(rows) {
  els.body.innerHTML = '';
  els.count.textContent = `${rows.length} result${rows.length === 1 ? '' : 's'}`;
  els.table.hidden = rows.length === 0;
  els.empty.hidden = rows.length > 0;

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.card_name)}</td>
      <td>${formatMoney(row.listing_price, row.currency)}</td>
      <td>${formatMoney(row.target_price, row.currency)}</td>
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
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.name)}</td>
      <td>${escapeHtml(row.set_name)}</td>
      <td>${escapeHtml(row.number)}</td>
      <td>${formatMoney(row.target_price, row.currency)}</td>
    `;
    els.targetCardsBody.appendChild(tr);
  }
}

async function loadTargetCards() {
  const res = await fetch('/api/target-cards');
  renderTargetCardRows(await res.json());
}

els.addCardForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.addCardError.hidden = true;

  const submitButton = els.addCardForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const res = await fetch('/api/target-cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: els.newCardName.value,
        set: els.newCardSet.value,
        number: els.newCardNumber.value,
        targetPrice: els.newCardPrice.value,
        currency: els.newCardCurrency.value,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `request failed: ${res.status}`);

    els.addCardForm.reset();
    els.newCardCurrency.value = 'GBP';
    await loadTargetCards();
  } catch (err) {
    els.addCardError.textContent = err.message;
    els.addCardError.hidden = false;
  } finally {
    submitButton.disabled = false;
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

els.apply.addEventListener('click', loadResults);
els.clear.addEventListener('click', () => {
  els.card.value = '';
  els.status.value = '';
  els.alerted.value = '';
  els.dateFrom.value = '';
  els.dateTo.value = '';
  els.priceMin.value = '';
  els.priceMax.value = '';
  loadResults();
});

loadCardNames();
loadResults();
loadTargetCards();

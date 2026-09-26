const STORAGE_KEY = "lumo-cycle-budget-v1";
const categories = {
  groceries: { label: "Groceries", color: "#5d9d7c" },
  eating_out: { label: "Eating out", color: "#df8769" },
  transport: { label: "Transport", color: "#7897b0" },
  entertainment: { label: "Entertainment", color: "#bb9a4d" },
  shopping: { label: "Shopping", color: "#c78086" },
  bills_other: { label: "Other bills", color: "#8986ad" },
  health: { label: "Healthcare", color: "#6c9f9d" },
  misc: { label: "Miscellaneous", color: "#9a9f90" },
};

const money = new Intl.NumberFormat("sv-SE", {
  style: "currency",
  currency: "SEK",
  maximumFractionDigits: 0,
});
const centsToSek = (value) => Number(value) / 100;
const formatSek = (value) => money.format(value).replace(/\s?kr$/, " kr");
const centsFromInput = (value) => BigInt(Math.round((Number(value) || 0) * 100));
const todayIso = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

function cycleDates() {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const start = today.getDate() >= 15 ? new Date(year, month, 15) : new Date(year, month - 1, 15);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 15);
  const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { start: iso(start), end: iso(end) };
}

const defaultDates = cycleDates();
const defaults = {
  income: "31900",
  openingBalance: "4434",
  fixedCosts: "28000",
  buffer: "0",
  carryover: "0",
  cycleStart: defaultDates.start,
  cycleEnd: defaultDates.end,
  transactions: [],
  deletedSourceIds: [],
};

const hasLegacyBrowserState = localStorage.getItem(STORAGE_KEY) !== null;
function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return { ...defaults, ...stored, transactions: Array.isArray(stored?.transactions) ? stored.transactions : [] };
  } catch {
    return { ...defaults };
  }
}

let state = loadState();
let wasm;
let storageReady = false;
let persistenceQueue = Promise.resolve();

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    document.querySelector(".local-note").textContent = "Browser backup is unavailable.";
  }
  if (!storageReady) return;

  const budget = Object.fromEntries(["income", "openingBalance", "fixedCosts", "buffer", "carryover", "cycleStart", "cycleEnd"]
    .map((key) => [key, state[key]]));
  const snapshot = JSON.stringify({ budget, transactions: state.transactions, deletedSourceIds: state.deletedSourceIds });
  persistenceQueue = persistenceQueue.then(async () => {
    const response = await fetch("./api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: snapshot,
    });
    if (!response.ok) throw new Error(`Local storage returned ${response.status}`);
  }).catch(() => {
    document.querySelector(".local-note").textContent = "Could not save to the local data file; browser backup is retained.";
  });
}

function inputNumber(id) {
  return Math.max(0, Number(document.getElementById(id).value) || 0);
}

function todayAtMidnight() {
  const [year, month, day] = todayIso().split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function remainingDays() {
  const endValue = document.getElementById("cycleEnd").value;
  if (!endValue) return 0;
  const [year, month, day] = endValue.split("-").map(Number);
  return Math.max(0, Math.ceil((Date.UTC(year, month - 1, day) - todayAtMidnight()) / 86_400_000));
}

function currentTransactions() {
  const start = document.getElementById("cycleStart").value;
  const end = document.getElementById("cycleEnd").value;
  return state.transactions.filter((transaction) =>
    (!start || transaction.date >= start) && (!end || transaction.date < end),
  );
}

function activeCurrentTransactions() {
  return currentTransactions().filter((transaction) => !transaction.reserved);
}

function renderTransactions() {
  const list = document.getElementById("transactionList");
  const ordered = currentTransactions().sort((a, b) => b.createdAt - a.createdAt);
  document.getElementById("transactionCount").textContent = `${ordered.length} ${ordered.length === 1 ? "entry" : "entries"}`;

  if (ordered.length === 0) {
    list.innerHTML = '<div class="empty-list">Your cycle is clear. Add the first purchase when it lands.</div>';
    return;
  }

  list.innerHTML = ordered.map((transaction) => {
    const category = categories[transaction.category] ?? categories.misc;
    return `<div class="transaction-item">
      <div class="transaction-main">
        <span class="category-dot" style="--dot-color:${category.color}"></span>
        <div class="transaction-copy">
          <div class="transaction-name">${escapeHtml(transaction.label)}</div>
          <div class="transaction-meta">${category.label} · ${transaction.date}${transaction.reserved ? " · Reserved next cycle" : ""}</div>
        </div>
      </div>
      <strong class="transaction-amount">${formatSek(transaction.amount)}</strong>
      <button class="delete-transaction" type="button" data-delete="${transaction.id}" aria-label="Delete ${escapeHtml(transaction.label)}" title="Delete expense">×</button>
    </div>`;
  }).join("");
}

function renderCategories() {
  const target = document.getElementById("categoryBreakdown");
  const totals = new Map();
  for (const transaction of activeCurrentTransactions()) {
    totals.set(transaction.category, (totals.get(transaction.category) ?? 0) + transaction.amount);
  }
  const total = [...totals.values()].reduce((sum, amount) => sum + amount, 0);
  if (total === 0) {
    target.innerHTML = '<div class="category-empty">Category totals will take shape as you log purchases.</div>';
    return;
  }

  target.innerHTML = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, amount]) => {
      const category = categories[key] ?? categories.misc;
      const percent = amount / total * 100;
      return `<div class="category-item">
        <div class="category-head"><span>${category.label}</span><strong>${formatSek(amount)} <span>${Math.round(percent)}%</span></strong></div>
        <div class="category-track"><span style="width:${percent}%;--category-color:${category.color}"></span></div>
      </div>`;
    }).join("");
}

function renderBudget() {
  if (!wasm) return;
  const income = inputNumber("income");
  const opening = inputNumber("openingBalance");
  const fixed = inputNumber("fixedCosts");
  const buffer = inputNumber("buffer");
  const carryover = inputNumber("carryover");
  const spent = activeCurrentTransactions().reduce((sum, transaction) => sum + transaction.amount, 0);
  const limitCents = wasm.cycle_limit_cents(
    centsFromInput(income), centsFromInput(opening), centsFromInput(fixed),
    centsFromInput(buffer), centsFromInput(carryover),
  );
  const remainingCents = wasm.remaining_cents(limitCents, centsFromInput(spent));
  const limit = centsToSek(limitCents);
  const remaining = centsToSek(remainingCents);
  const days = remainingDays();
  const percentUsed = limit > 0 ? Math.max(0, spent / limit * 100) : (spent > 0 ? 100 : 0);

  document.getElementById("cycleLimit").textContent = formatSek(limit);
  document.getElementById("remaining").textContent = formatSek(remaining);
  document.getElementById("spentLabel").textContent = `Spent ${formatSek(spent)}`;
  document.getElementById("limitLabel").textContent = `${Math.round(percentUsed)}% used`;
  document.getElementById("progressFill").style.width = `${Math.min(100, percentUsed)}%`;
  document.getElementById("budgetProgress").setAttribute("aria-valuenow", String(Math.min(100, Math.round(percentUsed))));
  document.getElementById("weeklyAllowance").textContent = formatSek(days > 0 ? remaining * 7 / days : remaining);
  document.getElementById("daysLeft").textContent = `${days} ${days === 1 ? "day" : "days"} left`;

  const start = document.getElementById("cycleStart").value;
  const end = document.getElementById("cycleEnd").value;
  document.getElementById("cycleLabel").textContent = start && end ? `${formatDate(start)} — ${formatDate(end)}` : "Choose cycle dates";
  document.getElementById("spentCaption").textContent = start && end ? `${formatDate(start)} to ${formatDate(end)}` : "Current cycle";

  const warning = document.getElementById("fundingWarning");
  const rawFunds = income + opening - fixed - buffer - carryover;
  if (rawFunds < 0) {
    warning.textContent = `Your plan is short by ${formatSek(-rawFunds)} before everyday spending. Add available funds or adjust the reserved amounts.`;
    warning.hidden = false;
  } else if (remaining < 0) {
    warning.textContent = `You are ${formatSek(-remaining)} over this cycle's spending limit.`;
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  renderTransactions();
  renderCategories();
}

function formatDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(year, month - 1, day));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function syncInputsFromState() {
  for (const id of ["income", "openingBalance", "fixedCosts", "buffer", "carryover", "cycleStart", "cycleEnd"]) {
    document.getElementById(id).value = state[id];
  }
}

function downloadCsv() {
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const header = ["type", "date", "label", "category", "amount_kr", "income_kr", "opening_balance_kr", "fixed_costs_kr", "buffer_kr", "carryover_kr", "cycle_start", "cycle_end"];
  const rows = [["budget", "", "", "", "", state.income, state.openingBalance, state.fixedCosts, state.buffer, state.carryover, state.cycleStart, state.cycleEnd]];
  for (const transaction of state.transactions) {
    rows.push(["expense", transaction.date, transaction.label, transaction.category, transaction.amount, "", "", "", "", "", state.cycleStart, state.cycleEnd]);
  }
  const csv = [header, ...rows].map((row) => row.map(quote).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = "ledger-cycle-budget.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

document.querySelectorAll("[data-budget], #cycleStart, #cycleEnd").forEach((input) => {
  input.addEventListener("input", () => {
    state[input.id] = input.value;
    saveState();
    renderBudget();
  });
});

document.getElementById("transactionForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const amount = Number(document.getElementById("expenseAmount").value);
  const label = document.getElementById("expenseLabel").value.trim();
  if (!Number.isFinite(amount) || amount <= 0 || !label) return;
  state.transactions.push({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    date: todayIso(),
    amount: Math.round(amount * 100) / 100,
    label,
    category: document.getElementById("expenseCategory").value,
  });
  saveState();
  event.currentTarget.reset();
  renderBudget();
  document.getElementById("expenseAmount").focus();
});

document.getElementById("transactionList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete]");
  if (!button) return;
  const deleted = state.transactions.find((transaction) => transaction.id === button.dataset.delete);
  if (deleted?.sourceId) state.deletedSourceIds.push(deleted.sourceId);
  state.transactions = state.transactions.filter((transaction) => transaction.id !== button.dataset.delete);
  saveState();
  renderBudget();
});

document.getElementById("exportCsv").addEventListener("click", downloadCsv);

async function start() {
  syncInputsFromState();
  try {
    const response = await fetch("./wasm/budget_tool.wasm");
    if (!response.ok) throw new Error(`WASM load failed (${response.status})`);
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
    wasm = instance.exports;
    renderBudget();
  } catch (error) {
    document.getElementById("cycleLimit").textContent = "WASM unavailable";
    document.getElementById("fundingWarning").textContent = `Could not load the WebAssembly calculator: ${error.message}. Build the module and reload this page.`;
    document.getElementById("fundingWarning").hidden = false;
  }

  try {
    const response = await fetch("./api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`Local data API returned ${response.status}`);
    const saved = await response.json();
    const oldTransactions = hasLegacyBrowserState ? state.transactions : [];
    const deletedSourceIds = new Set([...(saved.deletedSourceIds ?? []), ...state.deletedSourceIds]);
    const transactionsById = new Map();
    for (const transaction of [...(saved.transactions ?? []), ...oldTransactions]) {
      if (!transaction.sourceId || !deletedSourceIds.has(transaction.sourceId)) {
        transactionsById.set(transaction.id, transaction);
      }
    }
    state = {
      ...defaults,
      ...(saved.budget ?? {}),
      ...(hasLegacyBrowserState ? loadState() : {}),
      transactions: [...transactionsById.values()],
      deletedSourceIds: [...deletedSourceIds],
    };
    storageReady = true;
    syncInputsFromState();
    saveState();
    renderBudget();
    document.querySelector(".local-note").innerHTML = "<span aria-hidden=\"true\">◉</span> Saved to this computer in <code>.ledger_data.json</code>.";
  } catch (error) {
    document.querySelector(".local-note").textContent = `Using browser-only data: ${error.message}`;
  }
}

start();
const state = {
  settings: { currency: "₽", theme: "dark" },
  accounts: [],
  categories: [],
  summary: null,
  transactions: [],
  activeTab: "dashboard",
  donutMode: "expense",
  period: "this_month",
  dateFrom: "",
  dateTo: "",
  filters: { q: "", type: "", category_id: "", account_id: "", sort: "date_desc" },
};

const TAB_TITLES = {
  dashboard: "Дашборд",
  transactions: "Операции",
  manage: "Счета и категории",
  settings: "Данные и настройки",
};

const MONTHS_RU = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];

function $(id) {
  return document.getElementById(id);
}

function esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtMoney(val, showSign = false) {
  const num = Number(val || 0);
  const absStr = Math.abs(num).toLocaleString("ru-RU", {
    minimumFractionDigits: num % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  const cur = state.settings.currency || "₽";
  if (showSign) {
    const sign = num > 0 ? "+" : num < 0 ? "−" : "";
    return `${sign}${absStr} ${cur}`;
  }
  return `${num < 0 ? "−" : ""}${absStr} ${cur}`;
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function computePeriodDates(preset) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

  if (preset === "this_month") {
    return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
  }
  if (preset === "last_month") {
    return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
  }
  if (preset === "last_3m") {
    return [iso(new Date(y, m - 2, 1)), iso(new Date(y, m + 1, 0))];
  }
  if (preset === "this_year") {
    return [`${y}-01-01`, `${y}-12-31`];
  }
  if (preset === "all") {
    return ["", ""];
  }
  return [state.dateFrom, state.dateTo];
}

function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("toastContainer").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Ошибка ${res.status}`);
  }
  return data;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("btnTheme").textContent = theme === "dark" ? "☀️" : "🌙";
  document.querySelectorAll("#themeSegmented .seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeVal === theme);
  });
}

async function refreshAll() {
  const params = new URLSearchParams();
  if (state.dateFrom) params.set("from", state.dateFrom);
  if (state.dateTo) params.set("to", state.dateTo);
  if (state.filters.q) params.set("q", state.filters.q);
  if (state.filters.type) params.set("type", state.filters.type);
  if (state.filters.category_id) params.set("category_id", state.filters.category_id);
  if (state.filters.account_id) params.set("account_id", state.filters.account_id);
  if (state.filters.sort) params.set("sort", state.filters.sort);

  const data = await api(`/api/bootstrap?${params.toString()}`);
  state.settings = data.settings;
  state.accounts = data.accounts;
  state.categories = data.categories;
  state.summary = data.summary;
  state.transactions = data.transactions;

  applyTheme(state.settings.theme || "dark");
  $("settingCurrency").value = state.settings.currency || "₽";
  if ($("settingGistToken")) {
    $("settingGistToken").value = state.settings.gist_token || "";
    $("settingGistId").value = state.settings.gist_id || "";
    $("settingGistAutosync").checked = state.settings.gist_autosync === "true";
  }

  renderDashboard();
  renderTransactions();
  renderManage();
  populateFilterSelects();
}

function renderDashboard() {
  const s = state.summary;
  if (!s) return;

  $("kpiBalance").textContent = fmtMoney(s.total_balance);
  $("kpiIncome").textContent = fmtMoney(s.total_income);
  $("kpiExpense").textContent = fmtMoney(s.total_expense);
  $("kpiNet").textContent = fmtMoney(s.net, true);
  $("kpiNet").style.color = s.net >= 0 ? "var(--income)" : "var(--expense)";
  $("kpiSavingsRate").textContent = `Норма сбережений: ${s.savings_rate}%`;

  // Счета
  $("dashboardAccounts").innerHTML = state.accounts
    .map(
      (a) => `
      <div class="acc-pill">
        <div class="acc-badge" style="background: ${esc(a.color)}22; color: ${esc(a.color)}">${esc(a.icon)}</div>
        <div>
          <div class="acc-name">${esc(a.name)}</div>
          <div class="acc-bal">${fmtMoney(a.balance)}</div>
        </div>
      </div>`
    )
    .join("");

  renderDonut();
  renderBarChart();
  renderBudgets();
  renderRecentTx();
}

function renderDonut() {
  const container = $("donutContainer");
  const items =
    state.donutMode === "expense"
      ? (state.summary?.expense_by_category || []).filter((c) => c.total > 0)
      : (state.summary?.income_by_category || []).filter((c) => c.total > 0);

  if (items.length === 0) {
    container.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1">Нет данных за выбранный период</div>`;
    return;
  }

  const total = items.reduce((acc, c) => acc + c.total, 0);
  const r = 64;
  const cx = 85;
  const cy = 85;
  const circ = 2 * Math.PI * r;
  let offset = 0;

  const circles = items
    .map((c) => {
      const frac = c.total / total;
      const dash = frac * circ;
      const svg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${esc(c.color)}" stroke-width="22"
        stroke-dasharray="${dash} ${circ - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
      offset += dash;
      return svg;
    })
    .join("");

  const legend = items
    .map((c) => {
      const pct = Math.round((c.total / total) * 100);
      return `
        <div class="legend-row">
          <div class="legend-left">
            <span class="legend-swatch" style="background:${esc(c.color)}"></span>
            <span class="legend-name">${esc(c.icon)} ${esc(c.name)}</span>
          </div>
          <div class="legend-val">${fmtMoney(c.total)} <span class="muted">(${pct}%)</span></div>
        </div>`;
    })
    .join("");

  container.innerHTML = `
    <div class="donut-svg-wrap">
      <svg viewBox="0 0 170 170" width="170" height="170">${circles}</svg>
      <div class="donut-center">
        <div class="donut-center-label">${state.donutMode === "expense" ? "Расходы" : "Доходы"}</div>
        <div class="donut-center-val">${fmtMoney(total)}</div>
      </div>
    </div>
    <div class="donut-legend">${legend}</div>
  `;
}

function renderBarChart() {
  const wrap = $("barChartContainer");
  const months = state.summary?.monthly || [];
  if (months.length === 0) {
    wrap.innerHTML = `<div class="empty-state">Добавьте операции, чтобы увидеть динамику по месяцам</div>`;
    return;
  }

  const maxVal = Math.max(1, ...months.flatMap((m) => [m.income, m.expense]));
  const width = 560;
  const height = 210;
  const padL = 12;
  const padR = 12;
  const padT = 18;
  const padB = 28;
  const plotH = height - padT - padB;
  const groupW = (width - padL - padR) / months.length;
  const barW = Math.min(20, Math.max(8, groupW * 0.28));

  const gridLines = [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = padT + plotH * (1 - f);
      return `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="var(--border)" stroke-dasharray="3 3" />`;
    })
    .join("");

  const bars = months
    .map((m, i) => {
      const centerX = padL + groupW * i + groupW / 2;
      const incH = (m.income / maxVal) * plotH;
      const expH = (m.expense / maxVal) * plotH;
      const incY = padT + plotH - incH;
      const expY = padT + plotH - expH;
      const [, mm] = m.month.split("-");
      const label = MONTHS_RU[Number(mm) - 1] || m.month;

      return `
        <g>
          <title>${m.month}: Доход ${fmtMoney(m.income)}, Расход ${fmtMoney(m.expense)}</title>
          <rect x="${centerX - barW - 2}" y="${incY}" width="${barW}" height="${Math.max(2, incH)}" rx="4" fill="var(--income)" />
          <rect x="${centerX + 2}" y="${expY}" width="${barW}" height="${Math.max(2, expH)}" rx="4" fill="var(--expense)" />
          <text x="${centerX}" y="${height - 8}" text-anchor="middle" fill="var(--text-muted)" font-size="11">${label}</text>
        </g>`;
    })
    .join("");

  wrap.innerHTML = `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto">${gridLines}${bars}</svg>`;
}

function renderBudgets() {
  const list = $("budgetsList");
  const budgeted = (state.summary?.expense_by_category || []).filter((c) => c.budget_limit > 0);
  if (budgeted.length === 0) {
    list.innerHTML = `<div class="empty-state">Лимиты бюджета не заданы. Вы можете настроить их во вкладке «Счета и категории».</div>`;
    return;
  }

  list.innerHTML = budgeted
    .map((c) => {
      const pct = Math.min(100, Math.round((c.total / c.budget_limit) * 100));
      const over = c.total > c.budget_limit;
      const color = over ? "var(--expense)" : pct >= 80 ? "var(--warn)" : "var(--income)";
      return `
        <div>
          <div class="budget-item-head">
            <span>${esc(c.icon)} ${esc(c.name)}</span>
            <span class="budget-nums" style="${over ? "color:var(--expense);font-weight:600" : ""}">
              ${fmtMoney(c.total)} / ${fmtMoney(c.budget_limit)} (${Math.round((c.total / c.budget_limit) * 100)}%)
            </span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width:${pct}%;background:${color}"></div>
          </div>
        </div>`;
    })
    .join("");
}

function txRowHtml(t) {
  const isTransfer = t.type === "transfer";
  const icon = isTransfer ? "🔁" : t.category_icon || "📦";
  const color = isTransfer ? "#8b5cf6" : t.category_color || "#64748b";
  const title = isTransfer
    ? `Перевод: ${t.account_name} → ${t.to_account_name}`
    : t.category_name || "Без категории";
  const metaParts = [t.account_name];
  if (t.note) metaParts.push(t.note);

  const amountText =
    t.type === "income"
      ? fmtMoney(t.amount, true)
      : t.type === "expense"
      ? fmtMoney(-t.amount, true)
      : fmtMoney(t.amount);

  return `
    <div class="tx-row" data-tx-id="${t.id}">
      <div class="tx-icon" style="background:${esc(color)}22; color:${esc(color)}">${esc(icon)}</div>
      <div class="tx-info">
        <div class="tx-title">${esc(title)}</div>
        <div class="tx-meta">${esc(t.date)} · ${esc(metaParts.join(" · "))}</div>
      </div>
      <div class="tx-amount ${esc(t.type)}">${amountText}</div>
    </div>`;
}

function renderRecentTx() {
  const list = $("recentTxList");
  const recent = state.transactions.slice(0, 6);
  if (recent.length === 0) {
    list.innerHTML = `<div class="empty-state">Операций пока нет. Нажмите «＋ Операция», чтобы добавить первую.</div>`;
    return;
  }
  list.innerHTML = recent.map(txRowHtml).join("");
}

function formatDateHeading(iso) {
  const today = todayISO();
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yestIso = yest.toISOString().slice(0, 10);
  if (iso === today) return "Сегодня";
  if (iso === yestIso) return "Вчера";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function renderTransactions() {
  const list = $("allTxList");
  const txs = state.transactions;
  $("txCountBadge").textContent = txs.length;

  const inc = txs.filter((t) => t.type === "income").reduce((a, t) => a + t.amount, 0);
  const exp = txs.filter((t) => t.type === "expense").reduce((a, t) => a + t.amount, 0);
  $("txFilteredTotals").innerHTML = `
    <span style="color:var(--income)">+${fmtMoney(inc)}</span>
    <span style="color:var(--expense)">−${fmtMoney(exp)}</span>
  `;

  if (txs.length === 0) {
    list.innerHTML = `<div class="empty-state">По выбранным фильтрам операций не найдено.</div>`;
    return;
  }

  let html = "";
  let lastDate = "";
  const isDateSorted = (state.filters.sort || "date_desc").startsWith("date_");
  for (const t of txs) {
    if (isDateSorted && t.date !== lastDate) {
      lastDate = t.date;
      html += `<div class="tx-date-header">${esc(formatDateHeading(t.date))}</div>`;
    }
    html += txRowHtml(t);
  }
  list.innerHTML = html;
}

function renderManage() {
  $("accountsManageList").innerHTML = state.accounts
    .map(
      (a) => `
      <div class="manage-row">
        <div class="manage-left">
          <div class="acc-badge" style="background:${esc(a.color)}22;color:${esc(a.color)}">${esc(a.icon)}</div>
          <div>
            <div style="font-weight:600">${esc(a.name)}</div>
            <div class="muted" style="font-size:12px">Баланс: ${fmtMoney(a.balance)}</div>
          </div>
        </div>
        <div class="manage-actions">
          <button class="btn btn-sm btn-secondary" data-edit-acc="${a.id}">Изм.</button>
          <button class="btn btn-sm btn-danger" data-del-acc="${a.id}">✕</button>
        </div>
      </div>`
    )
    .join("");

  $("categoriesManageList").innerHTML = state.categories
    .map(
      (c) => `
      <div class="manage-row">
        <div class="manage-left">
          <div class="acc-badge" style="background:${esc(c.color)}22;color:${esc(c.color)}">${esc(c.icon)}</div>
          <div>
            <div style="font-weight:600">${esc(c.name)} <span class="muted" style="font-size:11.5px">(${c.type === "income" ? "доход" : "расход"})</span></div>
            ${c.type === "expense" ? `<div class="muted" style="font-size:12px">Лимит: ${c.budget_limit > 0 ? fmtMoney(c.budget_limit) : "не задан"}</div>` : ""}
          </div>
        </div>
        <div class="manage-actions">
          <button class="btn btn-sm btn-secondary" data-edit-cat="${c.id}">Изм.</button>
          <button class="btn btn-sm btn-danger" data-del-cat="${c.id}">✕</button>
        </div>
      </div>`
    )
    .join("");
}

function populateFilterSelects() {
  const catSel = $("filterCategory");
  const prevCat = catSel.value;
  catSel.innerHTML = `<option value="">Все категории</option>` +
    state.categories.map((c) => `<option value="${c.id}">${esc(c.icon)} ${esc(c.name)}</option>`).join("");
  catSel.value = prevCat;

  const accSel = $("filterAccount");
  const prevAcc = accSel.value;
  accSel.innerHTML = `<option value="">Все счета</option>` +
    state.accounts.map((a) => `<option value="${a.id}">${esc(a.icon)} ${esc(a.name)}</option>`).join("");
  accSel.value = prevAcc;
}

// ---------- Modals ----------
function openModal(id) {
  $(id).classList.remove("hidden");
}

function closeModal(id) {
  $(id).classList.add("hidden");
}

let currentTxType = "expense";

function setTxModalType(type) {
  currentTxType = type;
  document.querySelectorAll("#txTypeSwitch .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.txType === type);
  });

  const isTransfer = type === "transfer";
  $("txCategoryGroup").classList.toggle("hidden", isTransfer);
  $("txToAccountGroup").classList.toggle("hidden", !isTransfer);
  $("txAccountLabel").textContent = isTransfer ? "Со счёта" : "Счёт";

  if (!isTransfer) {
    const cats = state.categories.filter((c) => c.type === type);
    $("txCategory").innerHTML = cats
      .map((c) => `<option value="${c.id}">${esc(c.icon)} ${esc(c.name)}</option>`)
      .join("");
  }
}

function openTxModal(tx = null) {
  const accHtml = state.accounts
    .map((a) => `<option value="${a.id}">${esc(a.icon)} ${esc(a.name)} (${fmtMoney(a.balance)})</option>`)
    .join("");
  $("txAccount").innerHTML = accHtml;
  $("txToAccount").innerHTML = accHtml;
  if (state.accounts.length > 1) {
    $("txToAccount").value = String(state.accounts[1].id);
  }

  if (tx) {
    $("txModalTitle").textContent = "Редактировать операцию";
    $("txId").value = tx.id;
    setTxModalType(tx.type);
    $("txAmount").value = tx.amount;
    if (tx.category_id) $("txCategory").value = String(tx.category_id);
    $("txAccount").value = String(tx.account_id);
    if (tx.to_account_id) $("txToAccount").value = String(tx.to_account_id);
    $("txDate").value = tx.date;
    $("txNote").value = tx.note || "";
    $("btnDeleteTx").classList.remove("hidden");
  } else {
    $("txModalTitle").textContent = "Новая операция";
    $("txId").value = "";
    setTxModalType("expense");
    $("txAmount").value = "";
    $("txDate").value = todayISO();
    $("txNote").value = "";
    $("btnDeleteTx").classList.add("hidden");
  }
  openModal("txModal");
  setTimeout(() => $("txAmount").focus(), 50);
}

function openAccountModal(acc = null) {
  if (acc) {
    $("accModalTitle").textContent = "Редактировать счёт";
    $("accId").value = acc.id;
    $("accName").value = acc.name;
    $("accType").value = acc.type;
    $("accInitial").value = acc.initial_balance;
    $("accIcon").value = acc.icon;
    $("accColor").value = acc.color;
  } else {
    $("accModalTitle").textContent = "Новый счёт";
    $("accId").value = "";
    $("accName").value = "";
    $("accType").value = "card";
    $("accInitial").value = 0;
    $("accIcon").value = "💳";
    $("accColor").value = "#3b82f6";
  }
  openModal("accountModal");
}

function openCategoryModal(cat = null) {
  if (cat) {
    $("catModalTitle").textContent = "Редактировать категорию";
    $("catId").value = cat.id;
    $("catName").value = cat.name;
    $("catType").value = cat.type;
    $("catTypeGroup").classList.add("hidden");
    $("catIcon").value = cat.icon;
    $("catColor").value = cat.color;
    $("catBudget").value = cat.budget_limit;
    $("catBudgetGroup").classList.toggle("hidden", cat.type !== "expense");
  } else {
    $("catModalTitle").textContent = "Новая категория";
    $("catId").value = "";
    $("catName").value = "";
    $("catType").value = "expense";
    $("catTypeGroup").classList.remove("hidden");
    $("catIcon").value = "📦";
    $("catColor").value = "#3b82f6";
    $("catBudget").value = 0;
    $("catBudgetGroup").classList.remove("hidden");
  }
  openModal("categoryModal");
}

function switchTab(tab) {
  state.activeTab = tab;
  $("pageTitle").textContent = TAB_TITLES[tab] || "FinTrack";
  document.querySelectorAll(".nav-item, .mobile-nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((el) => {
    el.classList.toggle("active", el.id === `tab-${tab}`);
  });
  $("periodBar").classList.toggle("hidden", tab === "manage" || tab === "settings");
}

// ---------- Event Listeners ----------
function initEvents() {
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.goto));
  });

  $("btnNewTxSidebar").addEventListener("click", () => openTxModal());
  $("btnNewTxTop").addEventListener("click", () => openTxModal());

  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });

  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.classList.add("hidden");
    });
  });

  // Период
  $("periodPreset").addEventListener("change", async (e) => {
    state.period = e.target.value;
    $("customDates").classList.toggle("hidden", state.period !== "custom");
    if (state.period !== "custom") {
      [state.dateFrom, state.dateTo] = computePeriodDates(state.period);
      await refreshAll();
    }
  });
  $("dateFrom").addEventListener("change", async (e) => {
    state.dateFrom = e.target.value;
    await refreshAll();
  });
  $("dateTo").addEventListener("change", async (e) => {
    state.dateTo = e.target.value;
    await refreshAll();
  });

  // Donut toggle
  document.querySelectorAll("#donutMode .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.donutMode = btn.dataset.mode;
      document.querySelectorAll("#donutMode .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderDonut();
    });
  });

  // Theme
  const toggleTheme = async (targetTheme) => {
    const next = targetTheme || (state.settings.theme === "dark" ? "light" : "dark");
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ theme: next }) });
    state.settings.theme = next;
    applyTheme(next);
  };
  $("btnTheme").addEventListener("click", () => toggleTheme());
  document.querySelectorAll("#themeSegmented .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleTheme(btn.dataset.themeVal));
  });

  // Currency
  $("settingCurrency").addEventListener("change", async (e) => {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ currency: e.target.value }) });
    toast("Валюта обновлена", "success");
    await refreshAll();
  });

  // Filters
  let searchTimer = null;
  $("filterSearch").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.q = e.target.value.trim();
      refreshAll();
    }, 200);
  });
  for (const [id, key] of [
    ["filterType", "type"],
    ["filterCategory", "category_id"],
    ["filterAccount", "account_id"],
    ["filterSort", "sort"],
  ]) {
    $(id).addEventListener("change", (e) => {
      state.filters[key] = e.target.value;
      refreshAll();
    });
  }

  // Click on transaction row
  document.addEventListener("click", (e) => {
    const row = e.target.closest(".tx-row");
    if (row) {
      const tx = state.transactions.find((t) => t.id === Number(row.dataset.txId));
      if (tx) openTxModal(tx);
    }
  });

  // Tx Modal type switch & submit
  document.querySelectorAll("#txTypeSwitch .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => setTxModalType(btn.dataset.txType));
  });

  $("txForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("txId").value;
    const payload = {
      type: currentTxType,
      amount: Number($("txAmount").value),
      category_id: currentTxType === "transfer" ? null : Number($("txCategory").value),
      account_id: Number($("txAccount").value),
      to_account_id: currentTxType === "transfer" ? Number($("txToAccount").value) : null,
      date: $("txDate").value,
      note: $("txNote").value.trim(),
    };
    try {
      if (id) {
        await api(`/api/transactions/${id}`, { method: "PUT", body: JSON.stringify(payload) });
        toast("Операция обновлена", "success");
      } else {
        await api("/api/transactions", { method: "POST", body: JSON.stringify(payload) });
        toast("Операция добавлена", "success");
      }
      closeModal("txModal");
      await refreshAll();
      maybeAutoSync();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("btnDeleteTx").addEventListener("click", async () => {
    const id = $("txId").value;
    if (!id) return;
    try {
      await api(`/api/transactions/${id}`, { method: "DELETE" });
      toast("Операция удалена", "success");
      closeModal("txModal");
      await refreshAll();
      maybeAutoSync();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // Accounts CRUD
  $("btnAddAccount").addEventListener("click", () => openAccountModal());
  $("accountForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("accId").value;
    const payload = {
      name: $("accName").value.trim(),
      type: $("accType").value,
      initial_balance: Number($("accInitial").value || 0),
      icon: $("accIcon").value.trim() || "💳",
      color: $("accColor").value,
    };
    try {
      if (id) {
        await api(`/api/accounts/${id}`, { method: "PUT", body: JSON.stringify(payload) });
        toast("Счёт обновлён", "success");
      } else {
        await api("/api/accounts", { method: "POST", body: JSON.stringify(payload) });
        toast("Счёт создан", "success");
      }
      closeModal("accountModal");
      await refreshAll();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("accountsManageList").addEventListener("click", async (e) => {
    const editBtn = e.target.closest("[data-edit-acc]");
    if (editBtn) {
      const acc = state.accounts.find((a) => a.id === Number(editBtn.dataset.editAcc));
      if (acc) openAccountModal(acc);
      return;
    }
    const delBtn = e.target.closest("[data-del-acc]");
    if (delBtn) {
      try {
        await api(`/api/accounts/${delBtn.dataset.delAcc}`, { method: "DELETE" });
        toast("Счёт удалён", "success");
        await refreshAll();
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });

  // Categories CRUD
  $("btnAddCategory").addEventListener("click", () => openCategoryModal());
  $("catType").addEventListener("change", (e) => {
    $("catBudgetGroup").classList.toggle("hidden", e.target.value !== "expense");
  });
  $("categoryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("catId").value;
    const payload = {
      name: $("catName").value.trim(),
      type: $("catType").value,
      icon: $("catIcon").value.trim() || "📦",
      color: $("catColor").value,
      budget_limit: Number($("catBudget").value || 0),
    };
    try {
      if (id) {
        await api(`/api/categories/${id}`, { method: "PUT", body: JSON.stringify(payload) });
        toast("Категория обновлена", "success");
      } else {
        await api("/api/categories", { method: "POST", body: JSON.stringify(payload) });
        toast("Категория создана", "success");
      }
      closeModal("categoryModal");
      await refreshAll();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("categoriesManageList").addEventListener("click", async (e) => {
    const editBtn = e.target.closest("[data-edit-cat]");
    if (editBtn) {
      const cat = state.categories.find((c) => c.id === Number(editBtn.dataset.editCat));
      if (cat) openCategoryModal(cat);
      return;
    }
    const delBtn = e.target.closest("[data-del-cat]");
    if (delBtn) {
      try {
        await api(`/api/categories/${delBtn.dataset.delCat}`, { method: "DELETE" });
        toast("Категория удалена", "success");
        await refreshAll();
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });

  // Import / Demo / Reset
  $("importJsonInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const res = await api("/api/import/json", { method: "POST", body: JSON.stringify(parsed) });
      toast(`Импортировано операций: ${res.imported.transactions}`, "success");
      await refreshAll();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      e.target.value = "";
    }
  });

  $("btnLoadDemo").addEventListener("click", async () => {
    try {
      const res = await api("/api/demo", { method: "POST" });
      toast(`Добавлено демо-операций: ${res.inserted}`, "success");
      switchTab("dashboard");
      await refreshAll();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("btnResetAll").addEventListener("click", async () => {
    if (!confirm("Удалить все операции и вернуть счета/категории к исходным?")) return;
    try {
      await api("/api/reset", { method: "POST" });
      toast("Данные сброшены", "success");
      await refreshAll();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // Cloud Sync (GitHub Gist)
  function maybeAutoSync() {
    if (state.settings.gist_autosync === "true" && state.settings.gist_token) {
      api("/api/sync/push", { method: "POST" }).catch(() => {});
    }
  }

  $("btnSyncSave").addEventListener("click", async () => {
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          gist_token: $("settingGistToken").value.trim(),
          gist_id: $("settingGistId").value.trim(),
          gist_autosync: $("settingGistAutosync").checked ? "true" : "false",
        }),
      });
      toast("Настройки синхронизации сохранены", "success");
      await refreshAll();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("btnSyncPush").addEventListener("click", async () => {
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          gist_token: $("settingGistToken").value.trim(),
          gist_id: $("settingGistId").value.trim(),
          gist_autosync: $("settingGistAutosync").checked ? "true" : "false",
        }),
      });
      toast("Выгрузка в облако...", "info");
      const res = await api("/api/sync/push", { method: "POST" });
      toast("Успешно выгружено в GitHub Gist", "success");
      if (res.gist_id) $("settingGistId").value = res.gist_id;
      await refreshAll();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("btnSyncPull").addEventListener("click", async () => {
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          gist_token: $("settingGistToken").value.trim(),
          gist_id: $("settingGistId").value.trim(),
          gist_autosync: $("settingGistAutosync").checked ? "true" : "false",
        }),
      });
      toast("Загрузка из облака...", "info");
      const res = await api("/api/sync/pull", { method: "POST" });
      toast(`Загружено операций: ${res.imported.transactions}`, "success");
      await refreshAll();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // Keyboard shortcut: Esc closes modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal-backdrop").forEach((m) => m.classList.add("hidden"));
    }
  });
}

(async function init() {
  [state.dateFrom, state.dateTo] = computePeriodDates("this_month");
  initEvents();
  try {
    await refreshAll();
  } catch (err) {
    toast(`Не удалось загрузить данные: ${err.message}`, "error");
  }
})();

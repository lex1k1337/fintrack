(function () {
  const STORAGE_KEY = "fintrack_android_db_v1";

  const DEFAULT_ACCOUNTS = [
    { id: 1, name: "Основная карта", type: "card", initial_balance: 0, color: "#3b82f6", icon: "💳" },
    { id: 2, name: "Наличные", type: "cash", initial_balance: 0, color: "#10b981", icon: "💵" },
    { id: 3, name: "Накопления", type: "savings", initial_balance: 0, color: "#8b5cf6", icon: "🏦" },
  ];

  const DEFAULT_CATEGORIES = [
    { id: 1, name: "Продукты", type: "expense", icon: "🛒", color: "#10b981", budget_limit: 25000 },
    { id: 2, name: "Кафе и рестораны", type: "expense", icon: "☕", color: "#f59e0b", budget_limit: 10000 },
    { id: 3, name: "Транспорт", type: "expense", icon: "🚕", color: "#3b82f6", budget_limit: 6000 },
    { id: 4, name: "Жильё и ЖКХ", type: "expense", icon: "🏠", color: "#6366f1", budget_limit: 30000 },
    { id: 5, name: "Здоровье", type: "expense", icon: "💊", color: "#ef4444", budget_limit: 5000 },
    { id: 6, name: "Развлечения", type: "expense", icon: "🎬", color: "#ec4899", budget_limit: 8000 },
    { id: 7, name: "Одежда", type: "expense", icon: "👕", color: "#8b5cf6", budget_limit: 10000 },
    { id: 8, name: "Подписки и связь", type: "expense", icon: "📱", color: "#06b6d4", budget_limit: 3000 },
    { id: 9, name: "Прочие расходы", type: "expense", icon: "📦", color: "#64748b", budget_limit: 0 },
    { id: 10, name: "Зарплата", type: "income", icon: "💼", color: "#10b981", budget_limit: 0 },
    { id: 11, name: "Фриланс", type: "income", icon: "💻", color: "#3b82f6", budget_limit: 0 },
    { id: 12, name: "Инвестиции", type: "income", icon: "📈", color: "#8b5cf6", budget_limit: 0 },
    { id: 13, name: "Кэшбэк и проценты", type: "income", icon: "🎁", color: "#f59e0b", budget_limit: 0 },
    { id: 14, name: "Прочие доходы", type: "income", icon: "✨", color: "#06b6d4", budget_limit: 0 },
  ];

  function createInitialDB() {
    return {
      settings: { currency: "₽", theme: "dark" },
      accounts: DEFAULT_ACCOUNTS.map((a) => ({ ...a })),
      categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
      transactions: [],
      nextId: { accounts: 4, categories: 15, transactions: 1 },
    };
  }

  function loadDB() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const init = createInitialDB();
        saveDB(init);
        return init;
      }
      return JSON.parse(raw);
    } catch {
      const init = createInitialDB();
      saveDB(init);
      return init;
    }
  }

  function saveDB(db) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }

  function computeAccounts(db) {
    return db.accounts.map((a) => {
      let delta = 0;
      for (const t of db.transactions) {
        if (t.type === "income" && t.account_id === a.id) delta += t.amount;
        else if (t.type === "expense" && t.account_id === a.id) delta -= t.amount;
        else if (t.type === "transfer") {
          if (t.account_id === a.id) delta -= t.amount;
          if (t.to_account_id === a.id) delta += t.amount;
        }
      }
      return { ...a, balance: Math.round((Number(a.initial_balance || 0) + delta) * 100) / 100 };
    });
  }

  function enrichTx(db, t) {
    const cat = db.categories.find((c) => c.id === t.category_id);
    const acc = db.accounts.find((a) => a.id === t.account_id);
    const toAcc = db.accounts.find((a) => a.id === t.to_account_id);
    return {
      ...t,
      category_name: cat ? cat.name : null,
      category_icon: cat ? cat.icon : null,
      category_color: cat ? cat.color : null,
      account_name: acc ? acc.name : "Счёт",
      account_icon: acc ? acc.icon : "💳",
      to_account_name: toAcc ? toAcc.name : null,
      to_account_icon: toAcc ? toAcc.icon : null,
    };
  }

  function filterTransactions(db, params) {
    let list = db.transactions.map((t) => enrichTx(db, t));
    const type = params.get("type");
    const catId = params.get("category_id");
    const accId = params.get("account_id");
    const from = params.get("from");
    const to = params.get("to");
    const q = (params.get("q") || "").trim().toLowerCase();
    const sort = params.get("sort") || "date_desc";

    if (type) list = list.filter((t) => t.type === type);
    if (catId) list = list.filter((t) => String(t.category_id) === String(catId));
    if (accId) list = list.filter((t) => String(t.account_id) === String(accId) || String(t.to_account_id) === String(accId));
    if (from) list = list.filter((t) => t.date >= from);
    if (to) list = list.filter((t) => t.date <= to);
    if (q) {
      list = list.filter(
        (t) =>
          (t.note || "").toLowerCase().includes(q) ||
          (t.category_name || "").toLowerCase().includes(q) ||
          String(t.amount).includes(q)
      );
    }

    list.sort((a, b) => {
      if (sort === "date_asc") return a.date.localeCompare(b.date) || a.id - b.id;
      if (sort === "amount_desc") return b.amount - a.amount || b.id - a.id;
      if (sort === "amount_asc") return a.amount - b.amount || a.id - b.id;
      return b.date.localeCompare(a.date) || b.id - a.id;
    });
    return list;
  }

  function computeSummary(db, from, to) {
    let txs = db.transactions;
    if (from) txs = txs.filter((t) => t.date >= from);
    if (to) txs = txs.filter((t) => t.date <= to);

    let total_income = 0;
    let total_expense = 0;
    for (const t of txs) {
      if (t.type === "income") total_income += t.amount;
      else if (t.type === "expense") total_expense += t.amount;
    }
    total_income = Math.round(total_income * 100) / 100;
    total_expense = Math.round(total_expense * 100) / 100;
    const net = Math.round((total_income - total_expense) * 100) / 100;
    const savings_rate = total_income > 0 ? Math.round((net / total_income) * 1000) / 10 : 0;

    const expense_by_category = db.categories
      .filter((c) => c.type === "expense")
      .map((c) => {
        const total = txs
          .filter((t) => t.type === "expense" && t.category_id === c.id)
          .reduce((acc, t) => acc + t.amount, 0);
        return { ...c, total: Math.round(total * 100) / 100 };
      })
      .filter((c) => c.total > 0 || c.budget_limit > 0)
      .sort((a, b) => b.total - a.total || a.id - b.id);

    const income_by_category = db.categories
      .filter((c) => c.type === "income")
      .map((c) => {
        const total = txs
          .filter((t) => t.type === "income" && t.category_id === c.id)
          .reduce((acc, t) => acc + t.amount, 0);
        return { ...c, total: Math.round(total * 100) / 100 };
      })
      .filter((c) => c.total > 0)
      .sort((a, b) => b.total - a.total);

    const monthMap = new Map();
    for (const t of db.transactions) {
      if (t.type !== "income" && t.type !== "expense") continue;
      const m = t.date.slice(0, 7);
      if (!monthMap.has(m)) monthMap.set(m, { month: m, income: 0, expense: 0 });
      const entry = monthMap.get(m);
      if (t.type === "income") entry.income += t.amount;
      else entry.expense += t.amount;
    }
    const monthly = Array.from(monthMap.values())
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12)
      .map((m) => ({
        month: m.month,
        income: Math.round(m.income * 100) / 100,
        expense: Math.round(m.expense * 100) / 100,
      }));

    const accounts = computeAccounts(db);
    const total_balance = Math.round(accounts.reduce((s, a) => s + a.balance, 0) * 100) / 100;

    return {
      total_balance,
      total_income,
      total_expense,
      net,
      savings_rate,
      tx_count: txs.length,
      expense_by_category,
      income_by_category,
      monthly,
    };
  }

  function validateTx(db, data) {
    const type = data.type;
    if (!["income", "expense", "transfer"].includes(type)) throw new Error("Некорректный тип операции.");
    const amount = Math.round(Number(data.amount) * 100) / 100;
    if (!amount || amount <= 0) throw new Error("Сумма должна быть больше нуля.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date || "")) throw new Error("Некорректная дата.");
    const account_id = Number(data.account_id);
    if (!db.accounts.some((a) => a.id === account_id)) throw new Error("Счёт не найден.");

    let category_id = null;
    let to_account_id = null;
    if (type === "transfer") {
      to_account_id = Number(data.to_account_id);
      if (!db.accounts.some((a) => a.id === to_account_id)) throw new Error("Счёт зачисления не найден.");
      if (to_account_id === account_id) throw new Error("Счета должны различаться.");
    } else {
      category_id = Number(data.category_id);
      const cat = db.categories.find((c) => c.id === category_id);
      if (!cat || cat.type !== type) throw new Error("Некорректная категория.");
    }
    return {
      type,
      amount,
      category_id,
      account_id,
      to_account_id,
      date: data.date,
      note: String(data.note || "").trim().slice(0, 300),
    };
  }

  function loadDemo(db) {
    const today = new Date();
    const d = (monthsAgo, day) => {
      const dt = new Date(today.getFullYear(), today.getMonth() - monthsAgo, Math.min(day, 28));
      const pad = (n) => String(n).padStart(2, "0");
      return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    };
    const card = db.accounts[0]?.id;
    const cash = db.accounts[1]?.id || card;
    const sav = db.accounts[2]?.id || card;
    const catByName = (n) => db.categories.find((c) => c.name === n)?.id;

    const samples = [
      ["income", 125000, catByName("Зарплата"), card, null, d(0, 5), "Зарплата"],
      ["income", 24000, catByName("Фриланс"), card, null, d(0, 12), "Дизайн проекта"],
      ["expense", 28000, catByName("Жильё и ЖКХ"), card, null, d(0, 2), "Аренда и ЖКХ"],
      ["expense", 6450, catByName("Продукты"), card, null, d(0, 4), "Супермаркет"],
      ["expense", 4200, catByName("Продукты"), cash, null, d(0, 11), "Рынок"],
      ["expense", 2850, catByName("Кафе и рестораны"), card, null, d(0, 7), "Ужин с друзьями"],
      ["expense", 1900, catByName("Транспорт"), card, null, d(0, 9), "Такси и метро"],
      ["transfer", 20000, null, card, sav, d(0, 6), "В резерв"],
      ["income", 125000, catByName("Зарплата"), card, null, d(1, 5), "Зарплата"],
      ["expense", 27500, catByName("Жильё и ЖКХ"), card, null, d(1, 2), "Аренда"],
      ["expense", 18400, catByName("Продукты"), card, null, d(1, 10), "Продукты"],
      ["expense", 7600, catByName("Одежда"), card, null, d(1, 15), "Кроссовки"],
      ["transfer", 15000, null, card, sav, d(1, 8), "Подушка безопасности"],
    ];

    let inserted = 0;
    for (const [type, amount, category_id, account_id, to_account_id, date, note] of samples) {
      if (type !== "transfer" && !category_id) continue;
      db.transactions.push({
        id: db.nextId.transactions++,
        type,
        amount,
        category_id,
        account_id,
        to_account_id,
        date,
        note,
        created_at: new Date().toISOString(),
      });
      inserted++;
    }
    saveDB(db);
    return inserted;
  }

  async function gistRequest(method, url, token, payload) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Ошибка GitHub API (${res.status}): ${data.message || "Неизвестная ошибка"}`);
    }
    return data;
  }

  async function findFinTrackGist(token) {
    const gists = await gistRequest("GET", "https://api.github.com/gists?per_page=30", token);
    const found = gists.find((g) => g.files && g.files["fintrack-backup.json"]);
    return found ? String(found.id) : null;
  }

  async function gistPush(db) {
    const token = (db.settings.gist_token || "").trim();
    if (!token) throw new Error("Укажите GitHub Token в настройках синхронизации.");
    let gistId = (db.settings.gist_id || "").trim() || (await findFinTrackGist(token));
    const body = {
      description: "FinTrack Cloud Backup",
      public: false,
      files: { "fintrack-backup.json": { content: window.LocalFinanceAPI.exportJSON() } },
    };
    let res;
    if (gistId) {
      res = await gistRequest("PATCH", `https://api.github.com/gists/${gistId}`, token, body);
    } else {
      res = await gistRequest("POST", "https://api.github.com/gists", token, body);
      gistId = String(res.id);
      db.settings.gist_id = gistId;
      saveDB(db);
    }
    return { gist_id: gistId, updated_at: res.updated_at };
  }

  async function gistPull(db) {
    const token = (db.settings.gist_token || "").trim();
    if (!token) throw new Error("Укажите GitHub Token в настройках синхронизации.");
    const gistId = (db.settings.gist_id || "").trim() || (await findFinTrackGist(token));
    if (!gistId) {
      throw new Error("Облачный бэкап FinTrack не найден. Сначала выгрузите данные с одного из устройств.");
    }
    const res = await gistRequest("GET", `https://api.github.com/gists/${gistId}`, token);
    const file = res.files && res.files["fintrack-backup.json"];
    if (!file || !file.content) throw new Error("В Gist отсутствует файл fintrack-backup.json.");
    const payload = JSON.parse(file.content);
    const imp = await window.LocalFinanceAPI.handle("/api/import/json", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const freshDb = loadDB();
    freshDb.settings.gist_id = gistId;
    saveDB(freshDb);
    return { gist_id: gistId, imported: imp.imported, updated_at: res.updated_at };
  }

  window.LocalFinanceAPI = {
    async handle(url, options = {}) {
      const method = (options.method || "GET").toUpperCase();
      const [path, queryStr] = url.split("?");
      const params = new URLSearchParams(queryStr || "");
      const body = options.body ? JSON.parse(options.body) : {};
      const db = loadDB();

      if (method === "GET" && path === "/api/bootstrap") {
        return {
          settings: db.settings,
          accounts: computeAccounts(db),
          categories: db.categories,
          summary: computeSummary(db, params.get("from"), params.get("to")),
          transactions: filterTransactions(db, params),
        };
      }
      if (method === "PUT" && path === "/api/settings") {
        if (body.currency !== undefined) db.settings.currency = String(body.currency);
        if (body.theme !== undefined) db.settings.theme = String(body.theme);
        if (body.gist_token !== undefined) db.settings.gist_token = String(body.gist_token).trim();
        if (body.gist_id !== undefined) db.settings.gist_id = String(body.gist_id).trim();
        if (body.gist_autosync !== undefined) db.settings.gist_autosync = String(body.gist_autosync);
        saveDB(db);
        return db.settings;
      }
      if (method === "POST" && path === "/api/transactions") {
        const clean = validateTx(db, body);
        const tx = { id: db.nextId.transactions++, ...clean, created_at: new Date().toISOString() };
        db.transactions.push(tx);
        saveDB(db);
        return enrichTx(db, tx);
      }
      if (method === "PUT" && path.startsWith("/api/transactions/")) {
        const id = Number(path.split("/").pop());
        const idx = db.transactions.findIndex((t) => t.id === id);
        if (idx === -1) throw new Error("Операция не найдена.");
        const clean = validateTx(db, body);
        db.transactions[idx] = { ...db.transactions[idx], ...clean };
        saveDB(db);
        return enrichTx(db, db.transactions[idx]);
      }
      if (method === "DELETE" && path.startsWith("/api/transactions/")) {
        const id = Number(path.split("/").pop());
        db.transactions = db.transactions.filter((t) => t.id !== id);
        saveDB(db);
        return { deleted: true };
      }
      if (method === "POST" && path === "/api/accounts") {
        const name = String(body.name || "").trim();
        if (!name) throw new Error("Название счёта не может быть пустым.");
        const acc = {
          id: db.nextId.accounts++,
          name,
          type: body.type || "card",
          initial_balance: Number(body.initial_balance || 0),
          icon: body.icon || "💳",
          color: body.color || "#3b82f6",
        };
        db.accounts.push(acc);
        saveDB(db);
        return acc;
      }
      if (method === "PUT" && path.startsWith("/api/accounts/")) {
        const id = Number(path.split("/").pop());
        const acc = db.accounts.find((a) => a.id === id);
        if (!acc) throw new Error("Счёт не найден.");
        acc.name = String(body.name || acc.name).trim();
        acc.type = body.type || acc.type;
        acc.initial_balance = Number(body.initial_balance ?? acc.initial_balance);
        acc.icon = body.icon || acc.icon;
        acc.color = body.color || acc.color;
        saveDB(db);
        return acc;
      }
      if (method === "DELETE" && path.startsWith("/api/accounts/")) {
        const id = Number(path.split("/").pop());
        if (db.transactions.some((t) => t.account_id === id || t.to_account_id === id)) {
          throw new Error("Нельзя удалить счёт с операциями.");
        }
        if (db.accounts.length <= 1) throw new Error("Должен остаться хотя бы один счёт.");
        db.accounts = db.accounts.filter((a) => a.id !== id);
        saveDB(db);
        return { deleted: true };
      }
      if (method === "POST" && path === "/api/categories") {
        const name = String(body.name || "").trim();
        if (!name) throw new Error("Название категории не может быть пустым.");
        const cat = {
          id: db.nextId.categories++,
          name,
          type: body.type === "income" ? "income" : "expense",
          icon: body.icon || "📦",
          color: body.color || "#64748b",
          budget_limit: Math.max(0, Number(body.budget_limit || 0)),
        };
        db.categories.push(cat);
        saveDB(db);
        return cat;
      }
      if (method === "PUT" && path.startsWith("/api/categories/")) {
        const id = Number(path.split("/").pop());
        const cat = db.categories.find((c) => c.id === id);
        if (!cat) throw new Error("Категория не найдена.");
        cat.name = String(body.name || cat.name).trim();
        cat.icon = body.icon || cat.icon;
        cat.color = body.color || cat.color;
        cat.budget_limit = Math.max(0, Number(body.budget_limit ?? cat.budget_limit));
        saveDB(db);
        return cat;
      }
      if (method === "DELETE" && path.startsWith("/api/categories/")) {
        const id = Number(path.split("/").pop());
        if (db.transactions.some((t) => t.category_id === id)) {
          throw new Error("Нельзя удалить категорию, используемую в операциях.");
        }
        db.categories = db.categories.filter((c) => c.id !== id);
        saveDB(db);
        return { deleted: true };
      }
      if (method === "POST" && path === "/api/demo") {
        return { inserted: loadDemo(db) };
      }
      if (method === "POST" && path === "/api/reset") {
        const fresh = createInitialDB();
        saveDB(fresh);
        return { ok: true };
      }
      if (method === "POST" && path === "/api/import/json") {
        if (!Array.isArray(body.accounts) || !Array.isArray(body.categories) || !Array.isArray(body.transactions)) {
          throw new Error("Некорректный формат JSON-бэкапа.");
        }
        const maxId = (arr) => arr.reduce((m, x) => Math.max(m, Number(x.id || 0)), 0) + 1;
        const mergedSettings = {
          ...(body.settings || {}),
          currency: body.settings?.currency || db.settings.currency,
          theme: body.settings?.theme || db.settings.theme,
          gist_token: db.settings.gist_token || "",
          gist_id: db.settings.gist_id || "",
          gist_autosync: db.settings.gist_autosync || "false",
        };
        const imported = {
          settings: mergedSettings,
          accounts: body.accounts,
          categories: body.categories,
          transactions: body.transactions,
          nextId: {
            accounts: maxId(body.accounts),
            categories: maxId(body.categories),
            transactions: maxId(body.transactions),
          },
        };
        saveDB(imported);
        return { imported: { transactions: body.transactions.length } };
      }
      if (method === "POST" && path === "/api/sync/push") {
        return await gistPush(db);
      }
      if (method === "POST" && path === "/api/sync/pull") {
        return await gistPull(db);
      }
      throw new Error("Неизвестный запрос: " + path);
    },

    exportJSON() {
      const db = loadDB();
      return JSON.stringify(
        {
          version: 1,
          exported_at: new Date().toISOString(),
          settings: { currency: db.settings.currency, theme: db.settings.theme },
          accounts: db.accounts,
          categories: db.categories,
          transactions: db.transactions,
        },
        null,
        2
      );
    },

    exportCSV() {
      const db = loadDB();
      const txs = filterTransactions(db, new URLSearchParams("sort=date_desc"));
      const typeLabels = { income: "Доход", expense: "Расход", transfer: "Перевод" };
      const lines = ["ID;Дата;Тип;Сумма;Категория;Счёт;Счёт зачисления;Комментарий"];
      for (const t of txs) {
        const row = [
          t.id,
          t.date,
          typeLabels[t.type] || t.type,
          t.amount.toFixed(2),
          t.category_name || "Перевод",
          t.account_name,
          t.to_account_name || "",
          (t.note || "").replaceAll(";", ","),
        ];
        lines.push(row.join(";"));
      }
      return "\ufeff" + lines.join("\n");
    },
  };
})();

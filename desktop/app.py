#!/usr/bin/env python3
"""
FinTrack — локальное веб-приложение для учёта личных финансов.
Запуск: python app.py [--port 8000] [--db finance.db] [--no-browser]
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import mimetypes
import os
import re
import sqlite3
import sys
import threading
import urllib.parse
import webbrowser
from contextlib import contextmanager
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

if getattr(sys, "frozen", False):
    RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    BASE_DIR = Path(sys.executable).resolve().parent
else:
    RESOURCE_DIR = Path(__file__).resolve().parent
    BASE_DIR = RESOURCE_DIR

STATIC_DIR = RESOURCE_DIR / "static"
DEFAULT_DB_PATH = BASE_DIR / "finance.db"

DEFAULT_ACCOUNTS = [
    ("Основная карта", "card", 0.0, "#3b82f6", "💳"),
    ("Наличные", "cash", 0.0, "#10b981", "💵"),
    ("Накопления", "savings", 0.0, "#8b5cf6", "🏦"),
]

DEFAULT_CATEGORIES = [
    # Расходы
    ("Продукты", "expense", "🛒", "#10b981", 25000.0),
    ("Кафе и рестораны", "expense", "☕", "#f59e0b", 10000.0),
    ("Транспорт", "expense", "🚕", "#3b82f6", 6000.0),
    ("Жильё и ЖКХ", "expense", "🏠", "#6366f1", 30000.0),
    ("Здоровье", "expense", "💊", "#ef4444", 5000.0),
    ("Развлечения", "expense", "🎬", "#ec4899", 8000.0),
    ("Одежда", "expense", "👕", "#8b5cf6", 10000.0),
    ("Подписки и связь", "expense", "📱", "#06b6d4", 3000.0),
    ("Прочие расходы", "expense", "📦", "#64748b", 0.0),
    # Доходы
    ("Зарплата", "income", "💼", "#10b981", 0.0),
    ("Фриланс", "income", "💻", "#3b82f6", 0.0),
    ("Инвестиции", "income", "📈", "#8b5cf6", 0.0),
    ("Кэшбэк и проценты", "income", "🎁", "#f59e0b", 0.0),
    ("Прочие доходы", "income", "✨", "#06b6d4", 0.0),
]

DEFAULT_SETTINGS = {
    "currency": "₽",
    "theme": "dark",
}


class FinanceDB:
    """Обёртка над SQLite для управления счетами, категориями, операциями и настройками."""

    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self._lock = threading.RLock()
        self.init_db()

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_db(self) -> None:
        with self._lock, self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL DEFAULT 'card',
                    initial_balance REAL NOT NULL DEFAULT 0,
                    color TEXT NOT NULL DEFAULT '#3b82f6',
                    icon TEXT NOT NULL DEFAULT '💳',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
                    icon TEXT NOT NULL DEFAULT '📦',
                    color TEXT NOT NULL DEFAULT '#64748b',
                    budget_limit REAL NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT NOT NULL CHECK(type IN ('income', 'expense', 'transfer')),
                    amount REAL NOT NULL CHECK(amount > 0),
                    category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
                    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
                    to_account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
                    date TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date DESC);
                CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )
            self._seed_defaults(conn)

    def _seed_defaults(self, conn: sqlite3.Connection) -> None:
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        if conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO accounts (name, type, initial_balance, color, icon, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                [(n, t, b, c, i, now) for (n, t, b, c, i) in DEFAULT_ACCOUNTS],
            )
        if conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO categories (name, type, icon, color, budget_limit) VALUES (?, ?, ?, ?, ?)",
                DEFAULT_CATEGORIES,
            )
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                (key, value),
            )

    # ---------- Settings ----------
    def get_settings(self) -> dict[str, str]:
        with self._lock, self._connect() as conn:
            rows = conn.execute("SELECT key, value FROM settings").fetchall()
            return {r["key"]: r["value"] for r in rows}

    def update_settings(self, updates: dict[str, Any]) -> dict[str, str]:
        allowed = {"currency", "theme"}
        with self._lock, self._connect() as conn:
            for k, v in updates.items():
                if k in allowed and v is not None:
                    conn.execute(
                        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (k, str(v).strip()[:16]),
                    )
        return self.get_settings()

    # ---------- Accounts ----------
    def list_accounts(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    a.id, a.name, a.type, a.initial_balance, a.color, a.icon, a.created_at,
                    COALESCE((
                        SELECT SUM(
                            CASE
                                WHEN t.type = 'income' AND t.account_id = a.id THEN t.amount
                                WHEN t.type = 'expense' AND t.account_id = a.id THEN -t.amount
                                WHEN t.type = 'transfer' AND t.account_id = a.id THEN -t.amount
                                WHEN t.type = 'transfer' AND t.to_account_id = a.id THEN t.amount
                                ELSE 0
                            END
                        )
                        FROM transactions t
                        WHERE t.account_id = a.id OR t.to_account_id = a.id
                    ), 0) AS tx_delta
                FROM accounts a
                ORDER BY a.id ASC
                """
            ).fetchall()
            result = []
            for r in rows:
                item = dict(r)
                item["balance"] = round(float(item["initial_balance"]) + float(item["tx_delta"]), 2)
                del item["tx_delta"]
                result.append(item)
            return result

    def create_account(self, data: dict[str, Any]) -> dict[str, Any]:
        name = str(data.get("name", "")).strip()
        if not name:
            raise ValueError("Название счёта не может быть пустым.")
        acc_type = str(data.get("type", "card"))
        if acc_type not in {"card", "cash", "savings", "other"}:
            acc_type = "card"
        initial_balance = float(data.get("initial_balance", 0) or 0)
        color = str(data.get("color", "#3b82f6"))[:20]
        icon = str(data.get("icon", "💳"))[:8]
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO accounts (name, type, initial_balance, color, icon, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (name, acc_type, initial_balance, color, icon, now),
            )
            acc_id = cur.lastrowid
        return next(a for a in self.list_accounts() if a["id"] == acc_id)

    def update_account(self, acc_id: int, data: dict[str, Any]) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM accounts WHERE id = ?", (acc_id,)).fetchone()
            if not row:
                raise LookupError("Счёт не найден.")
            name = str(data.get("name", row["name"])).strip()
            if not name:
                raise ValueError("Название счёта не может быть пустым.")
            acc_type = str(data.get("type", row["type"]))
            if acc_type not in {"card", "cash", "savings", "other"}:
                acc_type = row["type"]
            initial_balance = float(data.get("initial_balance", row["initial_balance"]))
            color = str(data.get("color", row["color"]))[:20]
            icon = str(data.get("icon", row["icon"]))[:8]
            conn.execute(
                "UPDATE accounts SET name = ?, type = ?, initial_balance = ?, color = ?, icon = ? WHERE id = ?",
                (name, acc_type, initial_balance, color, icon, acc_id),
            )
        return next(a for a in self.list_accounts() if a["id"] == acc_id)

    def delete_account(self, acc_id: int) -> None:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT id FROM accounts WHERE id = ?", (acc_id,)).fetchone()
            if not row:
                raise LookupError("Счёт не найден.")
            used = conn.execute(
                "SELECT COUNT(*) FROM transactions WHERE account_id = ? OR to_account_id = ?",
                (acc_id, acc_id),
            ).fetchone()[0]
            if used > 0:
                raise ValueError("Нельзя удалить счёт, по которому есть операции.")
            total = conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
            if total <= 1:
                raise ValueError("Должен остаться хотя бы один счёт.")
            conn.execute("DELETE FROM accounts WHERE id = ?", (acc_id,))

    # ---------- Categories ----------
    def list_categories(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT id, name, type, icon, color, budget_limit FROM categories ORDER BY type DESC, id ASC"
            ).fetchall()
            return [dict(r) for r in rows]

    def create_category(self, data: dict[str, Any]) -> dict[str, Any]:
        name = str(data.get("name", "")).strip()
        if not name:
            raise ValueError("Название категории не может быть пустым.")
        cat_type = str(data.get("type", "expense"))
        if cat_type not in {"income", "expense"}:
            raise ValueError("Некорректный тип категории.")
        icon = str(data.get("icon", "📦"))[:8]
        color = str(data.get("color", "#64748b"))[:20]
        budget_limit = max(0.0, float(data.get("budget_limit", 0) or 0))
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO categories (name, type, icon, color, budget_limit) VALUES (?, ?, ?, ?, ?)",
                (name, cat_type, icon, color, budget_limit),
            )
            cat_id = cur.lastrowid
            row = conn.execute("SELECT * FROM categories WHERE id = ?", (cat_id,)).fetchone()
            return dict(row)

    def update_category(self, cat_id: int, data: dict[str, Any]) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM categories WHERE id = ?", (cat_id,)).fetchone()
            if not row:
                raise LookupError("Категория не найдена.")
            name = str(data.get("name", row["name"])).strip()
            if not name:
                raise ValueError("Название категории не может быть пустым.")
            icon = str(data.get("icon", row["icon"]))[:8]
            color = str(data.get("color", row["color"]))[:20]
            budget_limit = max(0.0, float(data.get("budget_limit", row["budget_limit"]) or 0))
            conn.execute(
                "UPDATE categories SET name = ?, icon = ?, color = ?, budget_limit = ? WHERE id = ?",
                (name, icon, color, budget_limit, cat_id),
            )
            updated = conn.execute("SELECT * FROM categories WHERE id = ?", (cat_id,)).fetchone()
            return dict(updated)

    def delete_category(self, cat_id: int) -> None:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT id FROM categories WHERE id = ?", (cat_id,)).fetchone()
            if not row:
                raise LookupError("Категория не найдена.")
            used = conn.execute(
                "SELECT COUNT(*) FROM transactions WHERE category_id = ?", (cat_id,)
            ).fetchone()[0]
            if used > 0:
                raise ValueError("Нельзя удалить категорию, используемую в операциях.")
            conn.execute("DELETE FROM categories WHERE id = ?", (cat_id,))

    # ---------- Transactions ----------
    def _validate_tx_payload(self, conn: sqlite3.Connection, data: dict[str, Any]) -> tuple[str, float, int | None, int, int | None, str, str]:
        tx_type = str(data.get("type", "expense"))
        if tx_type not in {"income", "expense", "transfer"}:
            raise ValueError("Тип операции должен быть income, expense или transfer.")

        try:
            amount = round(float(data.get("amount", 0)), 2)
        except (TypeError, ValueError):
            raise ValueError("Некорректная сумма.")
        if amount <= 0:
            raise ValueError("Сумма должна быть больше нуля.")

        date_str = str(data.get("date", "")).strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_str):
            raise ValueError("Дата должна быть в формате ГГГГ-ММ-ДД.")
        try:
            dt.date.fromisoformat(date_str)
        except ValueError:
            raise ValueError("Некорректная календарная дата.")

        account_id = data.get("account_id")
        if account_id is None:
            raise ValueError("Укажите счёт.")
        account_id = int(account_id)
        if not conn.execute("SELECT 1 FROM accounts WHERE id = ?", (account_id,)).fetchone():
            raise ValueError("Выбранный счёт не существует.")

        category_id = data.get("category_id")
        to_account_id = data.get("to_account_id")

        if tx_type == "transfer":
            category_id = None
            if to_account_id is None:
                raise ValueError("Укажите счёт зачисления для перевода.")
            to_account_id = int(to_account_id)
            if to_account_id == account_id:
                raise ValueError("Счета списания и зачисления должны различаться.")
            if not conn.execute("SELECT 1 FROM accounts WHERE id = ?", (to_account_id,)).fetchone():
                raise ValueError("Счёт зачисления не существует.")
        else:
            to_account_id = None
            if category_id is None:
                raise ValueError("Выберите категорию.")
            category_id = int(category_id)
            cat = conn.execute("SELECT type FROM categories WHERE id = ?", (category_id,)).fetchone()
            if not cat:
                raise ValueError("Выбранная категория не существует.")
            if cat["type"] != tx_type:
                raise ValueError("Тип категории не соответствует типу операции.")

        note = str(data.get("note", "") or "").strip()[:300]
        return tx_type, amount, category_id, account_id, to_account_id, date_str, note

    def list_transactions(self, filters: dict[str, str] | None = None) -> list[dict[str, Any]]:
        filters = filters or {}
        clauses = []
        params: list[Any] = []

        if filters.get("type") in {"income", "expense", "transfer"}:
            clauses.append("t.type = ?")
            params.append(filters["type"])
        if filters.get("category_id"):
            clauses.append("t.category_id = ?")
            params.append(int(filters["category_id"]))
        if filters.get("account_id"):
            acc_id = int(filters["account_id"])
            clauses.append("(t.account_id = ? OR t.to_account_id = ?)")
            params.extend([acc_id, acc_id])
        if filters.get("from"):
            clauses.append("t.date >= ?")
            params.append(filters["from"])
        if filters.get("to"):
            clauses.append("t.date <= ?")
            params.append(filters["to"])
        if filters.get("q"):
            q = f"%{filters['q'].strip().lower()}%"
            clauses.append("(LOWER(t.note) LIKE ? OR LOWER(COALESCE(c.name, '')) LIKE ? OR CAST(t.amount AS TEXT) LIKE ?)")
            params.extend([q, q, q])

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sort_map = {
            "date_desc": "t.date DESC, t.id DESC",
            "date_asc": "t.date ASC, t.id ASC",
            "amount_desc": "t.amount DESC, t.id DESC",
            "amount_asc": "t.amount ASC, t.id ASC",
        }
        order_sql = sort_map.get(filters.get("sort", "date_desc"), "t.date DESC, t.id DESC")

        sql = f"""
            SELECT
                t.id, t.type, t.amount, t.category_id, t.account_id, t.to_account_id,
                t.date, t.note, t.created_at,
                c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
                a.name AS account_name, a.icon AS account_icon,
                ta.name AS to_account_name, ta.icon AS to_account_icon
            FROM transactions t
            LEFT JOIN categories c ON c.id = t.category_id
            JOIN accounts a ON a.id = t.account_id
            LEFT JOIN accounts ta ON ta.id = t.to_account_id
            {where_sql}
            ORDER BY {order_sql}
        """
        with self._lock, self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
            return [dict(r) for r in rows]

    def create_transaction(self, data: dict[str, Any]) -> dict[str, Any]:
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            tx_type, amount, category_id, account_id, to_account_id, date_str, note = self._validate_tx_payload(conn, data)
            cur = conn.execute(
                """
                INSERT INTO transactions (type, amount, category_id, account_id, to_account_id, date, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (tx_type, amount, category_id, account_id, to_account_id, date_str, note, now),
            )
            tx_id = cur.lastrowid
        return self._get_transaction(tx_id)

    def _get_transaction(self, tx_id: int) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                """
                SELECT
                    t.id, t.type, t.amount, t.category_id, t.account_id, t.to_account_id,
                    t.date, t.note, t.created_at,
                    c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
                    a.name AS account_name, a.icon AS account_icon,
                    ta.name AS to_account_name, ta.icon AS to_account_icon
                FROM transactions t
                LEFT JOIN categories c ON c.id = t.category_id
                JOIN accounts a ON a.id = t.account_id
                LEFT JOIN accounts ta ON ta.id = t.to_account_id
                WHERE t.id = ?
                """,
                (tx_id,),
            ).fetchone()
            if not row:
                raise LookupError("Операция не найдена.")
            return dict(row)

    def update_transaction(self, tx_id: int, data: dict[str, Any]) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            existing = conn.execute("SELECT id FROM transactions WHERE id = ?", (tx_id,)).fetchone()
            if not existing:
                raise LookupError("Операция не найдена.")
            tx_type, amount, category_id, account_id, to_account_id, date_str, note = self._validate_tx_payload(conn, data)
            conn.execute(
                """
                UPDATE transactions
                SET type = ?, amount = ?, category_id = ?, account_id = ?, to_account_id = ?, date = ?, note = ?
                WHERE id = ?
                """,
                (tx_type, amount, category_id, account_id, to_account_id, date_str, note, tx_id),
            )
        return self._get_transaction(tx_id)

    def delete_transaction(self, tx_id: int) -> None:
        with self._lock, self._connect() as conn:
            cur = conn.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))
            if cur.rowcount == 0:
                raise LookupError("Операция не найдена.")

    # ---------- Summary & Analytics ----------
    def get_summary(self, date_from: str | None = None, date_to: str | None = None) -> dict[str, Any]:
        clauses = []
        params: list[Any] = []
        if date_from:
            clauses.append("t.date >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("t.date <= ?")
            params.append(date_to)
        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""

        with self._lock, self._connect() as conn:
            totals_row = conn.execute(
                f"""
                SELECT
                    COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END), 0) AS total_income,
                    COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) AS total_expense,
                    COUNT(*) AS tx_count
                FROM transactions t
                {where_sql}
                """,
                params,
            ).fetchone()

            total_income = round(float(totals_row["total_income"]), 2)
            total_expense = round(float(totals_row["total_expense"]), 2)
            net = round(total_income - total_expense, 2)
            savings_rate = round((net / total_income * 100), 1) if total_income > 0 else 0.0

            expense_by_cat = [
                dict(r)
                for r in conn.execute(
                    f"""
                    SELECT c.id, c.name, c.icon, c.color, c.budget_limit,
                           ROUND(COALESCE(SUM(t.amount), 0), 2) AS total
                    FROM categories c
                    LEFT JOIN transactions t ON t.category_id = c.id AND t.type = 'expense'
                        {"AND " + " AND ".join(clauses) if clauses else ""}
                    WHERE c.type = 'expense'
                    GROUP BY c.id
                    HAVING total > 0 OR c.budget_limit > 0
                    ORDER BY total DESC, c.id ASC
                    """,
                    params,
                ).fetchall()
            ]

            income_by_cat = [
                dict(r)
                for r in conn.execute(
                    f"""
                    SELECT c.id, c.name, c.icon, c.color,
                           ROUND(COALESCE(SUM(t.amount), 0), 2) AS total
                    FROM categories c
                    JOIN transactions t ON t.category_id = c.id AND t.type = 'income'
                        {"AND " + " AND ".join(clauses) if clauses else ""}
                    WHERE c.type = 'income'
                    GROUP BY c.id
                    ORDER BY total DESC
                    """,
                    params,
                ).fetchall()
            ]

            monthly_rows = conn.execute(
                """
                SELECT
                    SUBSTR(date, 1, 7) AS month,
                    ROUND(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 2) AS income,
                    ROUND(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 2) AS expense
                FROM transactions
                WHERE type IN ('income', 'expense')
                GROUP BY SUBSTR(date, 1, 7)
                ORDER BY month DESC
                LIMIT 12
                """
            ).fetchall()
            monthly = [dict(r) for r in reversed(monthly_rows)]

        accounts = self.list_accounts()
        total_balance = round(sum(a["balance"] for a in accounts), 2)

        return {
            "total_balance": total_balance,
            "total_income": total_income,
            "total_expense": total_expense,
            "net": net,
            "savings_rate": savings_rate,
            "tx_count": int(totals_row["tx_count"]),
            "expense_by_category": expense_by_cat,
            "income_by_category": income_by_cat,
            "monthly": monthly,
        }

    # ---------- Export / Import / Demo ----------
    def export_json(self) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            return {
                "version": 1,
                "exported_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "settings": self.get_settings(),
                "accounts": [dict(r) for r in conn.execute("SELECT * FROM accounts ORDER BY id").fetchall()],
                "categories": [dict(r) for r in conn.execute("SELECT * FROM categories ORDER BY id").fetchall()],
                "transactions": [dict(r) for r in conn.execute("SELECT * FROM transactions ORDER BY id").fetchall()],
            }

    def import_json(self, payload: dict[str, Any]) -> dict[str, int]:
        if not isinstance(payload, dict) or "transactions" not in payload or "accounts" not in payload or "categories" not in payload:
            raise ValueError("Некорректный формат JSON-бэкапа.")
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM transactions")
            conn.execute("DELETE FROM categories")
            conn.execute("DELETE FROM accounts")

            for a in payload["accounts"]:
                conn.execute(
                    "INSERT INTO accounts (id, name, type, initial_balance, color, icon, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        int(a["id"]),
                        str(a["name"]),
                        str(a.get("type", "card")),
                        float(a.get("initial_balance", 0)),
                        str(a.get("color", "#3b82f6")),
                        str(a.get("icon", "💳")),
                        str(a.get("created_at", now)),
                    ),
                )
            for c in payload["categories"]:
                conn.execute(
                    "INSERT INTO categories (id, name, type, icon, color, budget_limit) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        int(c["id"]),
                        str(c["name"]),
                        str(c["type"]),
                        str(c.get("icon", "📦")),
                        str(c.get("color", "#64748b")),
                        float(c.get("budget_limit", 0)),
                    ),
                )
            for t in payload["transactions"]:
                conn.execute(
                    "INSERT INTO transactions (id, type, amount, category_id, account_id, to_account_id, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        int(t["id"]),
                        str(t["type"]),
                        float(t["amount"]),
                        t.get("category_id"),
                        int(t["account_id"]),
                        t.get("to_account_id"),
                        str(t["date"]),
                        str(t.get("note", "")),
                        str(t.get("created_at", now)),
                    ),
                )
            if isinstance(payload.get("settings"), dict):
                for k, v in payload["settings"].items():
                    if k in {"currency", "theme"}:
                        conn.execute(
                            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                            (k, str(v)),
                        )
        return {
            "accounts": len(payload["accounts"]),
            "categories": len(payload["categories"]),
            "transactions": len(payload["transactions"]),
        }

    def export_csv(self) -> str:
        txs = self.list_transactions({"sort": "date_desc"})
        buf = io.StringIO()
        # BOM для корректного открытия кириллицы в Excel
        buf.write("\ufeff")
        writer = csv.writer(buf, delimiter=";")
        writer.writerow(["ID", "Дата", "Тип", "Сумма", "Категория", "Счёт", "Счёт зачисления", "Комментарий"])
        type_labels = {"income": "Доход", "expense": "Расход", "transfer": "Перевод"}
        for t in txs:
            writer.writerow(
                [
                    t["id"],
                    t["date"],
                    type_labels.get(t["type"], t["type"]),
                    f"{t['amount']:.2f}",
                    t["category_name"] or "Перевод",
                    t["account_name"],
                    t["to_account_name"] or "",
                    t["note"],
                ]
            )
        return buf.getvalue()

    def load_demo_data(self) -> int:
        """Добавляет реалистичные операции за последние 3 месяца."""
        today = dt.date.today()
        with self._lock, self._connect() as conn:
            accounts = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM accounts").fetchall()}
            cats = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM categories").fetchall()}
            if not accounts or not cats:
                raise ValueError("Нет базовых счетов или категорий.")

            card_id = accounts.get("Основная карта") or next(iter(accounts.values()))
            cash_id = accounts.get("Наличные") or card_id
            sav_id = accounts.get("Накопления") or card_id

            def d(months_ago: int, day: int) -> str:
                y = today.year
                m = today.month - months_ago
                while m <= 0:
                    m += 12
                    y -= 1
                day_clamped = min(day, 28)
                return dt.date(y, m, day_clamped).isoformat()

            samples = [
                # Текущий месяц
                ("income", 125000, cats.get("Зарплата"), card_id, None, d(0, 5), "Аванс и основная часть"),
                ("income", 24000, cats.get("Фриланс"), card_id, None, d(0, 12), "Дизайн лендинга"),
                ("income", 1850, cats.get("Кэшбэк и проценты"), card_id, None, d(0, 15), "Кэшбэк за месяц"),
                ("expense", 28000, cats.get("Жильё и ЖКХ"), card_id, None, d(0, 2), "Аренда и коммунальные"),
                ("expense", 6450, cats.get("Продукты"), card_id, None, d(0, 4), "Супермаркет на неделю"),
                ("expense", 4200, cats.get("Продукты"), cash_id, None, d(0, 11), "Фермерский рынок"),
                ("expense", 5100, cats.get("Продукты"), card_id, None, d(0, 18), "Доставка продуктов"),
                ("expense", 2850, cats.get("Кафе и рестораны"), card_id, None, d(0, 7), "Ужин с друзьями"),
                ("expense", 950, cats.get("Кафе и рестораны"), cash_id, None, d(0, 14), "Кофе и десерт"),
                ("expense", 1900, cats.get("Транспорт"), card_id, None, d(0, 9), "Такси и метро"),
                ("expense", 1490, cats.get("Подписки и связь"), card_id, None, d(0, 3), "Интернет и музыка"),
                ("expense", 3200, cats.get("Развлечения"), card_id, None, d(0, 16), "Кино и настольные игры"),
                ("transfer", 20000, None, card_id, sav_id, d(0, 6), "Отложено в резерв"),
                # Прошлый месяц
                ("income", 125000, cats.get("Зарплата"), card_id, None, d(1, 5), "Зарплата"),
                ("income", 15000, cats.get("Фриланс"), card_id, None, d(1, 20), "Консультация"),
                ("expense", 27500, cats.get("Жильё и ЖКХ"), card_id, None, d(1, 2), "Аренда и счётчики"),
                ("expense", 18400, cats.get("Продукты"), card_id, None, d(1, 10), "Продукты за месяц"),
                ("expense", 7600, cats.get("Одежда"), card_id, None, d(1, 15), "Кроссовки"),
                ("expense", 4300, cats.get("Кафе и рестораны"), card_id, None, d(1, 21), "Ресторан"),
                ("expense", 3100, cats.get("Здоровье"), card_id, None, d(1, 18), "Аптека и витамины"),
                ("expense", 2400, cats.get("Транспорт"), card_id, None, d(1, 12), "Проездной и такси"),
                ("transfer", 15000, None, card_id, sav_id, d(1, 8), "Пополнение подушки"),
                # 2 месяца назад
                ("income", 120000, cats.get("Зарплата"), card_id, None, d(2, 5), "Зарплата"),
                ("expense", 27200, cats.get("Жильё и ЖКХ"), card_id, None, d(2, 2), "Жильё и интернет"),
                ("expense", 19200, cats.get("Продукты"), card_id, None, d(2, 14), "Продукты"),
                ("expense", 5800, cats.get("Развлечения"), card_id, None, d(2, 19), "Концерт"),
                ("expense", 3900, cats.get("Кафе и рестораны"), card_id, None, d(2, 23), "Кофейни и обеды"),
                ("transfer", 10000, None, card_id, sav_id, d(2, 7), "В копилку"),
            ]
            now = dt.datetime.now(dt.timezone.utc).isoformat()
            inserted = 0
            for tx_type, amount, cat_id, acc_id, to_acc_id, date_str, note in samples:
                if tx_type != "transfer" and not cat_id:
                    continue
                conn.execute(
                    """
                    INSERT INTO transactions (type, amount, category_id, account_id, to_account_id, date, note, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (tx_type, amount, cat_id, acc_id, to_acc_id, date_str, note, now),
                )
                inserted += 1
            return inserted

    def reset_all(self) -> None:
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM transactions")
            conn.execute("DELETE FROM categories")
            conn.execute("DELETE FROM accounts")
            self._seed_defaults(conn)


def make_handler(db: FinanceDB, static_dir: Path):
    class FinanceHandler(BaseHTTPRequestHandler):
        server_version = "FinTrack/1.0"

        def log_message(self, format: str, *args: Any) -> None:
            # Тихий лог в stderr только при необходимости
            pass

        def _send_json(self, status: int, data: Any) -> None:
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_error_json(self, status: int, message: str) -> None:
            self._send_json(status, {"error": message})

        def _read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length > 5 * 1024 * 1024:
                raise ValueError("Слишком большой запрос.")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                raise ValueError("Некорректный JSON.")
            if not isinstance(data, dict):
                raise ValueError("Ожидался JSON-объект.")
            return data

        def _serve_static(self, rel_path: str) -> None:
            if rel_path in ("", "/"):
                rel_path = "index.html"
            else:
                rel_path = rel_path.lstrip("/")
            target = (static_dir / rel_path).resolve()
            if not str(target).startswith(str(static_dir.resolve())) or not target.is_file():
                self.send_error(HTTPStatus.NOT_FOUND, "Not found")
                return
            mime, _ = mimetypes.guess_type(str(target))
            if target.suffix == ".js":
                mime = "application/javascript; charset=utf-8"
            elif target.suffix == ".css":
                mime = "text/css; charset=utf-8"
            elif target.suffix == ".html":
                mime = "text/html; charset=utf-8"
            content = target.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mime or "application/octet-stream")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}

            if not path.startswith("/api/"):
                self._serve_static(path)
                return

            try:
                if path == "/api/bootstrap":
                    self._send_json(
                        200,
                        {
                            "settings": db.get_settings(),
                            "accounts": db.list_accounts(),
                            "categories": db.list_categories(),
                            "summary": db.get_summary(query.get("from"), query.get("to")),
                            "transactions": db.list_transactions(query),
                        },
                    )
                elif path == "/api/summary":
                    self._send_json(200, db.get_summary(query.get("from"), query.get("to")))
                elif path == "/api/transactions":
                    self._send_json(200, db.list_transactions(query))
                elif path == "/api/accounts":
                    self._send_json(200, db.list_accounts())
                elif path == "/api/categories":
                    self._send_json(200, db.list_categories())
                elif path == "/api/settings":
                    self._send_json(200, db.get_settings())
                elif path == "/api/export/csv":
                    csv_data = db.export_csv().encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Disposition", 'attachment; filename="fintrack-export.csv"')
                    self.send_header("Content-Length", str(len(csv_data)))
                    self.end_headers()
                    self.wfile.write(csv_data)
                elif path == "/api/export/json":
                    data = json.dumps(db.export_json(), ensure_ascii=False, indent=2).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Disposition", 'attachment; filename="fintrack-backup.json"')
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                else:
                    self._send_error_json(404, "Маршрут не найден.")
            except Exception as exc:
                self._send_error_json(500, str(exc))

        def do_POST(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            try:
                if path == "/api/transactions":
                    tx = db.create_transaction(self._read_json())
                    self._send_json(201, tx)
                elif path == "/api/accounts":
                    acc = db.create_account(self._read_json())
                    self._send_json(201, acc)
                elif path == "/api/categories":
                    cat = db.create_category(self._read_json())
                    self._send_json(201, cat)
                elif path == "/api/import/json":
                    stats = db.import_json(self._read_json())
                    self._send_json(200, {"imported": stats})
                elif path == "/api/demo":
                    count = db.load_demo_data()
                    self._send_json(200, {"inserted": count})
                elif path == "/api/reset":
                    db.reset_all()
                    self._send_json(200, {"ok": True})
                else:
                    self._send_error_json(404, "Маршрут не найден.")
            except ValueError as exc:
                self._send_error_json(400, str(exc))
            except Exception as exc:
                self._send_error_json(500, str(exc))

        def do_PUT(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            try:
                if path == "/api/settings":
                    self._send_json(200, db.update_settings(self._read_json()))
                elif m := re.fullmatch(r"/api/transactions/(\d+)", path):
                    self._send_json(200, db.update_transaction(int(m.group(1)), self._read_json()))
                elif m := re.fullmatch(r"/api/accounts/(\d+)", path):
                    self._send_json(200, db.update_account(int(m.group(1)), self._read_json()))
                elif m := re.fullmatch(r"/api/categories/(\d+)", path):
                    self._send_json(200, db.update_category(int(m.group(1)), self._read_json()))
                else:
                    self._send_error_json(404, "Маршрут не найден.")
            except ValueError as exc:
                self._send_error_json(400, str(exc))
            except LookupError as exc:
                self._send_error_json(404, str(exc))
            except Exception as exc:
                self._send_error_json(500, str(exc))

        def do_DELETE(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            try:
                if m := re.fullmatch(r"/api/transactions/(\d+)", path):
                    db.delete_transaction(int(m.group(1)))
                    self._send_json(200, {"deleted": True})
                elif m := re.fullmatch(r"/api/accounts/(\d+)", path):
                    db.delete_account(int(m.group(1)))
                    self._send_json(200, {"deleted": True})
                elif m := re.fullmatch(r"/api/categories/(\d+)", path):
                    db.delete_category(int(m.group(1)))
                    self._send_json(200, {"deleted": True})
                else:
                    self._send_error_json(404, "Маршрут не найден.")
            except ValueError as exc:
                self._send_error_json(400, str(exc))
            except LookupError as exc:
                self._send_error_json(404, str(exc))
            except Exception as exc:
                self._send_error_json(500, str(exc))

    return FinanceHandler


def run_server(port: int = 8000, db_path: Path | str = DEFAULT_DB_PATH, open_browser: bool = True) -> None:
    db = FinanceDB(db_path)
    handler = make_handler(db, STATIC_DIR)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    url = f"http://127.0.0.1:{server.server_address[1]}"
    print(f"FinTrack запущен: {url}")
    print(f"База данных: {Path(db_path).resolve()}")
    print("Закройте это окно или нажмите Ctrl+C для остановки.")

    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")
    finally:
        server.server_close()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="FinTrack — учёт личных финансов")
    parser.add_argument("--port", type=int, default=8000, help="Порт сервера (по умолчанию 8000)")
    parser.add_argument("--db", type=str, default=str(DEFAULT_DB_PATH), help="Путь к файлу SQLite")
    parser.add_argument("--no-browser", action="store_true", help="Не открывать браузер автоматически")
    args = parser.parse_args()
    run_server(port=args.port, db_path=args.db, open_browser=not args.no_browser)

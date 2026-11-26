import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import FinanceDB, STATIC_DIR, make_handler


class FinTrackAPITests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp_dir.name) / "test.db"
        self.db = FinanceDB(self.db_path)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.db, STATIC_DIR))
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.tmp_dir.cleanup()

    def _req(self, method: str, path: str, body: dict | None = None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, json.loads(raw) if raw.startswith("{") or raw.startswith("[") else raw
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read().decode("utf-8"))

    def test_bootstrap_and_static(self):
        status, data = self._req("GET", "/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(len(data["accounts"]), 3)
        self.assertGreaterEqual(len(data["categories"]), 10)
        self.assertEqual(data["settings"]["currency"], "₽")

        with urllib.request.urlopen(f"{self.base_url}/", timeout=5) as resp:
            html = resp.read().decode("utf-8")
            self.assertIn("FinTrack", html)

    def test_transactions_balances_and_transfer(self):
        _, boot = self._req("GET", "/api/bootstrap")
        card_id = boot["accounts"][0]["id"]
        cash_id = boot["accounts"][1]["id"]
        salary_id = next(c["id"] for c in boot["categories"] if c["type"] == "income")
        food_id = next(c["id"] for c in boot["categories"] if c["type"] == "expense")

        # Доход +10000
        st, tx_inc = self._req(
            "POST",
            "/api/transactions",
            {
                "type": "income",
                "amount": 10000,
                "category_id": salary_id,
                "account_id": card_id,
                "date": "2026-11-10",
                "note": "Тест доход",
            },
        )
        self.assertEqual(st, 201)

        # Расход -2500
        st, _ = self._req(
            "POST",
            "/api/transactions",
            {
                "type": "expense",
                "amount": 2500,
                "category_id": food_id,
                "account_id": card_id,
                "date": "2026-11-11",
                "note": "Продукты",
            },
        )
        self.assertEqual(st, 201)

        # Перевод 3000 с карты на наличные
        st, _ = self._req(
            "POST",
            "/api/transactions",
            {
                "type": "transfer",
                "amount": 3000,
                "account_id": card_id,
                "to_account_id": cash_id,
                "date": "2026-11-12",
                "note": "Снятие",
            },
        )
        self.assertEqual(st, 201)

        # Проверяем балансы и сводку
        _, summary = self._req("GET", "/api/summary?from=2026-11-01&to=2026-11-30")
        self.assertEqual(summary["total_income"], 10000.0)
        self.assertEqual(summary["total_expense"], 2500.0)
        self.assertEqual(summary["net"], 7500.0)
        self.assertEqual(summary["total_balance"], 7500.0)

        _, accounts = self._req("GET", "/api/accounts")
        acc_map = {a["id"]: a["balance"] for a in accounts}
        self.assertEqual(acc_map[card_id], 4500.0)
        self.assertEqual(acc_map[cash_id], 3000.0)

        # Редактирование и удаление
        st, updated = self._req(
            "PUT",
            f"/api/transactions/{tx_inc['id']}",
            {
                "type": "income",
                "amount": 12000,
                "category_id": salary_id,
                "account_id": card_id,
                "date": "2026-11-10",
                "note": "Обновлено",
            },
        )
        self.assertEqual(st, 200)
        self.assertEqual(updated["amount"], 12000.0)

        st, _ = self._req("DELETE", f"/api/transactions/{tx_inc['id']}")
        self.assertEqual(st, 200)

    def test_validation_errors(self):
        _, boot = self._req("GET", "/api/bootstrap")
        card_id = boot["accounts"][0]["id"]
        food_id = next(c["id"] for c in boot["categories"] if c["type"] == "expense")

        st, _ = self._req(
            "POST",
            "/api/transactions",
            {"type": "expense", "amount": -50, "category_id": food_id, "account_id": card_id, "date": "2026-11-10"},
        )
        self.assertEqual(st, 400)

        st, _ = self._req(
            "POST",
            "/api/transactions",
            {"type": "transfer", "amount": 100, "account_id": card_id, "to_account_id": card_id, "date": "2026-11-10"},
        )
        self.assertEqual(st, 400)

    def test_demo_export_and_import(self):
        st, demo = self._req("POST", "/api/demo")
        self.assertEqual(st, 200)
        self.assertGreater(demo["inserted"], 10)

        st, backup = self._req("GET", "/api/export/json")
        self.assertEqual(st, 200)
        self.assertEqual(len(backup["transactions"]), demo["inserted"])

        st, _ = self._req("POST", "/api/reset")
        self.assertEqual(st, 200)
        _, txs_after_reset = self._req("GET", "/api/transactions")
        self.assertEqual(len(txs_after_reset), 0)

        st, imp = self._req("POST", "/api/import/json", backup)
        self.assertEqual(st, 200)
        self.assertEqual(imp["imported"]["transactions"], demo["inserted"])

    def test_sync_validation_and_token_privacy(self):
        # Без токена синк возвращает 400
        st, _ = self._req("POST", "/api/sync/push", {})
        self.assertEqual(st, 400)

        # Токен сохраняется в settings, но не утекает в экспорт JSON
        st, settings = self._req("PUT", "/api/settings", {"gist_token": "secret_tok_123", "gist_autosync": "true"})
        self.assertEqual(st, 200)
        self.assertEqual(settings["gist_token"], "secret_tok_123")

        _, backup = self._req("GET", "/api/export/json")
        self.assertNotIn("gist_token", backup["settings"])


if __name__ == "__main__":
    unittest.main()

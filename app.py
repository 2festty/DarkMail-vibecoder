import os
import sys
import json
import random
import string
import time
import threading
import webbrowser
import requests
import webview

API_BASE = "https://api.mail.tm"
MSG_LIFETIME = 3600

SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")


def _load_settings():
    try:
        with open(SETTINGS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_settings(s):
    with open(SETTINGS_FILE, "w") as f:
        json.dump(s, f, indent=2)


# ─── GMX helper (tries curl_cffi, falls back to requests) ───
def _gmx_post(url, data, headers):
    try:
        from curl_cffi import requests as cffi_req
        resp = cffi_req.post(url, json=data, headers=headers,
                             impersonate="chrome120", timeout=30)
        return resp.status_code, resp.text, dict(resp.headers)
    except ImportError:
        resp = requests.post(url, json=data, headers=headers, timeout=30)
        return resp.status_code, resp.text, dict(resp.headers)


# ─── Account ───
class _Account:
    def __init__(self, local_id, mailtm_id, email, password, token, provider="mailtm"):
        self.local_id = local_id
        self.mailtm_id = mailtm_id
        self.email = email
        self.password = password
        self.token = token
        self.known_ids = set()
        self.created_at = time.time()
        self.favorite = False
        self.provider = provider
        self.unread = 0


class Api:
    def __init__(self):
        self._accounts = {}
        self._current_id = None
        self._next_id = 1
        self._window = None
        self._provider = "mailtm"
        self._settings = _load_settings()

    def set_window(self, window):
        self._window = window

    def _gen_password(self):
        return ''.join(random.choices(string.ascii_letters + string.digits, k=16))

    def _gen_local(self, prefix=""):
        r = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
        return f"{prefix}_{r}" if prefix else r

    def _headers(self, token):
        return {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}

    def _current(self):
        if self._current_id is None:
            return None
        return self._accounts.get(self._current_id)

    # ─── Settings ───
    def get_settings(self):
        return {"ok": True, "settings": {
            "theme": self._settings.get("theme", "dark"),
            "sound": self._settings.get("sound", True),
            "provider": self._settings.get("provider", "mailtm"),
            "capsolver_key": self._settings.get("capsolver_key", ""),
            "default_domain": self._settings.get("default_domain", ""),
            "auto_copy": self._settings.get("auto_copy", True),
        }}

    def save_settings(self, s_json):
        try:
            s = json.loads(s_json) if isinstance(s_json, str) else s_json
            self._settings.update(s)
            _save_settings(self._settings)
            if "provider" in s:
                self._provider = s["provider"]
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ─── Provider ───
    def get_providers(self):
        return {"ok": True, "providers": [
            {"id": "mailtm", "name": "Mail.tm", "available": True},
            {"id": "gmx", "name": "GMX.com", "available": True,
             "note": "Нужен CapSolver API ключ в настройках"},
        ], "current": self._provider}

    def set_provider(self, provider):
        if provider == "gmx" and not self._settings.get("capsolver_key"):
            return {"ok": False, "error": "Вставьте CapSolver API ключ в настройках"}
        self._provider = provider
        self._settings["provider"] = provider
        _save_settings(self._settings)
        return {"ok": True, "provider": provider}

    # ─── Domains ───
    def get_domains(self):
        try:
            resp = requests.get(f"{API_BASE}/domains", timeout=10)
            resp.raise_for_status()
            domains = resp.json().get("hydra:member", [])
            return {"ok": True, "domains": [d["domain"] for d in domains]}
        except requests.RequestException as e:
            print("[DarkMail] Domain fetch error:", e)
            return {"ok": False, "error": str(e), "domains": []}

    # ─── GMX register ───
    def _gmx_register(self, template):
        capsolver = self._settings.get("capsolver_key", "")
        if not capsolver:
            return {"ok": False, "error": "Нет CapSolver API ключа"}

        try:
            sess = requests.Session()
            sess.headers.update({
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            })
            sess.get("https://www.gmx.com", timeout=15)

            task_payload = {
                "clientKey": capsolver,
                "task": {
                    "type": "CaptchaFoxTask",
                    "websiteURL": "https://signup.gmx.com",
                    "websiteKey": "semcrazzlinve-gmx-gmx",
                },
            }
            task_resp = requests.post(
                "https://api.capsolver.com/createTask", json=task_payload, timeout=30
            )
            task_data = task_resp.json()
            task_id = task_data.get("taskId")
            if not task_id:
                return {"ok": False, "error": "CapSolver: " + task_data.get("errorDescription", "unknown")}

            for _ in range(30):
                time.sleep(2)
                sol_resp = requests.post(
                    "https://api.capsolver.com/getTaskResult",
                    json={"clientKey": capsolver, "taskId": task_id}, timeout=15
                )
                sol = sol_resp.json()
                if sol.get("status") == "ready":
                    captcha_token = sol["solution"]["token"]
                    break
            else:
                return {"ok": False, "error": "CapSolver: timeout"}

            local = self._gen_local(template)
            pwd = self._gen_password()
            payload = {
                "captchaToken": captcha_token,
                "email": f"{local}@gmx.com",
                "password": pwd,
                "passwordRepetition": pwd,
                "firstName": random.choice(["Alex", "Max", "Jim", "Sam", "Leo", "Ray"]),
                "lastName": random.choice(["Smith", "Jones", "Lee", "Brown", "Wong"]),
                "birthDate": f"{random.randint(1,28)}.{random.randint(1,12)}.{random.randint(1985,2000)}",
                "gender": random.choice(["MALE", "FEMALE"]),
                "legalConfirmation": True,
                "agbConfirmation": True,
            }
            reg_headers = {
                "Content-Type": "application/json",
                "Origin": "https://signup.gmx.com",
                "Referer": "https://signup.gmx.com/",
                "User-Agent": sess.headers["User-Agent"],
            }
            st, body, _ = _gmx_post(
                "https://signup.gmx.com/api/v1/register", payload, reg_headers
            )
            if st not in (200, 201):
                return {"ok": False, "error": f"GMX register failed ({st}): {body[:200]}"}

            data = json.loads(body)
            gmx_id = data.get("id", local)
            token = data.get("token", "")

            local_id = self._next_id
            self._next_id += 1
            acc = _Account(local_id, gmx_id, f"{local}@gmx.com", pwd, token, "gmx")
            self._accounts[local_id] = acc
            self._current_id = local_id
            return {
                "ok": True, "local_id": local_id, "email": acc.email,
                "password": pwd, "created_at": acc.created_at, "favorite": False,
            }

        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ─── Add account ───
    def add_account(self):
        return self.add_account_template("", "")

    def add_account_template(self, template, domain_name=""):
        if self._provider == "gmx":
            return self._gmx_register(template)

        try:
            domain = domain_name or ""
            if not domain:
                dr = requests.get(f"{API_BASE}/domains", timeout=10)
                dr.raise_for_status()
                dl = dr.json().get("hydra:member", [])
                if not dl:
                    return {"ok": False, "error": "Нет доступных доменов от API"}
                domain = dl[0]["domain"]

            local = self._gen_local(template)
            address = f"{local}@{domain}"
            password = self._gen_password()
            payload = {"address": address, "password": password}
            ar = requests.post(f"{API_BASE}/accounts", json=payload,
                               headers={"Content-Type": "application/json"}, timeout=10)
            if ar.status_code not in (200, 201):
                err = ar.text[:200]
                print(f"[DarkMail] Create account failed ({ar.status_code}): {err}")
                return {"ok": False, "error": f"Ошибка создания ({ar.status_code})"}

            mailtm_id = ar.json()["id"]
            tr = requests.post(f"{API_BASE}/token", json=payload,
                               headers={"Content-Type": "application/json"}, timeout=10)
            tr.raise_for_status()
            token = tr.json()["token"]
            local_id = self._next_id
            self._next_id += 1
            acc = _Account(local_id, mailtm_id, address, password, token)
            self._accounts[local_id] = acc
            self._current_id = local_id
            return {"ok": True, "local_id": local_id, "email": address,
                    "password": password, "created_at": acc.created_at, "favorite": False}

        except requests.RequestException as e:
            return {"ok": False, "error": str(e)}

    def list_accounts(self):
        alist = []
        for acc in self._accounts.values():
            age = time.time() - acc.created_at
            alist.append({
                "local_id": acc.local_id, "email": acc.email,
                "created_at": acc.created_at, "is_current": acc.local_id == self._current_id,
                "favorite": acc.favorite, "unread": len(acc.known_ids) if acc.known_ids else 0,
                "provider": acc.provider, "age_min": int(age / 60),
            })
        alist.sort(key=lambda a: (-a["favorite"], -a["created_at"]))
        return {"ok": True, "accounts": alist}

    def switch_account(self, local_id):
        local_id = int(local_id)
        if local_id not in self._accounts:
            return {"ok": False, "error": "Not found"}
        self._current_id = local_id
        a = self._accounts[local_id]
        return {"ok": True, "local_id": a.local_id, "email": a.email,
                "password": a.password, "created_at": a.created_at, "favorite": a.favorite}

    def remove_account(self, local_id):
        local_id = int(local_id)
        acc = self._accounts.get(local_id)
        if not acc:
            return {"ok": False, "error": "Not found"}
        if acc.provider == "mailtm":
            try:
                requests.delete(f"{API_BASE}/accounts/{acc.mailtm_id}",
                                headers=self._headers(acc.token), timeout=10)
            except Exception:
                pass
        del self._accounts[local_id]
        if self._current_id == local_id:
            self._current_id = next(iter(self._accounts), None)
        return {"ok": True}

    def get_current(self):
        acc = self._current()
        if not acc:
            return {"ok": False, "error": "No active"}
        return {"ok": True, "local_id": acc.local_id, "email": acc.email,
                "password": acc.password, "created_at": acc.created_at, "favorite": acc.favorite}

    def toggle_favorite(self, local_id):
        local_id = int(local_id)
        acc = self._accounts.get(local_id)
        if not acc:
            return {"ok": False, "error": "Not found"}
        acc.favorite = not acc.favorite
        return {"ok": True, "favorite": acc.favorite}

    # ─── Messages ───
    def _mailtm_messages(self, acc):
        try:
            resp = requests.get(f"{API_BASE}/messages", headers=self._headers(acc.token), timeout=10)
            if resp.status_code == 401:
                print(f"[DarkMail] Token expired for {acc.email}")
                return [], False
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as e:
            print(f"[DarkMail] Messages fetch error: {e}")
            return [], False

        members = data.get("hydra:member", [])
        new_ids = set()
        has_new = False
        for m in members:
            new_ids.add(m["id"])
            if m["id"] not in acc.known_ids:
                has_new = True
        acc.known_ids = new_ids
        messages = []
        for m in members:
            messages.append({
                "id": m["id"], "from": m["from"].get("name", "") if m.get("from") else "",
                "from_addr": m["from"].get("address", "") if m.get("from") else "",
                "subject": m.get("subject", ""), "intro": m.get("intro", ""),
                "created_at": m.get("createdAt", ""),
                "has_attachments": m.get("hasAttachments", False),
            })
        return messages, has_new

    def get_messages(self):
        acc = self._current()
        if not acc:
            return {"ok": False, "error": "No active", "messages": []}
        try:
            if acc.provider == "gmx":
                return {"ok": True, "messages": [], "has_new": False}
            msgs, has_new = self._mailtm_messages(acc)
            return {"ok": True, "messages": msgs, "has_new": has_new}
        except requests.RequestException as e:
            return {"ok": False, "error": str(e), "messages": []}

    def get_message(self, msg_id):
        acc = self._current()
        if not acc:
            return {"ok": False, "error": "No active"}
        try:
            resp = requests.get(f"{API_BASE}/messages/{msg_id}",
                                headers=self._headers(acc.token), timeout=10)
            resp.raise_for_status()
            data = resp.json()
            html = data.get("html", [""])[0] if data.get("html") else ""
            text = data.get("text", "")
            atts = []
            for att in data.get("attachments", []):
                atts.append({"id": att.get("id", ""), "filename": att.get("filename", "file"),
                             "content_type": att.get("contentType", ""), "size": att.get("size", 0),
                             "download_url": att.get("downloadUrl", "")})
            return {"ok": True,
                    "from": data["from"].get("name", "") if data.get("from") else "",
                    "from_addr": data["from"].get("address", "") if data.get("from") else "",
                    "subject": data.get("subject", ""), "html": html, "text": text,
                    "created_at": data.get("createdAt", ""), "attachments": atts,
                    "has_attachments": data.get("hasAttachments", False)}
        except requests.RequestException as e:
            return {"ok": False, "error": str(e)}

    def delete_message(self, msg_id):
        acc = self._current()
        if not acc:
            return {"ok": False, "error": "No active"}
        try:
            resp = requests.delete(f"{API_BASE}/messages/{msg_id}",
                                   headers=self._headers(acc.token), timeout=10)
            resp.raise_for_status()
            return {"ok": True}
        except requests.RequestException as e:
            return {"ok": False, "error": str(e)}

    def export_message(self, msg_id, file_format):
        acc = self._current()
        if not acc:
            return {"ok": False, "error": "No active"}
        try:
            resp = requests.get(f"{API_BASE}/messages/{msg_id}",
                                headers=self._headers(acc.token), timeout=10)
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as e:
            return {"ok": False, "error": str(e)}
        html = data.get("html", [""])[0] if data.get("html") else ""
        text = data.get("text", "")
        ext = "txt" if file_format == "txt" else "html"
        content = (text or html or "(empty)").encode("utf-8") if ext == "txt" \
            else (html or f"<pre>{text}</pre>" or "(empty)").encode("utf-8")
        if not self._window:
            return {"ok": False, "error": "No window"}
        path = self._window.create_file_dialog(webview.SAVE_DIALOG, save_filename=f"message.{ext}")
        if not path:
            return {"ok": False, "error": "Cancelled"}
        try:
            with open(path, "wb") as f:
                f.write(content)
            return {"ok": True, "path": path}
        except OSError as e:
            return {"ok": False, "error": str(e)}

    def save_attachment(self, msg_id, attachment_id, filename):
        acc = self._current()
        if not acc:
            return {"ok": False, "error": "No active"}
        try:
            resp = requests.get(f"{API_BASE}/messages/{msg_id}/attachments/{attachment_id}",
                                headers=self._headers(acc.token), timeout=30)
            resp.raise_for_status()
        except requests.RequestException as e:
            return {"ok": False, "error": str(e)}
        if not self._window:
            return {"ok": False, "error": "No window"}
        path = self._window.create_file_dialog(webview.SAVE_DIALOG, save_filename=filename)
        if not path:
            return {"ok": False, "error": "Cancelled"}
        try:
            with open(path, "wb") as f:
                f.write(resp.content)
            return {"ok": True, "path": path}
        except OSError as e:
            return {"ok": False, "error": str(e)}

    def open_url(self, url):
        webbrowser.open(url)
        return {"ok": True}

    def get_stats(self):
        total = len(self._accounts)
        favs = sum(1 for a in self._accounts.values() if a.favorite)
        total_msgs = sum(len(a.known_ids) for a in self._accounts.values())
        recent = sorted(self._accounts.values(), key=lambda a: -a.created_at)[:5]
        recent_list = [{"email": a.email, "age_min": int((time.time()-a.created_at)/60),
                        "favorite": a.favorite, "provider": a.provider} for a in recent]
        return {"ok": True, "total_accounts": total, "favorites": favs,
                "total_messages": total_msgs, "recent": recent_list}


class JSApi:
    def __init__(self, api: Api):
        self._api = api

    def get_settings(self): return json.dumps(self._api.get_settings())
    def save_settings(self, s): return json.dumps(self._api.save_settings(s))
    def get_providers(self): return json.dumps(self._api.get_providers())
    def set_provider(self, p): return json.dumps(self._api.set_provider(p))
    def get_domains(self): return json.dumps(self._api.get_domains())
    def add_account(self): return json.dumps(self._api.add_account())
    def add_account_template(self, t, d=""): return json.dumps(self._api.add_account_template(t, d))
    def list_accounts(self): return json.dumps(self._api.list_accounts())
    def switch_account(self, lid): return json.dumps(self._api.switch_account(lid))
    def remove_account(self, lid): return json.dumps(self._api.remove_account(lid))
    def get_current(self): return json.dumps(self._api.get_current())
    def toggle_favorite(self, lid): return json.dumps(self._api.toggle_favorite(lid))
    def get_messages(self): return json.dumps(self._api.get_messages())
    def get_message(self, mid): return json.dumps(self._api.get_message(mid))
    def delete_message(self, mid): return json.dumps(self._api.delete_message(mid))
    def export_message(self, mid, fmt): return json.dumps(self._api.export_message(mid, fmt))
    def save_attachment(self, mid, aid, fn): return json.dumps(self._api.save_attachment(mid, aid, fn))
    def open_url(self, url): return json.dumps(self._api.open_url(url))
    def get_stats(self): return json.dumps(self._api.get_stats())


if __name__ == "__main__":
    api = Api()
    gui_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gui")
    index = os.path.join(gui_dir, "index.html")
    window = webview.create_window("DarkMail", index, js_api=JSApi(api),
                                   width=1000, height=700, min_size=(820, 560), resizable=True)
    api.set_window(window)
    webview.start(debug=False)

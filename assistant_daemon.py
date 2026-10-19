#!/usr/bin/env python3
"""
Manus 桌面助手 — 本地 HTTP 监控桥 (8765 端口)
为 assistant-wallpaper.html 提供：
  /stats   CPU/内存/磁盘/网络/异常登录
  /todo    今日代办列表 (GET)
  /todo/add 新增待办 (POST {title, due, cat})
  /todo/toggle 勾选/取消 (POST {id, done})
  /todo/del 删除待办 (POST {id})
  /login   异常登录检测
  /chat    接入本地模型 / Hermes (失败降级为本地兜底回复)
数据缓存：JSON + SQLite 放在项目目录 data/，严禁写入 ~/.hermes/ 或 Hermes 系统目录。
独立运行：nohup python3 assistant_daemon.py &
"""
import json, os, sqlite3, subprocess, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone

HOST, PORT = "127.0.0.1", 8765
APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, "data")
TODO_FILE = os.path.join(DATA_DIR, "todos.json")
DB_FILE = os.path.join(DATA_DIR, "manus.db")
KNOWN_FILE = os.path.join(DATA_DIR, "known_users.json")
LOGIN_LOG = os.path.join(DATA_DIR, "login.log")

os.makedirs(DATA_DIR, exist_ok=True)

# ── SQLite 初始化 (待办持久化) ────────────────────────────
def _db():
    conn = sqlite3.connect(DB_FILE)
    conn.execute("""CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        done INTEGER DEFAULT 0,
        due TEXT,
        cat TEXT DEFAULT '一般',
        created TEXT
    )""")
    conn.commit()
    return conn

def _db_seed():
    """首次启动时从旧 JSON 迁移，或写入示例数据。"""
    conn = _db()
    cur = conn.execute("SELECT COUNT(*) FROM todos")
    if cur.fetchone()[0] > 0:
        conn.close(); return
    # 示例代办
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    today = datetime.now().strftime("%Y-%m-%d")
    samples = [
        ("t1", "审阅 arXiv 前沿论文动向", 0, today, "研究", now),
        ("t2", "完成 cue 形象四状态动效", 0, today, "开发", now),
        ("t3", "待办任务输入与多端同步", 0, today, "开发", now),
    ]
    conn.executemany("INSERT INTO todos VALUES (?,?,?,?,?,?)", samples)
    conn.commit()
    conn.close()

_db_seed()

def todo_rows():
    conn = _db()
    rows = conn.execute("SELECT id,title,done,due,cat,created FROM todos ORDER BY done ASC, created DESC").fetchall()
    conn.close()
    return [{"id": r[0], "title": r[1], "done": bool(r[2]), "due": r[3], "cat": r[4], "created": r[5]} for r in rows]

def todo_add(title, due, cat):
    tid = "t" + str(int(time.time() * 1000))
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = _db()
    conn.execute("INSERT INTO todos VALUES (?,?,0,?,?,?)", (tid, title, due, cat, now))
    conn.commit(); conn.close()
    return tid

def todo_toggle(tid, done):
    conn = _db()
    conn.execute("UPDATE todos SET done=? WHERE id=?", (1 if done else 0, tid))
    conn.commit(); conn.close()

def todo_del(tid):
    conn = _db()
    conn.execute("DELETE FROM todos WHERE id=?", (tid,))
    conn.commit(); conn.close()

# 兼容旧 JSON 接口（只读，不再写入）
def get_todo():
    try:
        now = datetime.now().strftime("%Y-%m-%d")
        items = todo_rows()
        today = [it for it in items if (it.get("due") or "").startswith(now)]
        return {"items": today or items[:8]}
    except Exception:
        return {"items": []}

# ── 系统统计 ──────────────────────────────────────────────
def _run(cmd):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        return p.stdout.strip()
    except Exception:
        return ""

def stats():
    def cpuload():
        try:
            a = [float(x) for x in open("/proc/stat").readline().split()[1:5]]
            time.sleep(0.3)
            b = [float(x) for x in open("/proc/stat").readline().split()[1:5]]
            d = [b[i] - a[i] for i in range(4)]
            tot = sum(d); idle = d[3]
            return max(0, min(100, int(100 * (tot - idle) / max(tot, 1))))
        except Exception:
            return 0
    cpu = cpuload()
    try:
        mi = {}
        for line in open("/proc/meminfo"):
            k, v = line.split(":")[0], line.split(":")[1].split()[0]
            mi[k] = int(v)
        mem_pct = int(100 * (mi.get("MemTotal", 1) - mi.get("MemAvailable", 0)) / max(mi.get("MemTotal", 1), 1))
    except Exception:
        mem_pct = 0
    disk = _run(["df", "-B1", "/"]).splitlines()[-1].split()
    disk_pct = int(disk[4].rstrip("%")) if disk else 0
    net = _run(["ip", "-s", "-brief", "link"]).split("\n")
    parts = []
    for l in net:
        c = l.split()
        if c and "UP" in l and len(c) > 4:
            parts.append(c[0] + ":" + c[4])
    net_txt = " | ".join(parts)[:60] or "--"
    return {"cpu": cpu, "mem": mem_pct, "disk": disk_pct, "net": net_txt or "--",
            "ts": datetime.now().isoformat()}

# ── 登录监控 ──────────────────────────────────────────────
def known_users():
    try:
        return json.load(open(KNOWN_FILE))
    except Exception:
        return set()

def login_check():
    cur = set()
    try:
        out = _run(["who"])
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 1:
                cur.add(parts[0])
    except Exception:
        pass
    prev = known_users()
    new = [u for u in cur if u not in prev]
    result = {"newLogin": bool(new), "users": sorted(cur), "new": new,
              "time": datetime.now().strftime("%H:%M:%S"),
              "ip": "本地/SSH"}
    try:
        with open(LOGIN_LOG, "a") as f:
            f.write(json.dumps(result, ensure_ascii=False) + "\n")
    except Exception:
        pass
    try:
        json.dump(sorted(cur), open(KNOWN_FILE, "w"))
    except Exception:
        pass
    return result

# ── 聊天 (尝试本地模型，失败降级) ─────────────────────────
SYSTEM = "你是用户的桌面个人助手（Manus 风格），简洁、可靠、中文回复，不编造系统信息。"
def chat_reply(message, style):
    import urllib.request
    endpoints = [("http://127.0.0.1:11434/api/chat", "ollama")]
    for url, _ in endpoints:
        try:
            body = json.dumps({"model": "nemotron", "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": message}], "stream": False}).encode()
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=6) as r:
                j = json.load(r)
            return j.get("message", {}).get("content") or j.get("response") or "收到，已记录。"
        except Exception:
            continue
    m = message.lower()
    if any(k in m for k in ["你好", "在吗", "谁"]):
        return f"在的，我是{style}风格助手。有什么事？"
    if any(k in m for k in ["状态", "系统", "监控"]):
        return "请查看左侧系统监控面板，CPU/内存/磁盘实时显示。"
    if any(k in m for k in ["待办", "代办", "计划"]):
        return "右侧面板显示今日代办，勾选即可完成；底部可新增任务。"
    if any(k in m for k in ["异常", "登录", "安全"]):
        return "若检测到非本人登录，右下角会弹出安全预警。"
    return f'收到：“{message}”。我暂时运行在本地兜底模式，如需接入 Hermes / 大模型，请在本机启动对应服务并填写端点。'

# ── HTTP ─────────────────────────────────────────────────
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _j(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self._j({})

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/stats":
            self._j(stats())
        elif p == "/todo":
            self._j(get_todo())
        elif p == "/login":
            self._j(login_check())
        else:
            self._j({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(n)
        try:
            data = json.loads(body or b"{}")
        except Exception:
            data = {}
        if self.path == "/chat":
            self._j({"reply": chat_reply(data.get("message", ""), data.get("style", "manus"))})
        elif self.path == "/todo/add":
            tid = todo_add(data.get("title", ""), data.get("due", ""), data.get("cat", "一般"))
            self._j({"ok": True, "id": tid})
        elif self.path == "/todo/toggle":
            todo_toggle(data.get("id", ""), bool(data.get("done")))
            self._j({"ok": True})
        elif self.path == "/todo/del":
            todo_del(data.get("id", ""))
            self._j({"ok": True})
        else:
            self._j({"error": "not found"}, 404)

if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()

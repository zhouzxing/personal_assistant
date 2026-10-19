#!/usr/bin/env python3
"""
Manus 桌面助手 — 本地 HTTP 监控桥 (8765 端口)
为 assistant-wallpaper.html 提供：
  /stats   CPU/内存/磁盘/网络/异常登录
  /todo    今日代办 (从 ~/.hermes/cache/scratch/todos.json 读取)
  /login   异常登录检测 (对比 ~/.hermes/cache/scratch/known_users.json)
  /chat    接入本地模型 / Hermes (失败降级为本地兜底回复)
独立运行：nohup python3 assistant_daemon.py &
"""
import json, os, socket, subprocess, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone

HOST, PORT = "127.0.0.1", 8765
BASE = os.path.expanduser("~/.hermes/cache/scratch")
TODO_FILE = os.path.join(BASE, "todos.json")
KNOWN_FILE = os.path.join(BASE, "known_users.json")
LOGIN_LOG = os.path.join(BASE, "login.log")

os.makedirs(BASE, exist_ok=True)

# ── 系统统计 ──────────────────────────────────────────────
def _run(cmd):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        return p.stdout.strip()
    except Exception:
        return ""

def stats():
    def num(s):
        try: return int(float(s.split()[0]))
        except Exception: return 0
    cpu = num(_run(["top","-bn1"]).split("%Cpu(s):")[-1].split(",")[0]) if _run(["top","-bn1"]) else 0
    # 更可靠: /proc/stat 两次采样
    def cpuload():
        try:
            a=[float(x) for x in open("/proc/stat").readline().split()[1:5]]
            time.sleep(0.3); b=[float(x) for x in open("/proc/stat").readline().split()[1:5]]
            d=[b[i]-a[i] for i in range(4)]; tot=sum(d); idle=d[3]
            return max(0,min(100,int(100*(tot-idle)/max(tot,1))))
        except Exception: return 0
    cpu=cpuload()
    try:
        mi={}
        for line in open("/proc/meminfo"):
            k,v=line.split(":")[0],line.split(":")[1].split()[0]
            mi[k]=int(v)
        mem_pct=int(100*(mi.get("MemTotal",1)-mi.get("MemAvailable",0))/max(mi.get("MemTotal",1),1))
    except Exception:
        mem_pct=0
    disk=_run(["df","-B1","/"]).splitlines()[-1].split()
    disk_pct=int(disk[4].rstrip("%")) if disk else 0
    net=_run(["ip","-s","-brief","link"]).split("\n")
    parts=[]
    for l in net:
        c=l.split()
        if c and "UP" in l and len(c)>4:
            parts.append(c[0]+":"+c[4])
    net_txt=" | ".join(parts)[:60] or "--"
    return {"cpu":cpu,"mem":mem_pct,"disk":disk_pct,"net":net_txt or "--","ts":datetime.now().isoformat()}

# ── 登录监控 ──────────────────────────────────────────────
def known_users():
    try: return json.load(open(KNOWN_FILE))
    except Exception: return set()

def login_check():
    cur=set()
    try:
        out=_run(["who"])
        for line in out.splitlines():
            parts=line.split()
            if len(parts)>=1: cur.add(parts[0])
    except Exception: pass
    prev=known_users()
    new=[u for u in cur if u not in prev]
    result={"newLogin":bool(new),"users":sorted(cur),"new":new,
            "time":datetime.now().strftime("%H:%M:%S"),
            "ip":"本地/SSH"}
    try:
        with open(LOGIN_LOG,"a") as f: f.write(json.dumps(result,ensure_ascii=False)+"\n")
    except Exception: pass
    try: json.dump(sorted(cur),open(KNOWN_FILE,"w"))
    except Exception: pass
    return result

# ── 代办 ─────────────────────────────────────────────────
def get_todo():
    try:
        data=json.load(open(TODO_FILE))
        items=data.get("items",[])
        now=datetime.now().strftime("%Y-%m-%d")
        today=[it for it in items if it.get("date","")==now or it.get("due","")==now]
        return {"items":today or items[:8]}
    except Exception:
        return {"items":[]}

# ── 聊天 (尝试本地模型，失败降级) ─────────────────────────
SYSTEM = "你是用户的桌面个人助手（Manus 风格），简洁、可靠、中文回复，不编造系统信息。"
def chat_reply(message, style):
    # 优先尝试本地 Ollama / Hermes-compatible 端点
    endpoints=[("http://127.0.0.1:11434/api/chat","ollama")]
    for url,_ in endpoints:
        try:
            import urllib.request
            body=json.dumps({"model":"nemotron","messages":[{"role":"system","content":SYSTEM},{"role":"user","content":message}],"stream":False}).encode()
            req=urllib.request.Request(url,data=body,headers={"Content-Type":"application/json"})
            with urllib.request.urlopen(req,timeout=6) as r:
                j=json.load(r)
            return j.get("message",{}).get("content") or j.get("response") or "收到，已记录。"
        except Exception:
            continue
    # 兜底：本地关键词回复，确保脱机也能交互
    m=message.lower()
    if any(k in m for k in["你好","在吗","谁"]): return f"在的，我是{style}风格助手。有什么事？"
    if any(k in m for k in["状态","系统","监控"]): return "请查看左侧系统监控面板，CPU/内存/磁盘实时显示。"
    if any(k in m for k in["待办","代办","计划"]): return "右侧面板显示今日代办，勾选即可完成。"
    if any(k in m for k in["异常","登录","安全"]): return "若检测到非本人登录，右下角会弹出安全预警。"
    return f"收到：“{message}”。我暂时运行在本地兜底模式，如需接入 Hermes / 大模型，请在本机启动对应服务并填写端点。"

# ── HTTP ─────────────────────────────────────────────────
class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _j(self,obj,code=200):
        b=json.dumps(obj,ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Access-Control-Allow-Methods","GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type")
        self.send_header("Content-Length",str(len(b)));self.end_headers();self.wfile.write(b)
    def do_OPTIONS(self):
        self._j({})
    def do_GET(self):
        p=self.path.split("?")[0]
        if p=="/stats": self._j(stats())
        elif p=="/todo": self._j(get_todo())
        elif p=="/login": self._j(login_check())
        else: self._j({"error":"not found"},404)
    def do_POST(self):
        if self.path=="/chat":
            n=int(self.headers.get("Content-Length","0") or 0)
            body=self.rfile.read(n)
            try: data=json.loads(body or b"{}")
            except Exception: data={}
            msg=data.get("message",""); style=data.get("style","manus")
            self._j({"reply":chat_reply(msg,style)})
        else: self._j({"error":"not found"},404)

if __name__=="__main__":
    ThreadingHTTPServer((HOST,PORT),H).serve_forever()

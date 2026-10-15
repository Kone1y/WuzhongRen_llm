#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
LLM 文字冒险引擎 - 后端服务
================================
纯 Python 标准库实现，零第三方依赖。

功能：
  1. 托管 static/ 下的前端页面
  2. GET  /api/worlds          列出 worlds/ 目录下所有世界剧本
  3. GET  /api/world?world=xx  读取单个世界剧本 JSON
  4. POST /api/generate        代理转发到 OpenAI 兼容的 chat/completions 接口
  5. POST /api/image           (可选) 代理转发到 OpenAI 兼容的图片生成接口
  6. GET/POST /api/saves...    存档管理（写入 saves/ 目录）
  7. GET  /api/health          健康检查 + 配置状态

LLM 配置（二选一，优先 config.json）：
  A. 在本文件同目录放 config.json：
     {
       "baseUrl": "https://api.deepseek.com/v1",
       "apiKey":  "sk-xxxx",
       "model":   "deepseek-chat",
       "imageBaseUrl": "可选，图片接口地址",
       "imageApiKey":  "可选",
       "imageModel":   "可选，如 dall-e-3 / cogview-3-flash 等"
     }
  B. 环境变量：TA_BASE_URL / TA_API_KEY / TA_MODEL
     （任何 OpenAI 兼容服务均可：DeepSeek / 通义 / OpenAI / Ollama 本地等）

运行：
  python server.py            # 默认 0.0.0.0:8000
  python server.py 9000       # 指定端口
"""

import json
import os
import sys
import time
import uuid
import urllib.request
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ---------- 基础路径 ----------
ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
WORLDS_DIR = ROOT / "worlds"
SAVES_DIR = ROOT / "saves"
CONFIG_PATH = ROOT / "config.json"

SAVES_DIR.mkdir(exist_ok=True)

# ---------- 配置加载 ----------

def load_config():
    """读取 LLM 配置：config.json 优先，其次环境变量。"""
    cfg = {}
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[warn] config.json 解析失败，将被忽略: {e}")
    return {
        "baseUrl": cfg.get("baseUrl") or os.environ.get("TA_BASE_URL", ""),
        "apiKey": cfg.get("apiKey") or os.environ.get("TA_API_KEY", ""),
        "model": cfg.get("model") or os.environ.get("TA_MODEL", ""),
        "imageBaseUrl": cfg.get("imageBaseUrl", ""),
        "imageApiKey": cfg.get("imageApiKey", ""),
        "imageModel": cfg.get("imageModel", ""),
    }


def llm_ready(cfg):
    return bool(cfg.get("baseUrl") and cfg.get("model"))


def image_ready(cfg):
    return bool(cfg.get("imageBaseUrl") and cfg.get("imageModel"))

# ---------- HTTP 工具 ----------

def http_post_json(url, headers, payload, timeout=180):
    """POST JSON 并返回解析后的 dict。失败抛 RuntimeError(友好中文错误)。"""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    for k, v in headers.items():
        req.add_header(k, v)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "ignore")[:500]
        except Exception:
            pass
        raise RuntimeError(f"上游接口返回 HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"无法连接上游接口: {e.reason}")
    except Exception as e:
        raise RuntimeError(f"请求上游接口失败: {e}")

# ---------- 请求处理 ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "TextAdventure/1.0"

    # ---- 通用 ----
    def log_message(self, fmt, *args):
        # 简洁日志，避免 Windows 控制台编码问题
        try:
            print("[%s] %s %s" % (time.strftime("%H:%M:%S"), self.command, self.path))
        except Exception:
            pass

    def _send(self, code, obj, content_type="application/json; charset=utf-8"):
        body = obj if isinstance(obj, bytes) else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        query = {}
        if "?" in self.path:
            for kv in self.path.split("?", 1)[1].split("&"):
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    query[k] = urllib.parse.unquote(v)

        if path == "/api/health":
            cfg = load_config()
            self._send(200, {
                "ok": True,
                "llm": llm_ready(cfg),
                "image": image_ready(cfg),
                "model": cfg.get("model", ""),
            })

        elif path == "/api/config":
            # 读取当前 LLM 配置（key 打码）
            cfg = load_config()
            self._send(200, {
                "ok": True,
                "baseUrl": cfg.get("baseUrl", ""),
                "model": cfg.get("model", ""),
                "apiKey": ("****" + cfg["apiKey"][-4:]) if cfg.get("apiKey") else "",
                "hasKey": bool(cfg.get("apiKey")),
            })

        elif path == "/api/worlds":
            worlds = []
            if WORLDS_DIR.exists():
                for f in sorted(WORLDS_DIR.glob("*.json")):
                    try:
                        w = json.loads(f.read_text(encoding="utf-8"))
                        worlds.append({
                            "id": w.get("id", f.stem),
                            "name": w.get("name", f.stem),
                            "tagline": w.get("tagline", ""),
                            "cover": w.get("cover", ""),
                            "difficulty": w.get("difficulty", ""),
                        })
                    except Exception:
                        pass
            self._send(200, {"ok": True, "worlds": worlds})

        elif path == "/api/world":
            wid = query.get("world", "")
            safe = Path(wid).name  # 防目录穿越
            f = WORLDS_DIR / f"{safe}.json"
            if not f.exists():
                return self._send(404, {"ok": False, "error": f"世界不存在: {wid}"})
            try:
                self._send(200, {"ok": True, "world": json.loads(f.read_text(encoding="utf-8"))})
            except Exception as e:
                self._send(500, {"ok": False, "error": f"世界文件解析失败: {e}"})

        elif path == "/api/saves":
            saves = []
            for f in sorted(SAVES_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
                try:
                    d = json.loads(f.read_text(encoding="utf-8"))
                    saves.append({
                        "slot": f.stem,
                        "world": d.get("worldName", ""),
                        "player": d.get("player", ""),
                        "turn": d.get("turn", 0),
                        "time": time.strftime("%Y-%m-%d %H:%M", time.localtime(f.stat().st_mtime)),
                    })
                except Exception:
                    pass
            self._send(200, {"ok": True, "saves": saves})

        elif path == "/api/save":
            slot = Path(query.get("slot", "")).name
            f = SAVES_DIR / f"{slot}.json"
            if not f.exists():
                return self._send(404, {"ok": False, "error": "存档不存在"})
            self._send(200, {"ok": True, "data": json.loads(f.read_text(encoding="utf-8"))})

        else:
            self._serve_static(path)

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self._read_body()

        if path == "/api/generate":
            cfg = load_config()
            # 测试连接：允许用任意 baseUrl/apiKey/model 临时覆盖
            test_cfg = body.get("_test")
            if isinstance(test_cfg, dict) and test_cfg.get("baseUrl"):
                cfg = {**cfg, **{k: v for k, v in test_cfg.items() if v}}
            if not llm_ready(cfg):
                return self._send(503, {
                    "ok": False,
                    "error": "LLM 未配置：请在开始界面「接口设置」填写，或手动创建 config.json",
                })
            messages = body.get("messages", [])
            if not messages:
                return self._send(400, {"ok": False, "error": "messages 不能为空"})
            payload = {
                "model": cfg["model"],
                "messages": messages,
                "temperature": body.get("temperature", 0.9),
                "max_tokens": body.get("max_tokens", 1600),
            }
            headers = {"Authorization": f"Bearer {cfg.get('apiKey', '')}"}
            try:
                t0 = time.time()
                result = http_post_json(cfg["baseUrl"].rstrip("/") + "/chat/completions", headers, payload)
                content = result["choices"][0]["message"]["content"]
                self._send(200, {"ok": True, "content": content, "elapsed": round(time.time() - t0, 1)})
            except RuntimeError as e:
                self._send(502, {"ok": False, "error": str(e)})
            except (KeyError, IndexError, TypeError):
                self._send(502, {"ok": False, "error": "上游返回格式异常，请检查 baseUrl/model 是否正确"})

        elif path == "/api/image":
            cfg = load_config()
            if not image_ready(cfg):
                return self._send(503, {"ok": False, "error": "图片接口未配置（config.json 中的 imageBaseUrl / imageModel）"})
            prompt = body.get("prompt", "").strip()
            if not prompt:
                return self._send(400, {"ok": False, "error": "prompt 不能为空"})
            payload = {"model": cfg["imageModel"], "prompt": prompt[:800], "n": 1, "size": body.get("size", "1024x1024")}
            # 尽量请求 b64，兼容不支持的服务
            payload["response_format"] = "b64_json"
            headers = {"Authorization": f"Bearer {cfg.get('imageApiKey', '')}"}
            try:
                result = http_post_json(cfg["imageBaseUrl"].rstrip("/") + "/images/generations", headers, payload, timeout=300)
                item = result["data"][0]
                b64 = item.get("b64_json") or ""
                url = item.get("url") or ""
                self._send(200, {"ok": True, "b64": b64, "url": url})
            except RuntimeError as e:
                # 某些服务不支持 response_format，去掉重试一次
                if "response_format" in str(e) or "HTTP 400" in str(e):
                    payload.pop("response_format", None)
                    try:
                        result = http_post_json(cfg["imageBaseUrl"].rstrip("/") + "/images/generations", headers, payload, timeout=300)
                        item = result["data"][0]
                        self._send(200, {"ok": True, "b64": item.get("b64_json", ""), "url": item.get("url", "")})
                        return
                    except RuntimeError as e2:
                        return self._send(502, {"ok": False, "error": str(e2)})
                self._send(502, {"ok": False, "error": str(e)})
            except (KeyError, IndexError, TypeError):
                self._send(502, {"ok": False, "error": "图片接口返回格式异常"})

        elif path == "/api/save":
            slot = Path(body.get("slot", "")).name
            if not slot:
                return self._send(400, {"ok": False, "error": "slot 不能为空"})
            data = body.get("data", {})
            f = SAVES_DIR / f"{slot}.json"
            f.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            self._send(200, {"ok": True, "slot": slot})

        elif path == "/api/config":
            # 保存 LLM 配置到 config.json（apiKey 为 **** 尾号时保留原值）
            new_cfg = body.get("config", {})
            old = load_config()
            merged = {
                "baseUrl": new_cfg.get("baseUrl", "").strip() or old.get("baseUrl", ""),
                "model": new_cfg.get("model", "").strip() or old.get("model", ""),
                "imageBaseUrl": new_cfg.get("imageBaseUrl", "").strip() or old.get("imageBaseUrl", ""),
                "imageModel": new_cfg.get("imageModel", "").strip() or old.get("imageModel", ""),
            }
            api_key = new_cfg.get("apiKey", "").strip()
            if api_key and not api_key.startswith("****"):
                merged["apiKey"] = api_key
                if new_cfg.get("imageApiKey", "").strip() and not new_cfg["imageApiKey"].startswith("****"):
                    merged["imageApiKey"] = new_cfg["imageApiKey"].strip()
            else:
                merged["apiKey"] = old.get("apiKey", "")
                merged["imageApiKey"] = old.get("imageApiKey", "")
            CONFIG_PATH.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
            self._send(200, {"ok": True, "model": merged.get("model", "")})

        else:
            self._send(404, {"ok": False, "error": "not found"})

    # ---- 静态文件 ----
    MIME = {
        ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
    }

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        # 防目录穿越
        rel = Path(path.lstrip("/")).as_posix()
        if ".." in rel or rel.startswith("/"):
            return self._send(403, {"ok": False, "error": "forbidden"})
        f = (STATIC_DIR / rel).resolve()
        try:
            f.relative_to(STATIC_DIR.resolve())
        except ValueError:
            return self._send(403, {"ok": False, "error": "forbidden"})
        if not f.is_file():
            return self._send(404, {"ok": False, "error": "not found"})
        ext = f.suffix.lower()
        ct = self.MIME.get(ext, "application/octet-stream")
        self._send(200, f.read_bytes(), content_type=ct)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    cfg = load_config()
    print("=" * 52)
    print("  LLM 文字冒险引擎")
    print(f"  目录   : {ROOT}")
    print(f"  地址   : http://127.0.0.1:{port}")
    print(f"  LLM    : {'已配置 -> ' + cfg['model'] if llm_ready(cfg) else '未配置（可在 config.json 填写）'}")
    print(f"  图片   : {'已配置 -> ' + cfg['imageModel'] if image_ready(cfg) else '未配置（可选）'}")
    print("=" * 52)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_mobile.py — 为 Capacitor 打包准备 web 资产
=================================================
做三件事：
  1. 清空 mobile/app/，复制 static/ 三件套（index.html/style.css/game.js）
  2. 读取根目录 config.json，生成 mobile/app/config.js（window.TA_CONFIG = {...}）
  3. 读取 worlds/*.json，生成 mobile/app/worlds.js（window.TA_WORLDS = {id: json}）

用法：python build_mobile.py
之后在 mobile/ 里 npx cap sync android。
"""

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
WORLDS = ROOT / "worlds"
APP_DIR = ROOT / "mobile" / "app"


def main():
    if not STATIC.is_dir():
        raise SystemExit("static/ 不存在")
    APP_DIR.mkdir(parents=True, exist_ok=True)

    # 1. 复制前端
    for name in ["index.html", "style.css", "game.js"]:
        src = STATIC / name
        if not src.is_file():
            raise SystemExit(f"缺少 {name}")
        shutil.copy2(src, APP_DIR / name)
        print(f"copied {name}")

    # 2. config.js —— 可分发模式：不打包真实 key，用户在 APP「接口设置」里自己填
    #    （如需自用免填版，把下面 dist_cfg 改为读 config.json 即可）
    dist_cfg = {}
    (APP_DIR / "config.js").write_text(
        "// 由 build_mobile.py 生成 —— 分发版不含 key，请在 APP 内「接口设置」填写\n"
        "window.TA_CONFIG = " + json.dumps(dist_cfg, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    print("generated config.js (distributable: no key embedded)")

    # 3. worlds.js
    worlds = {}
    for f in sorted(WORLDS.glob("*.json")):
        worlds[f.stem] = json.loads(f.read_text(encoding="utf-8"))
    (APP_DIR / "worlds.js").write_text(
        "// 由 build_mobile.py 生成 —— 打包进 APK 的世界剧本\n"
        "window.TA_WORLDS = " + json.dumps(worlds, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    print(f"generated worlds.js ({len(worlds)} worlds)")

    print("done -> %s" % APP_DIR)


if __name__ == "__main__":
    main()

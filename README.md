# 雾中人 · LLM 文字冒险引擎

一个零依赖的 LLM 文字冒险（Interactive Fiction）游戏：AI 担任 Game Master，
你自由输入行动，剧情实时演算，带数值状态、物品、NPC 关系、多结局与存档。

## 快速开始

```
1. 复制 config.json.example 为 config.json，填入任意 OpenAI 兼容接口
   （DeepSeek / 通义 / Kimi / OpenAI / 本地 Ollama 均可）
2. python server.py        # 需 Python 3.8+，无任何第三方依赖
3. 浏览器打开 http://127.0.0.1:8000
```

## Android 打包（Capacitor）

```
1. python build_mobile.py          # 生成 mobile/app/（前端 + config.js + worlds.js）
2. cd mobile && npx cap sync android
3. cd android && gradlew assembleDebug
   （需要 JDK 21 + Android SDK；本机 JAVA_HOME=D:\AppCode\java\java-21，
     SDK 在 D:\AppCode\Android\SDK，见 android/local.properties）
4. 产物：mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

APK 为「独立模式」：前端内嵌 8 个世界剧本与 LLM 配置（config.js），
通过 CapacitorHttp 直连 DeepSeek（无 CORS 问题），存档存 localStorage。
注意：config.js 里含 API key，APK 不要外发。改了 static/ 或 worlds/ 后
重复第 1、2、3 步即可重新打包。

config.json 示例：

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-xxxx",
  "model": "deepseek-chat",
  "imageBaseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "imageApiKey": "xxxx",
  "imageModel": "cogview-3-flash"
}
```

- `baseUrl` + `apiKey` + `model`：必填（对话生成）
- `imageBaseUrl` + `imageApiKey` + `imageModel`：可选（场景插图，游戏中点 🖼 按钮）
- 也可用环境变量代替：`TA_BASE_URL` / `TA_API_KEY` / `TA_MODEL`
- 指定端口：`python server.py 9000`

## 目录结构

```
llm-text-adventure/
├── server.py              # 后端：静态托管 + LLM 代理 + 存档（纯标准库）
├── config.json            # 你的 LLM 配置（自行创建，勿提交 git）
├── config.json.example    # 配置模板
├── static/
│   ├── index.html         # 界面结构
│   ├── style.css          # 水墨暗色主题
│   └── game.js            # 游戏核心逻辑（状态机 / JSON 解析 / 打字机 / 存档）
├── worlds/                # 世界剧本（JSON）
│   ├── mist_valley.json   # 雾隐谷 · 武侠怪谈
│   ├── station_elysium.json # 厄里斯号 · 太空心理惊悚
│   ├── linlan.json        # 临澜黑潮 · 民国克苏鲁
│   ├── neon_echo.json     # 霓洲回声 · 赛博朋克悬疑
│   ├── iron_crown.json    # 铁冠与灰烬 · 史诗奇幻
│   ├── abyss.json         # 无光深渊 · 深海密闭恐怖
│   ├── time_loop.json     # 时之回廊 · 时间循环悬疑
│   └── london_fog.json    # 雾都神探 · 蒸汽朋克侦探
└── saves/                 # 自动生成的存档目录
```

## 玩法

- 选世界 → 取名 → 调叙事风格（简练/均衡/沉浸）→ 启程
- 自由输入任何行动；金色词条是 GM 给你的提示
- 侧栏：❤ 体力 / ☯ 神智（归零即终局）· 行囊 · NPC 好感 · 当前目标
- 「幕后一瞥」：GM 泄露一句它正在安排的玄机（彩蛋）
- 💾 存档 / 📂 读档随时可用；🖼 可为当前场景生成插图（需配图片接口）

## 自制世界

在 `worlds/` 下新建 JSON 即可，字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 唯一标识（文件名需为 `<id>.json`） |
| `name` / `tagline` / `cover` / `difficulty` | ✓ | 选世界界面展示（cover 填一个 emoji） |
| `setting` | ✓ | 世界观正文，玩家可见的开场背景 |
| `gmLore` | ✓ | GM 幕后真相：凶手/秘密/线索链/分幕节奏，AI 据此推动剧情 |
| `npcs` | 建议 | `[{name, desc}]`，desc 里埋外貌线索 |
| `resources` | 建议 | 可用剧情资源清单（线索、道具、地点） |
| `initialState` | 建议 | 初始 hp/sanity/gold/物品/关系/目标 |
| `endingHints` | 建议 | good/neutral/bad/secret 四类结局的方向提示（会注入 GM 的 system prompt） |
| `currency` | 可选 | 货币单位名（默认「银两」，如「银元」「信用点」） |

## 技术要点

- 后端 500 行纯标准库：`http.server` + `urllib`，转发 OpenAI 兼容
  `/chat/completions` 与 `/images/generations`
- 前端对 LLM 输出做四层兜底解析（整体 → 代码块 → 括号配平 → 正则抓字段），
  优先使用**支持 JSON 输出的模型**（DeepSeek / Kimi / GLM 等）体验最佳
- 坏输出自动让模型重试一次，仍失败则降级为纯文本叙事，不会卡死游戏
- 打字机逐字渲染、存档为服务端 JSON 文件、世界文件热加载（重进即生效）
- 沉浸层：每世界独立主题色与 Canvas 氛围粒子（雾隐谷金尘萤火 / 厄里斯号星点
  流星 / 临澜冷雨丝 / 霓洲霓虹浮光）、暗角与噪点纹理、低血量红晕脉动、
  低神智画面扭曲、受击数值闪烁
- 音效：Web Audio 全合成（无音频素材）——每世界环境音（风声/深空低鸣/雨声/
  霓虹 pad）+ 事件音（受击/神智受损/得物/新幕/结局钟声），顶栏 🔊 开关，
  偏好存 localStorage
- 自动插图：GM 每幕输出 sceneForImage（英文绘画提示词），每 3 幕自动生成
  一幅该世界美术风格的场景图（失败静默跳过）；🖼 按钮可随时手动生成

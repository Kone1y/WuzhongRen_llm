/* ============================================================
   雾中人 · LLM 文字冒险引擎 - 前端核心
   ============================================================ */

"use strict";

/* ---------------- 全局状态 ---------------- */

const S = {
  screen: "start",        // start | game
  world: null,            // 当前世界 JSON
  playerName: "",
  style: 1,               // 0 简练 1 均衡 2 沉浸
  turn: 0,
  history: [],            // [{role, content}] 发给 LLM 的消息（含 system）
  displayLog: [],         // 渲染用日志 [{type, html, ...}]
  stats: { hp: 100, sanity: 100, gold: 10 },
  inventory: [],
  relations: [],
  objectives: [],
  gmNote: "",
  ending: null,
  busy: false,
  ended: false,
  worldCardSel: null,
};

const STYLE_PROMPTS = [
  "叙事风格：简练明快，每段 2-3 句话，节奏快。",
  "叙事风格：均衡，每段 3-5 句话，叙事与氛围兼顾。",
  "叙事风格：沉浸细腻，注重五感描写与环境氛围，每段 4-6 句话。",
];

const $ = (id) => document.getElementById(id);

/* ---------------- 运行模式：web(走 server.py) / native(APK 直连) ---------------- */

const RUNTIME = {
  native: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()),
  cfg: window.TA_CONFIG || null,   // native 模式由 config.js 注入 {baseUrl, apiKey, model, imageBaseUrl, imageApiKey, imageModel}
  worlds: window.TA_WORLDS || null, // native 模式由 worlds.js 注入 {worldId: worldJson}
};

/* ---------------- API（双模式统一入口） ---------------- */

async function api(path, opts = {}) {
  if (RUNTIME.native) return nativeApi(path, opts);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({ ok: false, error: "响应解析失败" }));
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  return data;
}

/* native：CapacitorHttp 直连上游 + localStorage 存档 + 内嵌世界 */
async function nativeApi(path, opts = {}) {
  const body = opts.body ? JSON.parse(opts.body) : {};
  const query = Object.fromEntries(new URLSearchParams(path.split("?")[1] || ""));

  if (path.startsWith("/api/health")) {
    const c = effectiveCfg();
    return { ok: true, llm: !!(c.baseUrl && c.model && (c.apiKey || RUNTIME.cfg?.apiKey)), image: !!(c.imageBaseUrl && c.imageModel), model: c.model || "" };
  }

  if (path.startsWith("/api/worlds")) {
    const worlds = Object.values(RUNTIME.worlds || {}).map((w) => ({
      id: w.id, name: w.name, tagline: w.tagline, cover: w.cover, difficulty: w.difficulty,
    }));
    return { ok: true, worlds };
  }

  if (path.startsWith("/api/world")) {
    let w = (RUNTIME.worlds || {})[query.world];
    if (!w) {
      // 工坊自定义世界（localStorage）
      try {
        const col = JSON.parse(localStorage.getItem("ta_custom_worlds") || "{}");
        w = col[query.world];
      } catch (e) {}
    }
    return w ? { ok: true, world: w } : { ok: false, error: `世界不存在: ${query.world}` };
  }

  if (path.startsWith("/api/generate")) {
    const c = { ...(RUNTIME.cfg || {}), ...effectiveCfg() };
    if (!c.baseUrl || !c.model) return { ok: false, error: "未配置 LLM 接口：请到「接口设置」填写 API 地址 / Key / 模型名" };
    if (body._test) Object.assign(c, body._test); // 测试连接：临时覆盖
    return capHttpPost(c.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      model: c.model,
      messages: body.messages,
      temperature: body.temperature ?? 0.9,
      max_tokens: body.max_tokens ?? 1600,
    }, c.apiKey).then((result) => {
      // 解包 OpenAI 兼容响应：choices[0].message.content（兼容 content 为数组的推理模型）
      let content = result?.choices?.[0]?.message?.content;
      if (Array.isArray(content)) {
        content = content.map((seg) => (typeof seg === "string" ? seg : seg?.text || "")).join("");
      }
      if (typeof content !== "string") {
        return { ok: false, error: "上游返回缺少 content（响应：" + JSON.stringify(result).slice(0, 150) + "）" };
      }
      return { ok: true, content, elapsed: 0 };
    }).catch((e) => ({ ok: false, error: e.message }));
  }

  if (path.startsWith("/api/image")) {
    const c = RUNTIME.cfg;
    if (!c || !c.imageBaseUrl || !c.imageModel) return { ok: false, error: "图片接口未配置（config.js）" };
    return capHttpPost(c.imageBaseUrl.replace(/\/$/, "") + "/images/generations", {
      model: c.imageModel,
      prompt: (body.prompt || "").slice(0, 800),
      n: 1,
      size: body.size || "1024x1024",
      response_format: "b64_json",
    }, c.imageApiKey).then((result) => {
      const item = result?.data?.[0] || {};
      return { ok: true, b64: item.b64_json || "", url: item.url || "" };
    }).catch((e) => ({ ok: false, error: e.message }));
  }

  if (path.startsWith("/api/saves")) {
    const saves = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.startsWith("ta_save_")) continue;
      try {
        const d = JSON.parse(localStorage.getItem(key));
        saves.push({ slot: key.slice(8), world: d.worldName, player: d.player, turn: d.turn, time: (d.savedAt || "").replace("T", " ").slice(0, 16) });
      } catch (e) {}
    }
    saves.sort((a, b) => (b.time || "").localeCompare(a.time || ""));
    return { ok: true, saves };
  }

  if (path.startsWith("/api/save") && opts.method === "POST") {
    try {
      localStorage.setItem("ta_save_" + body.slot, JSON.stringify({ ...body.data, savedAt: new Date().toISOString() }));
      return { ok: true, slot: body.slot };
    } catch (e) {
      return { ok: false, error: "存档失败：" + e.message };
    }
  }

  if (path.startsWith("/api/save")) { // GET ?slot=xx
    const raw = localStorage.getItem("ta_save_" + query.slot);
    if (!raw) return { ok: false, error: "存档不存在" };
    return { ok: true, data: JSON.parse(raw) };
  }

  return { ok: false, error: "native 模式不支持: " + path };
}

async function capHttpPost(url, payload, apiKey) {
  const { CapacitorHttp } = window.Capacitor.Plugins;
  const res = await CapacitorHttp.request({
    url, method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (apiKey || "") },
    data: payload,
    connectTimeout: 30000,   // 连接 30s
    readTimeout: 300000,     // 读取 5 分钟（工坊大剧本生成慢）
  });
  if (res.status >= 400) throw new Error(`上游 HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  return res.data;
}

async function generate(messages, extra = {}) {
  const data = await api("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, ...extra }),
  });
  if (!data.ok) throw new Error(data.error || "生成失败");
  return data.content;
}

/* ---------------- 健壮的 JSON 提取 ---------------- */

function extractJSON(text) {
  if (!text) return null;
  // 去掉推理模型可能的 <think> 块
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // 1) 直接整体解析
  try { return JSON.parse(text); } catch (e) {}
  // 2) ```json ... ``` 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (e) {}
  }
  // 3) 括号配平：找第一个 { 或 [，向后配平
  const start = text.search(/[{[]/);
  if (start >= 0) {
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch (e) {}
          break;
        }
      }
    }
  }
  // 4) 宽松兜底：正则抓字段（至少保底 narration）
  const grab = (key) => {
    const m = text.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', "m"));
    return m ? m[1] : null;
  };
  const narration = grab("narration");
  if (narration) return { narration };
  return null;
}

/* ---------------- 世界加载 ---------------- */

async function loadWorlds() {
  const box = $("worldList");
  try {
    const data = await api("/api/worlds");
    if (!data.ok) throw new Error(data.error);
    // 合并工坊自定义世界
    const col = collectionGet();
    const customs = Object.values(col.worlds || {}).map((w) => ({
      id: w.id, name: w.name, tagline: w.tagline, cover: w.cover, difficulty: w.difficulty, custom: true,
    }));
    const all = [...data.worlds, ...customs];
    if (!all.length) {
      box.innerHTML = '<div class="loading-hint">没有找到世界剧本（worlds/ 目录为空）</div>';
      return;
    }
    box.innerHTML = "";
    all.forEach((w) => {
      const card = document.createElement("div");
      card.className = "world-card";
      card.innerHTML = `
        <div class="world-emoji">${w.cover || "❖"}</div>
        <div class="world-info">
          <div class="world-name">${esc(w.name)}${w.custom ? ' <span class="empty" style="font-size:10px">工坊</span>' : ""}</div>
          <div class="world-tagline">${esc(w.tagline)}</div>
          ${w.difficulty ? `<span class="world-diff">${esc(w.difficulty)}</span>` : ""}
        </div>`;
      card.onclick = () => {
        box.querySelectorAll(".world-card").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
        gotoDetail(w.id);
      };
      box.appendChild(card);
    });
  } catch (e) {
    box.innerHTML = `<div class="loading-hint">无法连接服务器，请确认 server.py 已运行</div>`;
  }
}

/* ---------------- 开始游戏 ---------------- */

/* ---------------- 开始流程：四段式导航 ---------------- */

const START_SCREENS = ["titleScreen", "pickScreen", "detailScreen", "nameScreen", "forgeScreen", "settingsScreen"];

function showStartScreen(id) {
  START_SCREENS.forEach((s) => $(s).classList.toggle("hidden", s !== id));
}

function gotoTitle() { showStartScreen("titleScreen"); }
function gotoPick() {
  loadWorlds(); // 每次进入都刷新：工坊新铸的世界、删除的世界即时反映
  showStartScreen("pickScreen");
}

/* 取世界数据：server/内嵌优先，工坊自定义世界（localStorage）兜底 —— web/native 通吃 */
async function fetchWorld(worldId) {
  const data = await api(`/api/world?world=${encodeURIComponent(worldId)}`);
  if (data.ok && data.world) return data;
  try {
    const col = JSON.parse(localStorage.getItem("ta_custom_worlds") || "{}");
    if (col[worldId]) return { ok: true, world: col[worldId] };
  } catch (e) {}
  return data; // 原始错误
}

let _detailWorld = null;

async function gotoDetail(worldId) {
  showStartScreen("detailScreen");
  const body = $("detailBody");
  body.innerHTML = '<div class="loading-hint">读取世界设定中……</div>';
  try {
    const data = await fetchWorld(worldId);
    if (!data.ok) throw new Error(data.error);
    const w = data.world;
    _detailWorld = w;
    S.worldCardSel = worldId;
    // 预览该世界主题色（进入详情即切换氛围）
    document.body.className = "world-" + (worldId || "default");
    fxSetWorld(worldId);
    $("detailName").textContent = w.name;
    // setting 截断到 ~260 字，保留悬念
    const setting = String(w.setting || "");
    const cut = setting.length > 260 ? setting.slice(0, 260).replace(/[，。；,;\s]+$/, "") + "……" : setting;
    const cast = (w.npcs || []).slice(0, 4).map((n) => {
      // NPC 描述只保留第一句，制造悬念
      const firstSentence = String(n.desc || "").split(/[。！？!?]/)[0] + "。";
      return `<li><b>${esc(n.name)}</b>：${esc(firstSentence)}</li>`;
    }).join("");
    body.innerHTML = `
      <div class="detail-emoji">${w.cover || "❖"}</div>
      <p class="detail-tagline">${esc(w.tagline || "")}</p>
      <div class="detail-diff"><span>${esc(w.difficulty || "")}</span></div>
      <p class="detail-setting">${esc(cut)}<span class="more">（更多的秘密，留给进入的人）</span></p>
      ${cast ? `<div class="detail-cast"><h4>此界之人</h4><ul class="cast-list">${cast}</ul></div>` : ""}
    `;
  } catch (e) {
    body.innerHTML = `<div class="loading-hint">读取失败：${esc(e.message || "")}</div>`;
  }
}

function gotoName() {
  // 渲染出身选择
  const list = $("originList");
  const origins = (_detailWorld && _detailWorld.origins) || [];
  S.originSel = null;
  if (!origins.length) {
    list.innerHTML = '<div class="loading-hint">此世界无出身分支</div>';
  } else {
    list.innerHTML = "";
    origins.forEach((o, i) => {
      const card = document.createElement("div");
      card.className = "origin-card" + (i === 0 ? " selected" : "");
      card.innerHTML = `
        <div class="origin-name">${esc(o.name)}</div>
        <div class="origin-desc">${esc(o.desc || "")}</div>`;
      card.onclick = () => {
        list.querySelectorAll(".origin-card").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
        S.originSel = o;
      };
      list.appendChild(card);
    });
    S.originSel = origins[0];
  }
  $("nameWorldHint").textContent = _detailWorld ? `即将进入：${_detailWorld.name}` : "";
  // 难度默认标准
  S.difficulty = 1;
  document.querySelectorAll("#diffSeg .diff-btn").forEach((b) => {
    b.classList.toggle("selected", b.dataset.d === "1");
  });
  showStartScreen("nameScreen");
}

async function startGame() {
  const err = $("startError");
  err.textContent = "";
  const name = $("playerName").value.trim() || "无名客";

  // 检查 LLM 配置
  try {
    const h = await api("/api/health");
    if (!h.llm) {
      err.textContent = "LLM 未配置：请先到「接口设置」填写 API Key";
      setTimeout(() => gotoSettings(), 1200);
      return;
    }
  } catch (e) {
    err.textContent = RUNTIME.native ? "初始化失败" : "无法连接服务器，请确认 server.py 已运行";
    return;
  }

  $("btnStart").disabled = true;
  $("btnStart").textContent = "推演中……";

  try {
    const data = await fetchWorld(S.worldCardSel);
    if (!data.ok) throw new Error(data.error);
    S.world = data.world;
    S.playerName = name;
    S.style = parseInt($("styleRange").value, 10);
    applyWorldTheme(S.world.id);
    initGameState();
    await runFirstScene();
    switchScreen("game");
  } catch (e) {
    err.textContent = e.message || "启动失败";
  } finally {
    $("btnStart").disabled = false;
    $("btnStart").textContent = "启 程";
  }
}

function initGameState() {
  const w = S.world;
  S.turn = 0;
  S.history = [];
  S.displayLog = [];
  S.chronicle = [];
  S.clues = [];
  S.companions = [];
  S.titles = [];
  S.checkWins = 0;
  S.ended = false;
  S.ending = null;
  S.gmNote = "";
  // 多周目残忆：本世界通关过则带记忆
  S.echoMemory = "";
  try {
    const col = JSON.parse(localStorage.getItem("ta_endings") || "{}");
    const rec = col[w.id];
    if (rec && rec.seen && rec.seen.length) S.echoMemory = rec.seen[0].title;
  } catch (e) {}
  const init = w.initialState || {};
  S.stats = {
    hp: init.hp ?? 100,
    sanity: init.sanity ?? 100,
    gold: init.gold ?? 10,
  };
  S.inventory = (init.inventory || []).map((x) => ({ name: x, isNew: false }));
  S.relations = (init.relations || []).map((r) => ({ ...r }));
  S.objectives = (init.objectives || []).map((o) => (typeof o === "string" ? { text: o, done: false } : { ...o }));
  // 出身覆盖：属性偏移 + 追加物品 + 合并关系
  if (S.originSel) {
    const o = S.originSel;
    const os = o.stats || {};
    if (os.hp) S.stats.hp = Math.min(120, S.stats.hp + (os.hp - 100));
    if (os.sanity) S.stats.sanity = Math.min(110, S.stats.sanity + (os.sanity - 100));
    if (os.gold) S.stats.gold += Math.max(0, os.gold - 20);
    (o.items || []).forEach((it) => { if (!S.inventory.find((x) => x.name === it)) S.inventory.push({ name: it, isNew: false }); });
    (o.relations || []).forEach((r) => {
      const exist = S.relations.find((x) => x.name === r.name);
      if (exist) Object.assign(exist, r);
      else S.relations.push({ ...r });
    });
  }
  $("charName").textContent = S.playerName;
  renderSide({ hp: 999, sanity: 999 }); // 初始化不触发受击闪烁
}

/* ---------------- System Prompt ---------------- */

function buildSystemPrompt() {
  const w = S.world;
  return `你是一个顶级文字冒险游戏的 Game Master（游戏主持人）。玩家在玩一个中文互动小说游戏。

【世界观设定】
${w.setting || w.tagline}

【GM 幕后设定（玩家不可见，你据此推动剧情）】
${w.gmLore || "（无）"}

【重要 NPC】
${(w.npcs || []).map((n) => `- ${n.name}：${n.desc}`).join("\n") || "（无）"}

【可用剧情资源】
${(w.resources || []).map((r) => `- ${r}`).join("\n") || "（无）"}

【玩家】姓名：${S.playerName}
${S.originSel ? `出身：${S.originSel.name} —— ${S.originSel.desc}
（出身影响：${S.originSel.gmHint || "剧情应体现其专业背景"}）` : ""}

【结局方向指引】（据此安排 ending 时机与内容）
${Object.entries(w.endingHints || {}).map(([k, v]) => `- ${k}：${v}`).join("\n") || "（无特别指引，自行安排合理结局）"}

【硬性规则】
1. 你是沉浸式叙事者，用第二人称"你"称呼玩家，文风与世界观一致。
2. 每次回复必须且只能输出一个 JSON 对象，不要输出任何 JSON 之外的文字（包括代码块标记、解释、问候）。
3. 剧情要有真实的因果与后果：玩家的选择会改变走向，世界不围着玩家转。
4. 适度挑战玩家，但不刻意杀死玩家；hp 或 sanity 归 0 时触发 ending。
5. 数值变动要合理克制（每次 0~25），物品与银两增减需符合剧情。
6. narration 内部用 \\n\\n 分段，可用 <em>词</em> 强调关键事物。
7. suggestions 给 3 个有代入感的行动建议（第一人称或短语，不超 12 字）。
8. gmNote 是给玩家"幕后一瞥"的彩蛋，用一句俏皮话点破你安排的玄机，不要剧透未来剧情。
9. ${STYLE_PROMPTS[S.style]}
10. 检定规则：当玩家尝试有不确定性或有风险的关键行动（攀爬、说服、潜行、破译、格斗等）时，输出 check 字段做一次检定。检定时你先心中判定难度 DC（6 简单/10 常规/14 困难/18 极难），再在 1-20 里掷骰，结合玩家出身与状态给出 roll（优势出身可 +3~+5）。check.success 决定剧情走向：成功则叙述成功的结果，失败则给出有代价的失败（不是必死，但要有后果）。普通对话、观察、移动不需要检定，不要滥用（每 2~4 幕一次为宜）。${S.companions && S.companions.length ? "当前有伙伴同行，凡与其专长相关的检定 roll 可 +2（伙伴加值），narration 里体现伙伴的协助。" : ""}
11. chronicle 字段：用一句 15 字以内的话记录本幕发生的关键事件（如「查明掌柜死于子时前」），平淡幕给空字符串。它将编入玩家的旅程编年史。
12. clue 字段：本幕若揭开了值得记录的调查线索（物证、口供矛盾、异象规律等），输出一张线索卡 {name:"线索名(≤6字)", desc:"一句话说明"}。平淡幕给 null。线索会拼进玩家的线索墙。
13. companion 字段：仅当剧情自然出现可同行的 NPC 且玩家表达过同行意愿时输出 {name, action:"join|leave|loyalty", note:"一句话"}：join=入队 / leave=离队（忠诚崩塌或剧情需要）/ loyalty=忠诚度变化（note 里说明升降与原因）。同伴的加入必须谨慎：一个世界最多 2 名，要有情感或利益的基础。
14. 物品使用与交易：玩家在 suggestions 或自由输入中要求使用/细看/丢弃物品、向 NPC 购买情报物品服务、讨价还价时，认真给出剧情后果（用错物品会有代价，讲价成功可打折）。涉及银两变动走 stateDelta.gold，涉及物品走 itemGained/itemLost。
15. 随机遭遇：若本幕的 user 消息带有【随机遭遇】标记，从世界剧情资源里就地取材写一段支线（奇遇/危机/神秘商人/旧识重逢，任选其一），要与主线若即若离。
16. ${S.difficulty === 0 ? "当前为【故事模式】：检定 DC 一律 -2，且玩家 hp/sanity 最低保留 5 点不归零（不会死），结局只走向 good 或 neutral，尽情给温情与冒险。" : S.difficulty === 2 ? "当前为【硬核模式】：检定 DC +2，hp/sanity 归零即死（真实输出 ending），物品银两稀缺，NPC 不轻易施援。残酷但真实。" : "当前为【标准模式】：常规难度。"}
${S.echoMemory ? `17. 【残忆】玩家已在此世界通关过（达成结局「${S.echoMemory}」）。本局让 1~2 位关键 NPC 对玩家有似曾相识之感（一句台词点到即止，不必解释），并在适当时机（第 5 幕后）给一段只有二周目才会出现的隐藏对话。玩家的检定因残忆 +1。` : ""}

【输出 JSON 格式】
{
  "narration": "……（正文，80~350字）",
  "suggestions": ["行动1", "行动2", "行动3"],
  "stateDelta": { "hp": 0, "sanity": 0, "gold": 0 },
  "itemGained": ["物品名"],
  "itemLost": ["物品名"],
  "relations": [ { "name": "NPC名", "attitude": "neutral|positive|negative", "note": "一句话" } ],
  "objectives": [ { "text": "目标", "done": false } ],
  "check": null,
  "clue": null,
  "companion": null,
  "chronicle": "本幕大事记（15字内，无事则空）",
  "gmNote": "幕后一瞥",
  "location": "当前地点",
  "sceneForImage": "将本幕画面压缩成一句英文绘画提示词（如：a lone lantern in misty ancient chinese courtyard, night, rain），没有合适画面时给空字符串",
  "ending": null
}

【check 字段】仅在需要检定时输出：
{ "stat": "身手|心智|社交|学识 之一", "dc": 12, "roll": 15, "success": true, "desc": "翻墙潜入后院" }
narration 中不要重复检定结果，把成败融进叙事即可。

【ending 字段】当 hp/sanity 归零、或剧情自然走到上述结局方向之一时，ending 填：
{ "type": "good|bad|neutral|secret", "title": "结局标题", "text": "终章描述（120~300字）" }
其余情况 ending 必须为 null。一旦 ending 非 null，游戏结束。不要仓促给结局：至少 8 幕之后再考虑收束。`;
}

/* ---------------- 主回合 ---------------- */

async function runFirstScene() {
  appendDivider(`序章 · ${S.world.name}`);
  await callGM(`（游戏开始。请以 ${S.playerName} 的视角，写出这个世界对 ${S.playerName} 的开场第一幕：交代地点、处境、氛围，并在结尾留下钩子。）`, true);
}

async function playerAct(text) {
  if (S.busy || S.ended) return;
  S.busy = true;
  appendPlayer(text);
  $("suggestions").innerHTML = "";
  // 随机遭遇：第 4 幕起，每次玩家行动 30% 概率触发支线（同世界资源就地取材）
  let msg = text;
  if (S.turn >= 3 && S.turn % 5 === 4 && Math.random() < 0.3) {
    msg = text + "\n（【随机遭遇】请在主线推进前插入一段支线遭遇，写完再回应玩家的行动。）";
    toast("⚑ 似乎有什么要发生了……");
  }
  await callGM(msg);
  S.busy = false;
}

async function callGM(userText, isIntro = false) {
  if (S.turn === 0) {
    S.history.push({ role: "system", content: buildSystemPrompt() });
  }
  S.history.push({ role: "user", content: userText });

  // 上下文压缩：对话超过 30 条时，把 system 后最早的一段折叠成回忆摘要
  await maybeCompressHistory();

  const holder = appendNarrationHolder();
  await typewriterLoading(holder);

  let content, parsed;
  let retries = 0;
  while (true) {
    try {
      content = await generate(S.history);
    } catch (e) {
      holder.innerHTML = "";
      appendMsg("err", `⚠ ${e.message}`);
      S.history.pop();
      S.busy = false;
      return;
    }
    parsed = extractJSON(content);
    if (parsed && parsed.narration) break;
    // JSON 坏了，让模型重试一次
    retries++;
    if (retries >= 2) {
      // 两次都失败：把原文当纯文本展示
      holder.innerHTML = "";
      appendMsg("narration", textToHtml(content || "（一阵浓雾掠过，什么也看不见……请重试）"));
      S.history.pop();
      S.busy = false;
      return;
    }
    S.history.push({ role: "assistant", content });
    S.history.push({ role: "user", content: "你刚才的输出不是合法 JSON（或缺少 narration 字段）。请重新输出，只输出 JSON 对象本身。" });
  }

  S.history.push({ role: "assistant", content });
  S.turn++;
  applyDelta(parsed);
  sndEvent("turn");
  await renderTurn(parsed, holder);
}

let _prevStatsBeforeRender = null;

function applyDelta(p) {
  _prevStatsBeforeRender = { ...S.stats };
  // stateDelta
  const d = p.stateDelta || {};
  if (typeof d.hp === "number") S.stats.hp = clamp(S.stats.hp + d.hp, 0, 100);
  if (typeof d.sanity === "number") S.stats.sanity = clamp(S.stats.sanity + d.sanity, 0, 100);
  if (typeof d.gold === "number") S.stats.gold = Math.max(0, S.stats.gold + d.gold);

  // items
  (p.itemGained || []).forEach((n) => {
    if (!S.inventory.find((i) => i.name === n)) S.inventory.push({ name: n, isNew: true });
  });
  (p.itemLost || []).forEach((n) => {
    const idx = S.inventory.findIndex((i) => i.name === n);
    if (idx >= 0) S.inventory.splice(idx, 1);
  });

  // relations（按 name 合并）
  (p.relations || []).forEach((r) => {
    if (!r || !r.name) return;
    const exist = S.relations.find((x) => x.name === r.name);
    if (exist) Object.assign(exist, r);
    else S.relations.push({ ...r });
  });

  // objectives（整体替换，保留 done 状态）
  if (Array.isArray(p.objectives) && p.objectives.length) {
    S.objectives = p.objectives.map((o) => {
      if (typeof o === "string") return { text: o, done: false };
      const old = S.objectives.find((x) => x.text === o.text);
      return { text: o.text, done: o.done ?? (old ? old.done : false) };
    });
  }

  if (p.location) $("locationText").textContent = p.location;
  if (p.gmNote) S.gmNote = p.gmNote;
  if (S.world && S.world.currency) {
    document.querySelector(".coin-row span:first-child").textContent = `✦ ${S.world.currency}`;
  }
  renderSide(_prevStatsBeforeRender);
}

async function renderTurn(p, holder) {
  // 检定骰子行（打字机前先掷骰，制造悬念）
  if (p.check && p.check.stat) {
    renderCheck(p.check);
  }
  // 打字机
  const paras = String(p.narration).split(/\n{2,}/).filter(Boolean);
  holder.innerHTML = "";
  for (const para of paras) {
    const el = document.createElement("p");
    holder.appendChild(el);
    await typewriter(el, mdInline(para), 14);
  }
  // sys 提示（数值/物品变化）
  const sysMsgs = [];
  const d = p.stateDelta || {};
  if (d.hp) sysMsgs.push(`体力 ${d.hp > 0 ? "+" : ""}${d.hp}`);
  if (d.sanity) sysMsgs.push(`神智 ${d.sanity > 0 ? "+" : ""}${d.sanity}`);
  if (d.gold) sysMsgs.push(`${S.world.currency || "银两"} ${d.gold > 0 ? "+" : ""}${d.gold}`);
  if (sysMsgs.length) appendMsg("sys", sysMsgs.join(" · "));
  (p.itemGained || []).forEach((n) => { appendMsg("sys", `获得「${esc(n)}」`); sndEvent("item"); vibrate(40); });
  (p.itemLost || []).forEach((n) => appendMsg("sys", `失去「${esc(n)}」`));

  // 编年史
  const chron = String(p.chronicle || "").trim();
  if (chron) {
    S.chronicle.push({ turn: S.turn, text: chron });
  }

  // 线索墙
  if (p.clue && p.clue.name && !S.clues.find((c) => c.name === p.clue.name)) {
    S.clues.push({ name: String(p.clue.name).slice(0, 8), desc: String(p.clue.desc || "").slice(0, 60) });
    appendMsg("sys", `🔍 线索入墙「${esc(S.clues[S.clues.length - 1].name)}」`);
    sndEvent("item");
    vibrate(40);
    if (S.clues.length >= 5 && S.clues.length % 5 === 0) {
      appendMsg("sys", `✦ 已集 ${S.clues.length} 条线索，真相渐明……`);
    }
    renderSide();
  }

  // 伙伴
  if (p.companion && p.companion.name) {
    const c = p.companion;
    if (c.action === "join" && !S.companions.find((x) => x.name === c.name) && S.companions.length < 2) {
      S.companions.push({ name: String(c.name).slice(0, 8), note: String(c.note || "").slice(0, 40), loyalty: 2 });
      appendMsg("sys", `🤝 ${esc(S.companions[S.companions.length - 1].name)} 加入了你的旅程`);
      sndEvent("item");
      renderSide();
    } else if (c.action === "leave") {
      const idx = S.companions.findIndex((x) => x.name === c.name);
      if (idx >= 0) {
        S.companions.splice(idx, 1);
        appendMsg("sys", `👋 ${esc(c.name)} 离开了：${esc(String(c.note || "").slice(0, 30))}`);
        renderSide();
      }
    } else if (c.action === "loyalty") {
      const one = S.companions.find((x) => x.name === c.name);
      if (one) {
        const up = !/降|跌|减|失|离/.test(c.note || "");
        one.loyalty = Math.max(0, Math.min(5, one.loyalty + (up ? 1 : -1)));
        appendMsg("sys", `${up ? "💚" : "💔"} ${esc(c.name)} 的信任${up ? "加深" : "动摇"}了（${one.loyalty}/5）`);
        if (one.loyalty === 0) appendMsg("sys", `⚠ ${esc(c.name)} 去意已决……`);
        renderSide();
      }
    }
  }

  // 检定胜场 → 称号
  if (p.check && p.check.success) {
    S.checkWins = (S.checkWins || 0) + 1;
    if (S.checkWins === 5) grantRunTitle("神探", "连续推理验案，五次检定全胜");
  }
  if (S.inventory.length >= 8 && !S.titles.find((t) => t.name === "收藏家")) grantRunTitle("收藏家", "随身之物达八件");
  if (S.turn >= 12 && S.companions.length === 0 && !S.titles.find((t) => t.name === "孤狼")) grantRunTitle("孤狼", "十二幕独行无人同行");

  // 建议
  renderSuggestions(p.suggestions || []);

  // 结局判定
  if (p.ending && p.ending.title) {
    S.ended = true;
    showEnding(p.ending);
  } else if (S.stats.hp <= 0 || S.stats.sanity <= 0) {
    if (S.difficulty === 0) {
      // 故事模式：保命
      S.stats.hp = Math.max(5, S.stats.hp);
      S.stats.sanity = Math.max(5, S.stats.sanity);
      appendMsg("sys", "（故事模式：命悬一线，但命运仍留了一线）");
      renderSide();
    } else {
      S.ended = true;
      showEnding({
        type: "bad",
        title: S.stats.hp <= 0 ? "形销骨立" : "神魂俱灭",
        text: `${S.playerName} 的旅程在此戛然而止。雾散了，故事却没能等来它的结局。${S.difficulty === 2 ? "\n\n（硬核模式：没有重来。）" : ""}`,
      });
    }
  }
  $("turnBadge").textContent = `第 ${S.turn + 1} 幕`;
  renderSide(_prevStatsBeforeRender);
  maybeAutoImage(p); // 异步插图，不阻塞
  maybeAutoSave();   // 每 3 幕自动存档
}

/* ---------------- 重新推演 ---------------- */

async function retryTurn() {
  if (S.busy || S.ended || S.turn === 0) { if (S.turn === 0) toast("还没有可重推的幕"); return; }
  S.busy = true;
  // 弹掉最后一对 user/assistant（保留 system 与 recap）
  let lastUser = null;
  for (let i = S.history.length - 1; i >= 0; i--) {
    if (S.history[i].role === "assistant") { S.history.splice(i, 1); continue; }
    if (S.history[i].role === "user") { lastUser = S.history.splice(i, 1)[0]; break; }
  }
  if (!lastUser) { S.busy = false; return; }
  // 移除界面上最后一个玩家气泡 + 最后一个叙事块
  const log = $("storyLog");
  const msgs = log.querySelectorAll(".msg");
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.classList.contains("player") || m.classList.contains("narration")) { m.remove(); break; }
  }
  S.turn--;
  $("turnBadge").textContent = `第 ${S.turn + 1} 幕`;
  toast("命运重新洗牌……");
  // 以稍高随机度重推
  await callGM(lastUser.content, true);
  S.busy = false;
}

/* ---------------- 自动存档 + 断点续玩 ---------------- */

async function maybeAutoSave() {
  if (S.ended || S.turn === 0 || S.turn % 3 !== 0) return;
  if (S.difficulty === 2) return; // 硬核模式：无自动存档，命只有一条
  try {
    await api("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: "auto_" + S.playerName + "_" + (S.world ? S.world.id : "x"), data: { ...saveData(), auto: true } }),
    });
  } catch (e) { /* 自动存档失败静默 */ }
}

function checkAutoSaveBanner() {
  const banner = $("resumeBanner");
  if (!banner) return;
  api("/api/saves").then((data) => {
    if (!data.ok) return;
    const auto = data.saves.find((s) => s.slot && s.slot.startsWith("auto_"));
    if (auto && auto.turn > 0) {
      banner.classList.remove("hidden");
      banner.querySelector(".resume-text").textContent = `继续上次旅程：${auto.player} · ${auto.world} 第 ${auto.turn + 1} 幕`;
      banner.onclick = () => {
        banner.classList.add("hidden");
        loadSave(auto.slot, true);
      };
    } else {
      banner.classList.add("hidden");
    }
  }).catch(() => {});
}

/* ---------------- 检定骰子 ---------------- */

function renderCheck(check) {
  const log = $("storyLog");
  const div = document.createElement("div");
  div.className = "check-roll " + (check.success ? "check-ok" : "check-fail");
  const stat = esc(check.stat || "检定");
  const dc = check.dc ?? "?";
  const desc = esc(check.desc || "");
  div.innerHTML = `<span class="check-stat">${stat}</span> 检定 <span class="check-dc">DC ${dc}</span> ${desc ? `<span class="check-desc">${desc}</span>` : ""} <span class="check-result">掷骰中…</span>`;
  log.appendChild(div);
  scrollBottom();
  // 骰子滚动动画
  const resultEl = div.querySelector(".check-result");
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    resultEl.textContent = `🎲 ${1 + Math.floor(Math.random() * 20)}`;
    if (ticks >= 10) {
      clearInterval(timer);
      const final = check.roll ?? "?";
      resultEl.innerHTML = `掷出 <b>${final}</b> ${check.success ? "✓ 成功" : "✗ 失败"}`;
      div.classList.add("done");
      sndEvent(check.success ? "item" : "sanity");
      vibrate(check.success ? 50 : [50, 50, 50]);
      scrollBottom();
    }
  }, 60);
}

/* ---------------- 局内称号 ---------------- */

function grantRunTitle(name, desc) {
  if (!S.titles) S.titles = [];
  if (S.titles.find((t) => t.name === name)) return;
  S.titles.push({ name, desc, turn: S.turn });
  appendMsg("sys", `🏆 获得称号「${name}」—— ${desc}`);
  sndEvent("item");
  vibrate([40, 60, 40]);
}

/* ---------------- 渲染 ---------------- */

function flashStat(el) {
  el.classList.remove("hurt");
  void el.offsetWidth; // 重置动画
  el.classList.add("hurt");
}

function renderSuggestions(list) {
  const box = $("suggestions");
  box.innerHTML = "";
  list.filter(Boolean).slice(0, 4).forEach((s) => {
    const chip = document.createElement("span");
    chip.className = "suggestion-chip";
    chip.textContent = s;
    chip.onclick = () => {
      if (!S.busy && !S.ended) {
        $("playerInput").value = s;
        $("playerInput").focus();
      }
    };
    box.appendChild(chip);
  });
}

function renderSide(prevStats) {
  const was = prevStats || S.stats;
  // 条
  const hpEl = $("barHp"), sanEl = $("barSanity");
  hpEl.style.width = S.stats.hp + "%";
  sanEl.style.width = S.stats.sanity + "%";
  hpEl.classList.toggle("low", S.stats.hp <= 30);
  sanEl.classList.toggle("low", S.stats.sanity <= 30);
  document.body.classList.toggle("low-hp", S.stats.hp <= 30);
  document.body.classList.toggle("low-sanity", S.stats.sanity <= 30);

  // 受击闪烁
  if (S.stats.hp < was.hp) { flashStat($("numHp")); sndEvent("hurt"); vibrate([60, 40, 60]); }
  if (S.stats.sanity < was.sanity) { flashStat($("numSanity")); sndEvent("sanity"); vibrate([80, 60, 80]); }

  $("numHp").textContent = S.stats.hp;
  $("numSanity").textContent = S.stats.sanity;
  $("numGold").textContent = S.stats.gold;

  // 行囊（可交互：使用/细看/丢弃）
  const inv = $("inventoryList");
  inv.innerHTML = "";
  if (!S.inventory.length) {
    inv.innerHTML = '<li class="empty">空空如也</li>';
  } else {
    S.inventory.forEach((i) => {
      const li = document.createElement("li");
      li.innerHTML = `${esc(i.name)}<span class="item-ops"><button data-op="use">用</button><button data-op="look">看</button><button data-op="drop">弃</button></span>`;
      if (i.isNew) { li.classList.add("new-item"); i.isNew = false; }
      li.querySelectorAll("button").forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          const op = b.dataset.op;
          const phrases = { use: `使用「${i.name}」`, look: `仔细查看「${i.name}」`, drop: `丢弃「${i.name}」` };
          $("playerInput").value = phrases[op];
          $("playerInput").focus();
          // 移动端顺手收侧栏
          if (window.innerWidth <= 900) {
            document.querySelector(".side-pane").classList.remove("open");
            const mask = $("sideMask");
            if (mask) mask.classList.add("hidden");
          }
        };
      });
      inv.appendChild(li);
    });
  }

  // 伙伴
  const compPanel = $("companionPanel");
  const compList = $("companionList");
  if (S.companions && S.companions.length) {
    compPanel.style.display = "";
    compList.innerHTML = "";
    S.companions.forEach((c) => {
      const li = document.createElement("li");
      li.className = "companion-card";
      li.innerHTML = `<span class="npc-avatar">${npcAvatar(c.name)}</span><div style="min-width:0;flex:1"><b>${esc(c.name)}</b><div class="companion-note">${esc(c.note || "")}</div></div><span class="companion-loyalty" title="信任">${"◆".repeat(c.loyalty)}${"◇".repeat(5 - c.loyalty)}</span>`;
      compList.appendChild(li);
    });
  } else {
    compPanel.style.display = "none";
  }

  // 线索墙
  const cluePanel = $("cluePanel");
  const clueList = $("clueList");
  if (S.clues && S.clues.length) {
    cluePanel.style.display = "";
    $("clueCount").textContent = `${S.clues.length} 条`;
    clueList.innerHTML = "";
    S.clues.forEach((c) => {
      const li = document.createElement("li");
      li.innerHTML = `<div class="clue-name">🔍 ${esc(c.name)}</div><div class="clue-desc">${esc(c.desc)}</div>`;
      clueList.appendChild(li);
    });
  } else {
    cluePanel.style.display = "none";
  }

  // 关系
  const rel = $("relList");
  rel.innerHTML = "";
  if (!S.relations.length) {
    rel.innerHTML = '<li class="empty">萍水相逢者尚无</li>';
  } else {
    S.relations.forEach((r) => {
      const li = document.createElement("li");
      const cls = r.attitude === "positive" ? "att-positive" : r.attitude === "negative" ? "att-negative" : "att-neutral";
      const sym = r.attitude === "positive" ? "◈善" : r.attitude === "negative" ? "◈恶" : "◈常";
      li.innerHTML = `<span class="npc-avatar">${npcAvatar(r.name)}</span><b>${esc(r.name)}</b> <span class="rel-att ${cls}">${sym}</span> <button class="mini-btn ask-btn" title="向 TA 问话">问</button><br><span class="empty">${esc(r.note || "")}</span>`;
      li.querySelector(".ask-btn").onclick = (e) => {
        e.stopPropagation();
        askNPC(r.name);
        // 移动端：点问话后顺手收起侧栏露出输入区
        if (window.innerWidth <= 900) {
          document.querySelector(".side-pane").classList.remove("open");
          const mask = $("sideMask");
          if (mask) mask.classList.add("hidden");
        }
      };
      rel.appendChild(li);
    });
  }

  // 目标
  const obj = $("objList");
  obj.innerHTML = "";
  if (!S.objectives.length) {
    obj.innerHTML = '<li class="empty">尚未定计</li>';
  } else {
    S.objectives.forEach((o) => {
      const li = document.createElement("li");
      li.textContent = o.text;
      if (o.done) li.className = "done";
      obj.appendChild(li);
    });
  }

  if (S.gmNote) $("gmNote").textContent = S.gmNote;
}

/* ---------------- 日志 DOM ---------------- */

function scrollBottom() {
  const log = $("storyLog");
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

function appendMsg(type, html) {
  const log = $("storyLog");
  const div = document.createElement("div");
  div.className = "msg " + type;
  if (type === "sys") div.textContent = html;
  else div.innerHTML = html;
  log.appendChild(div);
  scrollBottom();
  return div;
}

function appendNarrationHolder() {
  return appendMsg("narration", "");
}

function appendPlayer(text) {
  appendMsg("player", `<div class="bubble">${esc(text)}</div>`);
}

function appendDivider(text) {
  const log = $("storyLog");
  const div = document.createElement("div");
  div.className = "divider";
  div.textContent = `✦ ${text} ✦`;
  log.appendChild(div);
  scrollBottom();
}

/* ---------------- 打字机 ---------------- */

function typewriterLoading(holder) {
  return new Promise((resolve) => {
    holder.innerHTML = '<p><span class="typing-cursor"></span></p>';
    setTimeout(resolve, 350);
  });
}

function typewriter(el, html, speed) {
  // 按"可见字符"逐个显示：先解析为纯文本+标签结构，简单做法：逐字追加已截断的 html
  return new Promise((resolve) => {
    const chars = Array.from(html);
    let i = 0;
    el.innerHTML = "";
    const timer = setInterval(() => {
      // 每次追加 2 个字符
      i = Math.min(chars.length, i + 2);
      // 避免截断标签：只在标签闭合后才渲染（简单策略：查找最后一个 '>' 后的截断点）
      let partial = chars.slice(0, i).join("");
      const lastOpen = partial.lastIndexOf("<");
      const lastClose = partial.lastIndexOf(">");
      if (lastOpen > lastClose) {
        // 标签未闭合，去掉未完标签再渲染
        partial = partial.slice(0, lastOpen);
      }
      el.innerHTML = partial + '<span class="typing-cursor"></span>';
      scrollBottom();
      if (i >= chars.length) {
        clearInterval(timer);
        el.innerHTML = partial;
        resolve();
      }
    }, speed);
  });
}

/* ---------------- 结局 ---------------- */

function showEnding(ending) {
  S.ending = ending;
  sndEvent("ending");
  recordEnding(ending);
  $("endingType").textContent = { good: "善 终", bad: "劫 灭", neutral: "尘 落", secret: "隐 秘" }[ending.type] || "终 章";
  $("endingTitle").textContent = ending.title || "未名之终";
  $("endingText").textContent = ending.text || "";
  $("endingStats").innerHTML = `
    <div><b>${S.turn}</b>历经幕数</div>
    <div><b>${S.inventory.length}</b>随身之物</div>
    <div><b>${S.relations.length}</b>相识之人</div>`;
  // 本局称号与难度
  const diffNames = ["故事", "标准", "硬核"];
  if (S.titles && S.titles.length) {
    $("endingStats").innerHTML += `<div style="grid-column:1/-1;font-size:12px;color:var(--accent-bright);letter-spacing:1px;margin-top:4px">「${S.titles.map((t) => t.name).join("」「")}」 · ${diffNames[S.difficulty ?? 1]}模式</div>`;
  }
  // 编年史复盘
  const chronBox = $("endingChronicle");
  if (chronBox) {
    if (S.chronicle && S.chronicle.length) {
      chronBox.innerHTML = `<h4 class="chron-title">— 旅程编年史 —</h4>` +
        S.chronicle.map((c) => `<div class="chron-item"><span class="chron-turn">第${c.turn + 1}幕</span>${esc(c.text)}</div>`).join("");
      chronBox.classList.remove("hidden");
    } else {
      chronBox.classList.add("hidden");
    }
  }
  checkAchievements();
  setTimeout(() => $("endingScreen").classList.remove("hidden"), 1400);
}

/* ---------------- 结局图鉴 + 成就（跨局持久化） ---------------- */

function collectionGet() {
  try {
    return {
      endings: JSON.parse(localStorage.getItem("ta_endings") || "{}"),
      achieves: JSON.parse(localStorage.getItem("ta_achieves") || "{}"),
      worlds: JSON.parse(localStorage.getItem("ta_custom_worlds") || "{}"),
    };
  } catch (e) {
    return { endings: {}, achieves: {}, worlds: {} };
  }
}

function collectionSet(key, obj) {
  localStorage.setItem(key === "endings" ? "ta_endings" : key === "achieves" ? "ta_achieves" : "ta_custom_worlds", JSON.stringify(obj));
}

function recordEnding(ending) {
  if (!S.world || !ending || !ending.title) return;
  const col = collectionGet();
  const wid = S.world.id;
  col.endings[wid] = col.endings[wid] || { seen: [] };
  const seen = col.endings[wid].seen;
  const isNew = !seen.find((e) => e.type === ending.type && e.title === ending.title);
  if (isNew) {
    seen.push({ type: ending.type, title: ending.title, at: new Date().toISOString().slice(0, 10) });
    collectionSet("endings", col.endings);
    if (S.turn > 0) setTimeout(() => toast("🌟 解锁新结局卡"), 2400);
  }
}

const ACHIEVEMENTS = [
  { id: "first_blood", name: "初入迷雾", desc: "完成第一段旅程" },
  { id: "iron_will", name: "钢铁意志", desc: "硬核模式通关（非死亡结局）" },
  { id: "survivor_low", name: "悬崖边的舞者", desc: "以低于 15 的体力或神智存活到结局" },
  { id: "pacifist", name: "不染血之手", desc: "历经 10 幕以上且体力从未低于 70" },
  { id: "collector_4", name: "读遍人间", desc: "同一世界解锁全部 4 种结局" },
  { id: "collector_half", name: "半卷江湖", desc: "累计解锁 16 张结局卡" },
  { id: "collector_all", name: "万象归一", desc: "累计解锁 32 张结局卡" },
  { id: "deep_dive", name: "长夜行者", desc: "单局历经 25 幕以上" },
  { id: "hoarder", name: "行囊满满", desc: "单局收集 12 件以上物品" },
  { id: "socialite", name: "萍水皆缘", desc: "单局结识 6 位以上 NPC" },
  { id: "secret_keeper", name: "隐秘的知情人", desc: "达成任意 hidden/secret 类结局" },
  { id: "world_maker", name: "造世者", desc: "用世界工坊创造一个世界并开局" },
  { id: "six_worlds", name: "八荒旅人", desc: "在 8 个不同的世界各完成一段旅程" },
];

function checkAchievements() {
  const col = collectionGet();
  const unlocked = col.achieves;
  const grant = (id) => {
    if (!unlocked[id]) {
      unlocked[id] = { at: new Date().toISOString().slice(0, 10) };
      collectionSet("achieves", unlocked);
      const a = ACHIEVEMENTS.find((x) => x.id === id);
      if (a) setTimeout(() => toast(`🏆 成就解锁：${a.name}`), 3000);
    }
  };
  grant("first_blood");
  if (S.difficulty === 2 && S.turn >= 8 && (S.ending && S.ending.type !== "bad")) grant("iron_will");
  if ((S.stats.hp <= 15 && S.stats.hp > 0) || S.stats.sanity <= 15) grant("survivor_low");
  if (S.turn >= 10 && S.stats.hp >= 70) grant("pacifist");
  if (S.turn >= 25) grant("deep_dive");
  if (S.inventory.length >= 12) grant("hoarder");
  if (S.relations.length >= 6) grant("socialite");
  if (S.ending && S.ending.type === "secret") grant("secret_keeper");
  // 收集类
  const wid = S.world ? S.world.id : "";
  if (wid && col.endings[wid] && new Set(col.endings[wid].seen.map((e) => e.type)).size >= 4) grant("collector_4");
  const totalCards = Object.values(col.endings).reduce((n, w) => n + w.seen.length, 0);
  if (totalCards >= 16) grant("collector_half");
  if (totalCards >= 32) grant("collector_all");
  // 多世界
  if (wid) {
    col.endings[wid].played = true;
    collectionSet("endings", col.endings);
    const played = Object.values(col.endings).filter((w) => w.played).length;
    if (played >= 8) grant("six_worlds");
  }
}

/* 图鉴弹窗（标题页/取名页入口） */
function openCollectionModal() {
  const col = collectionGet();
  const body = $("modalBody");
  $("modalTitle").textContent = "结局图鉴 · 成就";
  const worldPlayed = col.endings;
  let html = '<div class="coll-section"><h4>结局卡（' + Object.values(worldPlayed).reduce((n, w) => n + w.seen.length, 0) + ' / 32）</h4>';
  for (const [wid, w] of Object.entries(worldPlayed)) {
    const seenTypes = new Set(w.seen.map((e) => e.type));
    html += `<div class="coll-world"><span class="coll-wname">${esc(wid)}</span>`;
    for (const t of ["good", "neutral", "bad", "secret"]) {
      const hit = w.seen.find((e) => e.type === t);
      html += hit
        ? `<span class="coll-card got t-${t}">${esc(hit.title)}</span>`
        : `<span class="coll-card">${seenTypes.size > 0 ? "？？？" : "未启"}</span>`;
    }
    html += `</div>`;
  }
  html += "</div>";
  html += '<div class="coll-section"><h4>成就（' + Object.keys(col.achieves).length + " / " + ACHIEVEMENTS.length + "）</h4>";
  html += ACHIEVEMENTS.map((a) => {
    const got = !!col.achieves[a.id];
    return `<div class="coll-ach ${got ? "got" : ""}"><span class="ach-name">${got ? "🏆" : "🔒"} ${esc(a.name)}</span><span class="ach-desc">${esc(a.desc)}</span></div>`;
  }).join("");
  html += "</div>";
  body.innerHTML = html;
  openModal();
}

/* ---------------- 世界工坊 ---------------- */

const FORGE_PROMPT = `你是文字冒险游戏剧本设计师。根据用户创意生成中文世界剧本 JSON。

硬性要求：只输出一个合法 JSON 对象（不要 markdown 代码块、不要解释），JSON 内字符串不要出现未转义换行。

字段（全部必填）：
- id：英文小写下划线
- name：2-5字世界名
- tagline：一句悬念标语
- cover：一个 emoji
- difficulty："入门|进阶|硬核 · 题材"
- currency：货币名
- setting：世界观正文 200~300字，第二人称"你"的开场处境，结尾留钩子
- gmLore：GM 幕后真相 400~600字（核心秘密、NPC 真实身份、线索链、三幕节奏）
- npcs：4个 {name, desc}，desc 一句话埋线索
- resources：6条剧情资源
- initialState：{hp, sanity, gold, inventory:[2-3件], relations:[1-2个{name,attitude,note}], objectives:[2条]}
- endingHints：{good, neutral, bad, secret} 各一句话结局方向
- origins：2个 {name, desc, stats:{hp,sanity,gold}, items:[1-2件], relations:[], gmHint}

风格：悬念式怪谈/惊悚均可，与创意题材契合。全文控制在 1500 字内。`;

async function forgeWorld() {
  const idea = $("forgeIdea").value.trim();
  const result = $("forgeResult");
  if (idea.length < 6) { result.textContent = "创意太短了，再描述几句（至少 6 字）"; return; }
  result.className = "range-val";
  result.textContent = "铸造中……这需要一两分钟";
  $("btnForgeGo").disabled = true;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await generate([
        { role: "system", content: FORGE_PROMPT },
        { role: "user", content: `创意：${idea}` },
      ], { temperature: attempt === 0 ? 1.0 : 0.7, max_tokens: 8000 });
      const w = extractJSON(content);
      if (!w) throw new Error(`AI 输出无法解析为 JSON（长度 ${String(content || "").length}，开头：${String(content || "").slice(0, 60)}…）`);
      if (!w.name || !w.setting || !w.gmLore) {
        const missing = ["name", "setting", "gmLore"].filter((k) => !w[k]).join("、");
        throw new Error(`剧本缺关键字段：${missing}（多为输出被截断，正在自动重试）`);
      }
      w.id = w.id || ("custom_" + Date.now().toString(36));
      w.cover = w.cover || "🌌";
      w.difficulty = w.difficulty || "自定义";
      w.tagline = w.tagline || "一个由你亲手铸成的世界";
      w.npcs = Array.isArray(w.npcs) ? w.npcs : [];
      w.resources = Array.isArray(w.resources) ? w.resources : [];
      w.origins = Array.isArray(w.origins) ? w.origins : [];
      const col = collectionGet();
      col.worlds[w.id] = w;
      collectionSet("worlds", col.worlds);
      result.className = "range-val";
      result.textContent = `✓ 世界「${w.name}」铸成！已加入世界列表`;
      renderForgeList();
      toast("🌟 新世界已铸成");
      $("btnForgeGo").disabled = false;
      return;
    } catch (e) {
      lastErr = e.message || "未知错误";
      if (attempt === 0) result.textContent = "首次铸造不完整，自动重试中……";
    }
  }
  result.className = "error-hint";
  result.textContent = "铸造失败：" + lastErr;
  $("btnForgeGo").disabled = false;
}

function renderForgeList() {
  const col = collectionGet();
  const box = $("forgeList");
  const ids = Object.keys(col.worlds);
  if (!ids.length) { box.innerHTML = ""; return; }
  box.innerHTML = '<label class="field-label" style="margin-top:16px">已铸成的世界</label>';
  ids.forEach((id) => {
    const w = col.worlds[id];
    const div = document.createElement("div");
    div.className = "forge-world";
    div.innerHTML = `
      <div class="save-info">
        <div class="save-title">${esc(w.cover || "🌌")} ${esc(w.name)} <span class="empty">${esc(w.tagline || "")}</span></div>
      </div>
      <button class="save-del" title="删除">✕</button>`;
    div.querySelector(".save-del").onclick = () => {
      const c2 = collectionGet();
      delete c2.worlds[id];
      collectionSet("worlds", c2.worlds);
      renderForgeList();
    };
    box.appendChild(div);
  });
}

function gotoForge() {
  renderForgeList();
  showStartScreen("forgeScreen");
}

/* ---------------- NPC 定向对话 ---------------- */

function askNPC(name) {
  if (S.busy || S.ended) return;
  const topics = [
    `向${name}打听最近的事`,
    `观察${name}的举动`,
    ...S.objectives.filter((o) => !o.done).slice(0, 2).map((o) => `问${name}：${o.text}`),
  ];
  if (S.stats && S.stats.gold >= 10) {
    topics.push(`向${name}打听有什么可以买的（情报或物品）`, `试着和${name}讲价买下我需要的东西`);
  }
  const box = $("suggestions");
  box.innerHTML = "";
  topics.filter(Boolean).forEach((t) => {
    const chip = document.createElement("span");
    chip.className = "suggestion-chip ask-chip";
    chip.textContent = t;
    chip.onclick = () => {
      $("playerInput").value = t;
      $("playerInput").focus();
    };
    box.appendChild(chip);
  });
  toast(`已为你准备向 ${name} 的问话`);
  $("playerInput").focus();
}

/* ---------------- 上下文自动压缩 ---------------- */

const HISTORY_SOFT_LIMIT = 30; // 超过此消息数触发折叠

async function maybeCompressHistory() {
  // 需要折叠的是 system 之后的对话；保留最近 12 条原文
  const dialog = S.history.slice(1);
  if (dialog.length <= HISTORY_SOFT_LIMIT) return;
  const keep = 12;
  const foldCount = dialog.length - keep;
  if (foldCount < 8) return; // 至少折叠 8 条才有意义

  const toFold = dialog.slice(0, foldCount);
  // 已有 recap 的合并进这次折叠
  const oldRecap = S.history[1] && S.history[1].role === "system" && S.history[1].recap ? S.history[1].content : "";

  const transcript = toFold.map((m) => (m.role === "user" ? `【玩家】${m.content}` : `【GM】${String(m.content).slice(0, 200)}`)).join("\n");

  try {
    const summary = await generate([
      { role: "system", content: "你是游戏记录员。把这段文字冒险的对局历史压缩成 200~300 字的「前情提要」，保留：关键事件、已揭开的秘密、NPC 状态变化、玩家重大抉择与后果、数值重大变化。用第三人称，简洁。" },
      { role: "user", content: (oldRecap ? oldRecap + "\n\n" : "") + transcript },
    ], { temperature: 0.3, max_tokens: 500 });
    if (!summary) return;
    S.history = [
      S.history[0],                        // 主 system
      { role: "system", content: `【前情提要（此前剧情的压缩回忆，视为已发生的事实）】\n${summary.trim()}`, recap: true },
      ...dialog.slice(foldCount),
    ];
  } catch (e) {
    // 压缩失败不影响游戏
  }
}

/* ---------------- 接口设置 ---------------- */

function localCfgGet() {
  try { return JSON.parse(localStorage.getItem("ta_api_cfg") || "null"); } catch (e) { return null; }
}

function localCfgSet(cfg) {
  localStorage.setItem("ta_api_cfg", JSON.stringify(cfg));
  // 立即生效：更新 RUNTIME.cfg
  RUNTIME.cfg = { ...(RUNTIME.cfg || {}), ...cfg };
}

function effectiveCfg() {
  // 优先级：本机设置页存的 > 内嵌 config.js（打包时的）
  const local = localCfgGet();
  if (local && local.baseUrl && local.model) return local;
  return RUNTIME.cfg || {};
}

async function gotoSettings() {
  showStartScreen("settingsScreen");
  const status = $("cfgStatus");
  status.textContent = "";
  // 加载当前生效配置（打码显示）
  let cfg = effectiveCfg();
  if (!RUNTIME.native) {
    try {
      const r = await api("/api/config");
      if (r.ok && r.baseUrl) {
        cfg = { baseUrl: r.baseUrl, model: r.model, apiKey: r.apiKey };
      }
    } catch (e) {}
  }
  $("cfgBaseUrl").value = cfg.baseUrl || "";
  $("cfgModel").value = cfg.model || "";
  $("cfgApiKey").value = cfg.apiKey || "";
  $("cfgApiKey").placeholder = cfg.apiKey ? `已保存（${cfg.apiKey}）` : "sk-...";
}

async function testApiKey() {
  const status = $("cfgStatus");
  const baseUrl = $("cfgBaseUrl").value.trim().replace(/\/$/, "");
  const apiKey = $("cfgApiKey").value.trim();
  const model = $("cfgModel").value.trim();
  if (!baseUrl || !model) { status.className = "error-hint"; status.textContent = "请先填 API 地址和模型名"; return; }
  if (!apiKey || apiKey.startsWith("****")) { status.className = "error-hint"; status.textContent = "请填入完整 API Key"; return; }
  status.className = "range-val"; status.textContent = "测试中……";
  try {
    let ok, content;
    if (RUNTIME.native) {
      const r = await capHttpPost(baseUrl + "/chat/completions", {
        model, messages: [{ role: "user", content: "只回两个字：连通" }], max_tokens: 512,
      }, apiKey);
      let c = r?.choices?.[0]?.message?.content;
      if (Array.isArray(c)) c = c.map((s) => (typeof s === "string" ? s : s?.text || "")).join("");
      ok = typeof c === "string" && c.length > 0;
      content = c;
    } else {
      const r = await api("/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "只回两个字：连通" }], max_tokens: 512, _test: { baseUrl, apiKey, model } }),
      });
      ok = r.ok; content = r.content;
      if (!ok) throw new Error(r.error);
    }
    status.className = "error-hint cfg-status-ok";
    status.textContent = `✓ 连接成功（模型回复：${String(content).slice(0, 20)}）`;
    sndEvent("item");
  } catch (e) {
    status.className = "error-hint";
    status.textContent = "✗ " + (e.message || "连接失败，检查地址/Key/模型名");
  }
}

async function saveApiKey() {
  const baseUrl = $("cfgBaseUrl").value.trim().replace(/\/$/, "");
  const apiKey = $("cfgApiKey").value.trim();
  const model = $("cfgModel").value.trim();
  const status = $("cfgStatus");
  if (!baseUrl || !model || !apiKey || apiKey.startsWith("****")) {
    status.className = "error-hint";
    status.textContent = "地址、Key、模型名都要填完整才能保存";
    return;
  }
  const cfg = { baseUrl, apiKey, model };
  if (RUNTIME.native) {
    localCfgSet(cfg);
  } else {
    // web：写 server config.json，同时本地也存一份（server 不在线时兜底）
    localCfgSet(cfg);
    try { await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: cfg }) }); } catch (e) {}
  }
  status.className = "error-hint cfg-status-ok";
  status.textContent = "✓ 配置已保存，可以开始游戏了";
  toast("配置已保存");
}

/* NPC 头像映射（内置世界；工坊 NPC 走默认） */
const NPC_AVATARS = {
  "顾青梧": "🎻", "铁千山": "🍶", "宋算盘": "🧮", "柳三变": "📜", "阿石": "🧹",
  "MOSS-9": "🤖", "赵沉舟": "🎖", "维克多·科瓦奇": "🔧", "小满": "🍜", "沈原": "💉",
  "老聂": "🫖", "顾菡之": "📚", "马啸山": "👮", "顾鹤年": "🩺", "周楼长": "🗝",
  "陈阿禾": "🧺", "白泽": "☕", "老鲍": "⚙", "苏警官": "⚖", "回声体·陈拾遗": "💭",
  "艾拉": "⚔", "塞德里克": "📖", "布兰温": "🛡", "加尔文": "🍺", "托尔": "🧒",
  "顾深蓝": "⚓", "白鹭": "🔬", "郑野": "🗿",
  "沈既明": "🕰", "白馆长": "👴", "小蔓": "📱", "保安队长": "🔒", "送水工": "🚚",
  "艾德琳·莫里": "👗", "格里高利探长": "🚬", "「铰链」": "🔩", "坦尼森": "🔩", "火柴": "📰",
};
const npcAvatar = (name) => NPC_AVATARS[name] || "👤";

/* ---------------- 字号 / 前情 / 震动 ---------------- */

const FONT_SIZES = ["fs-small", "", "fs-large"];
const FONT_NAMES = ["小", "标准", "大"];

function applyFontSize(idx) {
  document.body.classList.remove("fs-small", "fs-large");
  if (FONT_SIZES[idx]) document.body.classList.add(FONT_SIZES[idx]);
  localStorage.setItem("ta_fontsize", String(idx));
}

function initFontSize() {
  const idx = Math.min(2, Math.max(0, parseInt(localStorage.getItem("ta_fontsize") || "1", 10)));
  applyFontSize(idx);
  const slider = $("fsRange");
  if (slider) {
    slider.value = idx;
    $("fsVal").textContent = FONT_NAMES[idx];
    slider.oninput = (e) => {
      applyFontSize(parseInt(e.target.value, 10));
      $("fsVal").textContent = FONT_NAMES[e.target.value];
    };
  }
}

/* 震动反馈：native(Capacitor) 或 web Vibration API */
function vibrate(pattern) {
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics) {
      window.Capacitor.Plugins.Haptics.impact({ style: "LIGHT" });
      return;
    }
    if (navigator.vibrate) { navigator.vibrate(pattern); }
  } catch (e) {}
}

/* 前情提要弹窗 */
function openRecallModal() {
  const body = $("modalBody");
  $("modalTitle").textContent = "前情提要";
  let html = "";
  // recap（若上下文压缩过）
  const recapMsg = S.history && S.history[1] && S.history[1].recap ? S.history[1].content : "";
  if (recapMsg) html += `<div class="detail-setting" style="font-size:13px">${esc(recapMsg.replace(/^【[^】]*】\n?/, ""))}</div>`;
  // 最近叙事（倒序取 6 段，正序显示）
  const narrs = [...document.querySelectorAll("#storyLog .msg.narration p")].map((p) => p.textContent).filter(Boolean);
  const recent = narrs.slice(-6);
  if (recent.length) {
    html += `<div class="coll-section" style="margin-top:${recapMsg ? 14 : 0}px"><h4>最近发生</h4>` +
      recent.map((t) => `<p class="detail-setting" style="font-size:13px;margin-bottom:8px">${esc(t.length > 120 ? t.slice(0, 120) + "……" : t)}</p>`).join("") + "</div>";
  }
  // 编年史
  if (S.chronicle && S.chronicle.length) {
    html += `<div class="coll-section recall-chron"><h4>旅程编年史</h4>` +
      S.chronicle.map((c) => `<div class="chron-item"><span class="chron-turn">第${c.turn + 1}幕</span>${esc(c.text)}</div>`).join("") + "</div>";
  }
  body.innerHTML = html || '<div class="loading-hint">故事才刚刚开始……</div>';
  openModal();
}

/* ---------------- 旅程导出 + 分享卡 ---------------- */

function buildJourneyMarkdown() {
  const lines = [];
  lines.push(`# ${S.world ? S.world.name : "未知世界"} · ${S.ending ? S.ending.title : ""}`);
  lines.push("");
  lines.push(`> 旅人：${S.playerName} · 历经 ${S.turn} 幕 · ${new Date().toLocaleDateString("zh-CN")}`);
  lines.push("");
  if (S.chronicle && S.chronicle.length) {
    lines.push("## 编年史");
    S.chronicle.forEach((c) => lines.push(`- 第${c.turn + 1}幕：${c.text}`));
    lines.push("");
  }
  lines.push("## 旅程全文");
  const log = $("storyLog");
  if (log) {
    log.querySelectorAll(".msg").forEach((m) => {
      if (m.classList.contains("player")) {
        const t = m.textContent.trim();
        if (t) lines.push(`**「${t}」**`, "");
      } else if (m.classList.contains("narration")) {
        m.querySelectorAll("p").forEach((p) => { if (p.textContent.trim()) lines.push(p.textContent.trim(), ""); });
      } else if (m.classList.contains("sys")) {
        const t = m.textContent.trim();
        if (t) lines.push(`*${t}*`, "");
      } else if (m.classList.contains("divider")) {
        lines.push("---", "");
      }
    });
  }
  if (S.ending) {
    lines.push("## 终章");
    lines.push(`**${S.ending.title}**`, "");
    lines.push(S.ending.text || "");
  }
  lines.push("");
  lines.push("*—— 由「雾中人」文字冒险引擎记录 ——*");
  return lines.join("\n");
}

async function exportJourney() {
  const md = buildJourneyMarkdown();
  const fname = `雾中人_${S.world ? S.world.id : "journey"}_${Date.now() % 100000}.md`;
  try {
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("旅程已导出：" + fname);
  } catch (e) {
    try {
      if (navigator.share) { await navigator.share({ title: fname, text: md.slice(0, 2000) }); return; }
      await navigator.clipboard.writeText(md);
      toast("已复制全文到剪贴板");
    } catch (e2) {
      toast("导出失败");
    }
  }
}

function drawEndingCard() {
  const cv = document.createElement("canvas");
  cv.width = 720; cv.height = 960;
  const g = cv.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 960);
  grad.addColorStop(0, "#151820"); grad.addColorStop(1, "#0d0f14");
  g.fillStyle = grad; g.fillRect(0, 0, 720, 960);
  g.strokeStyle = "rgba(201,168,106,0.8)"; g.lineWidth = 2;
  g.strokeRect(28, 28, 664, 904);
  g.strokeStyle = "rgba(201,168,106,0.3)"; g.lineWidth = 1;
  g.strokeRect(40, 40, 640, 880);
  g.fillStyle = "#8a8577"; g.font = "26px serif"; g.textAlign = "center";
  g.fillText("雾 中 人 · 旅 程 终 章", 360, 130);
  g.fillStyle = "#c9a86a"; g.font = "44px serif";
  g.fillText((S.world ? S.world.name : "未知世界"), 360, 230);
  const typeMap = { good: "善 终", bad: "劫 灭", neutral: "尘 落", secret: "隐 秘" };
  g.fillStyle = "#5a9e8f"; g.font = "24px serif";
  g.fillText("「 " + (typeMap[S.ending?.type] || "终 章") + " 」", 360, 290);
  g.strokeStyle = "rgba(201,168,106,0.4)";
  g.beginPath(); g.moveTo(180, 330); g.lineTo(540, 330); g.stroke();
  g.fillStyle = "#e6c78a"; g.font = "52px serif";
  g.fillText(S.ending ? S.ending.title : "未名之终", 360, 420);
  g.fillStyle = "#d8d3c8"; g.font = "28px serif";
  g.fillText(`${S.playerName} 的旅程`, 360, 520);
  g.fillStyle = "#8a8577"; g.font = "22px serif";
  g.fillText(`历经 ${S.turn} 幕 · 随身 ${S.inventory.length} 物 · 相识 ${S.relations.length} 人`, 360, 570);
  if (S.chronicle && S.chronicle.length) {
    g.fillStyle = "#6b675c"; g.font = "20px serif";
    S.chronicle.slice(0, 5).forEach((c, i) => {
      g.fillText(`· ${c.text}`, 360, 650 + i * 36);
    });
  }
  g.fillStyle = "#5b574e"; g.font = "18px serif";
  g.fillText("LLM 文字冒险引擎", 360, 900);
  return cv;
}

async function shareEndingCard() {
  try {
    const cv = drawEndingCard();
    cv.toBlob(async (blob) => {
      if (!blob) { toast("卡片生成失败"); return; }
      const fname = `雾中人_结局卡_${Date.now() % 100000}.png`;
      try {
        const file = new File([blob], fname, { type: "image/png" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: fname });
          return;
        }
      } catch (e) {}
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast("结局卡已保存：" + fname);
    }, "image/png");
  } catch (e) {
    toast("分享卡失败：" + (e.message || ""));
  }
}

/* ---------------- 存档 ---------------- */

function saveData() {
  return {
    version: 1,
    worldId: S.world ? S.world.id : "",
    worldName: S.world ? S.world.name : "",
    player: S.playerName,
    style: S.style,
    turn: S.turn,
    history: S.history,
    stats: S.stats,
    inventory: S.inventory,
    relations: S.relations,
    objectives: S.objectives,
    gmNote: S.gmNote,
    chronicle: S.chronicle || [],
    clues: S.clues || [],
    companions: S.companions || [],
    titles: S.titles || [],
    difficulty: S.difficulty ?? 1,
    ended: S.ended,
    endedAt: new Date().toISOString(),
  };
}

async function doSave() {
  if (!S.world) return;
  const slot = `${S.playerName}_${S.world.id}_t${S.turn}_${Date.now() % 100000}`;
  const data = await api("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot, data: saveData() }),
  });
  if (data.ok) toast(`已存档 · ${S.world.name} 第 ${S.turn + 1} 幕`);
  else toast("存档失败：" + (data.error || ""));
}

async function openLoadModal(fromStart = false) {
  const data = await api("/api/saves");
  const body = $("modalBody");
  $("modalTitle").textContent = "读取存档";
  if (!data.ok || !data.saves.length) {
    body.innerHTML = '<div class="loading-hint">暂无存档</div>';
  } else {
    body.innerHTML = "";
    data.saves.forEach((sv) => {
      const div = document.createElement("div");
      div.className = "save-entry";
      div.innerHTML = `
        <div class="save-info">
          <div class="save-title">${esc(sv.player)} · ${esc(sv.world)}</div>
          <div class="save-meta">第 ${sv.turn + 1} 幕 · ${esc(sv.time)}</div>
        </div>
        <button class="save-del" title="删除">✕</button>`;
      div.onclick = (e) => {
        if (e.target.classList.contains("save-del")) return;
        closeModal();
        loadSave(sv.slot, fromStart);
      };
      div.querySelector(".save-del").onclick = async (e) => {
        e.stopPropagation();
        await api("/api/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot: sv.slot, data: { deleted: true, worldName: "", player: "", turn: 0 } }),
        }).catch(() => {});
        div.remove();
      };
      body.appendChild(div);
    });
  }
  openModal();
}

async function loadSave(slot, fromStart) {
  const data = await api(`/api/save?slot=${encodeURIComponent(slot)}`);
  if (!data.ok || !data.data.deleted) {
    const d = data.data || data;
    if (!d.history) { toast("存档损坏"); return; }
    const wd = await fetchWorld(d.worldId);
    if (!wd.ok) { toast("找不到对应世界：" + d.worldId); return; }
    S.world = wd.world;
    S.playerName = d.player;
    S.style = d.style ?? 1;
    S.turn = d.turn || 0;
    S.history = d.history;
    S.stats = d.stats || { hp: 100, sanity: 100, gold: 10 };
    S.inventory = d.inventory || [];
    S.relations = d.relations || [];
    S.objectives = d.objectives || [];
    S.gmNote = d.gmNote || "";
    S.chronicle = d.chronicle || [];
    S.clues = d.clues || [];
    S.companions = d.companions || [];
    S.titles = d.titles || [];
    S.difficulty = d.difficulty ?? 1;
    S.ended = !!d.ended;
    applyWorldTheme(S.world.id);
    $("charName").textContent = S.playerName;
    if (S.world.currency) {
      document.querySelector(".coin-row span:first-child").textContent = `✦ ${S.world.currency}`;
    }
    $("turnBadge").textContent = `第 ${S.turn + 1} 幕`;
    switchScreen("game");
    $("storyLog").innerHTML = "";
    appendDivider(`继续 · ${S.world.name}`);
    appendMsg("narration", `<p><em>（旧梦重续。你回想起自己在 ${S.world.name} 的经历……）</em></p>`);
    if (S.ended && S.ending) showEnding(S.ending);
    renderSide({ hp: 999, sanity: 999 }); // 读档不触发受击闪烁
    renderSuggestions(["环顾四周", "检查行囊", "继续未竟之事"]);
    toast("已读取存档");
  }
}

/* ---------------- 插图 ---------------- */

const WORLD_ART_STYLE = {
  mist_valley: "traditional Chinese ink painting style, wuxia atmosphere, muted gold tones",
  station_elysium: "retro-futurism sci-fi concept art, cold blue tones, cinematic",
  linlan: "dark moody atmosphere, republican-era China, lovecraftian horror, desaturated purple-grey palette",
  neon_echo: "cyberpunk concept art, neon pink and cyan, rain-soaked megacity, cinematic lighting",
  iron_crown: "epic dark fantasy concept art, dragon fire embers, snow fortress, dramatic lighting",
  abyss: "deep sea bioluminescent horror, abyssal darkness, teal glow, claustrophobic sci-fi interior",
  time_loop: "atmospheric noir, rain-soaked chinese city, vintage clockwork motifs, muted amber palette",
  london_fog: "victorian steampunk, gaslamp london, thick fog, brass and coal smoke, cinematic",
};

async function requestImage(prompt) {
  const data = await api("/api/image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!data.ok) throw new Error(data.error || "图片接口错误");
  const src = data.b64 ? `data:image/png;base64,${data.b64}` : data.url;
  if (!src) throw new Error("图片接口未返回图片");
  return src;
}

function appendSceneImage(src, caption) {
  const log = $("storyLog");
  const div = document.createElement("div");
  div.className = "msg narration";
  div.innerHTML = `<img class="scene-img" src="${src}" alt="场景插图"${caption ? ` title="${esc(caption)}"` : ""}>`;
  log.appendChild(div);
  scrollBottom();
}

/* 自动插图：每 3 幕，利用 GM 给的 sceneForImage */
async function maybeAutoImage(parsed) {
  if (!S.world || S.ended || S.turn % 3 !== 0) return;
  // native 模式未配图片接口时直接跳过，不白调
  if (RUNTIME.native) {
    const c = RUNTIME.cfg || {};
    if (!c.imageBaseUrl || !c.imageModel) return;
  }
  const scene = String(parsed.sceneForImage || "").trim();
  if (!scene) return;
  const style = WORLD_ART_STYLE[S.world.id] || "atmospheric digital painting";
  const prompt = `${scene}, ${style}, no text, no watermark`;
  try {
    const src = await requestImage(prompt);
    appendSceneImage(src);
  } catch (e) {
    // 自动插图失败静默跳过，不打断游戏
    console.warn("auto image skipped:", e.message);
  }
}

async function genImage() {
  if (S.busy || !S.world) return;
  const lastNarr = [...document.querySelectorAll("#storyLog .msg.narration p")]
    .map((p) => p.textContent).join(" ").slice(-400);
  if (!lastNarr) { toast("还没有可画的场景"); return; }
  toast("正在勾勒眼前的景象……");
  try {
    const style = WORLD_ART_STYLE[S.world.id] || "atmospheric digital painting";
    const src = await requestImage(`illustration of: ${lastNarr}. ${style}, no text, no watermark`);
    appendSceneImage(src);
  } catch (e) {
    toast("插图失败：" + e.message);
  }
}

/* ---------------- 氛围粒子系统 ---------------- */

const FX = {
  canvas: null,
  ctx: null,
  particles: [],
  mode: "idle", // idle | mist | space | rain | neon
  raf: null,
  last: 0,
};

const FX_THEMES = {
  idle: { count: 26, color: "rgba(201, 168, 106, alpha)" },
  mist_valley: { count: 46, color: "rgba(201, 168, 106, alpha)", mode: "mist" },
  station_elysium: { count: 60, color: "rgba(160, 200, 235, alpha)", mode: "space" },
  linlan: { count: 70, color: "rgba(170, 180, 210, alpha)", mode: "rain" },
  neon_echo: { count: 80, color: "rgba(217, 123, 166, alpha)", mode: "neon" },
  iron_crown: { count: 40, color: "rgba(216, 143, 90, alpha)", mode: "mist" },
  abyss: { count: 34, color: "rgba(94, 160, 170, alpha)", mode: "space" },
  time_loop: { count: 56, color: "rgba(190, 175, 120, alpha)", mode: "rain" },
  london_fog: { count: 64, color: "rgba(176, 178, 168, alpha)", mode: "rain" },
};

function fxInit() {
  FX.canvas = $("fxCanvas");
  if (!FX.canvas) return;
  FX.ctx = FX.canvas.getContext("2d");
  window.addEventListener("resize", fxResize);
  fxResize();
  fxSetWorld(null);
  FX.last = performance.now();
  FX.raf = requestAnimationFrame(fxLoop);
}

function fxResize() {
  if (!FX.canvas) return;
  FX.canvas.width = window.innerWidth;
  FX.canvas.height = window.innerHeight;
}

function fxSetWorld(worldId) {
  const theme = FX_THEMES[worldId] || FX_THEMES.idle;
  FX.mode = theme.mode || "idle";
  FX.color = theme.color;
  FX.particles = [];
  for (let i = 0; i < theme.count; i++) {
    FX.particles.push(fxSpawn(true));
  }
}

function fxSpawn(anywhere) {
  const W = FX.canvas ? FX.canvas.width : 800;
  const H = FX.canvas ? FX.canvas.height : 600;
  const p = {
    x: Math.random() * W,
    y: anywhere ? Math.random() * H : (FX.mode === "rain" ? -20 : Math.random() * H),
    a: 0.15 + Math.random() * 0.5,
    seed: Math.random() * Math.PI * 2,
  };
  switch (FX.mode) {
    case "mist":   // 金尘 / 萤火：慢速漂浮 + 闪烁
      p.r = 0.8 + Math.random() * 2.2;
      p.vx = (Math.random() - 0.5) * 0.15;
      p.vy = (Math.random() - 0.5) * 0.12;
      p.twinkle = 0.5 + Math.random() * 2;
      break;
    case "space":  // 星点：几乎静止 + 偶尔流星
      p.r = 0.5 + Math.random() * 1.5;
      p.vx = (Math.random() - 0.5) * 0.05;
      p.vy = 0.02 + Math.random() * 0.06;
      p.twinkle = 0.3 + Math.random() * 1.2;
      p.meteor = Math.random() < 0.04;
      if (p.meteor) { p.vx = 3 + Math.random() * 3; p.vy = 1 + Math.random(); p.r = 1.6; }
      break;
    case "rain":   // 冷雨丝：细长下落
      p.len = 10 + Math.random() * 18;
      p.r = 0.6;
      p.vx = -0.3 - Math.random() * 0.4;
      p.vy = 3.5 + Math.random() * 3.5;
      break;
    case "neon":   // 霓虹浮光：多彩光斑缓慢上浮
      p.r = 1 + Math.random() * 2.6;
      p.vx = (Math.random() - 0.5) * 0.3;
      p.vy = -(0.1 + Math.random() * 0.35);
      p.twinkle = 0.8 + Math.random() * 2.4;
      p.hue = [335, 190, 265][Math.floor(Math.random() * 3)]; // 粉/青/紫
      break;
    default:       // idle：微尘
      p.r = 0.6 + Math.random() * 1.6;
      p.vx = (Math.random() - 0.5) * 0.1;
      p.vy = (Math.random() - 0.5) * 0.08;
      p.twinkle = 0.4 + Math.random() * 1.5;
  }
  return p;
}

function fxColor(p, t) {
  if (FX.mode === "neon") {
    const a = p.a * (0.6 + 0.4 * Math.sin(t / 600 * p.twinkle + p.seed));
    return `hsla(${p.hue}, 85%, 68%, ${a})`;
  }
  const a = Math.max(0, Math.min(0.8, p.a * (0.6 + 0.4 * Math.sin(t / 900 * (p.twinkle || 1) + p.seed))));
  return (FX.color || "rgba(201,168,106,alpha)").replace("alpha", a.toFixed(3));
}

function fxLoop(t) {
  if (!FX.ctx) return;
  const W = FX.canvas.width, H = FX.canvas.height;
  const dt = Math.min(50, t - FX.last);
  FX.last = t;
  FX.ctx.clearRect(0, 0, W, H);
  FX.ctx.save();
  if (FX.mode === "rain") FX.ctx.lineWidth = 1;

  for (const p of FX.particles) {
    p.x += p.vx * (dt / 16);
    p.y += p.vy * (dt / 16);
    // 越界重生
    if (p.y > H + 30 || p.y < -30 || p.x < -40 || p.x > W + 40) {
      Object.assign(p, fxSpawn(false));
      if (FX.mode === "rain") p.y = -20;
      continue;
    }
    if (FX.mode === "rain") {
      FX.ctx.strokeStyle = fxColor(p, t);
      FX.ctx.beginPath();
      FX.ctx.moveTo(p.x, p.y);
      FX.ctx.lineTo(p.x + p.vx * 3, p.y + p.len);
      FX.ctx.stroke();
    } else {
      FX.ctx.fillStyle = fxColor(p, t);
      FX.ctx.beginPath();
      FX.ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      FX.ctx.fill();
    }
  }
  FX.ctx.restore();
  FX.raf = requestAnimationFrame(fxLoop);
}

/* ---------------- 音效系统（Web Audio 全合成，无素材） ---------------- */

const SND = {
  ctx: null,
  master: null,
  ambientNodes: [],
  enabled: localStorage.getItem("ta_sound") !== "off",
  worldId: null,
};

function sndEnsureCtx() {
  if (!SND.ctx) {
    SND.ctx = new (window.AudioContext || window.webkitAudioContext)();
    SND.master = SND.ctx.createGain();
    SND.master.gain.value = SND.enabled ? 0.5 : 0;
    SND.master.connect(SND.ctx.destination);
  }
  if (SND.ctx.state === "suspended") SND.ctx.resume();
  return SND.ctx;
}

function sndToggle() {
  SND.enabled = !SND.enabled;
  localStorage.setItem("ta_sound", SND.enabled ? "on" : "off");
  if (SND.master) SND.master.gain.linearRampToValueAtTime(SND.enabled ? 0.5 : 0, SND.ctx.currentTime + 0.3);
  $("btnSound").textContent = SND.enabled ? "🔊" : "🔇";
  if (SND.enabled) { sndEnsureCtx(); sndAmbient(SND.worldId); }
  toast(SND.enabled ? "音效已开启" : "音效已关闭");
}

/* 白噪声 buffer（复用） */
let _noiseBuf = null;
function noiseBuffer(ctx) {
  if (_noiseBuf) return _noiseBuf;
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  _noiseBuf = buf;
  return buf;
}

/* 环境音：按世界切换 */
function sndAmbient(worldId) {
  SND.worldId = worldId;
  if (!SND.enabled) return;
  const ctx = sndEnsureCtx();
  // 清掉旧环境音
  SND.ambientNodes.forEach((n) => { try { n.stop ? n.stop() : n.disconnect(); } catch (e) {} });
  SND.ambientNodes = [];

  const t = ctx.currentTime;

  if (worldId === "linlan") {
    // 雨：带通滤波噪声 + 偶尔雷声
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx); src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2400; bp.Q.value = 0.4;
    const g = ctx.createGain(); g.gain.value = 0.055;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.02;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    src.connect(bp); bp.connect(g); g.connect(SND.master);
    src.start(); lfo.start();
    SND.ambientNodes.push(src, lfo, g);
  } else if (worldId === "station_elysium") {
    // 深空低鸣：两个失谐低频正弦 + 极慢呼吸
    const o1 = ctx.createOscillator(); o1.frequency.value = 48;
    const o2 = ctx.createOscillator(); o2.frequency.value = 48.7;
    const g = ctx.createGain(); g.gain.value = 0.035;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.015;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    o1.connect(g); o2.connect(g); g.connect(SND.master);
    o1.start(); o2.start(); lfo.start();
    SND.ambientNodes.push(o1, o2, lfo, g);
  } else if (worldId === "neon_echo") {
    // 霓虹 pad：锯齿波和弦 + 低通 + 慢颤
    const freqs = [110, 164.81, 220];
    const g = ctx.createGain(); g.gain.value = 0.018;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 900;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.5;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.008;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    freqs.forEach((f) => {
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f;
      o.connect(lp); o.start();
      SND.ambientNodes.push(o);
    });
    lp.connect(g); g.connect(SND.master); lfo.start();
    SND.ambientNodes.push(lfo, g, lp);
  } else {
    // 雾隐谷 / 默认：风声（低频噪声 + 缓慢滤波漂移）
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx); src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 320;
    const g = ctx.createGain(); g.gain.value = 0.045;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09;
    const lfoG = ctx.createGain(); lfoG.gain.value = 160;
    lfo.connect(lfoG); lfoG.connect(lp.frequency);
    src.connect(lp); lp.connect(g); g.connect(SND.master);
    src.start(); lfo.start();
    SND.ambientNodes.push(src, lfo, g, lp);
  }
}

/* 事件音 */
function sndEvent(kind) {
  if (!SND.enabled) return;
  const ctx = sndEnsureCtx();
  const t = ctx.currentTime;

  const tone = (freq, dur, type = "sine", vol = 0.12, slide = 0) => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(SND.master);
    o.start(t); o.stop(t + dur + 0.05);
  };

  switch (kind) {
    case "hurt":       // 受击：低频钝响
      tone(110, 0.35, "triangle", 0.2, -60);
      break;
    case "sanity":     // 神智：失谐双音下滑
      tone(520, 0.5, "sine", 0.09, -180);
      tone(523, 0.5, "sine", 0.09, -200);
      break;
    case "item":       // 得物：轻快双音
      tone(660, 0.12, "sine", 0.1);
      setTimeout(() => tone(880, 0.18, "sine", 0.1), 90);
      break;
    case "turn":       // 新幕开始：柔和提示音
      tone(392, 0.25, "sine", 0.06);
      setTimeout(() => tone(523.25, 0.3, "sine", 0.05), 120);
      break;
    case "ending":     // 结局：钟声般的泛音
      [261.6, 329.6, 392, 523.3].forEach((f, i) => setTimeout(() => tone(f, 1.6, "sine", 0.07), i * 140));
      break;
    case "send":       // 发送：轻点
      tone(700, 0.06, "square", 0.03);
      break;
  }
}

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function textToHtml(t) {
  return t.split(/\n{2,}/).filter(Boolean).map((p) => `<p>${mdInline(p)}</p>`).join("");
}

function mdInline(t) {
  return esc(t)
    .replace(/\*\*(.+?)\*\*/g, "<em>$1</em>")
    .replace(/「(.+?)」/g, '<em style="color:var(--gold-bright)">「$1」</em>');
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

let toastTimer = null;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

function openModal() { $("modalMask").classList.remove("hidden"); }
function closeModal() { $("modalMask").classList.add("hidden"); }

function switchScreen(name) {
  START_SCREENS.forEach((s) => $(s).classList.toggle("hidden", name !== "start"));
  $("gameScreen").classList.toggle("hidden", name !== "game");
  S.screen = name;
}

function applyWorldTheme(worldId) {
  document.body.className = "world-" + (worldId || "default");
  fxSetWorld(worldId);
  sndAmbient(worldId);
}

let _menuConfirmTimer = null;
function backToStart() {
  if (!S.ended && S.turn > 0) {
    // WebView 里 confirm() 不可靠，改用「3 秒内再点一次确认」
    if (!_menuConfirmTimer) {
      toast("再点一次离开（3 秒内）");
      _menuConfirmTimer = setTimeout(() => { _menuConfirmTimer = null; }, 3000);
      return;
    }
    clearTimeout(_menuConfirmTimer);
    _menuConfirmTimer = null;
  }
  location.reload();
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  // 开始流程导航
  $("btnTitle").onclick = gotoPick;
  $("btnPickBack").onclick = gotoTitle;
  $("btnDetailBack").onclick = gotoPick;
  $("btnGoName").onclick = gotoName;
  $("btnNameBack").onclick = () => gotoDetail(S.worldCardSel);
  $("btnCollection").onclick = openCollectionModal;
  $("btnForge").onclick = gotoForge;
  $("btnForgeBack").onclick = gotoTitle;
  $("btnForgeGo").onclick = forgeWorld;
  $("btnSettings").onclick = gotoSettings;
  $("btnSettingsBack").onclick = gotoTitle;
  $("btnTestKey").onclick = testApiKey;
  $("btnSaveCfg").onclick = saveApiKey;
  document.querySelectorAll("#diffSeg .diff-btn").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#diffSeg .diff-btn").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      S.difficulty = parseInt(b.dataset.d, 10);
    };
  });
  document.querySelectorAll(".preset-btn").forEach((b) => {
    b.onclick = () => {
      $("cfgBaseUrl").value = b.dataset.base;
      $("cfgModel").value = b.dataset.model;
      $("cfgStatus").textContent = "";
    };
  });

  $("btnStart").onclick = startGame;
  $("playerName").addEventListener("keydown", (e) => { if (e.key === "Enter") startGame(); });
  $("styleRange").oninput = (e) => {
    $("styleVal").textContent = ["简练", "均衡", "沉浸"][e.target.value];
  };
  $("btnQuickLoad").onclick = () => openLoadModal(true);

  // 游戏界面
  $("btnSend").onclick = () => {
    const input = $("playerInput");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "46px";
    sndEvent("send");
    playerAct(text);
  };

  $("playerInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("btnSend").click();
    }
  });
  $("playerInput").addEventListener("input", function () {
    // 重置为单行基准再按内容撑高；短内容保持单行不出现滚动条
    this.style.height = "46px";
    this.style.height = Math.max(46, Math.min(this.scrollHeight + 2, 128)) + "px";
  });

  $("btnSave").onclick = doSave;
  $("btnLoad").onclick = () => openLoadModal(false);
  $("btnImage").onclick = genImage;
  $("btnMenu").onclick = backToStart;
  $("btnSound").onclick = sndToggle;
  $("btnSound").textContent = SND.enabled ? "🔊" : "🔇";

  $("btnGmToggle").onclick = () => {
    const note = $("gmNote");
    const hidden = note.classList.toggle("hidden");
    $("btnGmToggle").textContent = hidden ? "显示" : "隐藏";
  };

  // 结局
  $("btnEndingRestart").onclick = () => location.reload();
  $("btnEndingReview").onclick = () => $("endingScreen").classList.add("hidden");
  $("btnEndingExport").onclick = exportJourney;
  $("btnEndingCard").onclick = shareEndingCard;

  // 前情 / 重推
  $("btnRecall").onclick = openRecallModal;
  $("btnRetry").onclick = retryTurn;

  // 移动端侧栏抽屉
  const sidePane = document.querySelector(".side-pane");
  const sideMask = $("sideMask");
  const toggleSide = (open) => {
    sidePane.classList.toggle("open", open);
    sideMask.classList.toggle("hidden", !open);
  };
  $("btnSide").onclick = () => toggleSide(!sidePane.classList.contains("open"));
  sideMask.onclick = () => toggleSide(false);

  // 软键盘自适应：interactive-widget 在部分厂商 WebView 不生效，
  // 用 visualViewport 直接压缩 #gameScreen 高度（键盘弹出=界面变矮，收起=恢复）
  if (window.visualViewport) {
    // 基准高度：取启动时较大的那个，避免 innerHeight 跟着键盘变导致判定失效
    let vvBase = Math.max(window.visualViewport.height, window.innerHeight);
    const fitToViewport = () => {
      const game = $("gameScreen");
      const h = window.visualViewport.height;
      const shrunk = h < vvBase - 40; // 键盘弹出判定（原生层已加 IME padding，这里阈值放低）
      if (!shrunk) {
        vvBase = Math.max(vvBase, h); // 键盘收起后更新基准（如旋转屏幕）
        // 彻底复位：清掉内联高度，回到 CSS 的 100dvh（开始流程四屏是 .screen.start，CSS 已 100dvh）
        if (game) game.style.height = "";
        START_SCREENS.forEach((s) => $(s).style.height = "");
      } else {
        if (game) game.style.height = h + "px";
        START_SCREENS.forEach((s) => $(s).style.height = h + "px");
      }
      if (shrunk) scrollBottom();
    };
    window.visualViewport.addEventListener("resize", fitToViewport);
    window.visualViewport.addEventListener("scroll", fitToViewport);
    fitToViewport();
  }

  // 聚焦输入框兜底：等键盘动画完成后再滚到底
  const playerInput = $("playerInput");
  playerInput.addEventListener("focusin", () => {
    setTimeout(scrollBottom, 300);
    setTimeout(scrollBottom, 700);
  });
  playerInput.addEventListener("focusout", () => {
    setTimeout(scrollBottom, 100);
  });

  // 弹窗
  $("modalClose").onclick = closeModal;
  $("modalMask").onclick = (e) => { if (e.target === $("modalMask")) closeModal(); };
}

/* ---------------- 启动 ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  loadWorlds();
  fxInit();
  initFontSize();
  checkAutoSaveBanner();
});

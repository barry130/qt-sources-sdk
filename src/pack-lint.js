/**
 * 音源包内容预检 —— 宿主安装期内容安全扫描的**公开镜像**。
 *
 * ## 为什么 SDK 里要有一份
 *
 * 宿主对第三方包的内容扫描在 `qt-pc/src-tauri/src/pack_safety.rs`（与
 * `qt-uniappx/services/pack-safety.uts` 逐条一致）。命中即**拒装**，而拒装的反馈
 * 出现在用户那侧、作者看不到。洛雪源脚本是第三方写的，里面出现 `fetch(` /
 * `new XMLHttpRequest` 字面量非常常见——直接把原文塞进播放包，作者会拿到
 * 「装上去了但装不上」这种说不清的结果。
 *
 * 所以打包器在**产出前**先扫一遍，把命中的模式、理由、行号报给作者。
 *
 * ## 这份镜像的纪律
 *
 * - 规则表与判定算法**逐条对齐** `pack_safety.rs`，改一边必须改另一边；
 * - 扫描对象是**剥掉签名块后的包正文**——本 SDK 产出的包不带签名块，
 *   所以直接扫全文本即可；
 * - 与宿主一致，**刻意不拦 `eval(` / `Function(`**：crypto-js 的
 *   `Function("return this")()` 探测是内联加密库标配，拦了会误杀主流第三方包。
 *   （这也是本 SDK 的洛雪运行时能安全地用 `new Function` 装载脚本的前提。）
 *
 * ## 这不是「绕过检测」的工具
 *
 * 预检只做**报告**，不做改写。本 SDK **不会**帮你把 `fetch(` 拆成 `fet` + `ch(`
 * 之类来骗过扫描——那是绕过安全闸门，不是打包。命中就如实告诉作者：这个源不能
 * 以第三方包形式分发，要么改源，要么走官方签名包渠道。
 */

/** RAW 规则：纯子串匹配，命中即拒（官方保留 id 只记日志） */
export const RAW_PATTERNS = [
  // ---- 宿主/系统桥：拿到即可能越出引擎沙箱 ----
  ["__TAURI_INTERNALS__", "Tauri IPC 内部对象（可跨过引擎窗口直接调用应用命令）"],
  ["__TAURI__", "Tauri 宿主桥（可跨过引擎窗口直接调用应用命令）"],
  ["ipcRenderer", "Electron IPC 桥"],
  ["webkit.messageHandlers", "WKWebView 原生桥"],
  ["UTSAndroid", "uni-app x 原生桥"],
  ["io.dcloud", "uni-app 原生运行时"],
  // ---- 自由外联面：绕过宿主网络出口（builtin_request 的协议/内网校验）----
  ["WebSocket", "自由长连接（绕过宿主网络出口）"],
  ["EventSource", "SSE 外联（绕过宿主网络出口）"],
  ["sendBeacon", "浏览器上报通道（绕过宿主网络出口）"],
  ["new XMLHttpRequest", "XHR 直连（绕过宿主网络出口）"],
  // ---- 后台执行体 ----
  ["importScripts", "Worker 脚本注入"],
  ["new Worker(", "后台 Worker（不受引擎生命周期管理）"],
  ["ServiceWorker", "Service Worker（可劫持引擎页网络）"],
  ["serviceWorker", "Service Worker（可劫持引擎页网络）"],
  // ---- Node/本地文件面（引擎环境本就不该出现）----
  ["child_process", "Node 子进程"],
  ["process.binding", "Node 进程内 API"],
  ["content://", "Android 内容提供器访问"],
];

/** CALL 规则：`模式(` 且前一字符不是标识符/`.` */
export const CALL_PATTERNS = [
  ["fetch(", "全局 fetch 直连（音源包的网络出口只能是 host.request）"],
  ["require(", "CommonJS require（引擎是 ESM 环境，无此全局）"],
];

/**
 * `c` 是否为标识符字符或 `.`（CALL 形态里这些前缀意味着方法调用/更长标识符）。
 * 对齐 `pack_safety.rs:69-71` 的 `is_ident_or_dot`。
 */
function isIdentOrDot(c) {
  return /[A-Za-z0-9_$.]/.test(c);
}

/**
 * 在 `text` 中找 CALL 形态的 `pattern`（首个命中下标；无则 -1）。
 *
 * 对齐 `pack_safety.rs:78-92`：`backend.fetch(songId)`（方法调用）与
 * `prefetch(url)`（长词）都不算，`fetch("https://…")`、`await fetch(…)`
 * 之类才算全局调用。
 */
export function findCallPattern(text, pattern) {
  let from = 0;
  for (;;) {
    const idx = text.indexOf(pattern, from);
    if (idx < 0) return -1;
    const okPrefix = idx === 0 || !isIdentOrDot(text[idx - 1]);
    if (okPrefix) return idx;
    from = idx + pattern.length;
  }
}

/** 命中下标 → 行号（1 起）。对齐 `pack_safety.rs:95-101` 的 `line_of`。 */
export function lineOf(text, idx) {
  let line = 1;
  const end = Math.min(idx, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * 扫描包文本，返回全部命中。
 *
 * @param {string} text 包正文（本 SDK 产物无签名块，直接传全文本）
 * @returns {{pattern: string, reason: string, line: number, kind: "raw"|"call", snippet: string}[]}
 */
export function scanPackText(text) {
  const src = String(text == null ? "" : text);
  const hits = [];

  const push = (pattern, reason, idx, kind) => {
    const line = lineOf(src, idx);
    // 取命中所在行的原文，给作者一眼能定位的上下文
    let start = src.lastIndexOf("\n", idx - 1) + 1;
    let end = src.indexOf("\n", idx);
    if (end < 0) end = src.length;
    let snippet = src.slice(start, end).trim();
    if (snippet.length > 160) snippet = snippet.slice(0, 157) + "...";
    hits.push({ pattern, reason, line, kind, snippet });
  };

  for (const [pattern, reason] of RAW_PATTERNS) {
    const idx = src.indexOf(pattern);
    if (idx >= 0) push(pattern, reason, idx, "raw");
  }
  for (const [pattern, reason] of CALL_PATTERNS) {
    const idx = findCallPattern(src, pattern);
    if (idx >= 0) push(pattern, reason, idx, "call");
  }

  // 与宿主一致：按行号排序，方便作者从上往下看
  hits.sort((a, b) => a.line - b.line || a.pattern.localeCompare(b.pattern));
  return hits;
}

/**
 * 把命中列表渲染成人读报告（CLI 与构建函数共用）。
 *
 * @param {{pattern: string, reason: string, line: number, kind: string, snippet: string}[]} hits
 * @returns {string} 无命中时空串
 */
export function formatHits(hits) {
  if (!hits || hits.length === 0) return "";
  const lines = [
    `内容安全预检命中 ${hits.length} 处（宿主安装期会据此拒绝第三方包）：`,
  ];
  for (const h of hits) {
    lines.push(`  第 ${h.line} 行  [${h.kind === "raw" ? "字面量" : "调用形态"}]  ${h.pattern}`);
    lines.push(`      理由：${h.reason}`);
    if (h.snippet) lines.push(`      原文：${h.snippet}`);
  }
  lines.push(
    "  说明：宿主对第三方包「命中即拒装」。请改源（把所有网络出口收敛到 lx.request / host.request），",
  );
  lines.push(
    "        或走官方签名包渠道。本工具不会帮你把命中文字拆开以骗过扫描——那是绕过安全闸门。",
  );
  return lines.join("\n");
}

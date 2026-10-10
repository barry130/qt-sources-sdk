/**
 * 洛雪打包器自测 —— 不需要测试框架，`node scripts/test-lx-packer.mjs` 直接跑。
 *
 * 覆盖四层，缺一层就不算「能用」：
 *   1. 预检镜像：与 `pack_safety.rs` 同规则的判定（含 CALL 形态的前缀豁免）；
 *   2. 打包器：包头字段、id 校验、保留 id、versionCode 校验、U+2028 转义；
 *   3. **产物真能装配**：把生成文本当脚本求值 → 调 `__qtPlayPackFactory(host)`
 *      → 用桩 host.request 喂一个假的洛雪后端 → 验证取链返回的 JSON 形状。
 *      这一层是重点：生成成功 ≠ 能跑。
 *   4. 失败口径：脚本里没有取链入口时，错误文本要是人话。
 *
 * 退出码 0 全过；1 有失败。
 */
import { createLxBridgeRuntime } from "../src/lx-runtime.js";
import { buildLxPlayPack, toPackId } from "../src/build-lx-pack.js";
import { scanPackText, findCallPattern, lineOf } from "../src/pack-lint.js";

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ─────────────────────────── 1. 预检镜像 ───────────────────────────

console.log("\n[1] 内容预检（pack_safety.rs 镜像）");

eq("RAW 命中 new XMLHttpRequest", scanPackText("var x = new XMLHttpRequest();").length, 1);
eq("RAW 不误伤 XMLHttpRequest 字面量", scanPackText('headers:{"X-Requested-With":"XMLHttpRequest"}').length, 0);
eq("CALL 命中裸 fetch(", scanPackText('fetch("https://a.b")').length, 1);
eq("CALL 不误伤 backend.fetch(", scanPackText("backend.fetch(url)").length, 0);
eq("CALL 不误伤 prefetch(", scanPackText("prefetch(url)").length, 0);
eq("CALL 命中 require(", scanPackText('var x = require("fs")').length, 1);
eq("刻意不拦 eval(", scanPackText('eval("1")').length, 0);
eq("刻意不拦 Function(", scanPackText('Function("return this")()').length, 0);
eq("WebSocket 命中", scanPackText("new WebSocket(u)").length, 1);

check(
  "行号定位正确",
  lineOf("a\nb\nc", 4) === 3,
  `实际 ${lineOf("a\nb\nc", 4)}`,
);
check(
  "findCallPattern 跳过方法调用后仍能命中真调用",
  findCallPattern("backend.fetch(1); fetch(2)", "fetch(") === 18,
  `实际 ${findCallPattern("backend.fetch(1); fetch(2)", "fetch(")}`,
);

// ─────────────────────────── 2. 打包器校验 ───────────────────────────

console.log("\n[2] 打包器");

eq("toPackId 中文转连字符", toPackId("洛雪 音乐源"), "");
eq("toPackId 英文正常", toPackId("LX Music Source v2"), "lx-music-source-v2");

const badId = buildLxPlayPack({ scriptText: "var a=1;", id: "A_B", versionCode: 1 });
check("非法 id 被拒", !badId.ok && /id 不合法/.test(badId.error), badId.error);

const reserved = buildLxPlayPack({ scriptText: "var a=1;", id: "play-official", versionCode: 1 });
check("官方保留 id 被拒", !reserved.ok && /保留 id/.test(reserved.error), reserved.error);

const badVer = buildLxPlayPack({ scriptText: "var a=1;", id: "lx-t", versionCode: 0 });
check("versionCode=0 被拒", !badVer.ok && /versionCode/.test(badVer.error), badVer.error);

const badVer2 = buildLxPlayPack({ scriptText: "var a=1;", id: "lx-t", versionCode: 1.5 });
check("非整数 versionCode 被拒", !badVer2.ok, badVer2.error);

const empty = buildLxPlayPack({ scriptText: "   ", id: "lx-t", versionCode: 1 });
check("空脚本被拒", !empty.ok, empty.error);

// U+2028 必须被转义：它在 JSON 里合法，在旧版 JS 字符串字面量里是换行
const withSep = buildLxPlayPack({
  scriptText: 'var s = "\u2028";\n@name 分隔符源\nlx.on("request",function(){return "u"});',
  id: "lx-sep",
  versionCode: 1,
});
check("含 U+2028 的脚本能打包", withSep.ok, withSep.error);
check(
  "产物里 U+2028 已转义",
  withSep.ok && withSep.text.indexOf("\u2028") < 0 && withSep.text.indexOf("\\u2028") >= 0,
);
check(
  "产物首行是合法包头",
  /^\/\*__QT_PACK__\{"kind":"play","id":"lx-sep"/.test(withSep.text),
  withSep.text.slice(0, 80),
);

// 回归：@name 行以 `*/` 收尾的单行注释头（真实洛雪源里极常见）——
// 必须不提前闭合包头块注释，首行可 JSON.parse，全文可编译。
const starSlash = buildLxPlayPack({
  scriptText:
    '/* @name 带星号源 @version 1.0 @author 测试 */\nlx.on(lx.EVENT_NAMES.request,function(){return "u";});',
  id: "lx-starslash",
  versionCode: 1,
});
check("@name 含 */ 的源能打包", starSlash.ok, starSlash.error);
let starSlashFirstParsed = null;
let starSlashCompiles = false;
if (starSlash.ok) {
  const firstLine = starSlash.text.slice(0, starSlash.text.indexOf("\n"));
  try {
    const m = firstLine.match(/^\/\*__QT_PACK__(\{.*\})\*\/$/);
    starSlashFirstParsed = JSON.parse(m[1]);
  } catch (e) {
    starSlashFirstParsed = { parseError: e.message, line: firstLine };
  }
  try {
    new Function(starSlash.text);
    starSlashCompiles = true;
  } catch (e) {
    starSlashCompiles = false;
    console.log(`      编译失败：${e.message}`);
  }
}
check("包头行可 JSON.parse", !!starSlashFirstParsed && starSlashFirstParsed.name === "带星号源", JSON.stringify(starSlashFirstParsed));
eq("包头 JSON.name 不含 */ 残留", starSlashFirstParsed && starSlashFirstParsed.name, "带星号源");
check("全文可编译", starSlashCompiles);

// ─────────────────────────── 3. 产物真能装配 ───────────────────────────

console.log("\n[3] 产物装配与取链（端到端）");

/** 一个最小但形状正确的洛雪 v2 源：注册 handler，返回固定地址 */
const FAKE_LX_SOURCE = `
/* @name 自测洛雪源 @version 9.9 @author 测试 */
lx.on(lx.EVENT_NAMES.request, function (req) {
  if (req.action !== "musicUrl") throw new Error("unexpected action " + req.action);
  // 走 lx.request 拿一次「后端」响应，验证宿主出口是通的
  return new Promise(function (resolve, reject) {
    lx.request("https://backend.invalid/api", { method: "GET" }, function (err, res) {
      if (err) return reject(err);
      resolve("https://cdn.example.com/" + req.info.musicInfo.songmid + "." + req.info.type + ".mp3?tag=" + res.body.tag);
    });
  });
});
`;

const built = buildLxPlayPack({
  scriptText: FAKE_LX_SOURCE,
  id: "lx-selftest",
  versionCode: 7,
  versionName: "7.0",
});
check("自测源打包成功", built.ok, built.error);
check("自测源预检无命中", built.lint.length === 0, JSON.stringify(built.lint));

/** 桩宿主：只实现契约里的 request/log */
const requestLog = [];
const fakeHost = {
  platform: 1103,
  log() {},
  request(url, options) {
    requestLog.push({ url, options });
    return Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "text/plain" },
      body: { tag: "ok" },
    });
  },
};

// 在独立作用域里求值产物（模拟宿主引擎求值包文件）
let factory = null;
const globals = { __qtPlayPackFactory: null };
try {
  // 产物是普通脚本（IIFE），求值后挂 globalThis.__qtPlayPackFactory
  const runner = new Function(
    "globalThis",
    built.text + "\n;return globalThis.__qtPlayPackFactory;",
  );
  factory = runner(globals);
} catch (err) {
  check("产物可求值", false, err && err.message ? err.message : String(err));
}
check("产物挂出了 __qtPlayPackFactory", typeof factory === "function");

if (typeof factory === "function") {
  const api = factory(fakeHost);
  check("工厂返回 name", api.name === "自测洛雪源", api.name);
  check("工厂返回 version", api.version === "7.0", api.version);
  check("loadChain 回 ok", /"ok":true/.test(api.loadChain("{}")));
  check("bundleInfo 是 JSON", (() => {
    try {
      const info = JSON.parse(api.bundleInfo());
      return info.scriptMd5 && info.scriptMd5.length === 32;
    } catch (e) {
      return false;
    }
  })(), api.bundleInfo());

  const result = await api
    .getPlayUrl({ platform: "wyy", id: "12345", name: "测试曲", singer: "测试歌手", album: "测试专辑", quality: "320", duration: 200 })
    .then((text) => JSON.parse(text), (err) => ({ error: err && err.message ? err.message : String(err) }));

  check("取链成功", !result.error, result.error);
  check("url 由脚本逻辑生成", typeof result.url === "string" && result.url.indexOf("12345") >= 0, result.url);
  eq("source 回显", result.source, "wyy");
  eq("quality 回显", result.quality, "320");
  eq("line.kind 是 lx", result.line && result.line.kind, "lx");
  eq("line.id 是包 id", result.line && result.line.id, "lx-selftest");
  check("音质映射 320 → 320k", typeof result.url === "string" && result.url.indexOf(".320k.mp3") >= 0, result.url);
  check(
    "脚本的 lx.request 走了宿主出口并带上后端响应",
    requestLog.length === 1 && requestLog[0].url === "https://backend.invalid/api" && /tag=ok/.test(result.url),
    JSON.stringify(requestLog),
  );
}

// 死后端要快速失败
console.log("\n[3b] 死后端剪线");
const bridgeDead = createLxBridgeRuntime({
  host: {
    request: () => {
      throw new Error("不该发出去");
    },
  },
  scriptText: `
lx.on(lx.EVENT_NAMES.request, function (req) {
  return new Promise(function (resolve, reject) {
    lx.request("https://api.xcvts.cn/x", {}, function (err, res) { err ? reject(err) : resolve("u"); });
  });
});
`,
  scriptName: "死后端源",
});
const deadResult = await bridgeDead.getUrl("wyy", { id: "1", name: "n", singer: "s", album: "a" }, "128").then(
  (u) => ({ url: u }),
  (err) => ({ error: err && err.message ? err.message : String(err) }),
);
check("死后端被剪线而非发出请求", !!deadResult.error && /已失效/.test(deadResult.error), deadResult.error);

// ─────────────────────────── 4. 失败口径与 v1 兼容 ───────────────────────────

console.log("\n[4] 失败口径与 v1 兼容");

const noEntry = createLxBridgeRuntime({
  host: { request: () => Promise.resolve({ statusCode: 200, headers: {}, body: null }) },
  scriptText: "var x = 1;",
  scriptName: "没有入口的源",
  initTimeoutMs: 300,
});
const noEntryResult = await noEntry.ensureReady().then(
  () => ({ ok: true }),
  (err) => ({ error: err && err.message ? err.message : String(err) }),
);
check(
  "无取链入口时报人话错误",
  !!noEntryResult.error && /未注册取链入口/.test(noEntryResult.error),
  noEntryResult.error,
);

// v1 口径：顶层 onRequest(id, option)
const v1 = createLxBridgeRuntime({
  host: { request: () => Promise.resolve({ statusCode: 200, headers: {}, body: {} }) },
  scriptText: `
function onRequest(id, option) {
  if (id !== "lx_MUSIC_URL") throw new Error("bad id " + id);
  return "https://v1.example.com/" + option.musicInfo.hash + "/" + option.quality;
}
`,
  scriptName: "v1 源",
  initTimeoutMs: 500,
});
const v1Result = await v1
  .getUrl("kg", { id: "HASH1", name: "n", singer: "s", album: "a" }, "flac")
  .then((u) => ({ url: u }), (err) => ({ error: err && err.message ? err.message : String(err) }));
check("v1 onRequest 被接住", !v1Result.error, v1Result.error);
eq("v1 拿到 id 别名 hash 与 flac 口径", v1Result.url, "https://v1.example.com/HASH1/flac");

// module.exports.onRequest 口径
const v1mod = createLxBridgeRuntime({
  host: { request: () => Promise.resolve({ statusCode: 200, headers: {}, body: {} }) },
  scriptText: `module.exports.onRequest = function (id, o) { return "https://v1mod/" + o.type; };`,
  scriptName: "v1 module 源",
  initTimeoutMs: 500,
});
const v1modResult = await v1mod
  .getUrl("kw", { id: "1", name: "n", singer: "s", album: "a" }, "128")
  .then((u) => ({ url: u }), (err) => ({ error: err && err.message ? err.message : String(err) }));
eq("module.exports.onRequest 被接住", v1modResult.url, "https://v1mod/128k");

// 平台 id 映射：qt 用 wyy/qq，洛雪协议用 wy/tx——脚本按洛雪名解构 apis[source]，
// 传错名字会直接 `apis[source].musicUrl` 报 undefined（真实源踩过）。
const idEcho = createLxBridgeRuntime({
  host: { request: () => Promise.resolve({ statusCode: 200, headers: {}, body: {} }) },
  scriptText: `lx.on(lx.EVENT_NAMES.request, function (req) { return "https://id/" + req.source; });`,
  scriptName: "平台回显源",
  initTimeoutMs: 500,
});
const echoOf = (s) =>
  idEcho.getUrl(s, { id: "1", name: "n", singer: "s", album: "a" }, "128").then(
    (u) => u.replace("https://id/", ""),
    (err) => "ERR:" + (err && err.message),
  );
// 未申报平台必须回人话，不能让脚本内部的 apis[source] 炸成英文天书。
// 真实源「稳定版音源」只声明 wy/tx/kw，问它 kg 就是这种情形。
const guard = createLxBridgeRuntime({
  host: { request: () => Promise.resolve({ statusCode: 200, headers: {}, body: {} }) },
  scriptText: `
lx.send(lx.EVENT_NAMES.inited, { sources: { wy: { qualitys: ["128k"] }, tx: { qualitys: ["128k"] }, kw: { qualitys: ["128k"] } } });
var apis = { wy: { musicUrl: function () { return "https://a/"; } }, tx: { musicUrl: function () { return "https://b/"; } }, kw: { musicUrl: function () { return "https://c/"; } } };
lx.on(lx.EVENT_NAMES.request, function (req) { return apis[req.source].musicUrl(req.info.musicInfo, req.info.type); });
`,
  scriptName: "有声明的源",
  initTimeoutMs: 500,
});
const guardOut = await guard
  .getUrl("kg", { id: "1", name: "n", singer: "s", album: "a" }, "128")
  .then((u) => "OK:" + u, (e) => e && e.message);
check(
  "未申报平台回人话而非 undefined 天书",
  typeof guardOut === "string" && /不支持该平台/.test(guardOut) && !/undefined/.test(guardOut),
  String(guardOut),
);
const guardDeclared = await guard
  .getUrl("wyy", { id: "1", name: "n", singer: "s", album: "a" }, "128")
  .then((u) => "OK:" + u, (e) => "ERR:" + (e && e.message));
eq("已申报平台不受拦截（wyy→wy）", guardDeclared, "OK:https://a/");

eq("wyy → wy（网易云）", await echoOf("wyy"), "wy");
eq("qq → tx（QQ 音乐）", await echoOf("qq"), "tx");
eq("kg 恒等", await echoOf("kg"), "kg");
eq("kw 恒等", await echoOf("kw"), "kw");
eq("mg 恒等", await echoOf("mg"), "mg");

// 反调试：process.exit 必须被挡住
console.log("\n[5] 反调试遮蔽");
const anti = createLxBridgeRuntime({
  host: { request: () => Promise.resolve({ statusCode: 200, headers: {}, body: {} }) },
  scriptText: `
try { process.exit(1); } catch (e) { globalThis.__exitBlocked = true; }
lx.on(lx.EVENT_NAMES.request, function () { return "https://ok/" + (globalThis.__exitBlocked ? "blocked" : "leaked"); });
`,
  scriptName: "反调试源",
});
const antiResult = await anti
  .getUrl("wyy", { id: "1", name: "n", singer: "s", album: "a" }, "128")
  .then((u) => ({ url: u }), (err) => ({ error: err && err.message ? err.message : String(err) }));
eq("process.exit 被阻断", antiResult.url, "https://ok/blocked");

// md5 正确性（对照已知向量）
console.log("\n[6] 内建算法正确性");
const md5case = createLxBridgeRuntime({
  host: { request: () => Promise.resolve({ statusCode: 200, headers: {}, body: {} }) },
  scriptText: `
lx.on(lx.EVENT_NAMES.request, function () {
  return "https://x/" + [
    lx.utils.crypto.md5(""),
    lx.utils.crypto.md5("abc"),
    lx.utils.crypto.md5("The quick brown fox jumps over the lazy dog"),
    lx.utils.buffer.bufToString(lx.utils.buffer.from("Hi"), "hex"),
    lx.utils.buffer.bufToString(lx.utils.buffer.from("Hi"), "base64"),
    SCRIPT_MD5.length
  ].join("|");
});
`,
  scriptName: "算法源",
});
const md5Result = await md5case
  .getUrl("wyy", { id: "1", name: "n", singer: "s", album: "a" }, "128")
  .then((u) => u.replace("https://x/", ""), (err) => "ERR:" + (err && err.message));
const parts = String(md5Result).split("|");
eq("md5('')", parts[0], "d41d8cd98f00b204e9800998ecf8427e");
eq("md5('abc')", parts[1], "900150983cd24fb0d6963f7d28e17f72");
eq("md5(quick brown fox)", parts[2], "9e107d9d372bb6826bd81d3542a419d6");
eq("buffer hex", parts[3], "4869");
eq("buffer base64", parts[4], "SGk=");
eq("SCRIPT_MD5 是 32 位 hex", parts[5], "32");

// AES：对照 NIST SP 800-38A F.1.1（AES-128-ECB 单块向量）。
// 运行时自带 PKCS7 填充：16 字节明文会补成 32 字节（两块），第一块即该向量。
const aescase = createLxBridgeRuntime({
  host: { request: () => Promise.resolve({ statusCode: 200, headers: {}, body: {} }) },
  scriptText: `
lx.on(lx.EVENT_NAMES.request, function () {
  var key = lx.utils.buffer.fromHex("2b7e151628aed2a6abf7158809cf4f3c");
  var pt = lx.utils.buffer.fromHex("6bc1bee22e409f96e93d7e117393172a");
  var out = lx.utils.crypto.aesEncrypt(pt, "aes-128-ecb", key);
  return "https://x/" + lx.utils.buffer.bufToString(out, "hex");
});
`,
  scriptName: "aes 源",
});
const aesHex = await aescase
  .getUrl("wyy", { id: "1", name: "n", singer: "s", album: "a" }, "128")
  .then((u) => u.replace("https://x/", ""), (err) => "ERR:" + (err && err.message));
eq(
  "AES-128-ECB 第一块 = NIST 向量 3ad77bb4…",
  aesHex.slice(0, 32),
  "3ad77bb40d7a3660a89ecaf32466ef97",
);

// 8 字符输入 → PKCS7 补到恰好一个块 → 32 位 hex；且两次输出必须一致（确定性）
const aesSingle = await createLxBridgeRuntime({
  host: { request: () => Promise.resolve({ statusCode: 200, headers: {}, body: {} }) },
  scriptText: `lx.on(lx.EVENT_NAMES.request,function(){return "https://x/"+lx.utils.buffer.bufToString(lx.utils.crypto.aesEncrypt("abcdefgh","aes-128-ecb","e82ckenh8dichen8"),"hex");});`,
  scriptName: "aes 单块",
})
  .getUrl("wyy", { id: "1", name: "n", singer: "s", album: "a" }, "128")
  .then((u) => u.replace("https://x/", ""), (err) => "ERR:" + (err && err.message));
check("aesEncrypt 单块产出 32 位 hex", /^[0-9a-f]{32}$/.test(aesSingle), aesSingle);

const aesSingle2 = await createLxBridgeRuntime({
  host: { request: () => Promise.resolve({ statusCode: 200, headers: {}, body: {} }) },
  scriptText: `lx.on(lx.EVENT_NAMES.request,function(){return "https://x/"+lx.utils.buffer.bufToString(lx.utils.crypto.aesEncrypt("abcdefgh","aes-128-ecb","e82ckenh8dichen8"),"hex");});`,
  scriptName: "aes 单块2",
})
  .getUrl("wyy", { id: "1", name: "n", singer: "s", album: "a" }, "128")
  .then((u) => u.replace("https://x/", ""), () => "ERR");
eq("aesEncrypt 确定性", aesSingle2, aesSingle);

// ─────────────────────────── 收尾 ───────────────────────────

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exitCode = failed === 0 ? 0 : 1;

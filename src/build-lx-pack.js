/**
 * 洛雪源 → qt 播放包 打包器。
 *
 * ## 产物长什么样
 *
 * 一个**单文件、免构建、可直接安装**的播放包，结构固定四段：
 *
 * ```
 * 第 1 行  /*__QT_PACK__{"kind":"play",…}*​/     包头（宿主不执行就能读出身份）
 * IIFE {  运行时源码（lx-runtime.js 的工厂函数，toString 内嵌）
 *         洛雪源脚本原文（JSON 字符串常量）
 *         globalThis.__qtPlayPackFactory = function (host) { … } }
 * ```
 *
 * 包体是**普通脚本**（顶层无 import/export），求值后挂 `__qtPlayPackFactory`，
 * 与手写包（examples/hello-play-pack.js）完全同构——宿主看不出区别。
 *
 * ## 为什么把运行时和脚本原文都内嵌，而不是引外部文件
 *
 * 播放包必须是**单文件**：宿主只拿到一个文件，没有模块解析、没有相对路径。
 * 所以运行时代码直接内嵌（`createLxBridgeRuntime.toString()`），脚本原文以
 * JSON 字符串常量内嵌，运行时用 `new Function` + 形参遮蔽把它执行起来。
 * 详见 lx-runtime.js 的「这个文件为什么长这样」。
 *
 * ## 能力边界（作者必须知道）
 *
 * 只做**取链**（播放包本职）：LX 源的 `musicUrl` 动作。
 * 搜索 / 歌词 / 封面在 qt 这边属于 **meta 包**（数据包），不在本工具产出范围。
 */
import { createLxBridgeRuntime } from "./lx-runtime.js";
import { scanPackText, formatHits } from "./pack-lint.js";

/** 包头前缀（与 qt-pc `source_pack_header.rs:21` 的 PACK_HEADER_PREFIX 同步） */
const PACK_HEADER_PREFIX = "/*__QT_PACK__";

/** 包 id 规则：`^[a-z0-9-]{2,32}$`（与 `source_pack_header.rs:36-42` 的 valid_pack_id 同步） */
const PACK_ID_RE = /^[a-z0-9-]{2,32}$/;

/** 官方保留 id：必须带发布方 ed25519 签名才能安装，第三方作者不要用 */
const RESERVED_PACK_IDS = ["play-official", "meta-official"];

/**
 * 内联脚本原文为 JS 字符串字面量。
 *
 * `JSON.stringify` 处理引号/换行/反斜杠，但**不转义 U+2028/U+2029**——
 * 这两个字符在 JSON 里合法、在旧版 JS 字符串字面量里却是换行符，会造成语法错误。
 * 现代引擎已放宽，但转义成本是零，没有理由不转。
 */
function jsStringLiteral(text) {
  return JSON.stringify(String(text))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * 从脚本头取 @name/@description/@version/@author。
 *
 * 与构建仓口径一致：抓整行（`.+` 不跨行）。但对单行注释形态的头部
 * （`/* @name … @version …` 写在一行、以「星号-斜杠」收尾的那种，很常见），
 * `(.+)` 会把行尾的收尾注释符也抓进来。显示上难看，更重要的是它若被拼进
 * 包头 JSON 会提前闭合块注释（见 escapeCommentDanger），所以这里顺带裁掉。
 */
function parseHeader(raw) {
  // 抓到下一个 ` @` 指令（或行尾）为止，再裁掉可能残留的注释收尾符。
  // `/* @name 洛雪源 @version 1.0 @author 测试 */` → name 只取 `洛雪源`。
  const strip = (s) => s.trim().replace(/\s*\*\/?\s*$/, "");
  const grab = (re) => {
    const m = String(raw).match(re);
    return m && m[1] ? strip(m[1]) : "";
  };
  return {
    name: grab(/@name\s+([^@\n]+)/),
    description: grab(/@description\s+([^@\n]+)/),
    version: grab(/@version\s+([^@\n]+)/),
    author: grab(/@author\s+([^@\n]+)/),
  };
}

/**
 * 让任意用户源文本安全地出现在**块注释**里（包首行包头 / banner）。
 *
 * 洛雪源的 @name 行常以「星号-斜杠」收尾（随笔头写在单行注释里的形态，很常见），若
 * 直接拼进包首行那条 `/*__QT_PACK__{...}` + 收尾注释符 的句子，内层那个「星号-斜杠」
 * 会把外层块注释提前闭合，产出语法错误的包（首行剩下的 `..."versionCode":7,...` 全部
 * 变成代码）。
 *
 * `\u002f` 是合法的 JSON 转义——`JSON.parse` 会把它还原成 `/`，所以对包头 JSON
 * 无损；banner 是给人看的注释，同样的写法可读性也够。对「斜杠-星号」也顺手转义，
 * 防御注释序列在解析时的各种边界。
 */
function escapeCommentDanger(text) {
  return String(text).replace(/\*\//g, "*\\u002f").replace(/\/\*/g, "\\u002f*");
}

/** 把任意显示名转成合法包 id（小写、非 [a-z0-9-] 换连字符、截到 32 位） */
export function toPackId(text) {
  const id = String(text == null ? "" : text)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return id.length >= 2 ? id : "";
}

/**
 * 打包一份洛雪源为 qt 播放包。
 *
 * @param {object} options
 * @param {string} options.scriptText   洛雪源脚本原文（必填）
 * @param {string} options.id           包 id（必填或可由 name 推导；规则 ^[a-z0-9-]{2,32}$）
 * @param {string} [options.name]       显示名（缺省取脚本 @name 头）
 * @param {number} [options.versionCode=1] 单调递增整数版本
 * @param {string} [options.versionName]   人读版本串（缺省取脚本 @version 头或 "1.0"）
 * @param {string} [options.author]        作者（仅写进产物注释，不进包头）
 * @param {string} [options.lineName]      命中线路展示名（缺省 = 显示名）
 * @param {string} [options.outFileName]   建议文件名（缺省 `<id>.js`）
 * @param {boolean} [options.force=false]  预检命中时是否仍然产出
 * @param {boolean} [options.skipLint=false] 跳过预检（**不推荐**，仅调试用）
 * @returns {{ok: boolean, fileName: string, text: string, lint: object[], report: string, error?: string}}
 */
export function buildLxPlayPack(options) {
  const opts = options || {};
  const scriptText = String(opts.scriptText == null ? "" : opts.scriptText);
  if (!scriptText.trim()) {
    return { ok: false, fileName: "", text: "", lint: [], report: "", error: "scriptText 不能为空" };
  }

  const header = parseHeader(scriptText);
  const name = String(opts.name || header.name || "").trim();
  const rawId = String(opts.id || "").trim();
  const id = rawId || toPackId(name);

  if (!PACK_ID_RE.test(id)) {
    return {
      ok: false,
      fileName: "",
      text: "",
      lint: [],
      report: "",
      error:
        `包 id 不合法：${JSON.stringify(id || "")}。` +
        "规则是 ^[a-z0-9-]{2,32}$（小写字母/数字/连字符，2~32 位）。" +
        "可用 --id 指定，或让脚本 @name 头能推出合法 id。",
    };
  }
  if (RESERVED_PACK_IDS.indexOf(id) >= 0) {
    return {
      ok: false,
      fileName: "",
      text: "",
      lint: [],
      report: "",
      error: `包 id「${id}」是官方保留 id，需要发布方 ed25519 签名才能安装，第三方作者请换一个。`,
    };
  }

  const versionCode = Number(opts.versionCode);
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    return {
      ok: false,
      fileName: "",
      text: "",
      lint: [],
      report: "",
      error: "versionCode 必须是 ≥1 的整数（宿主用它判断升级）。",
    };
  }

  const versionName = String(opts.versionName || header.version || String(versionCode));
  const displayName = name || id;
  const lineName = String(opts.lineName || displayName);
  const author = String(opts.author || header.author || "");
  const fileName = String(opts.outFileName || id + ".js");

  const headerJson = escapeCommentDanger(
    JSON.stringify({
      kind: "play",
      id,
      name: displayName,
      versionCode,
      versionName,
    }),
  );

  const runtimeSource = createLxBridgeRuntime.toString();
  const scriptLiteral = jsStringLiteral(scriptText);

  // 所有见缝插针地进块注释的用户文本都必须过 escapeCommentDanger，
  // 否则 @name/@author/@version 行尾的 `*/` 会提前闭合：包头那行整段报废。
  const banner = [
    "/**",
    ` * ${escapeCommentDanger(displayName)} —— qt 播放音源包（洛雪音乐自定义源转制）`,
    " *",
    " * 由 qt-sources-sdk 的洛雪打包器生成，请勿手改：改源脚本后重新打包。",
    ` * 包 id：${id}　版本：${escapeCommentDanger(versionName)}（versionCode ${versionCode}）`,
    author ? ` * 源作者：${escapeCommentDanger(author)}` : " * 源作者：脚本未声明",
    header.description ? ` * 源描述：${escapeCommentDanger(header.description)}` : null,
    " *",
    " * 结构：包头 → 洛雪运行时（内嵌）→ 源脚本原文（内嵌）→ __qtPlayPackFactory",
    " * 取链走洛雪源的 musicUrl 动作；搜索/歌词/封面不在播放包职责内。",
    " */",
  ]
    .filter(Boolean)
    .join("\n");

  // 注意：运行时是 toString() 出来的源码文本，直接拼进来即可（它本身就是一个函数声明）。
  const body = `${PACK_HEADER_PREFIX}${headerJson}*/
${banner}
(function () {
  "use strict";

  // ───────────────────────── 洛雪运行时（由 qt-sources-sdk 内嵌，勿手改） ─────────────────────────
  var createLxBridgeRuntime = ${runtimeSource};

  // ───────────────────────── 洛雪源脚本原文（打包时内嵌） ─────────────────────────
  var LX_SCRIPT_TEXT = ${scriptLiteral};

  var PACK_ID = ${jsStringLiteral(id)};
  var PACK_NAME = ${jsStringLiteral(displayName)};
  var PACK_VERSION = ${jsStringLiteral(versionName)};
  var LINE_NAME = ${jsStringLiteral(lineName)};
  var SOURCE_NAME = ${jsStringLiteral(displayName)};

  globalThis.__qtPlayPackFactory = function (host) {
    function log(message) {
      if (host && typeof host.log === "function") {
        host.log("[" + PACK_ID + "] " + message);
      }
    }

    var bridge = createLxBridgeRuntime({
      host: host,
      scriptText: LX_SCRIPT_TEXT,
      scriptName: SOURCE_NAME,
    });

    log("装配完成：源 " + SOURCE_NAME + " · 脚本 md5 " + bridge.scriptMd5);

    return {
      name: PACK_NAME,
      version: PACK_VERSION,

      bundleInfo: function () {
        return JSON.stringify({
          id: PACK_ID,
          name: PACK_NAME,
          version: PACK_VERSION,
          kind: "play",
          upstream: "lx-music-source",
          scriptMd5: bridge.scriptMd5,
          scriptHeader: bridge.header,
          registeredSources: bridge.registeredSources(),
          note: "洛雪自定义源转制的播放包，仅承担取链（musicUrl）",
        });
      },

      // 洛雪源自带线路定义，不走宿主的 chain 配置；保持成功的最小实现。
      loadChain: function (chainJson) {
        log("loadChain 被调用（" + String(chainJson).length + " 字节，洛雪源忽略）");
        return JSON.stringify({ ok: true, lines: 1 });
      },

      getPlayUrl: function (args) {
        var source = String(args.platform);
        var quality = String(args.quality);
        var song = {
          id: String(args.id),
          name: String(args.name),
          singer: String(args.singer),
          album: String(args.album == null ? "" : args.album),
          picUrl: "",
          interval: Number(args.duration) || 0,
        };
        log("取链：" + source + " · " + song.name + " · " + quality);

        return bridge.getUrl(source, song, quality).then(
          function (url) {
            return JSON.stringify({
              url: url,
              source: source,
              quality: quality,
              line: { id: PACK_ID, name: LINE_NAME, kind: "lx" },
            });
          },
          function (err) {
            var detail = err && err.message ? err.message : String(err);
            throw new Error("洛雪源「" + SOURCE_NAME + "」取链失败（" + source + "/" + quality + "）：" + detail);
          },
        );
      },
    };
  };
})();
`;

  // 两份扫描：
  // - bodyHits：扫装配产物——宿主安装期扫的就是这份全文，裁决以此为准；
  // - srcHits：扫源脚本——报给作者看的行号是**他文件里的真实行号**。
  //   脚本是以 JSON 字符串常量原样内嵌的（命中字符不被转义），两者命中集
  //   内容一致；唯独脚手架若意外带上命中，只会出现在产物扫描里。
  const bodyHits = opts.skipLint ? [] : scanPackText(body);
  const srcHits = opts.skipLint ? [] : scanPackText(scriptText);
  const sameHitSet =
    bodyHits.length === srcHits.length &&
    bodyHits.every((h, i) => h.pattern === srcHits[i].pattern && h.kind === srcHits[i].kind);
  const lint = sameHitSet ? srcHits : bodyHits;
  const report = formatHits(lint);
  const blocked = bodyHits.length > 0 && !opts.force;

  if (blocked) {
    return {
      ok: false,
      fileName,
      text: body,
      lint,
      report,
      error:
        `内容安全预检命中 ${lint.length} 处，已阻止产出（宿主安装期会拒装）。` +
        "处理方式见下方报告；确认要拿到产物可加 --force（产物仍会被宿主拒绝安装）。",
    };
  }

  return { ok: true, fileName, text: body, lint, report };
}

export { PACK_HEADER_PREFIX, PACK_ID_RE, RESERVED_PACK_IDS };

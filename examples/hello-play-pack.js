/*__QT_PACK__{"kind":"play","id":"hello-play-pack","name":"Hello 播放包（作者模板）","versionCode":1,"versionName":"1.0"}*/
/**
 * hello-play-pack —— 播放音源包作者模板（手写、免构建、可直接安装）
 *
 * 用途：
 * 1. 验证「包头 → 工厂 → 装配 → 冒烟 → 生效」整条链路（装上后任何歌都返回
 *    同一段 CC0 演示音频——能听到恐龙叫 = 你的包装配成功）；
 * 2. 作为写真实播放包的骨架：把 getPlayUrl 的主体换成你的取链实现即可。
 *
 * 格式要点（详见 ../docs/PACK-AUTHORING.md）：
 * - 第 1 行必须是 __QT_PACK__ 自述头（一条首行块注释，内嵌 JSON，宿主不执行
 *   包体就能读出身份；照抄本文件第 1 行的格式改字段即可）；
 * - 整个文件是普通脚本（IIFE），顶层不能有 import/export；
 * - 求值后顶层副作用：把工厂挂到 globalThis.__qtPlayPackFactory；
 * - 宿主调用工厂得到本 API：{ name, version, getPlayUrl, loadChain, bundleInfo? }。
 * - 第三方包不需要签名；官方保留 id（play-official/meta-official）必须带
 *   发布方 ed25519 签名才能安装，第三方作者别用这两个 id（详见指南 §7）。
 * - 安装期有内容安全扫描（指南 §6 红线表）：代码里不能出现直连网络、宿主桥、
 *   后台执行体相关的 API 特征（调用形态与字符串字面量都算），命中直接拒装。
 *   本模板只用 host.request，天然合规——写真实包时也请保持这个习惯。
 */
(function () {
  "use strict";

  /** 演示音频：MDN 公开的 CC0 音频（T-Rex Roar）。仅用于验证链路，不可用于真实分发。 */
  var DEMO_AUDIO_URL =
    "https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3";

  /** 宿主支持的四个源 id（见 contract.ts 的 Source） */
  var KNOWN_PLATFORMS = ["wyy", "qq", "kw", "kg"];

  globalThis.__qtPlayPackFactory = function (host) {
    /** 宿主注入的日志通道（引擎侧 console；安卓不落盘，PC 可见） */
    function log(message) {
      if (typeof host.log === "function") {
        host.log("[hello-play-pack] " + message);
      }
    }

    log("工厂装配：platform=" + (host.platform || 1101));

    return {
      name: "hello-play-pack",
      version: "1.0",

      /** 播放包自述（诊断用；宿主不透传） */
      bundleInfo: function () {
        return JSON.stringify({
          name: "hello-play-pack",
          version: "1.0",
          demo: "对任何曲目返回同一段 CC0 演示音频，仅用于验证装配链路",
        });
      },

      /**
       * 装载链路配置（chain.json 文本）。本模板不使用链路配置，直接回 ok。
       * 真实包若不需要链路配置，保持这个最小实现即可；配置非法时应抛错。
       */
      loadChain: function (chainJson) {
        log("loadChain 被调用（" + String(chainJson).length + " 字节，模板忽略）");
        return JSON.stringify({ ok: true, lines: 0 });
      },

      /**
       * 取链：宿主播放器要地址时调用。
       * - 成功：resolve JSON 字符串 { url, source, quality, line }（line 可为 null）；
       * - 失败：throw Error（宿主会回退并提示，错误文本是用户能看到的唯一诊断信息，
       *   请写清楚死因，例如「kw 线路 A：签名超时」而不是笼统的「失败」）。
       *
       * 真实包的主体：用 host.request(url, options) 调你的接口——
       *   const res = await host.request("https://example.com/api", {
       *     method: "GET",                       // 或 "POST"
       *     headers: { Referer: "https://..." }, // 需要伪造头时传
       *     body: "a=1",                         // POST 体（字符串）
       *     timeoutMs: 15000,                    // 缺省 15s
       *   });
       *   // res = { statusCode, headers（名全小写）, body（已尝试按 JSON 解析，失败为原样字符串） }
       */
      getPlayUrl: function (args) {
        var platform = String(args.platform);
        var quality = String(args.quality);
        log("getPlayUrl：" + platform + " · " + args.name + " · 音质 " + quality);

        // 演示失败口径：不认识的源直接抛错（宿主会展示错误文本）
        if (KNOWN_PLATFORMS.indexOf(platform) < 0) {
          return Promise.reject(new Error("hello-play-pack：不支持的源 " + platform));
        }

        // 模板实现：不做真实取链，固定返回演示音频（能通过宿主的 Range 预检）
        return Promise.resolve(
          JSON.stringify({
            url: DEMO_AUDIO_URL,
            source: platform,
            quality: quality,
            line: null, // 真实包可回 {id, name, kind, targetSong}，宿主据此展示命中线路
          })
        );
      },
    };
  };
})();

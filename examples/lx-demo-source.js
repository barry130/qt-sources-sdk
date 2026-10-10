/*
 * @name 演示洛雪源
 * @version 1.0
 * @description qt-sources-sdk 附带的洛雪源示例：只做取链，适合用来跑通打包链路
 * @author canace
 */
lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    demo: { qualitys: ["128k", "320k"] },
  },
});

lx.on?.(lx.EVENT_NAMES.request, function (req) {
  if (req.action !== "musicUrl") {
    return Promise.reject(new Error("本演示源只支持取链：" + req.action));
  }
  const info = req.info.musicInfo;
  const type = req.info.type; // "128k" | "320k" | "flac" | "flac24bit"

  // 取链必须经 lx.request（它桥接到宿主 host.request），不要用全局 fetch。
  return new Promise(function (resolve, reject) {
    lx.request(
      "https://demo-backend.invalid/url?hash=" + encodeURIComponent(info.hash) + "&type=" + type,
      { method: "GET" },
      function (err, res) {
        if (err) return reject(err);
        // 演示用：正常源会解析 res.body（宿主先试 JSON 解析）
        resolve("https://audio.example.com/" + info.hash + "." + (type === "flac" ? "flac" : "mp3"));
      }
    );
  });
});
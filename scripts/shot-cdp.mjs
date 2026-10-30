// 临时脚本：用 CDP 按指定 CSS 视口精确截图模型菜单。
import WebSocket from "ws";
import { writeFileSync } from "fs";

const CDP = "http://127.0.0.1:9333";
const width = Number(process.argv[2] || 1200);
const height = Number(process.argv[3] || 900);

let list = await (await fetch(CDP + "/json/list")).json();
let page = list.find((t) => t.type === "page");
if (!page) page = await (await fetch(CDP + "/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await new Promise((r) => ws.on("open", r));

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:3000/?modelmenu=1" });
await new Promise((r) => setTimeout(r, 3000));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result && shot.result.data) {
  const out = `E:/WorkSpaces/Test09/MyClaude/shot-${width}.png`;
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log("saved", out, width, "x", height);
} else {
  console.error("shot failed", JSON.stringify(shot).slice(0, 300));
}
ws.close();
process.exit(0);

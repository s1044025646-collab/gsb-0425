// 端到端演示：启动服务，走一遍 API 流程。
const { Store } = require("../dist/store");
const { startServer } = require("../dist/server");
const path = require("node:path");

(async () => {
  const store = new Store(path.join(process.cwd(), "data", "e2e.db"));
  const { server, port } = await startServer(store);
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  console.log("端口:", port);
  const ctx = (await post("/contexts", { predictor: 0, index: 0 })).body;
  console.log("创建上下文:", ctx.id);
  const b1 = await post(`/contexts/${ctx.id}/blocks`, { data: "77", format: "hex", nibbleCount: 2, requestId: "e2e-1" });
  console.log("追加块样本:", b1.body.samples, "状态:", b1.body.context.predictor, b1.body.context.index);
  const replay = await post(`/contexts/${ctx.id}/blocks`, { data: "77", format: "hex", nibbleCount: 2, requestId: "e2e-1" });
  console.log("幂等重放:", replay.body.idempotentReplay);
  const bad = await post(`/contexts/${ctx.id}/blocks`, { data: "17", format: "hex", nibbleCount: 1 });
  console.log("坏块拒绝:", bad.status, bad.body.error.code);
  const exp = await post("/explain", { predictor: 0, index: 0, code: 15 });
  console.log("单码解释 code=15:", JSON.stringify(exp.body));
  const pcm = await fetch(`${base}/contexts/${ctx.id}/pcm`);
  const buf = Buffer.from(await pcm.arrayBuffer());
  console.log("PCM 字节:", [...buf], "样本数:", pcm.headers.get("x-sample-count"));
  const derived = (await post(`/contexts/${ctx.id}/derive`, {})).body;
  console.log("派生上下文初值:", derived.initialPredictor, derived.initialIndex);
  server.close();
  store.close();
})().catch((e) => { console.error(e); process.exit(1); });

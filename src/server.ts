import * as http from "node:http";
import { Store } from "./store.js";
import { ImaError, decodeNibble, parseHex, parseBase64, validatePredictor, validateIndex } from "./ima.js";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new ImaError("PAYLOAD_TOO_LARGE", "请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseBlockPayload(body: any): { data: Uint8Array; nibbleCount: number; blockId: string } {
  if (!body || typeof body !== "object") throw new ImaError("BAD_REQUEST", "请求体须为 JSON 对象");
  const { encoding, data, nibbleCount, blockId } = body;
  if (typeof data !== "string") throw new ImaError("BAD_REQUEST", "缺少 data 字符串字段");
  let bytes: Uint8Array;
  if (encoding === "hex") bytes = parseHex(data);
  else if (encoding === "base64") bytes = parseBase64(data);
  else throw new ImaError("BAD_ENCODING", "encoding 须为 hex 或 base64");
  if (!Number.isInteger(nibbleCount) || nibbleCount < 0) {
    throw new ImaError("INVALID_NIBBLE_COUNT", "nibbleCount 须为非负整数");
  }
  if (typeof blockId !== "string" || !blockId) throw new ImaError("INVALID_BLOCK_ID", "blockId 不能为空");
  return { data: bytes, nibbleCount, blockId };
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, obj: any, headers: Record<string, string> = {}) => {
      const buf = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj, null, 2));
      res.writeHead(status, {
        "Content-Type": Buffer.isBuffer(obj) ? "application/octet-stream" : "application/json; charset=utf-8",
        ...headers,
      });
      res.end(buf);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") return send(200, { ok: true });

      if (method === "POST" && url.pathname === "/contexts") {
        const body = JSON.parse(await readBody(req) || "{}");
        const info = store.createContext(validatePredictor(body.initialPredictor), validateIndex(body.initialIndex));
        return send(201, info);
      }
      if (method === "GET" && url.pathname === "/contexts") return send(200, store.listContexts());

      if (parts[0] === "contexts" && parts.length >= 2) {
        const id = parts[1];
        if (method === "GET" && parts.length === 2) return send(200, store.getContext(id));

        if (method === "POST" && parts[2] === "blocks" && parts.length === 3) {
          const body = JSON.parse(await readBody(req) || "{}");
          const { data, nibbleCount, blockId } = parseBlockPayload(body);
          const r = store.appendBlock(id, blockId, data, nibbleCount);
          return send(r.duplicated ? 200 : 201, { ...r.info, appended: r.sampleCount, duplicated: r.duplicated, seq: r.seq });
        }
        if (method === "GET" && parts[2] === "samples") {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 1000);
          return send(200, store.getSamples(id, offset, limit));
        }
        if (method === "GET" && parts[2] === "pcm") {
          const pcm = store.getPcm(id);
          return send(200, pcm, { "X-Sample-Count": String(pcm.length / 2) });
        }
        if (method === "GET" && parts[2] === "steps") {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 100);
          return send(200, store.getTraces(id, offset, limit));
        }
        if (method === "POST" && parts[2] === "derive") {
          const body = JSON.parse(await readBody(req) || "{}");
          const atSeq = body.atSeq === undefined ? undefined : Number(body.atSeq);
          return send(201, store.deriveContext(id, atSeq));
        }
      }

      if (method === "POST" && url.pathname === "/explain") {
        const body = JSON.parse(await readBody(req) || "{}");
        const predictor = validatePredictor(body.predictor);
        const index = validateIndex(body.index);
        const r = decodeNibble({ predictor, index }, body.nibble);
        return send(200, r.trace);
      }

      return send(404, { error: "NOT_FOUND", message: "未知路由" });
    } catch (e: any) {
      if (e instanceof ImaError) {
        const status = e.code === "CONTEXT_NOT_FOUND" || e.code === "BLOCK_NOT_FOUND" ? 404
          : e.code === "BLOCK_CONFLICT" ? 409 : 400;
        return send(status, { error: e.code, message: e.message });
      }
      if (e instanceof SyntaxError) return send(400, { error: "BAD_JSON", message: "JSON 解析失败" });
      return send(500, { error: "INTERNAL", message: String(e?.message ?? e) });
    }
  });
}

export function startServer(store: Store, port: number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(store);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

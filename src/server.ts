import * as http from "node:http";
import * as net from "node:net";
import { AdpcmError, decodeNibble, parsePayload, validateInitialState } from "./adpcm";
import { Store, MAX_SAMPLES_PER_CONTEXT, MAX_EXPLAIN_STEPS, MAX_BLOCK_BYTES } from "./store";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof AdpcmError) {
    sendJson(res, 400, { error: { code: err.code, message: err.message } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BLOCK_BYTES + 1024 * 1024) {
        reject(new AdpcmError("LIMIT_EXCEEDED", "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const buf = await readBody(req);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new AdpcmError("INVALID_PAYLOAD", "请求体不是合法 JSON");
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/limits") {
        return sendJson(res, 200, {
          maxSamplesPerContext: MAX_SAMPLES_PER_CONTEXT,
          maxBlockBytes: MAX_BLOCK_BYTES,
          maxExplainSteps: MAX_EXPLAIN_STEPS,
        });
      }
      if (req.method === "POST" && url.pathname === "/explain") {
        const body = await readJson(req);
        const state = { predictor: body?.predictor, index: body?.index };
        validateInitialState(state);
        return sendJson(res, 200, decodeNibble(body?.code, state));
      }
      if (req.method === "POST" && url.pathname === "/contexts") {
        const body = await readJson(req);
        return sendJson(res, 201, store.createContext(body?.predictor, body?.index, body?.id));
      }
      if (parts[0] === "contexts" && parts.length >= 2) {
        const id = decodeURIComponent(parts[1]);
        if (req.method === "GET" && parts.length === 2) {
          return sendJson(res, 200, store.getContext(id));
        }
        if (req.method === "POST" && parts[2] === "blocks" && parts.length === 3) {
          const body = await readJson(req);
          const data = parsePayload(body?.data, body?.format);
          const result = store.appendBlock(id, data, body?.nibbleCount, body?.requestId);
          return sendJson(res, result.idempotentReplay ? 200 : 201, result);
        }
        if (req.method === "GET" && parts[2] === "samples" && parts.length === 3) {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 10000);
          return sendJson(res, 200, store.getSamples(id, offset, limit));
        }
        if (req.method === "GET" && parts[2] === "pcm" && parts.length === 3) {
          const pcm = store.getPcm(id);
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "X-Sample-Count": String(pcm.length / 2),
          });
          return res.end(pcm);
        }
        if (req.method === "POST" && parts[2] === "derive" && parts.length === 3) {
          const raw = await readBody(req);
          const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
          return sendJson(res, 201, store.deriveContext(id, body?.id));
        }
      }
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

export async function startServer(
  store: Store,
  port?: number
): Promise<{ server: http.Server; port: number }> {
  const p = port ?? (await findFreePort());
  const server = createServer(store);
  await new Promise<void>((resolve) => server.listen(p, "127.0.0.1", resolve));
  return { server, port: p };
}

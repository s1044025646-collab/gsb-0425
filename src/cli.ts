import * as path from "node:path";
import * as fs from "node:fs";
import { Store } from "./store.js";
import { startServer } from "./server.js";
import { decodeNibble, parseHex, parseBase64 } from "./ima.js";

const DATA_DIR = process.env.IMA_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.IMA_DB_PATH ?? path.join(DATA_DIR, "ima.db");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function num(flag: string): number | undefined {
  const v = arg(flag);
  return v === undefined ? undefined : Number(v);
}

function print(obj: any): void { console.log(JSON.stringify(obj, null, 2)); }

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "create": {
        const p = num("--predictor") ?? 0;
        const i = num("--index") ?? 0;
        print(store.createContext(p, i));
        break;
      }
      case "list": print(store.listContexts()); break;
      case "state": print(store.getContext(rest[0] ?? "")); break;
      case "append": {
        const id = rest[0];
        const enc = arg("--encoding") ?? "hex";
        const dataStr = arg("--data") ?? "";
        const nibbleCount = num("--nibbles");
        const blockId = arg("--block") ?? `block-${Date.now()}`;
        if (nibbleCount === undefined) throw new Error("缺少 --nibbles");
        const bytes = enc === "hex" ? parseHex(dataStr) : parseBase64(dataStr);
        print(store.appendBlock(id, blockId, bytes, nibbleCount));
        break;
      }
      case "samples": {
        const id = rest[0];
        print(store.getSamples(id, num("--offset") ?? 0, num("--limit") ?? 1000));
        break;
      }
      case "steps": {
        const id = rest[0];
        print(store.getTraces(id, num("--offset") ?? 0, num("--limit") ?? 100));
        break;
      }
      case "export-pcm": {
        const id = rest[0];
        const out = arg("--out") ?? `${id}.pcm`;
        const pcm = store.getPcm(id);
        fs.writeFileSync(out, pcm);
        console.log(`已写出 ${out}：${pcm.length} 字节 = ${pcm.length / 2} 个 PCM16 样本（小端）`);
        break;
      }
      case "derive": {
        const id = rest[0];
        print(store.deriveContext(id, num("--at-seq")));
        break;
      }
      case "explain": {
        const p = num("--predictor") ?? 0;
        const i = num("--index") ?? 0;
        const n = num("--nibble");
        if (n === undefined) throw new Error("缺少 --nibble");
        print(decodeNibble({ predictor: p, index: i }, n).trace);
        break;
      }
      case "serve": {
        const port = num("--port") ?? Number(process.env.PORT ?? 0); // 默认 0 = 空闲端口
        const { port: actual } = await startServer(store, port);
        console.log(`IMA ADPCM 解码服务已启动: http://127.0.0.1:${actual}  (数据库: ${DB_PATH})`);
        return; // 保持进程
      }
      case "demo": {
        const ctx = store.createContext(0, 0);
        // 两个码 7：字节 0x77，nibbleCount=2
        const r1 = store.appendBlock(ctx.id, "demo-1", parseHex("77"), 2);
        console.log("初始 (0,0)，连续两个码 7 ->", store.getSamples(ctx.id).samples, "(期望 [11, 41])");
        const ctx2 = store.createContext(0, 0);
        store.appendBlock(ctx2.id, "demo-2", parseHex("0f"), 1);
        console.log("初始 (0,0)，码 15 ->", store.getSamples(ctx2.id).samples, "(期望 [-11])");
        console.log("上下文 1 状态:", store.getContext(ctx.id));
        void r1;
        break;
      }
      default:
        console.log(`用法: node dist/src/cli.js <命令>
  create --predictor N --index N        创建解码上下文
  list                                 列出上下文
  state <id>                           查看状态与摘要
  append <id> --block B --nibbles N --encoding hex|base64 --data STR
  samples <id> [--offset N] [--limit N]
  steps <id> [--offset N] [--limit N]  查看每步状态变化
  export-pcm <id> --out FILE           导出 PCM16 小端
  derive <id> [--at-seq N]             派生新上下文
  explain --predictor N --index N --nibble N   单码解释
  serve [--port N]                     启动 HTTP 服务（默认空闲端口）
  demo                                 运行演示`);
    }
  } finally {
    if (process.argv[2] !== "serve") store.close();
  }
}

main().catch((e) => {
  console.error(e.code ? `[${e.code}] ${e.message}` : e.message);
  process.exit(1);
});

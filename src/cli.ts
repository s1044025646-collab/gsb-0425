/**
 * 命令行入口。
 *   node dist/cli.js serve [--port N] [--db PATH]
 *   node dist/cli.js decode --predictor 0 --index 0 --data 77 --format hex --nibbles 2
 *   node dist/cli.js explain --predictor 0 --index 0 --code 7
 *   node dist/cli.js demo
 */
import * as fs from "node:fs";
import { decodeBlock, decodeNibble, parsePayload, samplesToPcm16LE } from "./adpcm";
import { Store, defaultDbPath } from "./store";
import { startServer } from "./server";

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function requireInt(args: string[], name: string): number {
  const v = argValue(args, name);
  if (v === undefined) throw new Error(`缺少参数 --${name}`);
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`参数 --${name} 必须是整数`);
  return n;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "serve": {
      const portArg = argValue(args, "port");
      const dbPath = argValue(args, "db") ?? defaultDbPath();
      const store = new Store(dbPath);
      const { port } = await startServer(store, portArg ? Number(portArg) : undefined);
      console.log(`IMA ADPCM 解码服务已启动: http://127.0.0.1:${port}  (数据库: ${dbPath})`);
      break;
    }
    case "decode": {
      const predictor = requireInt(args, "predictor");
      const index = requireInt(args, "index");
      const format = (argValue(args, "format") ?? "hex") as "hex" | "base64";
      const dataStr = argValue(args, "data");
      if (!dataStr) throw new Error("缺少参数 --data");
      const nibbles = requireInt(args, "nibbles");
      const data = parsePayload(dataStr, format);
      const result = decodeBlock(data, nibbles, { predictor, index });
      const out = argValue(args, "out");
      if (out) {
        fs.writeFileSync(out, samplesToPcm16LE(result.samples));
        console.log(`已写出 PCM16 小端: ${out} (${result.samples.length} 样本, ${result.samples.length * 2} 字节)`);
      }
      console.log(JSON.stringify({ samples: result.samples, steps: result.steps, state: result.state }, null, 2));
      break;
    }
    case "explain": {
      const predictor = requireInt(args, "predictor");
      const index = requireInt(args, "index");
      const code = requireInt(args, "code");
      console.log(JSON.stringify(decodeNibble(code, { predictor, index }), null, 2));
      break;
    }
    case "demo": {
      const r1 = decodeBlock(Buffer.from([0x77]), 2, { predictor: 0, index: 0 });
      console.log("演示 1: 初始 predictor=0 index=0, 码 [7,7]");
      console.log("  样本:", r1.samples, "(期望 [11, 41])");
      const r2 = decodeBlock(Buffer.from([0x0f]), 1, { predictor: 0, index: 0 });
      console.log("演示 2: 同一初值, 码 [15]");
      console.log("  样本:", r2.samples, "(期望 [-11])");
      break;
    }
    default:
      console.log(`用法:
  node dist/cli.js serve [--port N] [--db PATH]     启动 HTTP 服务（默认自动选空闲端口）
  node dist/cli.js decode --predictor P --index I --data DATA --format hex|base64 --nibbles N [--out FILE]
  node dist/cli.js explain --predictor P --index I --code C
  node dist/cli.js demo`);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});

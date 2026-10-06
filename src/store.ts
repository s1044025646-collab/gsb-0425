/**
 * SQLite 持久化：原子保存初始状态、块顺序、当前预测值与索引、输出摘要。
 * 使用 Node 内置 node:sqlite，无需外部服务。
 */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  AdpcmError,
  PredictorState,
  StepRecord,
  decodeBlock,
  samplesToPcm16LE,
  validateInitialState,
} from "./adpcm";

export const MAX_SAMPLES_PER_CONTEXT = 10_000_000;
export const MAX_BLOCK_BYTES = 4 * 1024 * 1024;
export const MAX_EXPLAIN_STEPS = 1000;

export interface ContextRow {
  id: string;
  initialPredictor: number;
  initialIndex: number;
  predictor: number;
  index: number;
  sampleCount: number;
  blockCount: number;
  digest: string;
}

export interface AppendResult {
  context: ContextRow;
  seq: number;
  sampleCount: number;
  samples: number[];
  steps: StepRecord[];
  stepsTruncated: boolean;
  idempotentReplay: boolean;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY,
        initial_predictor INTEGER NOT NULL,
        initial_index INTEGER NOT NULL,
        predictor INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        sample_count INTEGER NOT NULL,
        block_count INTEGER NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL REFERENCES contexts(id),
        seq INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        nibble_count INTEGER NOT NULL,
        data BLOB NOT NULL,
        pcm BLOB NOT NULL,
        sample_count INTEGER NOT NULL,
        digest TEXT NOT NULL,
        UNIQUE (context_id, seq),
        UNIQUE (context_id, request_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private rowToContext(row: any): ContextRow {
    return {
      id: row.id,
      initialPredictor: row.initial_predictor,
      initialIndex: row.initial_index,
      predictor: row.predictor,
      index: row.idx,
      sampleCount: row.sample_count,
      blockCount: row.block_count,
      digest: row.digest,
    };
  }

  getContext(id: string): ContextRow {
    const row = this.db.prepare("SELECT * FROM contexts WHERE id = ?").get(id);
    if (!row) throw new AdpcmError("NOT_FOUND", `上下文 ${id} 不存在`);
    return this.rowToContext(row);
  }

  createContext(predictor: number, index: number, id?: string): ContextRow {
    validateInitialState({ predictor, index });
    const ctxId = id ?? randomUUID();
    const emptyDigest = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    try {
      this.db
        .prepare(
          `INSERT INTO contexts
             (id, initial_predictor, initial_index, predictor, idx, sample_count, block_count, digest, created_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`
        )
        .run(ctxId, predictor, index, predictor, index, emptyDigest, new Date().toISOString());
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) {
        throw new AdpcmError("CONFLICT", `上下文 ${ctxId} 已存在`);
      }
      throw e;
    }
    return this.getContext(ctxId);
  }

  /** 从当前状态派生新上下文（以当前预测值/索引作为新上下文的初始状态）。 */
  deriveContext(sourceId: string, newId?: string): ContextRow {
    const src = this.getContext(sourceId);
    return this.createContext(src.predictor, src.index, newId);
  }

  /**
   * 追加码块。先在内存完整解码并校验，再在单事务中落库：
   * 坏块不会消耗部分码，也不会改变预测器。
   * requestId 相同的重复请求幂等返回首次结果。
   */
  appendBlock(
    contextId: string,
    data: Buffer,
    nibbleCount: number,
    requestId?: string
  ): AppendResult {
    if (data.length > MAX_BLOCK_BYTES) {
      throw new AdpcmError("LIMIT_EXCEEDED", `块字节数 ${data.length} 超过上限 ${MAX_BLOCK_BYTES}`);
    }
    const reqId = requestId ?? randomUUID();

    const existing = this.db
      .prepare("SELECT * FROM blocks WHERE context_id = ? AND request_id = ?")
      .get(contextId, reqId) as any;
    if (existing) {
      const pcm = Buffer.from(existing.pcm);
      const samples: number[] = [];
      for (let i = 0; i < pcm.length; i += 2) samples.push(pcm.readInt16LE(i));
      return {
        context: this.getContext(contextId),
        seq: existing.seq,
        sampleCount: existing.sample_count,
        samples,
        steps: [],
        stepsTruncated: true,
        idempotentReplay: true,
      };
    }

    const ctx = this.getContext(contextId);
    if (ctx.sampleCount + nibbleCount > MAX_SAMPLES_PER_CONTEXT) {
      throw new AdpcmError(
        "LIMIT_EXCEEDED",
        `样本总量将超过上限 ${MAX_SAMPLES_PER_CONTEXT}`
      );
    }

    // 先在内存中完整解码；任何错误在此抛出，数据库不受影响。
    const result = decodeBlock(data, nibbleCount, {
      predictor: ctx.predictor,
      index: ctx.index,
    });
    const pcm = samplesToPcm16LE(result.samples);
    const blockDigest = createHash("sha256").update(pcm).digest("hex");
    const digest = createHash("sha256")
      .update(Buffer.from(ctx.digest, "hex"))
      .update(pcm)
      .digest("hex");
    const seq = ctx.blockCount + 1;

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO blocks (context_id, seq, request_id, nibble_count, data, pcm, sample_count, digest)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(contextId, seq, reqId, nibbleCount, data, pcm, result.samples.length, blockDigest);
      this.db
        .prepare(
          `UPDATE contexts
             SET predictor = ?, idx = ?, sample_count = sample_count + ?,
                 block_count = block_count + 1, digest = ?
           WHERE id = ?`
        )
        .run(result.state.predictor, result.state.index, result.samples.length, digest, contextId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    const stepsTruncated = result.steps.length > MAX_EXPLAIN_STEPS;
    return {
      context: this.getContext(contextId),
      seq,
      sampleCount: result.samples.length,
      samples: result.samples,
      steps: stepsTruncated ? result.steps.slice(0, MAX_EXPLAIN_STEPS) : result.steps,
      stepsTruncated,
      idempotentReplay: false,
    };
  }

  /** 查询样本（整数数组）。 */
  getSamples(contextId: string, offset = 0, limit = 10000): { samples: number[]; total: number } {
    const ctx = this.getContext(contextId);
    const rows = this.db
      .prepare("SELECT pcm FROM blocks WHERE context_id = ? ORDER BY seq")
      .all(contextId) as any[];
    const all = Buffer.concat(rows.map((r) => Buffer.from(r.pcm)));
    const totalSamples = all.length / 2;
    const start = Math.max(0, Math.min(offset, totalSamples));
    const end = Math.min(start + Math.max(0, limit), totalSamples);
    const samples: number[] = [];
    for (let i = start; i < end; i++) samples.push(all.readInt16LE(i * 2));
    return { samples, total: ctx.sampleCount };
  }

  /** 导出 PCM16 小端二进制。 */
  getPcm(contextId: string): Buffer {
    this.getContext(contextId);
    const rows = this.db
      .prepare("SELECT pcm FROM blocks WHERE context_id = ? ORDER BY seq")
      .all(contextId) as any[];
    return Buffer.concat(rows.map((r) => Buffer.from(r.pcm)));
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "adpcm.db");
}

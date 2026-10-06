import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  decodeBlock, validatePredictor, validateIndex,
  ImaError, StepTrace,
} from "./ima.js";

export const MAX_SAMPLES_PER_CONTEXT = 1_000_000;
export const MAX_TRACES_RETURNED = 10_000;

export interface ContextInfo {
  id: string;
  initialPredictor: number;
  initialIndex: number;
  predictor: number;
  index: number;
  blockCount: number;
  sampleCount: number;
  digest: string;
  createdAt: string;
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
        block_count INTEGER NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocks (
        context_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        block_id TEXT NOT NULL,
        data BLOB NOT NULL,
        pcm BLOB NOT NULL,
        nibble_count INTEGER NOT NULL,
        predictor_after INTEGER NOT NULL,
        idx_after INTEGER NOT NULL,
        digest_after TEXT NOT NULL,
        traces TEXT NOT NULL,
        PRIMARY KEY (context_id, seq),
        UNIQUE (context_id, block_id)
      );
    `);
  }

  close(): void { this.db.close(); }

  private newId(): string {
    return createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
  }

  createContext(initialPredictor: number, initialIndex: number, id?: string): ContextInfo {
    validatePredictor(initialPredictor);
    validateIndex(initialIndex);
    const cid = id ?? this.newId();
    const emptyDigest = createHash("sha256").digest("hex");
    this.db.prepare(
      `INSERT INTO contexts (id, initial_predictor, initial_index, predictor, idx, digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(cid, initialPredictor, initialIndex, initialPredictor, initialIndex, emptyDigest, new Date().toISOString());
    return this.getContext(cid);
  }

  getContext(id: string): ContextInfo {
    const row = this.db.prepare(`SELECT * FROM contexts WHERE id = ?`).get(id) as any;
    if (!row) throw new ImaError("CONTEXT_NOT_FOUND", `上下文 ${id} 不存在`);
    return {
      id: row.id,
      initialPredictor: row.initial_predictor,
      initialIndex: row.initial_index,
      predictor: row.predictor,
      index: row.idx,
      blockCount: row.block_count,
      sampleCount: row.sample_count,
      digest: row.digest,
      createdAt: row.created_at,
    };
  }

  listContexts(): ContextInfo[] {
    const rows = this.db.prepare(`SELECT id FROM contexts ORDER BY created_at`).all() as any[];
    return rows.map((r) => this.getContext(r.id));
  }

  // 追加码块。blockId 幂等：同 blockId 同参数返回已有结果；同 blockId 不同参数报冲突。
  // 先完整解码再开事务落库：坏块不消耗任何码、不改变预测器。
  appendBlock(contextId: string, blockId: string, data: Uint8Array, nibbleCount: number): {
    info: ContextInfo; sampleCount: number; duplicated: boolean; seq: number;
  } {
    if (!blockId || typeof blockId !== "string") throw new ImaError("INVALID_BLOCK_ID", "blockId 不能为空");
    const ctx = this.getContext(contextId);
    const existing = this.db.prepare(
      `SELECT * FROM blocks WHERE context_id = ? AND block_id = ?`
    ).get(contextId, blockId) as any;
    if (existing) {
      const sameData = Buffer.from(existing.data as Uint8Array).equals(Buffer.from(data));
      if (!sameData || existing.nibble_count !== nibbleCount) {
        throw new ImaError("BLOCK_CONFLICT", `blockId "${blockId}" 已存在且内容不同`);
      }
      return { info: this.getContext(contextId), sampleCount: nibbleCount, duplicated: true, seq: existing.seq };
    }
    if (ctx.sampleCount + nibbleCount > MAX_SAMPLES_PER_CONTEXT) {
      throw new ImaError("SAMPLE_LIMIT", `样本总量超过上限 ${MAX_SAMPLES_PER_CONTEXT}`);
    }
    const decoded = decodeBlock({ predictor: ctx.predictor, index: ctx.index }, data, nibbleCount);
    const pcm = Buffer.from(decoded.samples.buffer, decoded.samples.byteOffset, decoded.samples.byteLength);
    // 增量摘要：digest = sha256(hexToBytes(prevDigest) || pcm)，可重启续算、可验证。
    const running = createHash("sha256");
    running.update(Buffer.from(ctx.digest, "hex"));
    running.update(pcm);
    const digestAfter = running.digest("hex");
    const tracesJson = JSON.stringify(decoded.traces);

    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        `INSERT INTO blocks (context_id, seq, block_id, data, pcm, nibble_count, predictor_after, idx_after, digest_after, traces)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(contextId, ctx.blockCount, blockId, data, pcm, nibbleCount,
        decoded.state.predictor, decoded.state.index, digestAfter, tracesJson);
      this.db.prepare(
        `UPDATE contexts SET predictor = ?, idx = ?, block_count = ?, sample_count = ?, digest = ? WHERE id = ?`
      ).run(decoded.state.predictor, decoded.state.index, ctx.blockCount + 1,
        ctx.sampleCount + nibbleCount, digestAfter, contextId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { info: this.getContext(contextId), sampleCount: nibbleCount, duplicated: false, seq: ctx.blockCount };
  }

  // 全部样本的 PCM16 小端字节流（字节数 = 样本数 * 2）。
  getPcm(contextId: string): Buffer {
    this.getContext(contextId);
    const rows = this.db.prepare(
      `SELECT pcm FROM blocks WHERE context_id = ? ORDER BY seq`
    ).all(contextId) as any[];
    return Buffer.concat(rows.map((r) => Buffer.from(r.pcm as Uint8Array)));
  }

  getSamples(contextId: string, offset = 0, limit = 1000): { samples: number[]; total: number } {
    const ctx = this.getContext(contextId);
    const pcm = this.getPcm(contextId);
    const total = pcm.length / 2;
    const out: number[] = [];
    const capped = Math.min(limit, MAX_TRACES_RETURNED);
    for (let i = offset; i < Math.min(total, offset + capped); i++) {
      out.push(pcm.readInt16LE(i * 2));
    }
    return { samples: out, total: ctx.sampleCount };
  }

  getTraces(contextId: string, offset = 0, limit = 100): { traces: StepTrace[]; total: number } {
    const ctx = this.getContext(contextId);
    const capped = Math.min(limit, MAX_TRACES_RETURNED);
    const rows = this.db.prepare(
      `SELECT traces FROM blocks WHERE context_id = ? ORDER BY seq`
    ).all(contextId) as any[];
    const out: StepTrace[] = [];
    let skipped = 0;
    for (const row of rows) {
      const traces = JSON.parse(row.traces as string) as StepTrace[];
      for (const t of traces) {
        if (skipped < offset) { skipped++; continue; }
        if (out.length < capped) out.push(t);
      }
    }
    return { traces: out, total: ctx.sampleCount };
  }

  // 派生新上下文：以某一块之后的状态（默认当前状态）作为新上下文的初始状态。
  deriveContext(contextId: string, atSeq?: number): ContextInfo {
    const ctx = this.getContext(contextId);
    let predictor = ctx.predictor, index = ctx.index;
    if (atSeq !== undefined) {
      const row = this.db.prepare(
        `SELECT predictor_after, idx_after FROM blocks WHERE context_id = ? AND seq = ?`
      ).get(contextId, atSeq) as any;
      if (!row) throw new ImaError("BLOCK_NOT_FOUND", `块序号 ${atSeq} 不存在`);
      predictor = row.predictor_after;
      index = row.idx_after;
    }
    return this.createContext(predictor, index);
  }
}

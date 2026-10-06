import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeNibble, decodeBlock, parseHex, parseBase64, STEP_TABLE, ImaError } from "../src/ima.js";
import { Store } from "../src/store.js";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ima-")), "test.db");
}

test("步长表为 89 项且单调不减、末项 32767", () => {
  assert.equal(STEP_TABLE.length, 89);
  assert.equal(STEP_TABLE[0], 7);
  assert.equal(STEP_TABLE[88], 32767);
  for (let i = 1; i < 89; i++) assert.ok(STEP_TABLE[i] >= STEP_TABLE[i - 1]);
});

test("演示：初值 (0,0) 连续两个码 7 得 11、41", () => {
  const r = decodeBlock({ predictor: 0, index: 0 }, parseHex("77"), 2);
  assert.deepEqual([...r.samples], [11, 41]);
  // 手算第一步：step=7, base=0, bit0=1, bit1=3, bit2=7 -> 11
  const t0 = r.traces[0];
  assert.equal(t0.step, 7);
  assert.deepEqual([t0.diffBase, t0.diffBit0, t0.diffBit1, t0.diffBit2], [0, 1, 3, 7]);
  assert.equal(t0.diff, 11);
  assert.equal(t0.newIndex, 8);
  // 手算第二步：index=8, step=16, base=2, bit0=4, bit1=8, bit2=16 -> 30 -> 41
  const t1 = r.traces[1];
  assert.equal(t1.step, 16);
  assert.equal(t1.diff, 30);
  assert.equal(t1.newPredictor, 41);
  assert.equal(t1.newIndex, 16);
});

test("演示：初值 (0,0) 码 15 得 -11", () => {
  const r = decodeNibble({ predictor: 0, index: 0 }, 15);
  assert.equal(r.state.predictor, -11);
  assert.equal(r.trace.sign, -1);
  assert.equal(r.trace.diff, -11);
});

test("零差值：码 0 在步长 7 时不改变预测值", () => {
  const r = decodeNibble({ predictor: 1234, index: 0 }, 0);
  assert.equal(r.trace.diff, 0);
  assert.equal(r.state.predictor, 1234);
  assert.equal(r.state.index, 0); // 调整 -1 后夹到下限 0
});

test("索引边界：下限 0 与上限 88 均夹住", () => {
  assert.equal(decodeNibble({ predictor: 0, index: 0 }, 0).state.index, 0);
  assert.equal(decodeNibble({ predictor: 0, index: 88 }, 7).state.index, 88);
  assert.equal(decodeNibble({ predictor: 0, index: 88 }, 4).state.index, 88);
});

test("正向饱和并标记", () => {
  const r = decodeNibble({ predictor: 32760, index: 88 }, 7);
  assert.equal(r.state.predictor, 32767);
  assert.equal(r.trace.saturated, true);
  assert.equal(r.trace.preClamp, 32760 + (4095 + 8191 + 16383 + 32767));
});

test("负向饱和并标记", () => {
  const r = decodeNibble({ predictor: -32760, index: 88 }, 15);
  assert.equal(r.state.predictor, -32768);
  assert.equal(r.trace.saturated, true);
});

test("手算核对：index=4 (step=11)，码 3，预测值 100 -> 108", () => {
  const r = decodeNibble({ predictor: 100, index: 4 }, 3);
  // base=11>>3=1, bit0=11>>2=2, bit1=11>>1=5 -> 8
  assert.deepEqual([r.trace.diffBase, r.trace.diffBit0, r.trace.diffBit1, r.trace.diffBit2], [1, 2, 5, 0]);
  assert.equal(r.trace.diff, 8);
  assert.equal(r.state.predictor, 108);
  assert.equal(r.state.index, 3);
});

test("奇数有效码：最后高四位零填充可接受，非零拒绝", () => {
  const ok = decodeBlock({ predictor: 0, index: 0 }, parseHex("0f"), 1);
  assert.deepEqual([...ok.samples], [-11]);
  assert.throws(() => decodeBlock({ predictor: 0, index: 0 }, parseHex("1f"), 1),
    (e: any) => e instanceof ImaError && e.code === "NONZERO_PADDING");
});

test("字节数与有效码数不符则拒绝", () => {
  assert.throws(() => decodeBlock({ predictor: 0, index: 0 }, parseHex("0000"), 5),
    (e: any) => e.code === "LENGTH_MISMATCH");
  assert.throws(() => decodeBlock({ predictor: 0, index: 0 }, parseHex("00"), 3),
    (e: any) => e.code === "LENGTH_MISMATCH");
});

test("十六进制与 Base64 严格校验", () => {
  assert.throws(() => parseHex("0"), (e: any) => e.code === "INVALID_HEX");
  assert.throws(() => parseHex("0g"), (e: any) => e.code === "INVALID_HEX");
  assert.throws(() => parseHex("77 "), (e: any) => e.code === "INVALID_HEX");
  assert.throws(() => parseBase64("dw="), (e: any) => e.code === "INVALID_BASE64");
  assert.throws(() => parseBase64("dw==extra"), (e: any) => e.code === "INVALID_BASE64");
  assert.deepEqual([...parseBase64("dw==")], [0x77]);
});

test("PCM 小端导出：字节数 = 样本数 * 2", () => {
  const store = new Store(tmpDb());
  const ctx = store.createContext(0, 0);
  store.appendBlock(ctx.id, "b1", parseHex("77"), 2);
  store.appendBlock(ctx.id, "b2", parseHex("0f"), 1);
  const pcm = store.getPcm(ctx.id);
  assert.equal(pcm.length, 3 * 2);
  assert.equal(pcm.readInt16LE(0), 11);
  assert.equal(pcm.readInt16LE(2), 41);
  // 第三码 15 在状态 (41,16) 上解码：step=34, base=4, bit0=8, bit1=17, bit2=34 -> -63 -> -22
  assert.equal(pcm.readInt16LE(4), -22);
  assert.equal(pcm[0], 0x0b); assert.equal(pcm[1], 0x00); // 小端
  assert.equal(pcm[4], 0xea); assert.equal(pcm[5], 0xff); // -22 小端
  store.close();
});

test("分块解码与拼接一次解码一致", () => {
  const nibbles = [7, 7, 15, 0, 1, 9, 3, 12, 5, 10];
  const bytes = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < nibbles.length; i++) {
    if (i % 2 === 0) bytes[i >> 1] |= nibbles[i];
    else bytes[i >> 1] |= nibbles[i] << 4;
  }
  const whole = decodeBlock({ predictor: 100, index: 20 }, bytes, nibbles.length);

  const store = new Store(tmpDb());
  const ctx = store.createContext(100, 20);
  // 分三块：4 码、4 码、2 码
  store.appendBlock(ctx.id, "c1", bytes.slice(0, 2), 4);
  store.appendBlock(ctx.id, "c2", bytes.slice(2, 4), 4);
  store.appendBlock(ctx.id, "c3", bytes.slice(4, 5), 2);
  const pcm = store.getPcm(ctx.id);
  const chunked: number[] = [];
  for (let i = 0; i < pcm.length / 2; i++) chunked.push(pcm.readInt16LE(i * 2));
  assert.deepEqual(chunked, [...whole.samples]);
  const info = store.getContext(ctx.id);
  assert.equal(info.predictor, whole.state.predictor);
  assert.equal(info.index, whole.state.index);
  store.close();
});

test("重启后状态保留并可继续下一块", () => {
  const db = tmpDb();
  let store = new Store(db);
  const ctx = store.createContext(0, 0);
  store.appendBlock(ctx.id, "b1", parseHex("77"), 2);
  store.close();

  store = new Store(db);
  const info = store.getContext(ctx.id);
  assert.equal(info.predictor, 41);
  assert.equal(info.index, 16);
  assert.equal(info.sampleCount, 2);
  store.appendBlock(ctx.id, "b2", parseHex("0f"), 1);
  const samples = store.getSamples(ctx.id).samples;
  // 连续等价：从 (0,0) 解 7,7,15
  const whole = decodeBlock({ predictor: 0, index: 0 }, parseHex("770f"), 3);
  assert.deepEqual(samples, [...whole.samples]);
  store.close();
});

test("坏块回滚：不改变预测器与样本数", () => {
  const store = new Store(tmpDb());
  const ctx = store.createContext(0, 0);
  store.appendBlock(ctx.id, "ok", parseHex("77"), 2);
  assert.throws(() => store.appendBlock(ctx.id, "bad", parseHex("1f"), 1), /零填充/);
  const info = store.getContext(ctx.id);
  assert.equal(info.predictor, 41);
  assert.equal(info.index, 16);
  assert.equal(info.sampleCount, 2);
  assert.equal(info.blockCount, 1);
  store.close();
});

test("重复块幂等：同 blockId 同内容不重复追加，不同内容冲突", () => {
  const store = new Store(tmpDb());
  const ctx = store.createContext(0, 0);
  store.appendBlock(ctx.id, "b1", parseHex("77"), 2);
  const dup = store.appendBlock(ctx.id, "b1", parseHex("77"), 2);
  assert.equal(dup.duplicated, true);
  assert.equal(store.getContext(ctx.id).sampleCount, 2);
  assert.throws(() => store.appendBlock(ctx.id, "b1", parseHex("00"), 2),
    (e: any) => e.code === "BLOCK_CONFLICT");
  store.close();
});

test("初始值越界拒绝而非静默夹限", () => {
  const store = new Store(tmpDb());
  assert.throws(() => store.createContext(40000, 0), (e: any) => e.code === "INVALID_PREDICTOR");
  assert.throws(() => store.createContext(0, 89), (e: any) => e.code === "INVALID_INDEX");
  assert.throws(() => store.createContext(0, -1), (e: any) => e.code === "INVALID_INDEX");
  store.close();
});

test("派生上下文：以当前状态为新初值", () => {
  const store = new Store(tmpDb());
  const ctx = store.createContext(0, 0);
  store.appendBlock(ctx.id, "b1", parseHex("77"), 2);
  const derived = store.deriveContext(ctx.id);
  assert.equal(derived.initialPredictor, 41);
  assert.equal(derived.initialIndex, 16);
  store.appendBlock(derived.id, "d1", parseHex("0f"), 1);
  const whole = decodeBlock({ predictor: 0, index: 0 }, parseHex("770f"), 3);
  assert.equal(store.getSamples(derived.id).samples[0], [...whole.samples][2]);
  store.close();
});

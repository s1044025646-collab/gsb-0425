const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  STEP_TABLE, INDEX_TABLE, decodeNibble, decodeBlock, decodeCodes,
  extractCodes, parsePayload, samplesToPcm16LE, AdpcmError,
} = require("../dist/adpcm");
const { Store } = require("../dist/store");

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "adpcm-")), "test.db");
}

test("步长表与索引表符合标准", () => {
  assert.equal(STEP_TABLE.length, 89);
  assert.equal(STEP_TABLE[0], 7);
  assert.equal(STEP_TABLE[88], 32767);
  assert.deepEqual([...INDEX_TABLE], [-1, -1, -1, -1, 2, 4, 6, 8]);
});

test("演示：初值 (0,0)，连续两个码 7 得 11、41", () => {
  const r = decodeBlock(Buffer.from([0x77]), 2, { predictor: 0, index: 0 });
  assert.deepEqual(r.samples, [11, 41]);
  assert.deepEqual(r.state, { predictor: 41, index: 16 });
});

test("演示：初值 (0,0)，码 15 得 -11", () => {
  const r = decodeBlock(Buffer.from([0x0f]), 1, { predictor: 0, index: 0 });
  assert.deepEqual(r.samples, [-11]);
  assert.equal(r.steps[0].sign, 1);
});

test("手算核对：index=8 (step=16)，码 7 -> diff=2+16+8+4=30", () => {
  const s = decodeNibble(7, { predictor: 100, index: 8 });
  assert.equal(s.step, 16);
  assert.equal(s.diffBase, 2);
  assert.equal(s.termStep, 16);
  assert.equal(s.termHalf, 8);
  assert.equal(s.termQuarter, 4);
  assert.equal(s.diff, 30);
  assert.equal(s.newPredictor, 130);
  assert.equal(s.newIndex, 16);
});

test("手算核对：index=10 (step=19)，码 4 -> diff=2+19=21，索引 +2", () => {
  const s = decodeNibble(4, { predictor: 0, index: 10 });
  assert.equal(s.step, 19);
  assert.equal(s.diffBase, 2);
  assert.equal(s.termStep, 19);
  assert.equal(s.termHalf, 0);
  assert.equal(s.termQuarter, 0);
  assert.equal(s.diff, 21);
  assert.equal(s.newIndex, 12);
});

test("零差值：码 0 在 index=0 时差值为 0，预测值不变", () => {
  const s = decodeNibble(0, { predictor: 5, index: 0 });
  assert.equal(s.diff, 0);
  assert.equal(s.newPredictor, 5);
  assert.equal(s.newIndex, 0);
});

test("索引边界夹限：index=0 码 0 保持 0；index=88 码 7 夹到 88", () => {
  assert.equal(decodeNibble(0, { predictor: 0, index: 0 }).newIndex, 0);
  assert.equal(decodeNibble(7, { predictor: 0, index: 88 }).newIndex, 88);
});

test("正负饱和并标记", () => {
  const hi = decodeNibble(7, { predictor: 32760, index: 88 });
  assert.equal(hi.newPredictor, 32767);
  assert.equal(hi.saturated, true);
  assert.ok(hi.rawPredictor > 32767);
  const lo = decodeNibble(15, { predictor: -32760, index: 88 });
  assert.equal(lo.newPredictor, -32768);
  assert.equal(lo.saturated, true);
  assert.ok(lo.rawPredictor < -32768);
  const no = decodeNibble(0, { predictor: 0, index: 0 });
  assert.equal(no.saturated, false);
});

test("初始状态越界拒绝，不静默夹限", () => {
  assert.throws(() => decodeBlock(Buffer.from([0]), 1, { predictor: 40000, index: 0 }), /越界/);
  assert.throws(() => decodeBlock(Buffer.from([0]), 1, { predictor: 0, index: 89 }), /越界/);
  assert.throws(() => decodeBlock(Buffer.from([0]), 1, { predictor: 0, index: -1 }), /越界/);
});

test("字节序：低四位先解、高四位后解", () => {
  const r = decodeBlock(Buffer.from([0x70]), 2, { predictor: 0, index: 0 });
  assert.deepEqual(r.steps.map((s) => s.code), [0, 7]);
});

test("奇数有效码：最后高四位必须为零填充", () => {
  const ok = decodeBlock(Buffer.from([0x07]), 1, { predictor: 0, index: 0 });
  assert.deepEqual(ok.samples, [11]);
  assert.throws(() => decodeBlock(Buffer.from([0x17]), 1, { predictor: 0, index: 0 }), (e) => e.code === "PADDING_NONZERO");
});

test("字节数必须恰好等于 ceil(nibbles/2)", () => {
  assert.throws(() => decodeBlock(Buffer.from([0x00, 0x00]), 1, { predictor: 0, index: 0 }), (e) => e.code === "SIZE_MISMATCH");
  assert.throws(() => decodeBlock(Buffer.from([]), 1, { predictor: 0, index: 0 }), (e) => e.code === "SIZE_MISMATCH");
});

test("输入解析：hex/base64 校验，非法尾部拒绝", () => {
  assert.deepEqual(parsePayload("77", "hex"), Buffer.from([0x77]));
  assert.deepEqual(parsePayload("dw==", "base64"), Buffer.from([0x77]));
  assert.throws(() => parsePayload("7z", "hex"), (e) => e.code === "INVALID_PAYLOAD");
  assert.throws(() => parsePayload("777", "hex"), (e) => e.code === "INVALID_PAYLOAD");
  assert.throws(() => parsePayload("dw== ", "base64"), (e) => e.code === "INVALID_PAYLOAD");
  assert.throws(() => parsePayload("dw=", "base64"), (e) => e.code === "INVALID_PAYLOAD");
});

test("PCM16 小端导出，字节数 = 样本数 * 2", () => {
  const pcm = samplesToPcm16LE([11, 41, -11]);
  assert.equal(pcm.length, 6);
  assert.equal(pcm.readInt16LE(0), 11);
  assert.equal(pcm.readInt16LE(2), 41);
  assert.equal(pcm.readInt16LE(4), -11);
  assert.deepEqual([...pcm.subarray(0, 2)], [0x0b, 0x00]);
  assert.deepEqual([...pcm.subarray(4, 6)], [0xf5, 0xff]);
});

test("分块解码与拼接一次解码一致（样本数守恒）", () => {
  const codes = Array.from({ length: 101 }, (_, i) => (i * 7 + 3) % 16);
  const whole = decodeCodes(codes, { predictor: 100, index: 20 });
  let state = { predictor: 100, index: 20 };
  const parts = [];
  for (const slice of [codes.slice(0, 37), codes.slice(37, 80), codes.slice(80)]) {
    const r = decodeCodes(slice, state);
    parts.push(...r.samples);
    state = r.state;
  }
  assert.deepEqual(parts, whole.samples);
  assert.deepEqual(state, whole.state);
  assert.equal(parts.length, codes.length);
});

test("SQLite：追加、重启续解、幂等、失败回滚", () => {
  const db = tmpDb();
  let store = new Store(db);
  const ctx = store.createContext(0, 0);
  const r1 = store.appendBlock(ctx.id, Buffer.from([0x77]), 2, "req-1");
  assert.deepEqual(r1.samples, [11, 41]);

  // 幂等：相同 requestId 重放，不产生新样本
  const replay = store.appendBlock(ctx.id, Buffer.from([0x77]), 2, "req-1");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(store.getContext(ctx.id).sampleCount, 2);

  // 坏块回滚：状态不变
  assert.throws(() => store.appendBlock(ctx.id, Buffer.from([0x17]), 1), (e) => e.code === "PADDING_NONZERO");
  let cur = store.getContext(ctx.id);
  assert.equal(cur.predictor, 41);
  assert.equal(cur.index, 16);
  assert.equal(cur.sampleCount, 2);
  assert.equal(cur.blockCount, 1);

  store.appendBlock(ctx.id, Buffer.from([0x77]), 2, "req-2");
  const before = store.getContext(ctx.id);
  store.close();

  // 重启后继续下一块，与连续解码一致
  store = new Store(db);
  const after = store.getContext(ctx.id);
  assert.deepEqual(
    { predictor: after.predictor, index: after.index, sampleCount: after.sampleCount },
    { predictor: before.predictor, index: before.index, sampleCount: before.sampleCount }
  );
  const r3 = store.appendBlock(ctx.id, Buffer.from([0x77]), 2, "req-3");
  const expected = decodeCodes([7, 7, 7, 7, 7, 7], { predictor: 0, index: 0 });
  assert.deepEqual(store.getSamples(ctx.id, 0, 100).samples, expected.samples);
  assert.deepEqual(r3.samples, expected.samples.slice(4));

  // PCM 导出
  const pcm = store.getPcm(ctx.id);
  assert.equal(pcm.length, expected.samples.length * 2);
  assert.equal(pcm.readInt16LE(0), 11);

  // 派生上下文
  const derived = store.deriveContext(ctx.id);
  const finalCtx = store.getContext(ctx.id);
  assert.equal(derived.initialPredictor, finalCtx.predictor);
  assert.equal(derived.initialIndex, finalCtx.index);
  store.close();
});

test("初始状态越界在存储层同样拒绝", () => {
  const store = new Store(tmpDb());
  assert.throws(() => store.createContext(32768, 0), (e) => e.code === "INVALID_INITIAL_STATE");
  store.close();
});

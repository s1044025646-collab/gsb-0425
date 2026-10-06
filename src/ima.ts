// IMA ADPCM 4 位码核心解码器。标准 89 项步长表（源自 IMA/DVI ADPCM 规范，
// 与 ITU-T G.726 附录及 SoX/libsndfile 中 ima_step_table 一致）。
export const STEP_TABLE: readonly number[] = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

// 低三位 -> 索引调整量
export const INDEX_ADJUST: readonly number[] = [-1, -1, -1, -1, 2, 4, 6, 8];

export const MIN_PREDICTOR = -32768;
export const MAX_PREDICTOR = 32767;
export const MIN_INDEX = 0;
export const MAX_INDEX = 88;

export interface PredictorState {
  predictor: number;
  index: number;
}

export interface StepTrace {
  nibble: number;
  oldPredictor: number;
  oldIndex: number;
  step: number;
  diffBase: number;   // step >> 3
  diffBit0: number;   // bit0 ? step >> 2 : 0
  diffBit1: number;   // bit1 ? step >> 1 : 0
  diffBit2: number;   // bit2 ? step : 0
  diff: number;       // 带符号差值
  sign: 1 | -1;
  preClamp: number;
  newPredictor: number;
  saturated: boolean;
  indexDelta: number;
  newIndex: number;
}

export class ImaError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ImaError";
  }
}

export function validatePredictor(p: unknown): number {
  if (typeof p !== "number" || !Number.isInteger(p) || p < MIN_PREDICTOR || p > MAX_PREDICTOR) {
    throw new ImaError("INVALID_PREDICTOR", `初始预测值须为 ${MIN_PREDICTOR}..${MAX_PREDICTOR} 的整数`);
  }
  return p;
}

export function validateIndex(i: unknown): number {
  if (typeof i !== "number" || !Number.isInteger(i) || i < MIN_INDEX || i > MAX_INDEX) {
    throw new ImaError("INVALID_INDEX", `初始步长索引须为 ${MIN_INDEX}..${MAX_INDEX} 的整数`);
  }
  return i;
}

export function decodeNibble(state: PredictorState, nibble: number): { state: PredictorState; trace: StepTrace } {
  if (!Number.isInteger(nibble) || nibble < 0 || nibble > 15) {
    throw new ImaError("INVALID_NIBBLE", "四位码须为 0..15 的整数");
  }
  const oldIndex = state.index;
  const step = STEP_TABLE[oldIndex];
  // 所有移位均在非负步长上做整数截断；先用旧索引取步长
  const diffBase = step >> 3;
  const diffBit0 = (nibble & 1) ? step >> 2 : 0;
  const diffBit1 = (nibble & 2) ? step >> 1 : 0;
  const diffBit2 = (nibble & 4) ? step : 0;
  const magnitude = diffBase + diffBit0 + diffBit1 + diffBit2;
  const sign: 1 | -1 = (nibble & 8) ? -1 : 1;
  const diff = sign * magnitude;
  const preClamp = state.predictor + diff;
  const newPredictor = Math.min(MAX_PREDICTOR, Math.max(MIN_PREDICTOR, preClamp));
  const saturated = newPredictor !== preClamp;
  const indexDelta = INDEX_ADJUST[nibble & 7];
  const newIndex = Math.min(MAX_INDEX, Math.max(MIN_INDEX, oldIndex + indexDelta));
  return {
    state: { predictor: newPredictor, index: newIndex },
    trace: {
      nibble,
      oldPredictor: state.predictor,
      oldIndex,
      step,
      diffBase, diffBit0, diffBit1, diffBit2,
      diff, sign, preClamp, newPredictor, saturated,
      indexDelta, newIndex,
    },
  };
}

export interface DecodedBlock {
  samples: Int16Array;
  traces: StepTrace[];
  state: PredictorState;
}

// 按“低四位先、高四位后”解一块打包码流。nibbleCount 为实际有效码数；
// 字节数必须恰为 ceil(nibbleCount/2)；奇数时最后高四位必须为零填充。
export function decodeBlock(state: PredictorState, bytes: Uint8Array, nibbleCount: number): DecodedBlock {
  if (!Number.isInteger(nibbleCount) || nibbleCount < 0) {
    throw new ImaError("INVALID_NIBBLE_COUNT", "有效码数须为非负整数");
  }
  const expectedBytes = Math.ceil(nibbleCount / 2);
  if (bytes.length !== expectedBytes) {
    throw new ImaError("LENGTH_MISMATCH", `字节数 ${bytes.length} 与有效码数 ${nibbleCount} 不符，应为 ${expectedBytes}`);
  }
  if (nibbleCount % 2 === 1 && bytes.length > 0 && (bytes[bytes.length - 1] >> 4) !== 0) {
    throw new ImaError("NONZERO_PADDING", "奇数有效码时最后字节高四位必须为零填充");
  }
  const samples = new Int16Array(nibbleCount);
  const traces: StepTrace[] = [];
  let cur: PredictorState = { predictor: state.predictor, index: state.index };
  for (let i = 0; i < nibbleCount; i++) {
    const byte = bytes[i >> 1];
    const nibble = (i % 2 === 0) ? (byte & 0x0f) : (byte >> 4);
    const r = decodeNibble(cur, nibble);
    cur = r.state;
    samples[i] = cur.predictor;
    traces.push(r.trace);
  }
  return { samples, traces, state: cur };
}

// 严格十六进制解析：仅 [0-9a-fA-F]，长度必须为偶数，不允许任何非法尾部。
export function parseHex(s: string): Uint8Array {
  if (typeof s !== "string" || s.length === 0) throw new ImaError("INVALID_HEX", "十六进制串不能为空");
  if (s.length % 2 !== 0) throw new ImaError("INVALID_HEX", "十六进制串长度必须为偶数");
  if (!/^[0-9a-fA-F]+$/.test(s)) throw new ImaError("INVALID_HEX", "十六进制串含非法字符");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// 严格 Base64 解析（含填充校验，拒绝非法字符与非法尾部）。
export function parseBase64(s: string): Uint8Array {
  if (typeof s !== "string" || s.length === 0) throw new ImaError("INVALID_BASE64", "Base64 串不能为空");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
    throw new ImaError("INVALID_BASE64", "Base64 串含非法字符或长度非法");
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

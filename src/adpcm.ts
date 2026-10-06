/**
 * IMA ADPCM 4 位码单声道离线解码核心。
 * 仅处理明确给定初始状态的连续原始码流，不解析任何容器格式。
 */

/** 标准 IMA 步长表，89 项（来源：IMA/DVI ADPCM 标准，亦见 RFC 2421/多媒体文献）。 */
export const STEP_TABLE: readonly number[] = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 61, 68, 75, 82, 91, 100, 110, 121,
  133, 147, 161, 178, 196, 216, 237, 261, 288, 317,
  349, 384, 422, 464, 511, 562, 618, 680, 749, 824,
  906, 997, 1097, 1207, 1328, 1461, 1607, 1768, 1945, 2140,
  2354, 2590, 2849, 3134, 3448, 3793, 4173, 4590, 5050, 5555,
  6111, 6722, 7394, 8134, 8947, 9842, 10826, 11909, 13100, 14410,
  15851, 17436, 19180, 21098, 23208, 25529, 28082, 30890, 32767,
];

/** 索引调整表，按码的低三位索引：-1,-1,-1,-1,2,4,6,8。 */
export const INDEX_TABLE: readonly number[] = [-1, -1, -1, -1, 2, 4, 6, 8];

export const MIN_PREDICTOR = -32768;
export const MAX_PREDICTOR = 32767;
export const MIN_INDEX = 0;
export const MAX_INDEX = 88;

export interface PredictorState {
  predictor: number;
  index: number;
}

/** 单个四位码的完整状态变化记录。 */
export interface StepRecord {
  /** 本步解码的四位码（0-15）。 */
  code: number;
  oldPredictor: number;
  oldIndex: number;
  /** 用旧索引查得的步长。 */
  step: number;
  /** 差值基底：step >> 3。 */
  diffBase: number;
  /** bit2 命中时累加的项：step。未命中为 0。 */
  termStep: number;
  /** bit1 命中时累加的项：step >> 1。未命中为 0。 */
  termHalf: number;
  /** bit0 命中时累加的项：step >> 2。未命中为 0。 */
  termQuarter: number;
  /** 最高位（bit3）：1 表示减去差值。 */
  sign: 0 | 1;
  /** 带符号差值。 */
  diff: number;
  /** 夹限前的预测值。 */
  rawPredictor: number;
  /** 夹限后的预测值，即本码产生的新样本。 */
  newPredictor: number;
  /** 是否发生夹限（饱和）。饱和不表示输入损坏。 */
  saturated: boolean;
  newIndex: number;
}

export class AdpcmError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "AdpcmError";
  }
}

export function clampInt16(v: number): number {
  if (v > MAX_PREDICTOR) return MAX_PREDICTOR;
  if (v < MIN_PREDICTOR) return MIN_PREDICTOR;
  return v;
}

export function clampIndex(v: number): number {
  if (v > MAX_INDEX) return MAX_INDEX;
  if (v < MIN_INDEX) return MIN_INDEX;
  return v;
}

/** 校验初始状态；越界拒绝，绝不静默夹限。 */
export function validateInitialState(state: PredictorState): void {
  if (!Number.isInteger(state.predictor) || !Number.isInteger(state.index)) {
    throw new AdpcmError("INVALID_INITIAL_STATE", "初始预测值与索引必须是整数");
  }
  if (state.predictor < MIN_PREDICTOR || state.predictor > MAX_PREDICTOR) {
    throw new AdpcmError(
      "INVALID_INITIAL_STATE",
      `初始预测值 ${state.predictor} 越界，须在 [${MIN_PREDICTOR}, ${MAX_PREDICTOR}]`
    );
  }
  if (state.index < MIN_INDEX || state.index > MAX_INDEX) {
    throw new AdpcmError(
      "INVALID_INITIAL_STATE",
      `初始步长索引 ${state.index} 越界，须在 [${MIN_INDEX}, ${MAX_INDEX}]`
    );
  }
}

/**
 * 解码一个四位码。严格按规范：
 * 1. 用旧索引取步长；
 * 2. 差值从 step>>3 开始，按低三位分别累加 step、step>>1、step>>2（非负整数截断右移）；
 * 3. 最高位决定加或减；
 * 4. 预测值夹到 int16；
 * 5. 索引按低三位调整后夹到 [0, 88]，供下一码使用。
 */
export function decodeNibble(code: number, state: PredictorState): StepRecord {
  if (!Number.isInteger(code) || code < 0 || code > 15) {
    throw new AdpcmError("INVALID_CODE", `四位码 ${code} 越界，须在 [0, 15]`);
  }
  const step = STEP_TABLE[state.index];
  const diffBase = step >> 3;
  const termStep = code & 4 ? step : 0;
  const termHalf = code & 2 ? step >> 1 : 0;
  const termQuarter = code & 1 ? step >> 2 : 0;
  const magnitude = diffBase + termStep + termHalf + termQuarter;
  const sign = (code & 8 ? 1 : 0) as 0 | 1;
  const diff = sign ? -magnitude : magnitude;
  const rawPredictor = state.predictor + diff;
  const newPredictor = clampInt16(rawPredictor);
  const newIndex = clampIndex(state.index + INDEX_TABLE[code & 7]);
  return {
    code,
    oldPredictor: state.predictor,
    oldIndex: state.index,
    step,
    diffBase,
    termStep,
    termHalf,
    termQuarter,
    sign,
    diff,
    rawPredictor,
    newPredictor,
    saturated: rawPredictor !== newPredictor,
    newIndex,
  };
}

export interface DecodeResult {
  samples: number[];
  steps: StepRecord[];
  state: PredictorState;
}

/** 顺序解码一组四位码，每个有效码恰好产生一个新样本。 */
export function decodeCodes(codes: Iterable<number>, initial: PredictorState): DecodeResult {
  validateInitialState(initial);
  const samples: number[] = [];
  const steps: StepRecord[] = [];
  let state: PredictorState = { predictor: initial.predictor, index: initial.index };
  for (const code of codes) {
    const rec = decodeNibble(code, state);
    steps.push(rec);
    samples.push(rec.newPredictor);
    state = { predictor: rec.newPredictor, index: rec.newIndex };
  }
  return { samples, steps, state };
}

/**
 * 从打包字节流提取四位码：每字节低四位先解、高四位后解。
 * 奇数个有效码时，最后字节的高四位必须为零填充，否则拒绝。
 */
export function extractCodes(data: Buffer, nibbleCount: number): number[] {
  if (!Number.isInteger(nibbleCount) || nibbleCount < 0) {
    throw new AdpcmError("INVALID_NIBBLE_COUNT", `有效码数 ${nibbleCount} 非法`);
  }
  const expectedBytes = Math.ceil(nibbleCount / 2);
  if (data.length !== expectedBytes) {
    throw new AdpcmError(
      "SIZE_MISMATCH",
      `字节数 ${data.length} 与有效码数 ${nibbleCount} 不符，期望恰好 ${expectedBytes} 字节`
    );
  }
  const codes: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    codes.push(byte & 0x0f);
    const isLast = i === data.length - 1;
    const hasHigh = i * 2 + 1 < nibbleCount;
    if (hasHigh) {
      codes.push(byte >> 4);
    } else if (isLast && byte >> 4 !== 0) {
      throw new AdpcmError(
        "PADDING_NONZERO",
        `奇数有效码时最后字节高四位必须为零填充，实际为 0x${(byte >> 4).toString(16)}`
      );
    }
  }
  return codes;
}

/** 一次性解码一个打包码块。 */
export function decodeBlock(data: Buffer, nibbleCount: number, initial: PredictorState): DecodeResult {
  const codes = extractCodes(data, nibbleCount);
  return decodeCodes(codes, initial);
}

/** 样本数组转 PCM16 小端二进制。 */
export function samplesToPcm16LE(samples: ArrayLike<number>): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], i * 2);
  }
  return buf;
}

/** 解析十六进制或 Base64 输入，严格校验字符与长度，不忽略非法尾部。 */
export function parsePayload(text: string, format: "hex" | "base64"): Buffer {
  if (typeof text !== "string" || text.length === 0) {
    throw new AdpcmError("INVALID_PAYLOAD", "码流数据不能为空");
  }
  if (format === "hex") {
    if (!/^[0-9a-fA-F]+$/.test(text)) {
      throw new AdpcmError("INVALID_PAYLOAD", "十六进制码流含非法字符");
    }
    if (text.length % 2 !== 0) {
      throw new AdpcmError("INVALID_PAYLOAD", "十六进制码流长度必须为偶数");
    }
    return Buffer.from(text, "hex");
  }
  if (format === "base64") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
      throw new AdpcmError("INVALID_PAYLOAD", "Base64 码流含非法字符或长度非法");
    }
    const buf = Buffer.from(text, "base64");
    if (buf.toString("base64") !== text) {
      throw new AdpcmError("INVALID_PAYLOAD", "Base64 码流含非法尾部填充");
    }
    return buf;
  }
  throw new AdpcmError("INVALID_PAYLOAD", `未知格式 ${format}，仅支持 hex 或 base64`);
}

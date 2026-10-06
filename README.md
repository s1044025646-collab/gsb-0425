# IMA ADPCM 四位码解码与预测器状态回放后端

仅后端（API + CLI），TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生依赖），Windows 本地运行，不需要 Docker / WSL / 外部服务。

## 受限格式说明（重要）

本服务**只**处理"明确给定初始状态的连续原始 IMA ADPCM 四位码流"：

- 单声道、每码 4 位、标准 IMA 步长表（89 项）。
- 调用方必须显式给出初始有符号 16 位预测值与初始步长索引（0..88）。
- **不解析** WAV 容器、不处理声卡数据、不录音、不做编码器；不要把任意压缩音频当作此格式喂进来。
- 初始预测值只是状态，**不**额外输出为样本；每个有效四位码恰好产生一个新样本。
- 码流按每字节**低四位先解、高四位后解**。

## 解码规则（核心实现，见 `src/ima.ts`）

- 步长表：标准 IMA/DVI ADPCM 89 项步长表（7, 8, 9, ..., 32767），与 ITU-T G.726 附录及 SoX / libsndfile 中的 `ima_step_table` 一致。
- 每个码先用**旧索引**取步长 `step`；差值从 `step >> 3` 开始，按低三位分别累加 `step >> 2`（bit0）、`step >> 1`（bit1）、`step`（bit2）。所有右移都在非负步长上做整数截断，不使用浮点整体比例。
- 最高位（bit3）为符号位：1 表示从预测值减去差值，0 表示加。
- 预测值夹到 [-32768, 32767]，饱和时在步轨迹中标记 `saturated: true`（饱和不代表输入损坏）。
- 索引按低三位查表 `[-1,-1,-1,-1,2,4,6,8]` 调整后夹到 [0, 88]，供下一码使用。
- 每步轨迹记录：旧预测值、旧索引、步长、差值各项（base/bit0/bit1/bit2）、符号、夹限前后值、是否饱和、索引调整量、新索引。

## 块格式

- 每块带实际有效码数 `nibbleCount`；字节数必须恰好等于 `ceil(nibbleCount / 2)`，否则报 `LENGTH_MISMATCH`。
- 奇数有效码时，最后字节高四位只作零填充、不输出样本；非零填充报 `NONZERO_PADDING`。
- 输入编码：`hex`（偶数长度、仅 0-9a-f，非法字符/尾部拒绝）或 `base64`（严格校验字符与填充）。
- PCM16 导出固定**小端**，字节数 = 样本数 × 2。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试（node:test）
npm start         # 启动 HTTP 服务（默认监听 127.0.0.1 空闲端口）
npm run demo      # 运行演示：初值 (0,0)，码 7,7 -> 11,41；码 15 -> -11
```

数据目录默认为项目内 `data/`（可用环境变量 `IMA_DB_PATH` 指定数据库文件）。端口用 `--port` 或环境变量 `PORT` 指定，默认 0（自动选空闲端口）。

## CLI

```
node dist/src/cli.js create --predictor 0 --index 0
node dist/src/cli.js append <id> --block b1 --nibbles 2 --encoding hex --data 77
node dist/src/cli.js samples <id> [--offset N] [--limit N]
node dist/src/cli.js state <id>
node dist/src/cli.js steps <id> [--offset N] [--limit N]
node dist/src/cli.js export-pcm <id> --out out.pcm
node dist/src/cli.js derive <id> [--at-seq N]
node dist/src/cli.js explain --predictor 0 --index 0 --nibble 15
node dist/src/cli.js serve [--port N]
node dist/src/cli.js demo
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/contexts` | 创建上下文 `{initialPredictor, initialIndex}` |
| GET | `/contexts` / `/contexts/:id` | 列出 / 查看状态与摘要 |
| POST | `/contexts/:id/blocks` | 追加块 `{blockId, encoding, data, nibbleCount}`（幂等） |
| GET | `/contexts/:id/samples?offset&limit` | 整数样本数组 |
| GET | `/contexts/:id/pcm` | PCM16 小端二进制（`X-Sample-Count` 头） |
| GET | `/contexts/:id/steps?offset&limit` | 每步状态轨迹 |
| POST | `/contexts/:id/derive` | 派生新上下文（可选 `{atSeq}`） |
| POST | `/explain` | 单码解释 `{predictor, index, nibble}` |

## 持久化与一致性

- SQLite 单库原子保存：初始状态、块顺序（`seq`）、当前预测值与索引、每块后的运行摘要（`sha256(prevDigest || pcm)`）。重启后从库中状态继续下一块。
- 同一上下文分块解码与把有效四位码拼接后一次解码**完全一致**（有测试保证）。
- 幂等：相同 `blockId` + 相同内容重复提交返回已有结果（`duplicated: true`）；相同 `blockId` 不同内容报 `BLOCK_CONFLICT`（409）。
- 坏块（长度不符、非零填充、非法编码）在解码阶段即失败，事务不落库，预测器与样本数不变。
- 初始预测值 / 索引越界直接拒绝（`INVALID_PREDICTOR` / `INVALID_INDEX`），不会静默夹限。
- 限制：单上下文样本总量上限 1,000,000；单次轨迹/样本查询上限 10,000 条。

## 错误码

`INVALID_PREDICTOR` `INVALID_INDEX` `INVALID_NIBBLE` `INVALID_NIBBLE_COUNT` `LENGTH_MISMATCH` `NONZERO_PADDING` `INVALID_HEX` `INVALID_BASE64` `BAD_ENCODING` `INVALID_BLOCK_ID` `BLOCK_CONFLICT` `CONTEXT_NOT_FOUND` `BLOCK_NOT_FOUND` `SAMPLE_LIMIT` `PAYLOAD_TOO_LARGE` `BAD_JSON` `NOT_FOUND`

## 测试覆盖（`test/ima.test.ts`，18 项）

演示用例（7,7→11,41；15→-11）、零差值、索引上下边界、正负饱和、奇数有效码与非零填充、长度不符、hex/Base64 严格校验、小端导出（字节数=样本数×2）、手算核对步长与状态变化（不依赖任何已有库）、分块与拼接一致性、重启续算、坏块回滚、幂等、越界拒绝、派生上下文。

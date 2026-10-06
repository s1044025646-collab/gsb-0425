# IMA ADPCM 四位码解码与预测器状态回放后端

单声道 IMA ADPCM 4 位码的离线解码服务，TypeScript + Node.js + SQLite（Node 内置
`node:sqlite`，无原生编译依赖）。只做 API 与 CLI，不解析 WAV 容器、不录音、不做编码器、
不实时播放。仅处理明确给定初始状态的连续原始码流。

## 环境要求

- Windows 本地，Node.js >= 22（开发使用 v25，内置 node:sqlite）
- 不需要 Docker / WSL / 任何外部在线服务

## 构建、测试、启动、演示

    npm install         REM 安装开发依赖（typescript、@types/node）
    npm run build       REM 编译 TypeScript 到 dist/
    npm test            REM 构建并运行全部单元测试（node:test）
    npm start           REM 启动 HTTP 服务（默认自动选择空闲端口，数据库在 data\adpcm.db）
    npm run demo        REM 演示：初值 (0,0)，码 [7,7] -> [11, 41]；码 [15] -> [-11]
    node scripts\e2e.js REM 端到端 API 演示

CLI 直接用法：

    node dist\cli.js serve [--port N] [--db PATH]
    node dist\cli.js decode --predictor 0 --index 0 --data 77 --format hex --nibbles 2 [--out out.pcm]
    node dist\cli.js explain --predictor 0 --index 0 --code 7
    node dist\cli.js demo

## 受限格式说明（务必阅读）

- 输入是裸四位码流，不是 WAV/声卡数据；任意压缩音频不能当作本格式。
- 每字节低四位先解、高四位后解。
- 每块必须给出实际有效码数 nibbleCount，字节数必须恰好等于 ceil(nibbleCount/2)，否则报 SIZE_MISMATCH。
- 奇数个有效码时，最后字节的高四位只作零填充、不产生样本；非零填充报 PADDING_NONZERO。
- 初始预测值必须在 [-32768, 32767]，初始索引必须在 [0, 88]；越界直接拒绝
  （INVALID_INITIAL_STATE），绝不静默夹限后声称使用了原始初值。
- 初始预测值只是状态，不额外输出为样本；每个有效四位码恰好产生一个新样本。
- 输出 PCM16 固定小端，字节数 = 样本数 x 2。
- 输入编码支持 hex 与 base64，严格校验字符与长度，不忽略非法尾部。

## 解码规则（与标准 IMA 一致）

对每个四位码 code（bit3 为符号位，bit2..0 为幅度位）：

1. 用旧索引取步长 step = STEP_TABLE[index]；
2. 差值从 step >> 3 开始，按低三位分别累加 step、step >> 1、step >> 2
   （全部为非负整数截断右移，不用浮点整体比例替代）；
3. 符号位为 1 则减去差值，否则加上；
4. 预测值夹到 [-32768, 32767]；饱和是合法情况，记录中 saturated=true 标出发生位置；
5. 索引按低三位查 [-1,-1,-1,-1,2,4,6,8] 调整后夹到 [0, 88]，供下一码使用。

每步记录字段：code / oldPredictor / oldIndex / step / diffBase / termStep / termHalf /
termQuarter / sign / diff / rawPredictor / newPredictor / saturated / newIndex。

## 步长表来源

89 项步长表（7, 8, 9, ..., 32767）来自 IMA（Interactive Multimedia Association）
DVI ADPCM 标准算法，该表亦收录于 RFC 2421 第 6.2 节及大量多媒体文献。索引调整表
[-1,-1,-1,-1,2,4,6,8] 同出该标准。正确性以独立手算用例核对（见 test/adpcm.test.js
中"手算核对"测试），不以任何已有库作为唯一依据。

## HTTP API

默认监听 127.0.0.1，未指定端口时自动选择空闲端口并在启动日志中打印。

- GET  /health                            健康检查
- GET  /limits                            当前限制值
- POST /contexts                          创建上下文 {predictor, index, id?}
- GET  /contexts/:id                      查看当前状态（预测值、索引、样本数、摘要）
- POST /contexts/:id/blocks               追加码块 {data, format, nibbleCount, requestId?}
- GET  /contexts/:id/samples?offset&limit 查询整数样本数组
- GET  /contexts/:id/pcm                  导出 PCM16 小端二进制（响应头 X-Sample-Count）
- POST /contexts/:id/derive               以当前状态为初值派生新上下文 {id?}
- POST /explain                           单码解释 {predictor, index, code}

错误统一为 {"error": {"code": "...", "message": "..."}}，错误码包括：
INVALID_INITIAL_STATE、INVALID_CODE、INVALID_PAYLOAD、SIZE_MISMATCH、
PADDING_NONZERO、LIMIT_EXCEEDED、NOT_FOUND、CONFLICT。

## 持久化与一致性

- SQLite（WAL）原子保存：初始状态、块顺序（seq）、当前预测值与索引、样本数、
  输出摘要（对 PCM 的链式 SHA-256）。重启后可继续追加下一块。
- 每个块先在内存中完整解码并校验，然后在单事务中落库；坏块不会消耗部分码，
  也不会改变预测器（失败回滚有测试覆盖）。
- 携带相同 requestId 的重复块请求幂等返回首次结果，不重复产生样本。
- 同一上下文分块解码与拼接有效四位码后一次解码完全一致（有测试覆盖）。

## 限制

- 单上下文样本总量上限：10,000,000
- 单块字节上限：4 MiB
- 追加块响应中逐步解释最多返回 1,000 条（超出时 stepsTruncated=true，样本不受影响）
- 仅本地回环监听；无鉴权，不要暴露到网络

## 项目结构

    src/adpcm.ts        解码核心：步长表、单码解码、块解码、输入解析
    src/store.ts        SQLite 持久化：上下文、块、幂等、事务
    src/server.ts       HTTP API（node:http，无框架）
    src/cli.ts          命令行入口
    test/adpcm.test.js  单元测试（node:test）
    scripts/e2e.js      端到端 API 演示

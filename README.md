# service-topology-builder

JavaScript 服务拓扑重建库，处理 Trace 调用边、实例聚合、跨集群边界和时间窗。

运行环境：Node.js 24.16.0（`node --test` 运行测试，无第三方依赖）。

## 用法

```js
import { buildTopology } from "./src/topology.js";

const result = buildTopology(jsonlString, {
  windowStart: 1730000000000,
  windowEnd: 1730003600000,
});
```

或命令行：

```sh
node cli.js spans.jsonl --start 1730000000000 --end 1730003600000
```

## 输入格式

JSON Lines，每行一个 span：

```json
{"traceId":"t1","spanId":"s1","parentSpanId":"s0","service":"api","cluster":"cn-east","instanceId":"pod-1","startTime":1730000000100,"sampleRate":0.5}
```

- `traceId` / `spanId` / `service` / `cluster` / `startTime`（毫秒）必填；`parentSpanId` 为 `null` 或缺省表示根 span。
- `sampleRate` 可选，取值 `(0, 1]`，表示该 span 所在实例的采样比例；缺省按 1（全量）处理但会降低置信度。
- 非法 JSON 行、缺字段、`sampleRate` 越界的记录进入 `invalidRecords`，不参与聚合。

## 处理规则

- **乱序容忍**：先按 `traceId` 归集全量 span 再解析父子关系，结果与到达顺序无关。
- **去重**：`(traceId, spanId)` 相同的重复上报只保留第一条，丢弃数计入 `stats.duplicatesDropped`。
- **时间窗**：`[windowStart, windowEnd)` 按 `startTime` 判定。窗外 span 仅用于补全父子关系，不产生调用次数、实例数或采样统计。
- **父节点缺失**：保留边，来源标记为 `(unknown)` 且 `parentMissing: true`，置信度乘以 0.5；子 span 进入 `unassociatedSpans`。
- **跨集群**：任一对贡献 span 的父子 cluster 不同，边标记 `crossCluster: true`，全部集群对列入 `clusterPairs`。
- **调用量 ≠ 实例数**：`callCount` 按去重后的窗内 span 计数；`instanceCount` 是窗内去重 `instanceId` 数量，两者独立统计。

## 输出结构

```json
{
  "window": {"start": 0, "end": 0},
  "nodes": [{"service":"api","clusters":["cn-east"],"callCount":4,"instanceCount":2,"instances":["pod-1","pod-2"],"estimatedCalls":8,"samplingConfidence":0.5}],
  "edges": [{"from":"api","to":"db","callCount":3,"estimatedCalls":13,"crossCluster":false,"parentMissing":false,"clusterPairs":["cn-east->cn-east"],"samplingConfidence":0.5333}],
  "unassociatedSpans": [{"traceId":"t1","spanId":"c","parentSpanId":"ghost","service":"db","reason":"missing-parent"}],
  "stats": {"spansTotal":10,"spansDeduped":9,"duplicatesDropped":1,"outOfWindowSpans":2,"invalidRecords":0},
  "invalidRecords": []
}
```

## 采样偏差说明

不同实例的采样比例可能不同，同一 trace 内也可能混用多版本采样配置。本库按 span 个体携带的 `sampleRate` 处理：

- `estimatedCalls = Σ 1/sampleRate`（未携带采样率的 span 按 1 计），是对真实调用量的无偏点估计，但仅在采样相互独立且上报的采样率准确时成立。
- `samplingConfidence = 采样率元数据覆盖率 × 已知采样率均值`，取值 `[0, 1]`。全部 span 携带 `sampleRate: 1` 时为 1；采样率越低、元数据缺失越多，置信度越低。父节点缺失的边再乘以 0.5。
- 置信度是启发式指标，不是统计显著性检验结果：它不感知实例间采样率差异的方向性（例如高流量实例恰好低采样时，估算误差会更大）。

## 结果边界

- 拓扑只反映**观测到**的调用关系；采样为 0 或采集器完全丢失的路径不会出现。
- 父 span 缺失时无法还原真实调用来源，边只能挂在 `(unknown)` 下，调用次数仍按子 span 统计。
- 同名服务部署在多个集群时聚合为同一节点，集群维度信息在 `clusters` 与边的 `clusterPairs` 中保留，但不拆分节点。
- 重复去重以 `(traceId, spanId)` 为准；采集器对同一 span 重发不同内容时以第一条为准。
- 时间窗边界附近的长耗时 span 按 `startTime` 归属，不按结束时间折算。

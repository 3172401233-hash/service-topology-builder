import test from "node:test";
import assert from "node:assert/strict";
import { buildTopology, parseSpans, UNKNOWN_SERVICE } from "../src/topology.js";

const W = { windowStart: 1000, windowEnd: 2000 };

function span(overrides) {
  return {
    traceId: "t1",
    spanId: "s1",
    parentSpanId: null,
    service: "svc",
    cluster: "c1",
    instanceId: "i1",
    startTime: 1500,
    ...overrides,
  };
}

function toJsonl(spans) {
  return spans.map((s) => JSON.stringify(s)).join("\n");
}

test("乱序上报:子 span 先于父 span 到达,拓扑结果一致", () => {
  const parent = span({ spanId: "p", service: "frontend" });
  const child = span({ spanId: "c", parentSpanId: "p", service: "backend", startTime: 1600 });
  const ordered = buildTopology(toJsonl([parent, child]), W);
  const reversed = buildTopology(toJsonl([child, parent]), W);
  assert.deepEqual(reversed, ordered);
  assert.equal(reversed.edges.length, 1);
  assert.equal(reversed.edges[0].from, "frontend");
  assert.equal(reversed.edges[0].to, "backend");
  assert.equal(reversed.edges[0].callCount, 1);
});

test("父节点缺失:保留边、降低置信度、子 span 进入未关联清单", () => {
  const orphan = span({ spanId: "c", parentSpanId: "ghost", service: "backend", sampleRate: 0.5 });
  const result = buildTopology(toJsonl([orphan]), W);
  assert.equal(result.edges.length, 1);
  const edge = result.edges[0];
  assert.equal(edge.from, UNKNOWN_SERVICE);
  assert.equal(edge.to, "backend");
  assert.equal(edge.parentMissing, true);
  assert.equal(edge.callCount, 1);
  // 采样置信度 0.5,孤儿系数 0.5 -> 0.25
  assert.equal(edge.samplingConfidence, 0.25);
  assert.deepEqual(result.unassociatedSpans, [
    {
      traceId: "t1",
      spanId: "c",
      parentSpanId: "ghost",
      service: "backend",
      reason: "missing-parent",
    },
  ]);
});

test("重复上报:相同 (traceId, spanId) 只计一次调用", () => {
  const parent = span({ spanId: "p", service: "frontend" });
  const child = span({ spanId: "c", parentSpanId: "p", service: "backend", startTime: 1600 });
  const result = buildTopology(toJsonl([parent, child, child, parent]), W);
  assert.equal(result.stats.duplicatesDropped, 2);
  assert.equal(result.edges[0].callCount, 1);
  const backend = result.nodes.find((n) => n.service === "backend");
  assert.equal(backend.callCount, 1);
});

test("跨集群调用单独标记", () => {
  const local = [
    span({ traceId: "t1", spanId: "p1", service: "a", cluster: "c1" }),
    span({ traceId: "t1", spanId: "c1", parentSpanId: "p1", service: "b", cluster: "c1", startTime: 1600 }),
  ];
  const remote = [
    span({ traceId: "t2", spanId: "p2", service: "a", cluster: "c1" }),
    span({ traceId: "t2", spanId: "c2", parentSpanId: "p2", service: "b", cluster: "c2", startTime: 1700 }),
  ];
  const result = buildTopology(toJsonl([...local, ...remote]), W);
  assert.equal(result.edges.length, 1);
  const edge = result.edges[0];
  assert.equal(edge.callCount, 2);
  assert.equal(edge.crossCluster, true);
  assert.deepEqual(edge.clusterPairs, ["c1->c1", "c1->c2"]);
});

test("空窗口:窗外 span 只补全关系,不产生节点、边和调用量", () => {
  const spans = [
    span({ spanId: "p", service: "frontend", startTime: 500 }),
    span({ spanId: "c", parentSpanId: "p", service: "backend", startTime: 2500 }),
  ];
  const result = buildTopology(toJsonl(spans), W);
  assert.equal(result.nodes.length, 0);
  assert.equal(result.edges.length, 0);
  assert.equal(result.stats.outOfWindowSpans, 2);
});

test("窗外父 span 补全关系但不增加调用次数", () => {
  const parent = span({ spanId: "p", service: "frontend", startTime: 500 });
  const child = span({ spanId: "c", parentSpanId: "p", service: "backend", startTime: 1500 });
  const result = buildTopology(toJsonl([parent, child]), W);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].from, "frontend");
  assert.equal(result.edges[0].callCount, 1);
  // 父 span 在窗外,frontend 节点不出现、不计调用
  assert.equal(result.nodes.find((n) => n.service === "frontend"), undefined);
  const backend = result.nodes.find((n) => n.service === "backend");
  assert.equal(backend.callCount, 1);
});

test("同 trace 多版本采样:不同 sampleRate 混合时估算与置信度正确", () => {
  const spans = [
    span({ spanId: "p", service: "frontend", sampleRate: 1 }),
    span({ spanId: "c1", parentSpanId: "p", service: "backend", startTime: 1500, sampleRate: 1 }),
    span({ spanId: "c2", parentSpanId: "p", service: "backend", startTime: 1600, sampleRate: 0.5 }),
    span({ spanId: "c3", parentSpanId: "p", service: "backend", startTime: 1700, sampleRate: 0.1 }),
  ];
  const result = buildTopology(toJsonl(spans), W);
  const edge = result.edges[0];
  assert.equal(edge.callCount, 3);
  // estimatedCalls = 1/1 + 1/0.5 + 1/0.1 = 13
  assert.equal(edge.estimatedCalls, 13);
  // 置信度 = 覆盖率 1 * 平均采样率 (1+0.5+0.1)/3
  assert.equal(edge.samplingConfidence, 0.5333);
  const backend = result.nodes.find((n) => n.service === "backend");
  assert.equal(backend.callCount, 3);
  assert.equal(backend.estimatedCalls, 13);
});

test("实例数与调用次数分离:同实例多次调用、多实例各一次调用", () => {
  const spans = [
    span({ spanId: "s1", service: "api", instanceId: "pod-1", startTime: 1100 }),
    span({ spanId: "s2", service: "api", instanceId: "pod-1", startTime: 1200 }),
    span({ spanId: "s3", service: "api", instanceId: "pod-1", startTime: 1300 }),
    span({ spanId: "s4", service: "api", instanceId: "pod-2", startTime: 1400 }),
  ];
  const result = buildTopology(toJsonl(spans), W);
  const api = result.nodes.find((n) => n.service === "api");
  assert.equal(api.callCount, 4);
  assert.equal(api.instanceCount, 2);
  assert.deepEqual(api.instances, ["pod-1", "pod-2"]);
});

test("非法行与缺字段记录进入 invalidRecords,不影响其余数据", () => {
  const good = span({ spanId: "ok", service: "api" });
  const jsonl = [`{"broken":`, JSON.stringify({ spanId: "no-trace" }), JSON.stringify(good)].join("\n");
  const result = buildTopology(jsonl, W);
  assert.equal(result.stats.invalidRecords, 2);
  assert.equal(result.invalidRecords.length, 2);
  assert.equal(result.nodes.length, 1);
});

test("parseSpans 拒绝越界 sampleRate", () => {
  const { spans, invalid } = parseSpans(toJsonl([span({ sampleRate: 0 }), span({ sampleRate: 1.5 }), span({ sampleRate: 0.3 })]));
  assert.equal(spans.length, 1);
  assert.equal(invalid.length, 2);
});

test("非法时间窗直接抛错", () => {
  assert.throws(() => buildTopology("", { windowStart: 2000, windowEnd: 1000 }), RangeError);
  assert.throws(() => buildTopology("", { windowStart: Number.NaN, windowEnd: 1000 }), RangeError);
});

/**
 * 服务拓扑构建器。
 *
 * 输入:JSON Lines,每行一个 span:
 * {
 *   "traceId": "t1",            // 必填
 *   "spanId": "s1",             // 必填
 *   "parentSpanId": "s0"|null,  // 根 span 为 null 或缺省
 *   "service": "api-gateway",   // 必填
 *   "cluster": "cn-east",       // 必填
 *   "instanceId": "pod-1",      // 可选,用于实例数统计
 *   "startTime": 1730000000000, // 必填,毫秒时间戳
 *   "sampleRate": 0.5           // 可选,(0,1],该 span 所在实例的采样比例
 * }
 *
 * 规则:
 * - 乱序容忍:先按 traceId 归集全量 span,再解析父子关系,与到达顺序无关。
 * - 去重:(traceId, spanId) 相同的重复上报只保留第一条,其余计入 duplicatesDropped。
 * - 时间窗:[windowStart, windowEnd) 按 startTime 判定。窗外 span 仅用于补全
 *   父子关系,不产生任何调用次数、实例数或采样统计。
 * - 父节点缺失:保留边,来源标记为 UNKNOWN_SERVICE,parentMissing=true,
 *   置信度减半;子 span 进入 unassociatedSpans。
 * - 跨集群:任一对贡献 span 的父子 cluster 不同,则边标记 crossCluster=true。
 * - 调用量与实例数分离:callCount 按去重后的窗内 span 计数;instanceCount 是
 *   窗内出现的去重 instanceId 数量,两者互不影响。
 */

export const UNKNOWN_SERVICE = "(unknown)";
export const ORPHAN_CONFIDENCE_FACTOR = 0.5;

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function normalizeSpan(raw, lineNo) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `line ${lineNo}: not an object` };
  }
  const { traceId, spanId, parentSpanId, service, cluster, instanceId, startTime, sampleRate } = raw;
  if (typeof traceId !== "string" || traceId === "") return { error: `line ${lineNo}: missing traceId` };
  if (typeof spanId !== "string" || spanId === "") return { error: `line ${lineNo}: missing spanId` };
  if (typeof service !== "string" || service === "") return { error: `line ${lineNo}: missing service` };
  if (typeof cluster !== "string" || cluster === "") return { error: `line ${lineNo}: missing cluster` };
  if (!Number.isFinite(startTime)) return { error: `line ${lineNo}: missing/invalid startTime` };
  const rate = sampleRate === undefined || sampleRate === null ? null : Number(sampleRate);
  if (rate !== null && (!Number.isFinite(rate) || rate <= 0 || rate > 1)) {
    return { error: `line ${lineNo}: sampleRate out of range (0,1]` };
  }
  return {
    span: {
      traceId,
      spanId,
      parentSpanId: typeof parentSpanId === "string" && parentSpanId !== "" ? parentSpanId : null,
      service,
      cluster,
      instanceId: typeof instanceId === "string" && instanceId !== "" ? instanceId : null,
      startTime,
      sampleRate: rate,
    },
  };
}

export function parseSpans(jsonl) {
  const spans = [];
  const invalid = [];
  const lines = String(jsonl).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    const lineNo = index + 1;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      invalid.push({ line: lineNo, reason: "invalid-json" });
      continue;
    }
    const { span, error } = normalizeSpan(raw, lineNo);
    if (error) {
      invalid.push({ line: lineNo, reason: error });
    } else {
      spans.push(span);
    }
  }
  return { spans, invalid };
}

class SamplingAccumulator {
  constructor() {
    this.total = 0;
    this.knownRate = 0;
    this.rateSum = 0;
    this.estimatedCalls = 0;
  }

  add(span) {
    this.total += 1;
    if (span.sampleRate !== null) {
      this.knownRate += 1;
      this.rateSum += span.sampleRate;
      this.estimatedCalls += 1 / span.sampleRate;
    } else {
      this.estimatedCalls += 1;
    }
  }

  confidence() {
    if (this.total === 0) return 0;
    const coverage = this.knownRate / this.total;
    const meanRate = this.knownRate > 0 ? this.rateSum / this.knownRate : 1;
    return round4(coverage * meanRate);
  }
}

/**
 * @param {string|object[]} input JSON Lines 字符串,或已解析的 span 对象数组
 * @param {{windowStart: number, windowEnd: number}} options 时间窗 [start, end),毫秒
 */
export function buildTopology(input, { windowStart, windowEnd } = {}) {
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowStart >= windowEnd) {
    throw new RangeError("windowStart/windowEnd 必须是有限数且 windowStart < windowEnd");
  }

  let parsed;
  let invalid;
  if (typeof input === "string") {
    ({ spans: parsed, invalid } = parseSpans(input));
  } else if (Array.isArray(input)) {
    parsed = [];
    invalid = [];
    input.forEach((raw, index) => {
      const { span, error } = normalizeSpan(raw, index + 1);
      if (error) invalid.push({ line: index + 1, reason: error });
      else parsed.push(span);
    });
  } else {
    throw new TypeError("input 必须是 JSON Lines 字符串或 span 数组");
  }

  // 去重:(traceId, spanId) 首次出现获胜,与上报顺序无关。
  const seen = new Set();
  const spans = [];
  let duplicatesDropped = 0;
  for (const span of parsed) {
    const key = `${span.traceId}${span.spanId}`;
    if (seen.has(key)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(key);
    spans.push(span);
  }

  // 按 trace 归集;窗外 span 也进入索引,仅用于补全父子关系。
  const byTrace = new Map();
  for (const span of spans) {
    let trace = byTrace.get(span.traceId);
    if (!trace) {
      trace = new Map();
      byTrace.set(span.traceId, trace);
    }
    trace.set(span.spanId, span);
  }

  const inWindow = (span) => span.startTime >= windowStart && span.startTime < windowEnd;

  const nodes = new Map(); // service -> aggregate
  const edges = new Map(); // "from to" -> aggregate
  const unassociatedSpans = [];
  let outOfWindowSpans = 0;

  const nodeFor = (service) => {
    let node = nodes.get(service);
    if (!node) {
      node = {
        service,
        clusters: new Set(),
        instances: new Set(),
        callCount: 0,
        sampling: new SamplingAccumulator(),
      };
      nodes.set(service, node);
    }
    return node;
  };

  const edgeFor = (from, to) => {
    const key = `${from} ${to}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = {
        from,
        to,
        callCount: 0,
        crossCluster: false,
        parentMissing: false,
        clusterPairs: new Set(),
        sampling: new SamplingAccumulator(),
      };
      edges.set(key, edge);
    }
    return edge;
  };

  for (const span of spans) {
    if (!inWindow(span)) {
      outOfWindowSpans += 1;
      continue;
    }

    const node = nodeFor(span.service);
    node.clusters.add(span.cluster);
    if (span.instanceId !== null) node.instances.add(span.instanceId);
    node.callCount += 1;
    node.sampling.add(span);

    if (span.parentSpanId === null) continue; // 根 span:只计节点,不产生边

    const trace = byTrace.get(span.traceId);
    const parent = trace ? trace.get(span.parentSpanId) : undefined;

    if (parent) {
      // 父 span 无论在窗内还是窗外,都只用于定位关系;调用次数记在窗内子 span 上。
      const edge = edgeFor(parent.service, span.service);
      edge.callCount += 1;
      edge.sampling.add(span);
      edge.clusterPairs.add(`${parent.cluster}->${span.cluster}`);
      if (parent.cluster !== span.cluster) edge.crossCluster = true;
    } else {
      // 父节点缺失:保留边但降低置信度,子 span 列入未关联清单。
      const edge = edgeFor(UNKNOWN_SERVICE, span.service);
      edge.callCount += 1;
      edge.sampling.add(span);
      edge.parentMissing = true;
      unassociatedSpans.push({
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        service: span.service,
        reason: "missing-parent",
      });
    }
  }

  const nodeList = [...nodes.values()]
    .map((node) => ({
      service: node.service,
      clusters: [...node.clusters].sort(),
      callCount: node.callCount,
      instanceCount: node.instances.size,
      instances: [...node.instances].sort(),
      estimatedCalls: round4(node.sampling.estimatedCalls),
      samplingConfidence: node.sampling.confidence(),
    }))
    .sort((a, b) => a.service.localeCompare(b.service));

  const edgeList = [...edges.values()]
    .map((edge) => {
      let confidence = edge.sampling.confidence();
      if (edge.parentMissing) confidence = round4(confidence * ORPHAN_CONFIDENCE_FACTOR);
      return {
        from: edge.from,
        to: edge.to,
        callCount: edge.callCount,
        estimatedCalls: round4(edge.sampling.estimatedCalls),
        crossCluster: edge.crossCluster,
        parentMissing: edge.parentMissing,
        clusterPairs: [...edge.clusterPairs].sort(),
        samplingConfidence: confidence,
      };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return {
    window: { start: windowStart, end: windowEnd },
    nodes: nodeList,
    edges: edgeList,
    unassociatedSpans,
    stats: {
      spansTotal: parsed.length,
      spansDeduped: spans.length,
      duplicatesDropped,
      outOfWindowSpans,
      invalidRecords: invalid.length,
    },
    invalidRecords: invalid,
  };
}

import type {
  GraphDocument,
  GraphEdge,
  ImpactPath,
  ImpactPathStep,
  PathTraceResult
} from '../shared/graph.js';
import { MAX_PATH_HOPS, TOP_IMPACT_PATHS } from '../shared/graph.js';

/** 枚举安全上限：完整路径达到该条数即停止枚举，防止稠密图上的指数爆炸。 */
const MAX_ENUMERATED_PATHS = 5000;

/**
 * 校验追踪的起点与终点。
 * 图严格校验由 validateGraphDocument 在调用处完成；这里只检查两个节点存在且不相同。
 */
export function validatePathTraceSelection(graph: GraphDocument, sourceNodeId: unknown, targetNodeId: unknown) {
  if (typeof sourceNodeId !== 'string' || !sourceNodeId.trim()) {
    throw new Error('缺少起始节点 sourceNodeId。');
  }
  if (typeof targetNodeId !== 'string' || !targetNodeId.trim()) {
    throw new Error('缺少目标节点 targetNodeId。');
  }
  const source = graph.nodes.find((node) => node.id === sourceNodeId);
  if (!source) throw new Error(`起始节点「${sourceNodeId}」不存在，无法追踪。`);
  const target = graph.nodes.find((node) => node.id === targetNodeId);
  if (!target) throw new Error(`目标节点「${targetNodeId}」不存在，无法追踪。`);
  if (source.id === target.id) throw new Error('起始节点与目标节点不能相同。');
  return { source, target };
}

export function validateMaxHops(value: unknown): number {
  if (value === undefined || value === null || value === '') return MAX_PATH_HOPS;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_PATH_HOPS) {
    throw new Error(`最大跳数必须是 1 到 ${MAX_PATH_HOPS} 之间的整数。`);
  }
  return number;
}

function buildPath(nodeIds: string[], steps: ImpactPathStep[]): ImpactPath {
  const rebutCount = steps.filter((step) => step.stance === 'rebut').length;
  const score = steps.reduce((product, step) => product * step.signedWeight, 1);
  return {
    nodeIds: [...nodeIds],
    steps: steps.map((step) => ({ ...step })),
    hops: steps.length,
    rebutCount,
    score
  };
}

/**
 * 影响路径追踪：深度优先枚举起始节点到目标节点、不超过 maxHops 跳的全部简单有向路径。
 * 下一条边的终点若已在当前路径上（会成环），该分支立即截断；到达目标节点即记录路径并回溯，
 * 不再从目标节点继续延伸。路径影响分数为逐边有符号边权（支持 +w / 反驳 −w）的乘积。
 */
export function traceImpactPaths(
  graph: GraphDocument,
  sourceNodeId: string,
  targetNodeId: string,
  maxHops: number = MAX_PATH_HOPS
): PathTraceResult {
  validatePathTraceSelection(graph, sourceNodeId, targetNodeId);
  const hops = validateMaxHops(maxHops);

  const adjacency = new Map<string, GraphEdge[]>();
  graph.edges.forEach((edge) => {
    const bucket = adjacency.get(edge.source);
    if (bucket) bucket.push(edge);
    else adjacency.set(edge.source, [edge]);
  });

  const allPaths: ImpactPath[] = [];
  let truncatedCount = 0;
  let exhaustive = true;

  const visited = new Set<string>([sourceNodeId]);
  const currentNodes: string[] = [sourceNodeId];
  const currentSteps: ImpactPathStep[] = [];

  const dfs = (nodeId: string): void => {
    for (const edge of adjacency.get(nodeId) ?? []) {
      // 遇到重复节点立即截断该分支，避免绕环无限延伸。
      if (visited.has(edge.target)) {
        truncatedCount += 1;
        continue;
      }
      currentNodes.push(edge.target);
      currentSteps.push({
        edgeId: edge.id,
        sourceId: edge.source,
        targetId: edge.target,
        stance: edge.stance,
        weight: edge.weight,
        signedWeight: edge.stance === 'support' ? edge.weight : -edge.weight
      });

      if (edge.target === targetNodeId) {
        allPaths.push(buildPath(currentNodes, currentSteps));
        if (allPaths.length >= MAX_ENUMERATED_PATHS) exhaustive = false;
      } else if (currentSteps.length < hops) {
        // 达到跳数上限的分支自然停止延伸，不计入“重复节点截断”。
        visited.add(edge.target);
        dfs(edge.target);
        visited.delete(edge.target);
      }

      currentNodes.pop();
      currentSteps.pop();
      if (!exhaustive) return;
    }
  };
  dfs(sourceNodeId);

  const netScore = allPaths.reduce((sum, path) => sum + path.score, 0);
  const netSign = (netScore > 0 ? 1 : netScore < 0 ? -1 : 0) as -1 | 0 | 1;

  // 绝对影响降序；并列时短路径优先，再按边 id 序列保证确定性。
  const ranked = [...allPaths].sort(
    (a, b) =>
      Math.abs(b.score) - Math.abs(a.score) ||
      a.hops - b.hops ||
      a.steps
        .map((step) => step.edgeId)
        .join('|')
        .localeCompare(b.steps.map((step) => step.edgeId).join('|'))
  );
  const paths = ranked.slice(0, TOP_IMPACT_PATHS);

  const labelOf = (id: string) => graph.nodes.find((node) => node.id === id)?.label ?? id;
  const netText = netSign > 0 ? '为正（整体偏向支持）' : netSign < 0 ? '为负（整体偏向反驳）' : '为零（无路径或正负抵消）';
  const truncationNote = truncatedCount > 0 ? `，${truncatedCount} 条分支因遇到重复节点被截断` : '';
  const message =
    allPaths.length === 0
      ? `在 ≤${hops} 跳内未找到从「${labelOf(sourceNodeId)}」到「${labelOf(targetNodeId)}」的有向路径${truncationNote}。`
      : `从「${labelOf(sourceNodeId)}」到「${labelOf(targetNodeId)}」共枚举 ${allPaths.length} 条有向路径（≤${hops} 跳）` +
        `${truncationNote}；净符号${netText}（合计 ${netScore.toFixed(4)}），` +
        `按绝对影响展示前 ${paths.length} 条。` +
        (exhaustive ? '' : `枚举达到安全上限 ${MAX_ENUMERATED_PATHS} 条已提前停止，结果基于已枚举部分。`);

  return {
    sourceNodeId,
    targetNodeId,
    maxHops: hops,
    enumeratedCount: allPaths.length,
    truncatedCount,
    exhaustive,
    netScore,
    netSign,
    paths,
    message
  };
}

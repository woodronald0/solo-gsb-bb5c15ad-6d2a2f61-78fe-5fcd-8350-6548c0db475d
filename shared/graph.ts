export type NodeKind = 'claim' | 'evidence';
export type Stance = 'support' | 'rebut';

export interface Position {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** 初始先验可信度，范围 0..1 */
  initialBelief: number;
  /** 是否在传播中固定为先验值 */
  anchored: boolean;
  position: Position;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  stance: Stance;
  /** 关系强度，范围 0..1 */
  weight: number;
}

export interface GraphDocument {
  version: 1;
  name?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface PropagateOptions {
  /** 收敛阈值：最大信念变化低于此值即收敛 */
  threshold: number;
  /** 最大迭代次数 */
  maxIterations: number;
  /** 传播/学习强度，0..1；1 表示允许强循环效应 */
  lambda: number;
}

export interface PropagationCycle {
  nodeIds: string[];
  edgeIds: string[];
  /** 反驳边数量 */
  rebutCount: number;
  /** 带符号乘积增益；奇数个反驳时为负 */
  signedGain: number;
  /** 该环节点在最近周期内的平均移动幅度 */
  activity: number;
}

export interface PropagateResult {
  converged: boolean;
  oscillating: boolean;
  iterations: number;
  finalBeliefs: Record<string, number>;
  /** 每个节点第 0 轮（先验）到停止轮的可信度轨迹，用于传播回放 */
  traces: Record<string, number[]>;
  maxChange: number;
  detectedPeriod: number | null;
  cycles: PropagationCycle[];
  /** 本次计算实际使用的参数（回放分解中的 λ 以此为准） */
  options: Required<PropagateOptions>;
  message: string;
}

export interface GraphApiResponse {
  graph: GraphDocument;
}

/** 边权敏感性扫描中单个边权取值点的计算状态 */
export type SensitivityPointStatus = 'converged' | 'oscillating' | 'limit';

export interface SensitivityPoint {
  /** 被扫描边在该点使用的权重，取值 0、0.05、…、1 */
  weight: number;
  /** 状态：收敛 / 振荡 / 达到上限未收敛 */
  status: SensitivityPointStatus;
  /** 实际迭代停止轮次 */
  iterations: number;
  /**
   * 目标节点的最终可信度：
   * 收敛点取收敛值；振荡点无稳定终值，恒为 null（无目标值时以 reason 展示原因）；
   * 达到上限未收敛时取最后一轮值，仅作参考。
   */
  targetValue: number | null;
  /** 检测到的振荡周期（仅振荡点可能非空） */
  detectedPeriod: number | null;
  /** 最后一轮的最大节点变化 */
  maxChange: number;
  /** 无目标值时的原因说明（供悬停展示） */
  reason: string;
}

export interface SensitivityThresholdBand {
  /** 首次跨越 0.5 的连续采样区间左端（权重） */
  fromWeight: number;
  /** 连续采样区间右端（权重） */
  toWeight: number;
  /** 区间左端的目标可信度 */
  fromValue: number;
  /** 区间右端的目标可信度 */
  toValue: number;
}

export interface SensitivityResult {
  edgeId: string;
  targetNodeId: string;
  samples: number;
  points: SensitivityPoint[];
  /** 首个由收敛点构成、目标值首次跨过 0.5 的连续采样区间；振荡/未收敛点不参与判断 */
  thresholdBand: SensitivityThresholdBand | null;
  /** 本次扫描实际使用的传播参数 */
  options: Required<PropagateOptions>;
  message: string;
}

export interface SensitivityRequest {
  /** 画布当前图：仅在内存中用于本次扫描，不会被保存或持久化 */
  graph: GraphDocument;
  edgeId: string;
  targetNodeId: string;
  options?: PropagateOptions;
  /** 等距采样点数量（含 0 和 1），默认 21 */
  samples?: number;
}

/** 影响路径追踪允许的最大跳数（边数）上限 */
export const MAX_PATH_HOPS = 8;
/** 影响路径追踪返回的路径条数：按绝对影响降序取前 N 条 */
export const TOP_IMPACT_PATHS = 3;

/** 影响路径中的一条边（按行进顺序） */
export interface ImpactPathStep {
  edgeId: string;
  sourceId: string;
  targetId: string;
  stance: Stance;
  weight: number;
  /** 有符号边权：支持为 +weight，反驳为 −weight */
  signedWeight: number;
}

/** 一条从起始节点到目标节点的简单有向路径及其影响分数 */
export interface ImpactPath {
  /** 路径上的节点 id（含起点与终点，按行进顺序） */
  nodeIds: string[];
  /** 逐边详情，与 nodeIds 的相邻节点对一一对应 */
  steps: ImpactPathStep[];
  /** 跳数（边数），范围 1..MAX_PATH_HOPS */
  hops: number;
  /** 路径上的反驳边数量 */
  rebutCount: number;
  /** 路径影响分数：逐边有符号边权的乘积（反驳边数为奇数时为负） */
  score: number;
}

export interface PathTraceResult {
  sourceNodeId: string;
  targetNodeId: string;
  /** 本次追踪实际使用的最大跳数 */
  maxHops: number;
  /** 枚举到的完整有向路径总数 */
  enumeratedCount: number;
  /** 因下一个节点已在当前路径上（成环）而被立即截断的分支数 */
  truncatedCount: number;
  /** 是否枚举了全部候选路径；达到枚举安全上限提前停止时为 false */
  exhaustive: boolean;
  /** 全部枚举路径影响分数的代数和 */
  netScore: number;
  /** 净符号：netScore 的符号；无路径或正负恰好抵消时为 0 */
  netSign: -1 | 0 | 1;
  /** 按 |score| 降序的前 TOP_IMPACT_PATHS 条路径 */
  paths: ImpactPath[];
  message: string;
}

export interface PathTraceRequest {
  /** 画布当前图：仅在内存中用于本次追踪，不会被保存或持久化 */
  graph: GraphDocument;
  /** 起始节点（通常为证据） */
  sourceNodeId: string;
  /** 目标节点 */
  targetNodeId: string;
  /** 最大跳数，默认 8，范围 1..MAX_PATH_HOPS */
  maxHops?: number;
}

import { Fragment } from 'react';
import type { Edge, Node } from 'reactflow';
import type { ArgumentNodeData } from './ArgumentNode';
import type { RoundDecomposition } from '../replay';
import { SensitivityChart } from './SensitivityChart';
import {
  MAX_PATH_HOPS,
  type GraphDocument,
  type ImpactPath,
  type NodeKind,
  type PathTraceResult,
  type PropagateOptions,
  type PropagateResult,
  type SensitivityResult,
  type Stance
} from '../../../shared/graph';

export interface SelectionState {
  node?: Node<ArgumentNodeData>;
  edge?: Edge;
}

export interface SensitivitySelection {
  edgeId: string;
  targetNodeId: string;
}

export interface PathTraceSelection {
  sourceNodeId: string;
  targetNodeId: string;
  maxHops: number;
}

interface SidePanelProps {
  options: PropagateOptions;
  onOptionsChange: (options: PropagateOptions) => void;
  result: PropagateResult | null;
  selection: SelectionState;
  decomposition: RoundDecomposition | null;
  onUpdateNode: (id: string, patch: Partial<ArgumentNodeData>) => void;
  onUpdateEdge: (id: string, patch: { weight?: number; stance?: Stance }) => void;
  onDeleteSelection: () => void;
  sensitivity: {
    selection: SensitivitySelection;
    onSelectionChange: (patch: Partial<SensitivitySelection>) => void;
    scan: SensitivityResult | null;
    scanning: boolean;
    status: string;
    onRun: () => void;
    onClose: () => void;
    edgeLabel: string;
    targetLabel: string;
  };
  pathTrace: {
    selection: PathTraceSelection;
    onSelectionChange: (patch: Partial<PathTraceSelection>) => void;
    trace: PathTraceResult | null;
    tracing: boolean;
    status: string;
    activePathIndex: number | null;
    onSelectPath: (index: number | null) => void;
    onRun: () => void;
    onClose: () => void;
  };
  nodes: Node<ArgumentNodeData>[];
  edges: Edge[];
}

const optionLabels: Array<{ key: keyof PropagateOptions; label: string; min: number; max: number; step: number }> = [
  { key: 'threshold', label: '收敛阈值', min: 0.0001, max: 0.05, step: 0.0001 },
  { key: 'maxIterations', label: '最大迭代', min: 5, max: 500, step: 5 },
  { key: 'lambda', label: '传播强度 λ', min: 0, max: 1, step: 0.05 }
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

const signed = (value: number, digits = 4) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;

/** 下一轮值的可核对分解：先验 + λ·Σ(入边有符号贡献)，再经 0..1 裁剪。 */
function DecompositionCard({ decomposition }: { decomposition: RoundDecomposition }) {
  const {
    baseRound,
    targetRound,
    isLastTransition,
    anchored,
    prior,
    lambda,
    contributions,
    influenceSum,
    raw,
    clipped,
    clipAmount,
    recorded,
    matches
  } = decomposition;

  return (
    <section className="panel-card decomposition-card">
      <h2>
        下一轮值分解（第 {baseRound} → {targetRound} 轮）
      </h2>
      {isLastTransition && <p className="hint">当前已是停止轮，以下展示最后一次迭代的分解。</p>}

      {anchored ? (
        <div className="decomp-locked">
          <p>
            🔒 该节点已<strong>固定</strong>，第 {targetRound} 轮值由先验锁定为{' '}
            <strong>{prior.toFixed(4)}</strong>。
          </p>
          <p className="hint">固定节点的入边不参与其取值计算，因此不列出任何入边贡献。</p>
        </div>
      ) : (
        <>
          <dl className="decomp-summary">
            <dt>先验 p</dt>
            <dd>{prior.toFixed(4)}</dd>
            <dt>传播强度 λ</dt>
            <dd>{lambda.toFixed(4)}</dd>
          </dl>
          {contributions.length === 0 ? (
            <p className="hint">该节点没有入边，下一轮值等于先验（经 0..1 裁剪）。</p>
          ) : (
            <table className="decomp-table">
              <thead>
                <tr>
                  <th>入边来源</th>
                  <th>贡献 ±w·b</th>
                </tr>
              </thead>
              <tbody>
                {contributions.map((item) => (
                  <tr key={item.edgeId}>
                    <td>
                      <span className={`decomp-stance ${item.stance}`}>
                        {item.stance === 'support' ? '支持' : '反驳'}
                      </span>{' '}
                      {item.sourceLabel}
                      <small>
                        w {item.weight.toFixed(2)} × 第{baseRound}轮 {item.sourceValue.toFixed(4)}
                      </small>
                    </td>
                    <td className={item.signedContribution >= 0 ? 'decomp-pos' : 'decomp-neg'}>
                      {signed(item.signedContribution)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <dl className="decomp-summary">
            <dt>Σ 入边贡献</dt>
            <dd>{signed(influenceSum)}</dd>
            <dt>裁剪前 p + λ·Σ</dt>
            <dd>
              {prior.toFixed(4)} {signed(lambda * influenceSum)} = {raw.toFixed(4)}
            </dd>
            <dt>0..1 裁剪量</dt>
            <dd>
              {clipAmount > 0
                ? `超出上界，裁去 ${clipAmount.toFixed(4)}`
                : clipAmount < 0
                  ? `低于下界，抬升 ${(-clipAmount).toFixed(4)}`
                  : '0（未裁剪）'}
            </dd>
            <dt>第 {targetRound} 轮值</dt>
            <dd>{clipped.toFixed(4)}</dd>
          </dl>
        </>
      )}

      <p className={`decomp-check ${matches ? 'ok' : 'bad'}`}>
        {matches ? '✓' : '✗'} 本地重算 {anchored ? prior.toFixed(6) : clipped.toFixed(6)} 与记录的第 {targetRound}{' '}
        轮值 {recorded.toFixed(6)} {matches ? '一致' : '不一致'}
      </p>
    </section>
  );
}

export function SidePanel({
  options,
  onOptionsChange,
  result,
  selection,
  decomposition,
  onUpdateNode,
  onUpdateEdge,
  onDeleteSelection,
  sensitivity,
  pathTrace,
  nodes,
  edges
}: SidePanelProps) {
  const stanceText = (stance: Stance) => (stance === 'support' ? '支持' : '反驳');
  const nodeLabelById = new Map(nodes.map((node) => [node.id, node.data.label] as const));

  return (
    <aside className="side-panel">
      <section className="panel-card">
        <h2>传播参数</h2>
        {optionLabels.map((item) => (
          <Field key={item.key} label={item.label}>
            <input
              type="number"
              min={item.min}
              max={item.max}
              step={item.step}
              value={options[item.key]}
              onChange={(event) =>
                onOptionsChange({ ...options, [item.key]: Number(event.target.value) })
              }
            />
          </Field>
        ))}
        <p className="hint">同步迭代：先验可信度 + λ·(支持 − 反驳)，结果裁剪到 0–1。</p>
      </section>

      <section className="panel-card">
        <h2>检查器</h2>
        {selection.node && (
          <div className="inspector">
            <Field label="标签">
              <input
                value={selection.node.data.label}
                onChange={(event) => onUpdateNode(selection.node!.id, { label: event.target.value })}
              />
            </Field>
            <Field label="类型">
              <select
                value={selection.node.data.kind}
                onChange={(event) =>
                  onUpdateNode(selection.node!.id, { kind: event.target.value as NodeKind })
                }
              >
                <option value="claim">观点 claim</option>
                <option value="evidence">证据 evidence</option>
              </select>
            </Field>
            <Field label={`初始可信度：${Math.round(selection.node.data.initialBelief * 100)}%`}>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={selection.node.data.initialBelief}
                onChange={(event) =>
                  onUpdateNode(selection.node!.id, { initialBelief: Number(event.target.value) })
                }
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={selection.node.data.anchored}
                onChange={(event) =>
                  onUpdateNode(selection.node!.id, { anchored: event.target.checked })
                }
              />
              固定为初始可信度
            </label>
            <button className="danger" onClick={onDeleteSelection}>
              删除节点
            </button>
          </div>
        )}

        {!selection.node && selection.edge && (
          <div className="inspector">
            <Field label="关系">
              <select
                value={(selection.edge.data?.stance as Stance) ?? 'support'}
                onChange={(event) =>
                  onUpdateEdge(selection.edge!.id, { stance: event.target.value as Stance })
                }
              >
                <option value="support">支持 support</option>
                <option value="rebut">反驳 rebut</option>
              </select>
            </Field>
            <Field label={`权重：${Math.round(Number(selection.edge.data?.weight ?? 0.6) * 100)}%`}>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={Number(selection.edge.data?.weight ?? 0.6)}
                onChange={(event) =>
                  onUpdateEdge(selection.edge!.id, { weight: Number(event.target.value) })
                }
              />
            </Field>
            <button className="danger" onClick={onDeleteSelection}>
              删除连线
            </button>
          </div>
        )}

        {!selection.node && !selection.edge && (
          <p className="hint">点击节点或连线进行编辑；从节点右侧圆点拖出即可连线。</p>
        )}
      </section>

      <SensitivityCard
        sensitivity={sensitivity}
        nodes={nodes}
        edges={edges}
        nodeLabelById={nodeLabelById}
        stanceText={stanceText}
      />

      <PathTraceCard pathTrace={pathTrace} nodes={nodes} nodeLabelById={nodeLabelById} stanceText={stanceText} />

      {decomposition && selection.node && <DecompositionCard decomposition={decomposition} />}

      {result && (
        <section className={`panel-card result-card ${result.oscillating ? 'bad' : result.converged ? 'good' : 'warn'}`}>
          <h2>传播结果</h2>
          <p>{result.message}</p>
          <dl>
            <dt>迭代轮数</dt>
            <dd>{result.iterations}</dd>
            <dt>最终最大变化</dt>
            <dd>{result.maxChange.toFixed(5)}</dd>
            <dt>检测周期</dt>
            <dd>{result.detectedPeriod ?? '—'}</dd>
          </dl>
          {result.oscillating && (
            <div className="cycle-list">
              <strong>高亮的负反馈环（{result.cycles.length}）</strong>
              {result.cycles.length === 0 && <p className="hint">未枚举到满足强度阈值的奇数反驳环，但系统仍未稳定。</p>}
              {result.cycles.slice(0, 6).map((cycle, index) => (
                <div className="cycle-item" key={cycle.edgeIds.join('-')}>
                  <span>#{index + 1} 环：{cycle.nodeIds.join(' → ')} → {cycle.nodeIds[0]}</span>
                  <small>
                    {cycle.rebutCount} 条反驳 · |增益| {Math.abs(cycle.signedGain).toFixed(2)} · 活跃度{' '}
                    {cycle.activity.toFixed(3)}
                  </small>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </aside>
  );
}

type SensitivityCardProps = Pick<SidePanelProps, 'sensitivity' | 'nodes' | 'edges'> & {
  nodeLabelById: Map<string, string>;
  stanceText: (stance: Stance) => string;
};

/** 边权敏感性扫描卡片：选择一条连线与一个目标节点后运行 0→1 的 21 点等距扫描。 */
function SensitivityCard({ sensitivity, nodes, edges, nodeLabelById, stanceText }: SensitivityCardProps) {
  const { selection: scanSelection, onSelectionChange, scan, scanning, status, onRun, onClose } = sensitivity;
  const selectedEdge = edges.find((edge) => edge.id === scanSelection.edgeId);
  const canRun = Boolean(selectedEdge) && nodes.some((node) => node.id === scanSelection.targetNodeId);

  const edgeLabel = (edge: Edge) => {
    const stance = (edge.data?.stance as Stance) ?? 'support';
    const weight = Math.round(Number(edge.data?.weight ?? 0.6) * 100);
    return `${nodeLabelById.get(edge.source) ?? edge.source} ${stanceText(stance)}→ ${
      nodeLabelById.get(edge.target) ?? edge.target
    }（${weight}%）`;
  };

  return (
    <section className="panel-card sensitivity-card">
      <div className="sensitivity-heading">
        <h2>边权敏感性扫描</h2>
        {scan && (
          <button type="button" className="sensitivity-close" onClick={onClose} title="关闭扫描结果">
            ✕
          </button>
        )}
      </div>

      {nodes.length === 0 || edges.length === 0 ? (
        <p className="hint">先创建节点与至少一条连线，才能扫描边权对目标可信度的影响。</p>
      ) : (
        <>
          <Field label="扫描连线（边权 0→1 等距 21 点）">
            <select
              value={scanSelection.edgeId}
              onChange={(event) => onSelectionChange({ edgeId: event.target.value })}
            >
              {!selectedEdge && <option value="">请选择连线…</option>}
              {edges.map((edge) => (
                <option key={edge.id} value={edge.id}>
                  {edgeLabel(edge)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="目标节点（曲线展示其最终可信度）">
            <select
              value={scanSelection.targetNodeId}
              onChange={(event) => onSelectionChange({ targetNodeId: event.target.value })}
            >
              {!nodes.some((node) => node.id === scanSelection.targetNodeId) && (
                <option value="">请选择目标节点…</option>
              )}
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.data.label}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="primary sensitivity-run" disabled={!canRun || scanning} onClick={onRun}>
            {scanning ? '扫描中…' : '运行边权扫描'}
          </button>
          <p className="hint">扫描使用上方当前传播参数，只在服务端内存中计算，不会保存或改动当前图。</p>
          {status && <p className="sensitivity-status">{status}</p>}
        </>
      )}

      {scan && (
        <>
          <SensitivityChart
            scan={scan}
            edgeLabel={sensitivity.edgeLabel}
            targetLabel={sensitivity.targetLabel}
          />
          <p className="hint">{scan.message}</p>
        </>
      )}
    </section>
  );
}

type PathTraceCardProps = Pick<SidePanelProps, 'pathTrace' | 'nodes'> & {
  nodeLabelById: Map<string, string>;
  stanceText: (stance: Stance) => string;
};

/** 影响路径追踪卡片：选择起始证据与目标节点，枚举 ≤8 跳的有向路径并展示绝对影响最大的前 3 条。 */
function PathTraceCard({ pathTrace, nodes, nodeLabelById, stanceText }: PathTraceCardProps) {
  const {
    selection,
    onSelectionChange,
    trace,
    tracing,
    status,
    activePathIndex,
    onSelectPath,
    onRun,
    onClose
  } = pathTrace;
  const sourceExists = nodes.some((node) => node.id === selection.sourceNodeId);
  const targetExists = nodes.some((node) => node.id === selection.targetNodeId);
  const canRun = sourceExists && targetExists && selection.sourceNodeId !== selection.targetNodeId;

  // 证据节点排在前面，便于选择“起始证据”。
  const orderedNodes = [...nodes].sort(
    (a, b) => (a.data.kind === 'evidence' ? 0 : 1) - (b.data.kind === 'evidence' ? 0 : 1)
  );
  const nodeOption = (node: Node<ArgumentNodeData>) => (
    <option key={node.id} value={node.id}>
      {`【${node.data.kind === 'evidence' ? '证据' : '观点'}】${node.data.label}`}
    </option>
  );

  const netSignText =
    trace === null
      ? ''
      : trace.netSign > 0
        ? '正（整体偏向支持）'
        : trace.netSign < 0
          ? '负（整体偏向反驳）'
          : '零（无路径或正负抵消）';

  return (
    <section className="panel-card path-card">
      <div className="sensitivity-heading">
        <h2>影响路径追踪</h2>
        {trace && (
          <button type="button" className="sensitivity-close" onClick={onClose} title="关闭追踪结果">
            ✕
          </button>
        )}
      </div>

      {nodes.length < 2 ? (
        <p className="hint">先创建至少两个节点并用连线连接，才能追踪起始证据到目标节点的影响路径。</p>
      ) : (
        <>
          <Field label="起始证据（路径起点）">
            <select
              value={selection.sourceNodeId}
              onChange={(event) => onSelectionChange({ sourceNodeId: event.target.value })}
            >
              {!sourceExists && <option value="">请选择起始节点…</option>}
              {orderedNodes.map(nodeOption)}
            </select>
          </Field>
          <Field label="目标节点">
            <select
              value={selection.targetNodeId}
              onChange={(event) => onSelectionChange({ targetNodeId: event.target.value })}
            >
              {!targetExists && <option value="">请选择目标节点…</option>}
              {orderedNodes.map(nodeOption)}
            </select>
          </Field>
          <Field label={`最大跳数（1–${MAX_PATH_HOPS}）`}>
            <input
              type="number"
              min={1}
              max={MAX_PATH_HOPS}
              step={1}
              value={selection.maxHops}
              onChange={(event) => onSelectionChange({ maxHops: Number(event.target.value) })}
            />
          </Field>
          <button type="button" className="primary sensitivity-run" disabled={!canRun || tracing} onClick={onRun}>
            {tracing ? '追踪中…' : '追踪影响路径'}
          </button>
          <p className="hint">
            枚举起点到目标、最多 {MAX_PATH_HOPS} 跳的有向路径；路径分数为逐边有符号边权（支持 +w / 反驳
            −w）的乘积，遇重复节点立即截断以避免环。只在服务端内存中计算，不会保存图。
          </p>
          {status && <p className="sensitivity-status">{status}</p>}
        </>
      )}

      {trace && (
        <div className="path-results">
          <dl className="decomp-summary path-summary">
            <dt>枚举路径</dt>
            <dd>
              {trace.enumeratedCount} 条{trace.exhaustive ? '' : '（已达上限）'}
            </dd>
            <dt>截断分支</dt>
            <dd>{trace.truncatedCount}</dd>
            <dt>净符号</dt>
            <dd className={trace.netSign > 0 ? 'decomp-pos' : trace.netSign < 0 ? 'decomp-neg' : ''}>
              {netSignText}（{signed(trace.netScore)}）
            </dd>
          </dl>

          {trace.paths.length > 0 && (
            <ol className="path-list">
              {trace.paths.map((path, index) => (
                <li key={path.steps.map((step) => step.edgeId).join('|')}>
                  <button
                    type="button"
                    className={`path-item ${index === activePathIndex ? 'active' : ''}`}
                    onClick={() => onSelectPath(index === activePathIndex ? null : index)}
                    title={index === activePathIndex ? '再次点击取消画布高亮' : '点击在画布上高亮该路径'}
                  >
                    <span className="path-item-head">
                      <strong>#{index + 1}</strong>
                      <span className={path.score >= 0 ? 'decomp-pos' : 'decomp-neg'}>{signed(path.score)}</span>
                      <small>
                        {path.hops} 跳 · {path.rebutCount} 条反驳
                      </small>
                    </span>
                    <PathChain path={path} nodeLabelById={nodeLabelById} stanceText={stanceText} />
                  </button>
                </li>
              ))}
            </ol>
          )}

          <p className="hint">{trace.message}</p>
          {trace.paths.length > 0 && activePathIndex !== null && (
            <button type="button" className="path-clear" onClick={() => onSelectPath(null)}>
              取消画布高亮
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** 单条路径的节点链：依次列出节点标签与逐边关系（支持/反驳 + 权重）。 */
function PathChain({
  path,
  nodeLabelById,
  stanceText
}: {
  path: ImpactPath;
  nodeLabelById: Map<string, string>;
  stanceText: (stance: Stance) => string;
}) {
  const labelOf = (id: string) => nodeLabelById.get(id) ?? id;
  return (
    <span className="path-chain">
      {path.steps.map((step, stepIndex) => (
        <Fragment key={step.edgeId}>
          {stepIndex === 0 && <span className="path-node">{labelOf(step.sourceId)}</span>}
          <span className={`path-step ${step.stance}`}>
            {stanceText(step.stance)} {Math.round(step.weight * 100)}% →
          </span>
          <span className="path-node">{labelOf(step.targetId)}</span>
        </Fragment>
      ))}
    </span>
  );
}

export function graphToDocument(name: string, nodes: Node<ArgumentNodeData>[], edges: Edge[]): GraphDocument {  return {
    version: 1,
    name,
    nodes: nodes.map((node) => ({
      id: node.id,
      label: node.data.label,
      kind: node.data.kind,
      initialBelief: node.data.initialBelief,
      anchored: node.data.anchored,
      position: { x: node.position.x, y: node.position.y }
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      stance: (edge.data?.stance as Stance) ?? 'support',
      weight: Number(edge.data?.weight ?? 0.6)
    }))
  };
}

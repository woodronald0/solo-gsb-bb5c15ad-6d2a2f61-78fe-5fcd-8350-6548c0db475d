import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  useEdgesState,
  useNodesState,
  MarkerType,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler
} from 'reactflow';
import 'reactflow/dist/style.css';
import { api } from './api';
import { ArgumentNode, nodeTypes, type ArgumentNodeData } from './components/ArgumentNode';
import { SidePanel, graphToDocument, type PathTraceSelection, type SensitivitySelection } from './components/SidePanel';
import { ReplayBar } from './components/ReplayBar';
import { buildRoundDecomposition } from './replay';
import {
  MAX_PATH_HOPS,
  type GraphDocument,
  type GraphNode,
  type GraphEdge,
  type PathTraceResult,
  type PropagateOptions,
  type PropagateResult,
  type SensitivityResult,
  type Stance
} from '../../shared/graph';
import { stableSample, oscillatingSample } from './samples';

const DEFAULT_OPTIONS: PropagateOptions = { threshold: 0.001, maxIterations: 200, lambda: 0.8 };

const documentToFlow = (graph: GraphDocument): { nodes: Node<ArgumentNodeData>[]; edges: Edge[] } => ({
  nodes: graph.nodes.map((node) => ({
    id: node.id,
    type: 'argument',
    position: node.position,
    data: {
      label: node.label,
      kind: node.kind,
      initialBelief: node.initialBelief,
      anchored: node.anchored
    }
  })),
  edges: graph.edges.map((edge) => makeEdge(edge))
});

function makeEdge(edge: GraphEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: `${edge.stance === 'support' ? '支持' : '反驳'} ${Math.round(edge.weight * 100)}%`,
    animated: false,
    data: { stance: edge.stance, weight: edge.weight },
    className: `stance-${edge.stance}`,
    markerEnd: { type: MarkerType.ArrowClosed }
  };
}

function decorateEdge(edge: Edge, highlight: { cycle?: boolean; path?: boolean } = {}): Edge {
  const stance = (edge.data?.stance as Stance) ?? 'support';
  const weight = Number(edge.data?.weight ?? 0.6);
  const classNames = [`stance-${stance}`];
  if (highlight.cycle) classNames.push('cycle-edge');
  if (highlight.path) classNames.push('path-edge');
  const active = Boolean(highlight.cycle || highlight.path);
  return {
    ...edge,
    label: `${stance === 'support' ? '支持' : '反驳'} ${Math.round(weight * 100)}%`,
    className: classNames.join(' '),
    animated: active,
    style: active ? { strokeWidth: 4 } : undefined,
    markerEnd: { type: MarkerType.ArrowClosed }
  };
}

let localCounter = 0;
const createId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(localCounter += 1)}`;

/** 用第 round 轮的轨迹值刷新节点显示（纯视图更新，不保存、不重新计算）。 */
function decorateNodesForRound(
  current: Node<ArgumentNodeData>[],
  result: PropagateResult,
  round: number,
  cycleNodeIds: Set<string>
): Node<ArgumentNodeData>[] {
  return current.map((node) => {
    const trace = result.traces[node.id];
    if (!trace || trace.length === 0) {
      return { ...node, data: { ...node.data, displayBelief: undefined, roundDelta: undefined, inCycle: false } };
    }
    const clamped = Math.max(0, Math.min(round, trace.length - 1));
    const value = trace[clamped];
    return {
      ...node,
      data: {
        ...node.data,
        displayBelief: value,
        roundDelta: clamped > 0 ? value - trace[clamped - 1] : undefined,
        inCycle: cycleNodeIds.has(node.id)
      }
    };
  });
}

export default function App() {
  const [documentName, setDocumentName] = useState('我的论证图');
  const [nodes, setNodes, onNodesChange] = useNodesState<ArgumentNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [options, setOptions] = useState<PropagateOptions>(DEFAULT_OPTIONS);
  const [result, setResult] = useState<PropagateResult | null>(null);
  const [replayRound, setReplayRound] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [status, setStatus] = useState('正在加载…');
  const [busy, setBusy] = useState(false);
  const [sensitivitySelection, setSensitivitySelection] = useState<SensitivitySelection>({
    edgeId: '',
    targetNodeId: ''
  });
  const [sensitivityResult, setSensitivityResult] = useState<SensitivityResult | null>(null);
  const [sensitivityScanning, setSensitivityScanning] = useState(false);
  const [sensitivityStatus, setSensitivityStatus] = useState('');
  const [pathSelection, setPathSelection] = useState<PathTraceSelection>({
    sourceNodeId: '',
    targetNodeId: '',
    maxHops: MAX_PATH_HOPS
  });
  const [pathTrace, setPathTrace] = useState<PathTraceResult | null>(null);
  const [pathTracing, setPathTracing] = useState(false);
  const [pathStatus, setPathStatus] = useState('');
  const [activePathIndex, setActivePathIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  const scheduleSave = useCallback(
    (nextNodes = nodes, nextEdges = edges, immediate = false) => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      const run = () => {
        setStatus('正在保存…');
        api
          .saveGraph(graphToDocument(documentName, nextNodes, nextEdges))
          .then(() => setStatus('已自动保存到 SQLite'))
          .catch((error: Error) => setStatus(`保存失败：${error.message}`));
      };
      if (immediate) run();
      else saveTimerRef.current = window.setTimeout(run, 700);
    },
    [documentName, edges, nodes]
  );

  useEffect(() => {
    api
      .getGraph()
      .then(({ graph }) => {
        const flow = documentToFlow(graph);
        setNodes(flow.nodes);
        setEdges(flow.edges);
        setDocumentName(graph.name ?? '我的论证图');
        setStatus('已从 SQLite 载入');
      })
      .catch((error: Error) => setStatus(`加载失败：${error.message}`));
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
    // 仅在启动时加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 图的任何增删改动都会使上一次扫描结果失效（扫描图与当前画布不再一致）。
  const invalidateSensitivity = useCallback(() => {
    setSensitivityResult(null);
    setSensitivityStatus('');
  }, []);

  // 图或传播参数的编辑都会使上一次路径追踪结果失效（追踪图与当前画布不再一致）。
  const invalidatePathTrace = useCallback(() => {
    setPathTrace(null);
    setActivePathIndex(null);
    setPathStatus('');
  }, []);

  const clearAnalysis = useCallback(
    (nextNodes = nodes, nextEdges = edges) => {
      setResult(null);
      setReplayRound(0);
      setPlaying(false);
      invalidateSensitivity();
      invalidatePathTrace();
      setNodes(
        nextNodes.map((node) => ({
          ...node,
          data: { ...node.data, displayBelief: undefined, roundDelta: undefined, inCycle: false, inPath: false }
        }))
      );
      setEdges(nextEdges.map((edge) => decorateEdge({ ...edge, animated: false, style: undefined })));
    },
    [edges, nodes, setEdges, setNodes, invalidateSensitivity, invalidatePathTrace]
  );

  const activePath = pathTrace && activePathIndex !== null ? (pathTrace.paths[activePathIndex] ?? null) : null;
  const cycleEdgeIds = useMemo(() => new Set((result?.cycles ?? []).flatMap((cycle) => cycle.edgeIds)), [result]);
  const activePathEdgeIds = useMemo(
    () => new Set((activePath?.steps ?? []).map((step) => step.edgeId)),
    [activePath]
  );
  const activePathNodeIds = useMemo(() => new Set(activePath?.nodeIds ?? []), [activePath]);

  // 统一应用画布高亮：负反馈环（红）与选中的影响路径（蓝）可叠加。
  useEffect(() => {
    setEdges((current) =>
      current.map((edge) =>
        decorateEdge(edge, { cycle: cycleEdgeIds.has(edge.id), path: activePathEdgeIds.has(edge.id) })
      )
    );
    setNodes((current) =>
      current.map((node) => {
        const inPath = activePathNodeIds.has(node.id);
        return Boolean(node.data.inPath) === inPath ? node : { ...node, data: { ...node.data, inPath } };
      })
    );
  }, [cycleEdgeIds, activePathEdgeIds, activePathNodeIds, setEdges, setNodes]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const edge = makeEdge({
        id: createId('edge'),
        source: connection.source,
        target: connection.target,
        stance: 'support',
        weight: 0.6
      });
      const nextEdges = [...edges, edge];
      clearAnalysis(nodes, nextEdges);
      scheduleSave(nodes, nextEdges, true);
    },
    [clearAnalysis, edges, nodes, scheduleSave, setEdges]
  );

  const onNodeDragStop: NodeMouseHandler = useCallback(
    (_event, node) => {
      // 位置变化不清除计算结果，但需要持久化布局。
      const nextNodes = nodes.map((item) => (item.id === node.id ? node : item));
      scheduleSave(nextNodes, edges);
    },
    [edges, nodes, scheduleSave]
  );

  const addNode = (kind: 'claim' | 'evidence') => {
    const id = createId(kind);
    const node: Node<ArgumentNodeData> = {
      id,
      type: 'argument',
      position: { x: 120 + Math.random() * 220, y: 90 + Math.random() * 260 },
      data: {
        label: kind === 'evidence' ? `证据 ${nodes.length + 1}` : `观点 ${nodes.length + 1}`,
        kind,
        initialBelief: kind === 'evidence' ? 0.8 : 0.5,
        anchored: false
      }
    };
    const nextNodes = [...nodes, node];
    clearAnalysis(nextNodes, edges);
    scheduleSave(nextNodes, edges, true);
  };

  const updateNode = (id: string, patch: Partial<ArgumentNodeData>) => {
    const nextNodes = nodes.map((node) =>
      node.id === id ? { ...node, data: { ...node.data, ...patch } } : node
    );
    clearAnalysis(nextNodes, edges);
    scheduleSave(nextNodes, edges);
  };

  const updateEdge = (id: string, patch: { weight?: number; stance?: Stance }) => {
    const nextEdges = edges.map((edge) =>
      edge.id === id ? decorateEdge({ ...edge, data: { ...edge.data, ...patch } }) : edge
    );
    clearAnalysis(nodes, nextEdges);
    scheduleSave(nodes, nextEdges);
  };

  const deleteSelection = useCallback(() => {
    let nextNodes = nodes;
    let nextEdges = edges;
    if (selectedNodeId) {
      nextNodes = nodes.filter((node) => node.id !== selectedNodeId);
      nextEdges = edges.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId);
      setSelectedNodeId(null);
    } else if (selectedEdgeId) {
      nextEdges = edges.filter((edge) => edge.id !== selectedEdgeId);
      setSelectedEdgeId(null);
    } else {
      return;
    }
    clearAnalysis(nextNodes, nextEdges);
    scheduleSave(nextNodes, nextEdges, true);
  }, [
    clearAnalysis,
    edges,
    nodes,
    scheduleSave,
    selectedEdgeId,
    selectedNodeId,
    setEdges,
    setNodes
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Delete' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        deleteSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelection]);

  const runPropagation = async () => {
    setBusy(true);
    setStatus('正在迭代传播…');
    try {
      // 先保存，确保后端计算的是当前画布。
      await api.saveGraph(graphToDocument(documentName, nodes, edges));
      const { result: nextResult } = await api.propagate(options);
      const cycleNodeIds = new Set(nextResult.cycles.flatMap((cycle) => cycle.nodeIds));
      setResult(nextResult);
      setPlaying(false);
      setReplayRound(nextResult.iterations);
      setNodes((current) => decorateNodesForRound(current, nextResult, nextResult.iterations, cycleNodeIds));
      // 环边高亮由监听 result 的效果统一应用（与路径高亮叠加）。
      setStatus(nextResult.message);
    } catch (error) {
      setStatus(`计算失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  // 回放只切换展示的轮次：不修改图、不保存、不重新计算。
  const goToRound = useCallback(
    (round: number) => {
      if (!result) return;
      const clamped = Math.max(0, Math.min(result.iterations, Math.round(round)));
      setReplayRound(clamped);
      const cycleNodeIds = new Set(result.cycles.flatMap((cycle) => cycle.nodeIds));
      setNodes((current) => decorateNodesForRound(current, result, clamped, cycleNodeIds));
    },
    [result, setNodes]
  );

  // 播放：收敛结果播到停止轮即停；振荡结果在最后一个周期内循环。
  useEffect(() => {
    if (!playing || !result) return;
    const loopable = Boolean(result.oscillating && result.detectedPeriod);
    if (replayRound >= result.iterations && !loopable) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      if (replayRound >= result.iterations && loopable) {
        goToRound(Math.max(0, result.iterations - (result.detectedPeriod ?? 1) + 1));
      } else {
        goToRound(replayRound + 1);
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [playing, replayRound, result, goToRound]);

  const togglePlay = () => {
    if (!result) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    // 收敛结果停在末轮时再按播放，从第 0 轮重新播放。
    const loopable = Boolean(result.oscillating && result.detectedPeriod);
    if (replayRound >= result.iterations && !loopable) goToRound(0);
    setPlaying(true);
  };

  const loadDocument = (graph: GraphDocument, immediateSave = true, nextOptions?: PropagateOptions) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    const flow = documentToFlow(graph);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setDocumentName(graph.name ?? '导入的论证图');
    setResult(null);
    setReplayRound(0);
    setPlaying(false);
    invalidateSensitivity();
    invalidatePathTrace();
    setSensitivitySelection({ edgeId: '', targetNodeId: '' });
    setPathSelection({ sourceNodeId: '', targetNodeId: '', maxHops: MAX_PATH_HOPS });
    if (nextOptions) setOptions(nextOptions);
    if (immediateSave) {
      setStatus('正在导入…');
      api
        .saveGraph(graph)
        .then(() => setStatus('JSON 已导入并保存'))
        .catch((error: Error) => setStatus(`导入失败：${error.message}`));
    }
  };

  const exportJson = () => {
    const graphDocument = graphToDocument(documentName, nodes, edges);
    const blob = new Blob([JSON.stringify(graphDocument, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${documentName || 'argument-graph'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importJsonFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as GraphDocument | { graph: GraphDocument };
      const graph = 'graph' in parsed ? parsed.graph : parsed;
      // 后端执行严格校验并返回规范化文档。
      const saved = await api.saveGraph(graph);
      loadDocument(saved.graph, false);
      setStatus('JSON 已导入并保存');
    } catch (error) {
      setStatus(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId]
  );
  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId),
    [edges, selectedEdgeId]
  );

  // 被扫描的边或目标节点删除后，清掉失效选择；不自动重选，避免跑出用户意料之外的扫描。
  useEffect(() => {
    setSensitivitySelection((current) => {
      const edgeExists = !current.edgeId || edges.some((edge) => edge.id === current.edgeId);
      const nodeExists = !current.targetNodeId || nodes.some((node) => node.id === current.targetNodeId);
      if (edgeExists && nodeExists) return current;
      return {
        edgeId: edgeExists ? current.edgeId : '',
        targetNodeId: nodeExists ? current.targetNodeId : ''
      };
    });
  }, [edges, nodes]);

  // 选中一条连线后，默认把扫描目标填为该连线的目标节点，减少一次手动选择。
  useEffect(() => {
    if (!selectedEdge) return;
    setSensitivitySelection((current) => ({
      edgeId: selectedEdge.id,
      targetNodeId: current.targetNodeId || selectedEdge.target
    }));
  }, [selectedEdge]);

  const runSensitivityScan = useCallback(async () => {
    if (!sensitivitySelection.edgeId || !sensitivitySelection.targetNodeId) return;
    setSensitivityScanning(true);
    setSensitivityStatus('正在服务端内存中逐点计算（不保存图）…');
    try {
      // 直接提交当前画布：扫描只在服务端内存中进行，不触发任何持久化。
      const { scan } = await api.scanEdgeWeight({
        graph: graphToDocument(documentName, nodes, edges),
        edgeId: sensitivitySelection.edgeId,
        targetNodeId: sensitivitySelection.targetNodeId,
        options
      });
      setSensitivityResult(scan);
      setSensitivityStatus(scan.message);
    } catch (error) {
      setSensitivityResult(null);
      setSensitivityStatus(`扫描失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSensitivityScanning(false);
    }
  }, [documentName, edges, nodes, options, sensitivitySelection.edgeId, sensitivitySelection.targetNodeId]);

  const runPathTrace = async () => {
    if (!pathSelection.sourceNodeId || !pathSelection.targetNodeId) return;
    setPathTracing(true);
    setPathStatus('正在服务端内存中枚举有向路径（不保存图）…');
    try {
      // 直接提交当前画布：追踪只在服务端内存中进行，不触发任何持久化。
      const { trace } = await api.tracePaths({
        graph: graphToDocument(documentName, nodes, edges),
        sourceNodeId: pathSelection.sourceNodeId,
        targetNodeId: pathSelection.targetNodeId,
        maxHops: pathSelection.maxHops
      });
      setPathTrace(trace);
      // 默认高亮绝对影响最大的路径。
      setActivePathIndex(trace.paths.length > 0 ? 0 : null);
      setPathStatus(trace.message);
    } catch (error) {
      setPathTrace(null);
      setActivePathIndex(null);
      setPathStatus(`追踪失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPathTracing(false);
    }
  };

  const sensitivityEdgeLabel = useMemo(() => {
    const edge = edges.find((item) => item.id === sensitivitySelection.edgeId);
    if (!edge) return '所选连线';
    const labelById = new Map(nodes.map((node) => [node.id, node.data.label] as const));
    return `${labelById.get(edge.source) ?? edge.source} → ${labelById.get(edge.target) ?? edge.target}`;
  }, [edges, nodes, sensitivitySelection.edgeId]);

  const sensitivityTargetLabel = useMemo(
    () => nodes.find((node) => node.id === sensitivitySelection.targetNodeId)?.data.label ?? '目标节点',
    [nodes, sensitivitySelection.targetNodeId]
  );

  // 选中节点时，本地重算「当前轮 → 下一轮」的可核对分解。
  const decomposition = useMemo(() => {
    if (!result || !selectedNode) return null;
    return buildRoundDecomposition(selectedNode, nodes, edges, result, replayRound);
  }, [result, selectedNode, nodes, edges, replayRound]);

  const handleOptionsChange = useCallback(
    (nextOptions: PropagateOptions) => {
      setOptions(nextOptions);
      // 扫描与路径追踪沿用当前传播参数：参数一变，旧曲线与旧路径就过期了。
      invalidateSensitivity();
      invalidatePathTrace();
    },
    [invalidateSensitivity, invalidatePathTrace]
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>论证稳定性沙盘</h1>
          <input
            className="document-name"
            value={documentName}
            onChange={(event) => setDocumentName(event.target.value)}
            onBlur={() => scheduleSave(nodes, edges, true)}
          />
        </div>
        <div className="toolbar">
          <button onClick={() => addNode('claim')}>＋ 观点</button>
          <button onClick={() => addNode('evidence')}>＋ 证据</button>
          <button className="primary" disabled={busy || nodes.length === 0} onClick={runPropagation}>
            {busy ? '计算中…' : '运行稳定性分析'}
          </button>
          <button onClick={() => loadDocument(stableSample, true, DEFAULT_OPTIONS)}>载入稳定示例</button>
          <button onClick={() => loadDocument(oscillatingSample, true, { ...DEFAULT_OPTIONS, lambda: 1 })}>
            载入振荡示例
          </button>
          <button onClick={exportJson} disabled={nodes.length === 0}>
            导出 JSON
          </button>
          <button onClick={() => fileInputRef.current?.click()}>导入 JSON</button>
          <input
            ref={fileInputRef}
            hidden
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importJsonFile(file);
              event.target.value = '';
            }}
          />
        </div>
      </header>

      <main className="workspace">
        <div className="canvas-wrap">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={(_event, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(_event, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            onNodesDelete={(deleted) => {
              if (deleted.some((node) => node.id === selectedNodeId)) setSelectedNodeId(null);
            }}
            onEdgesDelete={(deleted) => {
              if (deleted.some((edge) => edge.id === selectedEdgeId)) setSelectedEdgeId(null);
            }}
            fitView
            deleteKeyCode={null}
            connectionLineStyle={{ stroke: '#2563eb' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#c7d2fe" />
            <Controls />
          </ReactFlow>
          <div className="canvas-footer">
            {result ? (
              <ReplayBar
                result={result}
                round={replayRound}
                playing={playing}
                onSeek={goToRound}
                onTogglePlay={togglePlay}
              />
            ) : (
              <span className="canvas-footer-spacer" />
            )}
            <div className={`status-pill ${result?.oscillating ? 'bad' : result?.converged ? 'good' : ''}`}>
              {status}
            </div>
          </div>
        </div>

        <SidePanel
          options={options}
          onOptionsChange={handleOptionsChange}
          result={result}
          selection={{ node: selectedNode, edge: selectedEdge }}
          decomposition={decomposition}
          onUpdateNode={updateNode}
          onUpdateEdge={updateEdge}
          onDeleteSelection={deleteSelection}
          nodes={nodes}
          edges={edges}
          sensitivity={{
            selection: sensitivitySelection,
            onSelectionChange: (patch) =>
              setSensitivitySelection((current) => ({ ...current, ...patch })),
            scan: sensitivityResult,
            scanning: sensitivityScanning,
            status: sensitivityStatus,
            onRun: runSensitivityScan,
            onClose: () => setSensitivityResult(null),
            edgeLabel: sensitivityEdgeLabel,
            targetLabel: sensitivityTargetLabel
          }}
          pathTrace={{
            selection: pathSelection,
            onSelectionChange: (patch) => setPathSelection((current) => ({ ...current, ...patch })),
            trace: pathTrace,
            tracing: pathTracing,
            status: pathStatus,
            activePathIndex,
            onSelectPath: setActivePathIndex,
            onRun: runPathTrace,
            onClose: invalidatePathTrace
          }}
        />
      </main>
    </div>
  );
}

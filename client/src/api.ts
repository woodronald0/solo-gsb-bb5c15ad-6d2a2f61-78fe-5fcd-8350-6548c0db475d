import type {
  GraphDocument,
  PropagateOptions,
  PropagateResult,
  SensitivityResult
} from '../../shared/graph';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `请求失败：${response.status}`);
  return payload as T;
}

export const api = {
  getGraph: () => request<{ graph: GraphDocument }>('/api/graph'),
  saveGraph: (graph: GraphDocument) => request<{ graph: GraphDocument }>('/api/graph', {
    method: 'PUT',
    body: JSON.stringify(graph)
  }),
  propagate: (options: PropagateOptions) =>
    request<{ result: PropagateResult }>('/api/propagate', {
      method: 'POST',
      body: JSON.stringify({ options })
    }),
  /** 边权敏感性扫描：提交当前画布图，仅在服务端内存中计算，不会保存图。 */
  scanEdgeWeight: (payload: {
    graph: GraphDocument;
    edgeId: string;
    targetNodeId: string;
    options: PropagateOptions;
    samples?: number;
  }) =>
    request<{ scan: SensitivityResult }>('/api/sensitivity/edge-weight', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
};

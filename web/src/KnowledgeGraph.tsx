import { useMemo, useState } from "react";
import type { KnowledgeGraph, KnowledgeGraphNode } from "./api";
import { PAGE_TYPE_LABELS, type KnowledgePageType } from "../../src/knowledge/types";

const WIDTH = 560;
const HEIGHT = 360;
const PADDING = 36;

export const TYPE_COLORS: Record<KnowledgePageType, string> = {
  source: "#8b8b94",
  entity: "#2563eb",
  concept: "#bd4531",
  query: "#b45309",
  comparison: "#15803d",
  synthesis: "#7c3aed",
  note: "#0891b2",
};

export const COMMUNITY_COLORS = [
  "#bd4531",
  "#2563eb",
  "#15803d",
  "#b45309",
  "#7c3aed",
  "#0891b2",
  "#be185d",
  "#4d7c0f",
  "#6d28d9",
  "#0e7490",
  "#a16207",
  "#475569",
];

function communityColor(id: number): string {
  return COMMUNITY_COLORS[id % COMMUNITY_COLORS.length] ?? "#6d675d";
}

/** 与后端 graphEdgeKey 保持一致：无向边按路径排序后拼接。 */
function edgeKey(source: string, target: string): string {
  return [source, target].sort().join("|");
}

function hashSeed(ids: readonly string[]): number {
  let hash = 2166136261;
  for (const id of ids) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PositionedNode extends KnowledgeGraphNode {
  x: number;
  y: number;
  radius: number;
}

/**
 * 轻量力导向布局：斥力 + 弹簧 + 向心，固定迭代次数，种子由节点 ID 哈希决定。
 * 同一份图每次刷新得到相同初始位置，避免页面更新时节点乱跳；不引入 sigma.js / d3。
 */
function computeLayout(graph: KnowledgeGraph): {
  nodes: PositionedNode[];
  positions: Map<string, { x: number; y: number; radius: number }>;
} {
  const ids = [...graph.nodes.map((node) => node.id)].sort();
  const random = mulberry32(hashSeed(ids));
  const radius = new Map(
    graph.nodes.map((node) => [node.id, Math.min(15, 4.5 + Math.sqrt(node.degree) * 2.2)]),
  );
  const pos = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  const centerX = WIDTH / 2;
  const centerY = HEIGHT / 2;
  const ring = Math.min(WIDTH, HEIGHT) * 0.36;
  ids.forEach((id, index) => {
    const angle = (index / Math.max(1, ids.length)) * Math.PI * 2 + random() * 0.4;
    pos.set(id, {
      x: centerX + Math.cos(angle) * ring * (0.6 + random() * 0.5),
      y: centerY + Math.sin(angle) * ring * (0.6 + random() * 0.5),
      vx: 0,
      vy: 0,
    });
  });

  const maxWeight = graph.edges.reduce((max, edge) => Math.max(max, edge.weight), 1);
  const iterations = ids.length > 160 ? 80 : ids.length > 80 ? 110 : 150;
  const repulsion = 2200;
  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / (iterations + 20);
    const list = ids.map((id) => ({ id, ...pos.get(id)! }));
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i]!;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = (i % 2 === 0 ? 1 : -1) * 0.5;
          dy = (j % 2 === 0 ? 1 : -1) * 0.5;
          distance = 0.7;
        }
        const force = (repulsion / (distance * distance)) * cooling;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        pos.get(a.id)!.vx += fx;
        pos.get(a.id)!.vy += fy;
        pos.get(b.id)!.vx -= fx;
        pos.get(b.id)!.vy -= fy;
      }
    }
    for (const edge of graph.edges) {
      const a = pos.get(edge.source);
      const b = pos.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const strength = 0.012 + (edge.weight / maxWeight) * 0.018;
      const force = (distance - 70) * strength;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    for (const id of ids) {
      const node = pos.get(id)!;
      node.vx += (centerX - node.x) * 0.0016;
      node.vy += (centerY - node.y) * 0.0016;
      node.vx *= 0.82;
      node.vy *= 0.82;
      node.x += Math.max(-18, Math.min(18, node.vx));
      node.y += Math.max(-18, Math.min(18, node.vy));
    }
  }

  const xs = ids.map((id) => pos.get(id)!.x);
  const ys = ids.map((id) => pos.get(id)!.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scaleX = (WIDTH - PADDING * 2) / Math.max(1, maxX - minX);
  const scaleY = (HEIGHT - PADDING * 2) / Math.max(1, maxY - minY);
  const scale = Math.min(scaleX, scaleY, 2.4);
  const offsetX = (WIDTH - (maxX - minX) * scale) / 2;
  const offsetY = (HEIGHT - (maxY - minY) * scale) / 2;
  const positions = new Map<string, { x: number; y: number; radius: number }>();
  for (const id of ids) {
    const node = pos.get(id)!;
    positions.set(id, {
      x: (node.x - minX) * scale + offsetX,
      y: (node.y - minY) * scale + offsetY,
      radius: radius.get(id) ?? 5,
    });
  }
  const nodes: PositionedNode[] = graph.nodes.map((node) => ({
    ...node,
    x: positions.get(node.id)?.x ?? centerX,
    y: positions.get(node.id)?.y ?? centerY,
    radius: positions.get(node.id)?.radius ?? 5,
  }));
  return { nodes, positions };
}

export interface GraphHighlight {
  nodeIds: string[];
  edgeKeys: string[];
}

export default function KnowledgeGraphView({
  graph,
  colorMode,
  onOpenPage,
  highlight,
}: {
  graph: KnowledgeGraph;
  colorMode: "type" | "community";
  onOpenPage(path: string): void;
  highlight?: GraphHighlight | null;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  const layout = useMemo(() => computeLayout(graph), [graph]);

  if (graph.nodes.length === 0) {
    return <p className="empty small">还没有页面，导入材料并整理后这里会出现图谱。</p>;
  }

  const neighbors = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const forSource = neighbors.get(edge.source) ?? new Set<string>();
    forSource.add(edge.target);
    neighbors.set(edge.source, forSource);
    const forTarget = neighbors.get(edge.target) ?? new Set<string>();
    forTarget.add(edge.source);
    neighbors.set(edge.target, forTarget);
  }

  const rawHighlight = highlight
    ? {
        nodes: new Set(highlight.nodeIds),
        edges: new Set(highlight.edgeKeys),
      }
    : null;
  const focusNodes = hovered
    ? new Set([hovered, ...(neighbors.get(hovered) ?? [])])
    : (rawHighlight?.nodes ?? null);
  const maxWeight = graph.edges.reduce((max, edge) => Math.max(max, edge.weight), 1);
  const labelled = new Set(
    [...layout.nodes]
      .sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title, "zh"))
      .slice(0, 24)
      .map((node) => node.id),
  );

  const nodeColor = (node: KnowledgeGraphNode): string =>
    colorMode === "community" ? communityColor(node.community) : TYPE_COLORS[node.type];
  const nodeOpacity = (id: string): number => {
    if (hovered) return focusNodes?.has(id) ? 1 : 0.18;
    if (rawHighlight) return rawHighlight.nodes.has(id) ? 1 : 0.16;
    return 1;
  };
  const edgeOpacity = (edge: KnowledgeGraph["edges"][number]): number => {
    const key = edgeKey(edge.source, edge.target);
    if (hovered) return edge.source === hovered || edge.target === hovered ? 0.85 : 0.08;
    if (rawHighlight) return rawHighlight.edges.has(key) ? 0.95 : 0.07;
    return 0.32;
  };

  function zoomBy(factor: number): void {
    setZoom((current) => {
      const next = Math.max(0.5, Math.min(3, current.scale * factor));
      const ratio = next / current.scale;
      const centerX = WIDTH / 2;
      const centerY = HEIGHT / 2;
      return {
        scale: next,
        tx: centerX - (centerX - current.tx) * ratio,
        ty: centerY - (centerY - current.ty) * ratio,
      };
    });
  }

  return (
    <div className="knowledge-graph">
      <div className="knowledge-graph-tools" role="group" aria-label="图谱缩放">
        <button type="button" title="放大" onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button type="button" title="缩小" onClick={() => zoomBy(0.8)}>
          −
        </button>
        <button type="button" title="适应画布" onClick={() => setZoom({ scale: 1, tx: 0, ty: 0 })}>
          ⤢
        </button>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`知识图谱：${graph.nodes.length} 个页面，${graph.edges.length} 条关联`}
      >
        <g transform={`translate(${zoom.tx} ${zoom.ty}) scale(${zoom.scale})`}>
          {graph.edges.map((edge) => {
            const a = layout.positions.get(edge.source);
            const b = layout.positions.get(edge.target);
            if (!a || !b) return null;
            const width = 0.6 + (edge.weight / maxWeight) * 1.8;
            const stroke =
              edge.kind === "link" ? "#bd4531" : edge.kind === "source" ? "#b45309" : "#2563eb";
            return (
              <line
                key={`${edge.source}-${edge.target}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={stroke}
                strokeWidth={width}
                strokeLinecap="round"
                opacity={edgeOpacity(edge)}
              />
            );
          })}
          {layout.nodes.map((node) => {
            const color = nodeColor(node);
            return (
              <g
                key={node.id}
                className="knowledge-graph-node"
                opacity={nodeOpacity(node.id)}
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => onOpenPage(node.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onOpenPage(node.id);
                }}
                aria-label={`${node.title}（${PAGE_TYPE_LABELS[node.type]}，${node.degree} 条关联）`}
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={hovered === node.id ? node.radius + 2 : node.radius}
                  fill={color}
                  stroke="var(--bg-elevated)"
                  strokeWidth={1.5}
                />
                {(hovered === node.id || labelled.has(node.id)) && (
                  <text
                    x={node.x}
                    y={node.y + node.radius + 11}
                    textAnchor="middle"
                    fill="var(--muted)"
                    fontSize={12}
                  >
                    {node.title.length > 12 ? `${node.title.slice(0, 12)}…` : node.title}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

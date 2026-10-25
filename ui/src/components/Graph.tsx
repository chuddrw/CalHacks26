/**
 * WHAT IT'S FOR: the team graph, the dashboard's centerpiece. The orchestrator sits on top and the
 * agents in a row below. Lines down are tasks the orchestrator assigned; arcs under the row are
 * reviews (dashed, reviewer → requester) and conflict threads between two agents. Nodes and labels
 * are HTML (readable, clickable); the edges are one SVG layer behind them. Data: team.ts.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { GraphEdge, GraphNode, Selection, TeamGraph } from "../team";
import { sameSelection } from "./select";

interface Point {
  x: number;
  y: number;
}
interface Layout {
  width: number;
  height: number;
  centers: Map<string, Point>;
  nodeWidth: Map<string, number>;
}

/** Nodes hang from their top edge, this far above the point their edges start from. */
const NODE_TOP = 34;

function layout(graph: TeamGraph, width: number, height: number): Layout {
  const agents = graph.nodes.filter((n) => n.kind === "agent");
  const centers = new Map<string, Point>();
  const nodeWidth = new Map<string, number>();
  const orchY = Math.max(NODE_TOP + 16, height * 0.14);
  const agentY = Math.max(orchY + 170, height * 0.44);
  for (const node of graph.nodes) {
    if (node.kind === "orchestrator") {
      centers.set(node.id, { x: width / 2, y: orchY });
      nodeWidth.set(node.id, Math.min(420, width - 32));
    }
  }
  agents.forEach((node, i) => {
    centers.set(node.id, {
      x: (width * (i + 0.5)) / agents.length,
      y: agentY,
    });
    nodeWidth.set(node.id, Math.min(230, width / agents.length - 16));
  });
  return { width, height, centers, nodeWidth };
}

interface Drawn {
  edge: GraphEdge;
  path: string;
  label: Point;
}

function drawEdges(graph: TeamGraph, l: Layout): Drawn[] {
  const repeats = new Map<string, number>();
  const drawn: Drawn[] = [];
  for (const edge of graph.edges) {
    const a = l.centers.get(edge.from);
    const b = l.centers.get(edge.to);
    if (!a || !b) continue;
    if (edge.kind === "task") {
      // Straight down from the orchestrator; the label sits just above the agent.
      const t = 0.6;
      drawn.push({
        edge,
        path: `M ${a.x} ${a.y} L ${b.x} ${b.y}`,
        label: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
      });
      continue;
    }
    // Arcs under the agent row. Conflicts curve deeper than reviews, repeats deeper still.
    const key = `${edge.kind}:${[edge.from, edge.to].sort().join("+")}`;
    const n = repeats.get(key) ?? 0;
    repeats.set(key, n + 1);
    const dx = Math.abs(b.x - a.x);
    const depth =
      (edge.kind === "conflict" ? 220 + dx * 0.24 : 150 + dx * 0.14) + n * 44;
    const mid = (a.x + b.x) / 2;
    const base = Math.max(a.y, b.y);
    drawn.push({
      edge,
      path: `M ${a.x} ${a.y} Q ${mid} ${base + depth} ${b.x} ${b.y}`,
      label: { x: mid, y: base + depth / 2 },
    });
  }
  return drawn;
}

function Node({
  node,
  at,
  width,
  selected,
  select,
}: {
  node: GraphNode;
  at: Point;
  width: number;
  selected: boolean;
  select: (s: Selection) => void;
}) {
  return (
    <button
      type="button"
      className={`node node-${node.kind} tone-${node.tone}${node.online ? "" : " offline"}${node.busy ? " busy" : ""}${selected ? " selected" : ""}`}
      style={{ left: at.x, top: at.y - NODE_TOP, width }}
      onClick={() => select(node.select)}
      aria-label={`${node.label}: ${node.state}. ${node.doing}`}
    >
      <span className="node-head">
        <span className="dot" />
        <strong>{node.label}</strong>
        <span className="node-state">{node.state}</span>
      </span>
      <span className="node-doing" title={node.doing}>
        {node.doing}
      </span>
    </button>
  );
}

export function Graph({
  graph,
  selection,
  select,
}: {
  graph: TeamGraph;
  selection: Selection | null;
  select: (s: Selection) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const l = layout(graph, size.width, size.height);
  const drawn = size.width ? drawEdges(graph, l) : [];
  const agents = graph.nodes.filter((n) => n.kind === "agent").length;
  return (
    <div className="graph" ref={box}>
      {size.width > 0 && (
        <>
          <svg
            className="edges"
            width={size.width}
            height={size.height}
            aria-hidden="true"
          >
            {drawn.map(({ edge, path }) => (
              <path
                key={edge.id}
                d={path}
                className={`edge edge-${edge.kind} tone-${edge.tone}${edge.dashed ? " dashed" : ""}${edge.active ? " active" : ""}`}
              />
            ))}
          </svg>
          {drawn.map(({ edge, label }) => (
            <button
              type="button"
              key={edge.id}
              className={`edge-label edge-label-${edge.kind} tone-${edge.tone}${sameSelection(selection, edge.select) ? " selected" : ""}`}
              style={{ left: label.x, top: label.y }}
              onClick={() => select(edge.select)}
            >
              {edge.label}
            </button>
          ))}
          {graph.nodes.map((node) => (
            <Node
              key={node.id}
              node={node}
              at={l.centers.get(node.id) ?? { x: 0, y: 0 }}
              width={l.nodeWidth.get(node.id) ?? 200}
              selected={sameSelection(selection, node.select)}
              select={select}
            />
          ))}
          {agents === 0 && (
            <p className="graph-empty">
              No agents yet. Each teammate's agent appears here once its MCP
              server connects.
            </p>
          )}
        </>
      )}
      <div className="legend" aria-hidden="true">
        <span>
          <i className="key key-task" /> task
        </span>
        <span>
          <i className="key key-review" /> review
        </span>
        <span>
          <i className="key key-conflict" /> conflict thread
        </span>
      </div>
    </div>
  );
}

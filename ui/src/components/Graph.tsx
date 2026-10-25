/**
 * WHAT IT'S FOR: the team graph, the dashboard's centerpiece. The orchestrator sits on top with the
 * people at the dashboard beside it, and the agents in a row below. Lines down are tasks the
 * orchestrator assigned, labeled with what the agent is doing; arcs under the row are reviews
 * (dashed, reviewer → requester) and conflict threads between two agents. On top of that, every
 * data transfer (transfers.ts) flashes as an arrow from sender to receiver for a few seconds.
 * Nodes and labels are HTML (readable, clickable); edges and arrows are SVG. Data: team.ts.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { upper, type GraphEdge, type GraphNode, type Selection, type TeamGraph } from "../team";
import { sameSelection } from "./select";
import type { Flight } from "./useFlights";

interface Point {
  x: number;
  y: number;
}
interface Rect extends Point {
  w: number;
  h: number;
}
interface Layout {
  width: number;
  height: number;
  centers: Map<string, Point>;
  nodeWidth: Map<string, number>;
  /** Room for one task label, so neighbors don't overlap. */
  taskLabelWidth: number;
}

/** Nodes hang from their top edge, this far above the point their edges start from. */
const NODE_TOP = 34;
/** Where along a task line its label sits (0 = orchestrator, 1 = agent). */
const TASK_LABEL_AT = 0.72;

function layout(graph: TeamGraph, width: number, height: number): Layout {
  const agents = graph.nodes.filter((n) => n.kind === "agent");
  const centers = new Map<string, Point>();
  const nodeWidth = new Map<string, number>();
  const orchY = Math.max(NODE_TOP + 16, height * 0.13);
  const agentY = Math.max(orchY + 200, height * 0.46);
  const peopleWidth = Math.min(190, width * 0.2);
  for (const node of graph.nodes) {
    if (node.kind === "orchestrator") {
      centers.set(node.id, { x: width / 2, y: orchY });
      nodeWidth.set(node.id, Math.min(420, width - 2 * (peopleWidth + 28)));
    } else if (node.kind === "people") {
      centers.set(node.id, { x: peopleWidth / 2 + 12, y: orchY });
      nodeWidth.set(node.id, peopleWidth);
    }
  }
  agents.forEach((node, i) => {
    centers.set(node.id, {
      x: (width * (i + 0.5)) / agents.length,
      y: agentY,
    });
    nodeWidth.set(node.id, Math.min(230, width / agents.length - 16));
  });
  const spacing = width / Math.max(1, agents.length);
  return { width, height, centers, nodeWidth, taskLabelWidth: spacing * TASK_LABEL_AT - 10 };
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
      drawn.push({
        edge,
        path: `M ${a.x} ${a.y} L ${b.x} ${b.y}`,
        label: {
          x: a.x + (b.x - a.x) * TASK_LABEL_AT,
          y: a.y + (b.y - a.y) * TASK_LABEL_AT,
        },
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

// ---- Transfer arrows -------------------------------------------------------------------------

const centerOf = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Where the line from the rect's center toward `toward` leaves the rect, plus a small gap. */
function borderPoint(r: Rect, toward: Point, gap = 4): Point {
  const c = centerOf(r);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  const s = Math.min(
    dx ? r.w / 2 / Math.abs(dx) : Infinity,
    dy ? r.h / 2 / Math.abs(dy) : Infinity,
  );
  return { x: c.x + dx * s + (dx / len) * gap, y: c.y + dy * s + (dy / len) * gap };
}

/**
 * A curve from border to border. Between two nodes in one row it dips below the row (above are the
 * task labels), A→B shallower than B→A so the two directions don't overlap. Otherwise it bows to
 * one side, A→B and B→A to opposite sides.
 */
function arrowPath(a: Rect, b: Rect): { d: string; mid: Point } {
  const ac = centerOf(a);
  const bc = centerOf(b);
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  const dist = Math.hypot(dx, dy) || 1;
  const sameRow = Math.abs(a.y - b.y) < 8;
  const bow = sameRow ? dist * (dx > 0 ? 0.42 : 0.6) : Math.min(90, dist * 0.2);
  const ctrl = sameRow
    ? { x: (ac.x + bc.x) / 2, y: Math.max(ac.y, bc.y) + bow }
    : {
        x: (ac.x + bc.x) / 2 - (dy / dist) * bow,
        y: (ac.y + bc.y) / 2 + (dx / dist) * bow,
      };
  const s = borderPoint(a, ctrl);
  const e = borderPoint(b, ctrl);
  return {
    d: `M ${s.x} ${s.y} Q ${ctrl.x} ${ctrl.y} ${e.x} ${e.y}`,
    mid: { x: 0.25 * s.x + 0.5 * ctrl.x + 0.25 * e.x, y: 0.25 * s.y + 0.5 * ctrl.y + 0.25 * e.y },
  };
}

const nameOf = (id: string) =>
  id === "orchestrator" ? "Orchestrator" : id === "people" ? "People" : upper(id);

function Arrows({
  flights,
  rectOf,
}: {
  flights: Flight[];
  rectOf: (id: string) => Rect | undefined;
}) {
  const drawn = flights.flatMap((flight) => {
    const from = rectOf(flight.transfer.from);
    if (!from) return [];
    return flight.transfer.to.flatMap((to, i) => {
      const target = rectOf(to);
      if (!target) return [];
      return [{ key: `${flight.id}-${to}`, flight, first: i === 0, ...arrowPath(from, target) }];
    });
  });
  // Only the newest arrow keeps its label: in a burst, older labels would pile up on top of each other.
  const newest = flights.at(-1)?.id;
  return (
    <>
      <svg className="flights" aria-hidden="true">
        <defs>
          {(["neutral", "accent", "green", "red", "amber"] as const).map((tone) => (
            <marker
              key={tone}
              id={`head-${tone}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="9"
              markerHeight="9"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className={`head tone-${tone}`} />
            </marker>
          ))}
        </defs>
        {drawn.map((a) => (
          <g key={a.key} className={`flight tone-${a.flight.transfer.tone}`}>
            <path d={a.d} pathLength={1} markerEnd={`url(#head-${a.flight.transfer.tone})`} />
          </g>
        ))}
      </svg>
      {drawn
        .filter((a) => a.first && a.flight.id === newest)
        .map((a) => (
          <div
            key={a.key}
            className={`flight-label tone-${a.flight.transfer.tone}`}
            style={{ left: a.mid.x, top: a.mid.y }}
            role="status"
          >
            <span className="flight-text">
              <strong>{nameOf(a.flight.transfer.from)}</strong> {a.flight.transfer.text}
            </span>
            <span className="flight-meta">
              → {a.flight.transfer.to.map(nameOf).join(", ")} · via {a.flight.transfer.via}
            </span>
          </div>
        ))}
    </>
  );
}

// ---- Nodes and the graph ---------------------------------------------------------------------

function Node({
  node,
  at,
  width,
  selected,
  select,
  register,
}: {
  node: GraphNode;
  at: Point;
  width: number;
  selected: boolean;
  select: (s: Selection) => void;
  register: (id: string, el: HTMLElement | null) => void;
}) {
  return (
    <button
      type="button"
      ref={(el) => register(node.id, el)}
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
  flights,
  selection,
  select,
}: {
  graph: TeamGraph;
  flights: Flight[];
  selection: Selection | null;
  select: (s: Selection) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const nodeEls = useRef(new Map<string, HTMLElement>());
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
  const register = (id: string, el: HTMLElement | null) => {
    if (el) nodeEls.current.set(id, el);
    else nodeEls.current.delete(id);
  };
  const rectOf = (id: string): Rect | undefined => {
    const c = l.centers.get(id);
    const w = l.nodeWidth.get(id);
    if (!c || !w) return undefined;
    return { x: c.x - w / 2, y: c.y - NODE_TOP, w, h: nodeEls.current.get(id)?.offsetHeight ?? 64 };
  };
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
              style={{
                left: label.x,
                top: label.y,
                maxWidth: edge.kind === "task" ? l.taskLabelWidth : undefined,
              }}
              title={edge.label}
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
              register={register}
            />
          ))}
          <Arrows flights={flights} rectOf={rectOf} />
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
        <span>
          <i className="key key-flight" /> data moving now
        </span>
      </div>
    </div>
  );
}

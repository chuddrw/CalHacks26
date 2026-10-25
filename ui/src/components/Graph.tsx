/**
 * WHAT IT'S FOR: the team graph, drawn as a hive. SpacetimeDB sits in the middle: no agent talks to
 * another directly; each writes to the shared database and the others get it through their
 * subscription. GitHub is the smaller hub below it, where the code itself moves (wip/<agent>
 * branches, the full stack). Around them, in a ring: the orchestrator on top, the agents, and the
 * people at the dashboard. Faint spokes connect every one of them to the database.
 *
 * Lasting relationships curve inside the ring: tasks (orchestrator → agent, labeled with what the
 * agent is doing), reviews (dashed, reviewer → requester) and conflict threads between two agents.
 * Every data transfer (transfers.ts) flashes in two hops: sender → hub (the write), the hub pulses
 * and shows what was written, hub → each receiver (the subscription push). Each hop draws from its
 * start to its end, with the arrowhead riding the tip; lasting edges draw in the same way when
 * they first appear. A node the team is waiting on ripples outward, and the corner says who it is.
 * Nodes, hubs and labels are HTML (readable, clickable); lines and arrows are SVG. Data: team.ts.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { Transfer } from "../transfers";
import {
  upper,
  waitingOn,
  type GraphEdge,
  type GraphNode,
  type HiveStats,
  type Selection,
  type TeamGraph,
} from "../team";
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
interface Spot {
  c: Point;
  w: number;
  /** Degrees on the ring, -90 = top. */
  angle: number;
}
interface Layout {
  center: Point;
  rx: number;
  ry: number;
  nodes: Map<string, Spot>;
  db: Rect;
  git: Rect;
  labelWidth: number;
}

/** Rough half height of a node at the normal font size, until the browser has measured it. */
const HALF_NODE = 40;
/** The edge-label font at the normal size; sizes below scale with the real one. */
const BASE_FONT = 11.7;

function layout(graph: TeamGraph, width: number, height: number, fontPx: number): Layout {
  const scale = fontPx / BASE_FONT;
  const halfNode = HALF_NODE * scale;
  const legend = 30 * scale;
  // Ring order, clockwise from the top: orchestrator, agents, people.
  const ring = [
    ...graph.nodes.filter((n) => n.kind === "orchestrator"),
    ...graph.nodes.filter((n) => n.kind === "agent"),
    ...graph.nodes.filter((n) => n.kind === "people"),
  ];
  const nodeW = Math.max(140, Math.min(210, width * 0.2));
  // The legend takes the bottom `legend` px.
  const center = { x: width / 2, y: (height - legend) / 2 };
  const rx = Math.max(120, width / 2 - nodeW / 2 - 12);
  const ry = Math.max(120, center.y - halfNode - 12);
  const nodes = new Map<string, Spot>();
  ring.forEach((node, i) => {
    const angle = -90 + (i * 360) / ring.length;
    const rad = (angle * Math.PI) / 180;
    nodes.set(node.id, {
      c: { x: center.x + rx * Math.cos(rad), y: center.y + ry * Math.sin(rad) },
      w: nodeW,
      angle,
    });
  });
  // The two hubs stack in the band between the top and bottom of the ring, the database shrinking
  // if the band is short.
  const bandTop = center.y - ry + halfNode + 12;
  const band = 2 * (ry - halfNode - 12);
  const gap = 14 * scale;
  const gitH = 64 * scale;
  const dbH = Math.max(84 * scale, Math.min(132 * scale, band - gap - gitH));
  const stackTop = bandTop + Math.max(0, (band - dbH - gap - gitH) / 2);
  const dbW = Math.min(270, rx * 0.8);
  const dbY = stackTop + dbH / 2;
  const gitW = Math.min(210, rx * 0.7);
  const gitY = stackTop + dbH + gap + gitH / 2;
  return {
    center,
    rx,
    ry,
    nodes,
    db: { x: center.x - dbW / 2, y: dbY - dbH / 2, w: dbW, h: dbH },
    git: { x: center.x - gitW / 2, y: gitY - gitH / 2, w: gitW, h: gitH },
    labelWidth: Math.min(190, nodeW),
  };
}

const centerOf = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** A flattened hexagon: the hive's cell. */
function hexagon(r: Rect): string {
  const inset = r.w * 0.12;
  return [
    [r.x + inset, r.y],
    [r.x + r.w - inset, r.y],
    [r.x + r.w, r.y + r.h / 2],
    [r.x + r.w - inset, r.y + r.h],
    [r.x + inset, r.y + r.h],
    [r.x, r.y + r.h / 2],
  ]
    .map(([x, y]) => `${x},${y}`)
    .join(" ");
}

// ---- Lasting edges: curves inside the ring ---------------------------------------------------

interface Drawn {
  edge: GraphEdge;
  path: string;
  label: Point;
}

const bezier = (p0: Point, c: Point, p2: Point, t: number): Point => ({
  x: (1 - t) ** 2 * p0.x + 2 * t * (1 - t) * c.x + t * t * p2.x,
  y: (1 - t) ** 2 * p0.y + 2 * t * (1 - t) * c.y + t * t * p2.y,
});

const overlap = (a: Rect, b: Rect, margin = 4): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + margin) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + margin);

/** Where along its curve a label may sit, best first. Task labels prefer the agent's end. */
const TRIES = {
  task: [0.7, 0.6, 0.8, 0.5, 0.4, 0.85, 0.3],
  other: [0.5, 0.6, 0.4, 0.7, 0.3, 0.75, 0.25],
};

/**
 * A curve between two ring nodes. Its control point lies on the ring's middle angle, placed so the
 * curve's middle passes at a fixed fraction of the ring's radius: between the hubs and the ring,
 * whether the two nodes are neighbors or opposite. Repeats between the same pair sit further out.
 * Each label then takes the first spot along its curve that covers no node, hub or earlier label.
 */
function drawEdges(
  graph: TeamGraph,
  l: Layout,
  obstacles: Rect[],
  fontPx: number,
): Drawn[] {
  const repeats = new Map<string, number>();
  const placed: Rect[] = [];
  const drawn: Drawn[] = [];
  for (const edge of graph.edges) {
    const a = l.nodes.get(edge.from);
    const b = l.nodes.get(edge.to);
    if (!a || !b) continue;
    const pair = [edge.from, edge.to].sort().join("+");
    const n = repeats.get(pair) ?? 0;
    repeats.set(pair, n + 1);
    let span = b.angle - a.angle;
    while (span > 180) span -= 360;
    while (span <= -180) span += 360;
    const mid = ((a.angle + span / 2) * Math.PI) / 180;
    // A quadratic's middle is half the chord's middle plus half the control point.
    const reach = 0.64 + n * 0.1;
    const k = 2 * reach - Math.cos(((span / 2) * Math.PI) / 180);
    const ctrl = {
      x: l.center.x + l.rx * k * Math.cos(mid),
      y: l.center.y + l.ry * k * Math.sin(mid),
    };
    // Label size, estimated from its text (task labels wrap to two lines).
    const maxW = edge.kind === "task" ? l.labelWidth : 260;
    const textW = edge.label.length * fontPx * 0.52 + 18;
    const w = Math.min(maxW, textW);
    const h = (textW > maxW ? 2 : 1) * fontPx * 1.3 + 8;
    let best: { at: Point; cost: number; box: Rect } | undefined;
    for (const t of edge.kind === "task" ? TRIES.task : TRIES.other) {
      const at = bezier(a.c, ctrl, b.c, t);
      const box = { x: at.x - w / 2, y: at.y - h / 2, w, h };
      const cost = [...obstacles, ...placed].reduce((sum, o) => sum + overlap(box, o), 0);
      if (!best || cost < best.cost) best = { at, cost, box };
      if (cost === 0) break;
    }
    if (best) placed.push(best.box);
    drawn.push({
      edge,
      path: `M ${a.c.x} ${a.c.y} Q ${ctrl.x} ${ctrl.y} ${b.c.x} ${b.c.y}`,
      label: best?.at ?? bezier(a.c, ctrl, b.c, 0.5),
    });
  }
  return drawn;
}

// ---- Transfer arrows, in two hops through a hub -----------------------------------------------

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

interface Hop {
  d: string;
  at: (t: number) => Point;
}

/** Does the straight line from a to b pass through r? */
function crosses(a: Point, b: Point, r: Rect): boolean {
  for (let i = 1; i < 12; i++) {
    const x = a.x + ((b.x - a.x) * i) / 12;
    const y = a.y + ((b.y - a.y) * i) / 12;
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return true;
  }
  return false;
}

/**
 * A slightly bowed arrow from border to border; in and out of the same hub bow to opposite sides.
 * If `avoid` (the database hub) is in the way, as it is between the orchestrator and GitHub,
 * the arrow bows wide enough to go around it, on the side away from it.
 */
function hop(a: Rect, b: Rect, avoid?: Rect): Hop {
  const ac = centerOf(a);
  const bc = centerOf(b);
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  const dist = Math.hypot(dx, dy) || 1;
  const detour = !!avoid && avoid !== a && avoid !== b && crosses(ac, bc, avoid);
  const bow = detour ? 2 * (avoid.w / 2 + 28) : Math.min(36, dist * 0.12);
  const side = (sign: number) => ({
    x: (ac.x + bc.x) / 2 - (dy / dist) * bow * sign,
    y: (ac.y + bc.y) / 2 + (dx / dist) * bow * sign,
  });
  let ctrl = side(1);
  if (detour) {
    // Go around on whichever side is further from the hub.
    const hub = centerOf(avoid);
    const other = side(-1);
    if (Math.hypot(other.x - hub.x, other.y - hub.y) > Math.hypot(ctrl.x - hub.x, ctrl.y - hub.y))
      ctrl = other;
  }
  const s = borderPoint(a, ctrl);
  const e = borderPoint(b, ctrl);
  return {
    d: `M ${s.x} ${s.y} Q ${ctrl.x} ${ctrl.y} ${e.x} ${e.y}`,
    at: (t) => bezier(s, ctrl, e, t),
  };
}

/** Spots along the write hop for an arrow's label, best first. */
const FLIGHT_LABEL_AT = [0.45, 0.3, 0.6, 0.2, 0.75];

const nameOf = (id: string) =>
  id === "orchestrator" ? "Orchestrator" : id === "people" ? "People" : upper(id);

/**
 * An arrowhead that rides along a hop while the line draws (same duration and easing as the
 * stroke in app.css), so the arrow grows from its start to its end instead of appearing at once.
 */
function Head({ d, push }: { d: string; push: boolean }) {
  return <span className={`head${push ? " head-push" : ""}`} style={{ offsetPath: `path("${d}")` }} />;
}

function Flights({
  flights,
  rectOf,
  hubOf,
  db,
  obstacles,
  fontPx,
}: {
  flights: Flight[];
  rectOf: (id: string) => Rect | undefined;
  hubOf: (x: Transfer) => Rect;
  db: Rect;
  obstacles: Rect[];
  fontPx: number;
}) {
  const drawn = flights.flatMap((flight) => {
    const from = rectOf(flight.transfer.from);
    if (!from) return [];
    const hub = hubOf(flight.transfer);
    const write = hop(from, hub, db);
    const pushes = flight.transfer.to.flatMap((to) => {
      const target = rectOf(to);
      return target ? [hop(hub, target, db).d] : [];
    });
    return [{ flight, hub, write, pushes }];
  });
  // Only the newest arrow keeps its label: in a burst, older labels would pile up on top of each other.
  const newest = drawn.at(-1);
  // Its spot: along the write hop, covering as little of the nodes and hubs as possible.
  let labelAt: Point | undefined;
  if (newest) {
    const w = Math.min(19 * fontPx * 1.03, newest.flight.transfer.text.length * fontPx * 0.55 + 40);
    const h = fontPx * 4.2;
    let best = Infinity;
    for (const t of FLIGHT_LABEL_AT) {
      const at = newest.write.at(t);
      const box = { x: at.x - w / 2, y: at.y - h / 2, w, h };
      const cost = obstacles.reduce((sum, o) => sum + overlap(box, o, 0), 0);
      if (cost < best) {
        best = cost;
        labelAt = at;
      }
      if (cost === 0) break;
    }
  }
  return (
    <>
      <svg className="flights" aria-hidden="true">
        {drawn.map(({ flight, hub, write, pushes }) => {
          const tone = flight.transfer.tone;
          return (
            <g key={flight.id} className={`flight tone-${tone}`}>
              {flight.transfer.via === "DB" ? (
                <polygon className="hub-pulse" points={hexagon(hub)} />
              ) : (
                <rect className="hub-pulse" x={hub.x} y={hub.y} width={hub.w} height={hub.h} rx={10} />
              )}
              <path className="hop-write" d={write.d} pathLength={1} />
              {pushes.map((d, i) => (
                <path key={i} className="hop-push" d={d} pathLength={1} />
              ))}
            </g>
          );
        })}
      </svg>
      {drawn.map(({ flight, write, pushes }) => (
        <div key={flight.id} className={`flight-heads tone-${flight.transfer.tone}`} aria-hidden="true">
          <Head d={write.d} push={false} />
          {pushes.map((d, i) => (
            <Head key={i} d={d} push />
          ))}
        </div>
      ))}
      {newest && labelAt && (
        <div
          key={newest.flight.id}
          className={`flight-label tone-${newest.flight.transfer.tone}`}
          style={{ left: labelAt.x, top: labelAt.y }}
          role="status"
        >
          <span className="flight-text">
            <strong>{nameOf(newest.flight.transfer.from)}</strong> {newest.flight.transfer.text}
          </span>
          <span className="flight-meta">
            → {newest.flight.transfer.to.map(nameOf).join(", ")} · {newest.flight.transfer.via}:{" "}
            {newest.flight.transfer.table}
          </span>
        </div>
      )}
    </>
  );
}

// ---- Nodes and hubs ---------------------------------------------------------------------------

function Node({
  node,
  spot,
  selected,
  select,
  register,
}: {
  node: GraphNode;
  spot: Spot;
  selected: boolean;
  select: (s: Selection) => void;
  register: (id: string, el: HTMLElement | null) => void;
}) {
  return (
    <button
      type="button"
      ref={(el) => register(node.id, el)}
      className={`node node-${node.kind} tone-${node.tone}${node.online ? "" : " offline"}${node.busy ? " busy" : ""}${selected ? " selected" : ""}`}
      style={{ left: spot.c.x, top: spot.c.y, width: spot.w }}
      onClick={() => select(node.select)}
      aria-label={`${node.label}: ${node.state}. ${node.doing}`}
    >
      <span className="node-head">
        <span className="dot" />
        <strong>{node.label}</strong>
        {/* A passing agent needs no word: the green dot says it. */}
        {!(node.kind === "agent" && node.tone === "green") && (
          <span className="node-state">{node.state}</span>
        )}
      </span>
      <span className="node-doing" title={node.doing}>
        {node.doing}
      </span>
    </button>
  );
}

/** What the newest arrow into this hub wrote, shown on the hub while it lands. */
function Written({ flight }: { flight?: Flight }) {
  return flight ? (
    <span key={flight.id} className={`hub-write tone-${flight.transfer.tone}`}>
      + {flight.transfer.table}
    </span>
  ) : null;
}

function Hubs({
  l,
  hive,
  flights,
  select,
}: {
  l: Layout;
  hive: HiveStats;
  flights: Flight[];
  select: (s: Selection) => void;
}) {
  const lastDb = flights.filter((f) => f.transfer.via === "DB").at(-1);
  const lastGit = flights.filter((f) => f.transfer.via === "git").at(-1);
  return (
    <>
      <button
        type="button"
        className="hub hub-db"
        style={{ left: l.db.x, top: l.db.y, width: l.db.w, height: l.db.h }}
        onClick={() => select({ kind: "memory" })}
        aria-label={`SpacetimeDB, the team's shared mind: ${hive.online} of ${hive.agents} agents connected, ${hive.facts} verified facts`}
      >
        <strong>SpacetimeDB</strong>
        <span className="hub-sub">
          shared mind · {hive.online}/{hive.agents} connected
        </span>
        <span className="hub-rows">
          {hive.rows.length
            ? hive.rows
                .map((r) => `${r.count} ${r.count === 1 ? r.table.replace(/s$/, "") : r.table}`)
                .join(" · ")
            : "no rows yet"}
        </span>
        <span className="hub-fact" title={hive.latestFact}>
          {hive.facts
            ? `memory (${hive.facts}): ${hive.latestFact}`
            : "memory: no verified facts yet"}
        </span>
        <Written flight={lastDb} />
      </button>
      <button
        type="button"
        className="hub hub-git"
        style={{ left: l.git.x, top: l.git.y, width: l.git.w, height: l.git.h }}
        onClick={() => select({ kind: "checks" })}
        aria-label="GitHub: the code itself"
      >
        <strong>GitHub</strong>
        <span className="hub-rows">
          {hive.wip.length ? hive.wip.map((a) => `wip/${a}`).join(" · ") : "no wip branches yet"}
        </span>
        <span className="hub-sub">
          {hive.fullStack ? `full stack ${hive.fullStack.sha} ✓` : "no full stack yet"}
        </span>
        <Written flight={lastGit} />
      </button>
    </>
  );
}

// ---- The graph -------------------------------------------------------------------------------

export function Graph({
  graph,
  hive,
  flights,
  selection,
  select,
}: {
  graph: TeamGraph;
  hive: HiveStats;
  flights: Flight[];
  selection: Selection | null;
  select: (s: Selection) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const [size, setSize] = useState({ width: 0, height: 0, fontPx: 12 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Edge labels are 0.78em of the graph's font.
    const measure = () =>
      setSize({
        width: el.clientWidth,
        height: el.clientHeight,
        fontPx: parseFloat(getComputedStyle(el).fontSize) * 0.78,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const l = layout(graph, size.width, size.height, size.fontPx);
  const agents = graph.nodes.filter((n) => n.kind === "agent").length;
  const register = (id: string, el: HTMLElement | null) => {
    if (el) nodeEls.current.set(id, el);
    else nodeEls.current.delete(id);
  };
  const rectOf = (id: string): Rect | undefined => {
    const spot = l.nodes.get(id);
    if (!spot) return undefined;
    const h = nodeEls.current.get(id)?.offsetHeight ?? HALF_NODE * 2;
    return { x: spot.c.x - spot.w / 2, y: spot.c.y - h / 2, w: spot.w, h };
  };
  const obstacles = [
    ...graph.nodes.flatMap((n) => rectOf(n.id) ?? []),
    l.db,
    l.git,
  ];
  const drawn = size.width ? drawEdges(graph, l, obstacles, size.fontPx) : [];
  const hubOf = (x: Transfer) => (x.via === "git" ? l.git : l.db);
  const dbCenter = centerOf(l.db);
  const waiting = waitingOn(graph);
  return (
    <div className="graph" ref={box}>
      <p className={`waiting-on${waiting.length ? " busy" : ""}`} role="status">
        <span className="waiting-on-title">Waiting on</span>
        {waiting.length ? (
          waiting.map((n) => (
            <button key={n.id} type="button" className={`waiting-on-who tone-${n.tone}`} onClick={() => select(n.select)}>
              <i className="dot" />
              <strong>{n.label}</strong> {n.state}
            </button>
          ))
        ) : (
          <span className="waiting-on-none">nobody, all quiet</span>
        )}
      </p>
      {size.width > 0 && (
        <>
          <svg
            className="edges"
            width={size.width}
            height={size.height}
            aria-hidden="true"
          >
            {graph.nodes.map((node) => {
              const spot = l.nodes.get(node.id);
              return spot ? (
                <line
                  key={`spoke-${node.id}`}
                  className={`spoke${node.online ? "" : " offline"}`}
                  x1={spot.c.x}
                  y1={spot.c.y}
                  x2={dbCenter.x}
                  y2={dbCenter.y}
                />
              ) : null;
            })}
            <defs>
              {drawn.map(({ edge, path }) => (
                <mask
                  key={edge.id}
                  id={`draw-${edge.id}`}
                  maskUnits="userSpaceOnUse"
                  x={0}
                  y={0}
                  width={size.width}
                  height={size.height}
                >
                  <path className="edge-draw" d={path} pathLength={1} />
                </mask>
              ))}
            </defs>
            {drawn.map(({ edge, path }) => (
              <path
                key={edge.id}
                d={path}
                mask={`url(#draw-${edge.id})`}
                className={`edge edge-${edge.kind} tone-${edge.tone}${edge.dashed ? " dashed" : ""}${edge.active ? " active" : ""}`}
              />
            ))}
            <polygon className="hub-shape" points={hexagon(l.db)} />
            <rect
              className="hub-shape hub-shape-git"
              x={l.git.x}
              y={l.git.y}
              width={l.git.w}
              height={l.git.h}
              rx={10}
            />
          </svg>
          <Hubs l={l} hive={hive} flights={flights} select={select} />
          {drawn.map(({ edge, label }) => (
            <button
              type="button"
              key={edge.id}
              className={`edge-label edge-label-${edge.kind} tone-${edge.tone}${sameSelection(selection, edge.select) ? " selected" : ""}`}
              style={{
                left: label.x,
                top: label.y,
                maxWidth: edge.kind === "task" ? l.labelWidth : undefined,
              }}
              title={edge.label}
              onClick={() => select(edge.select)}
            >
              {edge.label}
            </button>
          ))}
          {graph.nodes.map((node) => {
            const spot = l.nodes.get(node.id);
            return spot ? (
              <Node
                key={node.id}
                node={node}
                spot={spot}
                selected={sameSelection(selection, node.select)}
                select={select}
                register={register}
              />
            ) : null;
          })}
          <Flights
            flights={flights}
            rectOf={rectOf}
            hubOf={hubOf}
            db={l.db}
            obstacles={obstacles}
            fontPx={size.fontPx}
          />
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
          <i className="key key-spoke" /> connected to the shared DB
        </span>
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
          <i className="key key-flight" /> data moving now (through a hub)
        </span>
        <span>
          <i className="key key-busy" /> waiting on it now
        </span>
      </div>
    </div>
  );
}

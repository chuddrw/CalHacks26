/** WHAT IT'S FOR: local-only rehearsal controls; every scene is visibly labeled as simulated. Owner: D. */
import { useEffect, useState } from "react";
import {
  initialScene,
  sceneLabels,
  showDemoScene,
  type DemoScene,
} from "../demo";
import { Icon } from "./Icon";
const sequence: DemoScene[] = ["working", "conflict", "fixing", "resolved"];
export function DemoControls() {
  const [scene, setScene] = useState<DemoScene>(initialScene);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    showDemoScene(scene);
    const url = new URL(location.href);
    url.searchParams.set("scene", scene);
    history.replaceState(null, "", url);
  }, [scene]);
  useEffect(() => {
    if (!playing) return;
    const next = sequence.indexOf(scene) + 1;
    if (next >= sequence.length) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setScene(sequence[next] ?? "working"), 6000);
    return () => clearTimeout(timer);
  }, [playing, scene]);
  function choose(next: DemoScene) {
    setPlaying(false);
    setScene(next);
  }
  return (
    <div className="demo-controls" aria-label="Simulated demo controls">
      <div className="demo-label">
        <Icon name="play" size={13} />
        <strong>SIMULATED DEMO</strong>
        <span>No agents or database connected</span>
      </div>
      <div className="demo-actions">
        <label>
          <span className="sr-only">Demo scene</span>
          <select
            value={scene}
            onChange={(e) => choose(e.target.value as DemoScene)}
          >
            {Object.entries(sceneLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button compact"
          onClick={() => {
            if (
              (!playing && !sequence.includes(scene)) ||
              (!playing && scene === "resolved")
            )
              setScene("working");
            setPlaying(!playing);
          }}
        >
          <Icon name={playing ? "pause" : "play"} size={13} />
          {playing ? "Pause" : "Play story"}
        </button>
        <a
          className="text-button"
          href={location.search.includes("big") ? "/?big" : "/"}
        >
          Live mode
          <Icon name="arrow" size={13} />
        </a>
      </div>
    </div>
  );
}

/** WHAT IT'S FOR: ?demo rehearsal controls: pick a scene or play the story. Always labeled as simulated. */
import { useEffect, useState } from "react";
import {
  initialScene,
  sceneLabels,
  showDemoScene,
  type DemoScene,
} from "../demo";

const story: DemoScene[] = ["working", "conflict", "fixing", "resolved"];
const STEP_MS = 6000;

export function DemoBar() {
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
    const next = story[story.indexOf(scene) + 1];
    if (!next) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setScene(next), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, scene]);
  return (
    <div className="demo-bar" aria-label="Simulated demo controls">
      <span className="chip tone-amber">Simulated</span>
      <span className="muted small">No agents or database connected.</span>
      <select
        aria-label="Demo scene"
        value={scene}
        onChange={(e) => {
          setPlaying(false);
          setScene(e.target.value as DemoScene);
        }}
      >
        {Object.entries(sceneLabels).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn"
        onClick={() => {
          if (!playing && (!story.includes(scene) || scene === "resolved"))
            setScene("working");
          setPlaying(!playing);
        }}
      >
        {playing ? "Pause" : "Play story"}
      </button>
      <a className="link" href="/">
        Live mode →
      </a>
    </div>
  );
}

// One fixed slide at a time. No page scrolling or intermediate resting positions.
const slides = Array.from(document.querySelectorAll(".slide"));
const links = Array.from(document.querySelectorAll(".deck-header nav a"));
const previous = document.querySelector("#previous");
const next = document.querySelector("#next");
const counter = document.querySelector(".page-count");
const stage = document.querySelector("#slides");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let active = Math.max(0, slides.findIndex(slide => `#${slide.id}` === location.hash));
let animating = false;
let motion = [];
let transitionId = 0;
function fitSlides() {
  const available = Math.max(1, stage.clientHeight - 40);
  slides.forEach(slide => {
    const content = slide.querySelector(".slide-content");
    content.style.setProperty("--slide-scale", Math.min(1, available / Math.max(1, content.offsetHeight)));
  });
}
function update() {
  slides.forEach((slide, i) => {
    slide.classList.toggle("is-active", i === active);
    slide.setAttribute("aria-hidden", String(i !== active));
    slide.inert = i !== active;
  });
  links.forEach((link, i) => i === active ? link.setAttribute("aria-current", "location") : link.removeAttribute("aria-current"));
  counter.textContent = `${String(active + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}`;
  previous.disabled = active === 0;
  next.disabled = active === slides.length - 1;
}
async function go(index, writeHash = true) {
  index = Math.max(0, Math.min(slides.length - 1, index));
  if (index === active) return;
  // A deliberate new input can reverse an unfinished transition.
  const id = ++transitionId;
  motion.forEach(animation => animation.cancel());
  slides.forEach(slide => slide.classList.remove("is-transitioning"));
  animating = false;
  const outgoing = slides[active];
  const incoming = slides[index];
  const direction = index > active ? 1 : -1;
  active = index;
  if (writeHash) history.replaceState(null, "", `#${incoming.id}`);
  update();
  fitSlides();
  incoming.focus({ preventScroll: true });
  if (reducedMotion.matches) return;
  animating = true;
  outgoing.classList.add("is-transitioning");
  const options = { duration: 420, easing: "cubic-bezier(.22,.61,.36,1)" };
  motion = [
    outgoing.animate([{ transform: "translateY(0)" }, { transform: `translateY(${-direction * 100}%)` }], options),
    incoming.animate([{ transform: `translateY(${direction * 100}%)` }, { transform: "translateY(0)" }], options),
  ];
  try { await Promise.all(motion.map(animation => animation.finished)); }
  catch (error) { if (error.name !== "AbortError") throw error; }
  finally {
    // Cancellation of an older transition must not unlock the newer one.
    if (id === transitionId) {
      outgoing.classList.remove("is-transitioning");
      animating = false;
      motion = [];
    }
  }
}
previous.addEventListener("click", () => go(active - 1));
next.addEventListener("click", () => go(active + 1));
document.addEventListener("click", event => {
  const anchor = event.target.closest('a[href^="#"]');
  if (!anchor) return;
  const hash = anchor.getAttribute("href");
  const index = slides.findIndex(slide => `#${slide.id}` === hash);
  if (index < 0) return;
  event.preventDefault();
  go(index);
});
window.addEventListener("hashchange", () => {
  const index = slides.findIndex(slide => `#${slide.id}` === location.hash);
  if (index >= 0) go(index, false);
});
document.addEventListener("keydown", event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target.closest("input, textarea, select, video, [contenteditable]")) return;
  let index;
  if (["ArrowDown", "PageDown", "ArrowRight", " "].includes(event.key)) index = active + 1;
  else if (["ArrowUp", "PageUp", "ArrowLeft"].includes(event.key)) index = active - 1;
  else if (event.key === "Home") index = 0;
  else if (event.key === "End") index = slides.length - 1;
  else return;
  if (event.key === " " && event.target.closest("button, a")) return;
  event.preventDefault();
  if (!event.repeat) go(index);
});
// Continued scrolling can traverse the entire deck. Pace steps without
// waiting for the trackpad's momentum to become completely silent.
let wheelAmount = 0;
let wheelDirection = 0;
let lastWheelAt = -Infinity;
let lastWheelStep = -Infinity;
window.addEventListener("wheel", event => {
  if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  event.preventDefault();
  const direction = Math.sign(event.deltaY);
  if (!direction) return;
  const now = performance.now();
  const reversed = direction !== wheelDirection;
  if (reversed || now - lastWheelAt > 250) wheelAmount = 0;
  wheelDirection = direction;
  lastWheelAt = now;
  if (!reversed && now - lastWheelStep < 520) return;
  wheelAmount += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
  if (Math.abs(wheelAmount) < 40) return;
  wheelAmount = 0;
  lastWheelStep = now;
  go(active + direction);
}, { passive: false });
let touchStart;
stage.addEventListener("touchstart", event => {
  touchStart = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : undefined;
}, { passive: true });
stage.addEventListener("touchend", event => {
  if (!touchStart || !event.changedTouches.length) return;
  const dx = touchStart.x - event.changedTouches[0].clientX;
  const dy = touchStart.y - event.changedTouches[0].clientY;
  if (Math.abs(dy) > 45 && Math.abs(dy) > Math.abs(dx) && !event.target.closest("video")) go(active + Math.sign(dy));
  touchStart = undefined;
}, { passive: true });
const observer = new ResizeObserver(fitSlides);
observer.observe(stage);
slides.forEach(slide => observer.observe(slide.querySelector(".slide-content")));
document.fonts.ready.then(fitSlides);
update();
fitSlides();

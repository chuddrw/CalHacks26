// One fixed slide at a time. No page scrolling or intermediate resting positions.
const slides = Array.from(document.querySelectorAll(".slide"));
const links = Array.from(document.querySelectorAll(".deck-header nav a"));
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
  if (slides[active].id === 'technical' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();

    return;
  }
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

// Horizontal input rotates technical cards; vertical input still moves slides.
const carousel = document.querySelector('.technical-carousel');
const cardRing = carousel.querySelector('.technical-grid');
const technicalCards = [...cardRing.children];
let cardStep = 0;
function rotateCard(direction) {
  cardStep += direction;
  const current = ((cardStep % technicalCards.length) + technicalCards.length) % technicalCards.length;
  cardRing.style.setProperty('--card-angle', `${-cardStep * 90}deg`);
  technicalCards.forEach((card, i) => {
    card.style.setProperty('--face', i);
    card.setAttribute('aria-hidden', String(i !== current));
    card.inert = i !== current;
  });
  carousel.setAttribute('aria-label', `Technical architecture: ${current + 1} of 4, ${technicalCards[current].querySelector('h3').textContent}. Swipe horizontally to rotate.`);
}

let cardTouch;
carousel.addEventListener('touchstart', event => { cardTouch = event.touches[0]; }, { passive: true });
carousel.addEventListener('touchend', event => {
  if (!cardTouch) return;
  const dx = cardTouch.clientX - event.changedTouches[0].clientX;
  const dy = cardTouch.clientY - event.changedTouches[0].clientY;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) rotateCard(Math.sign(dx));
  cardTouch = undefined;
}, { passive: true });
let lastCardWheel = -Infinity;
carousel.addEventListener('wheel', event => {
  if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  event.preventDefault(); event.stopPropagation();
  if (Math.abs(event.deltaX) > 8 && performance.now() - lastCardWheel > 800) {
    rotateCard(Math.sign(event.deltaX)); lastCardWheel = performance.now();
  }
}, { passive: false });
rotateCard(0);

// Mouse dragging mirrors a horizontal touch swipe.
let cardDrag;
carousel.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'mouse' || event.button !== 0) return;
  cardDrag = { x: event.clientX, y: event.clientY };
  carousel.setPointerCapture(event.pointerId);
});
carousel.addEventListener('pointerup', event => {
  if (!cardDrag) return;
  const dx = cardDrag.x - event.clientX;
  const dy = cardDrag.y - event.clientY;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) rotateCard(Math.sign(dx));
  cardDrag = undefined;
});
carousel.addEventListener('pointercancel', () => { cardDrag = undefined; });

const capabilityCards = [...document.querySelectorAll('.solution-network article')];
capabilityCards.forEach(card => card.addEventListener('click', () => {
  const button = card.querySelector('button');
  const expand = button.getAttribute('aria-expanded') !== 'true';
  capabilityCards.forEach(item => {
    const itemButton = item.querySelector('button');
    const open = item === card && expand;
    itemButton.setAttribute('aria-expanded', String(open));
    itemButton.nextElementSibling.hidden = !open;
  });
}));

// Keep diagram connectors attached as cards resize or expand.
const solutionNetwork = document.querySelector('.solution-network');
const connectorPath = solutionNetwork.querySelector('svg path');
function updateNetworkConnections() {
  const hub = solutionNetwork.querySelector('.network-hub');
  const sx = 1000 / solutionNetwork.clientWidth;
  const sy = 400 / solutionNetwork.clientHeight;
  const segments = [...solutionNetwork.querySelectorAll('.network-agent')].map(card => {
    const right = card.classList.contains('top-right') || card.classList.contains('bottom-right');
    const bottom = card.classList.contains('bottom-left') || card.classList.contains('bottom-right');
    const x = card.offsetLeft + (right ? 0 : card.offsetWidth);
    const y = card.offsetTop + card.offsetHeight / 2;
    const hx = hub.offsetLeft + hub.offsetWidth * (right ? .82 : .18);
    const hy = hub.offsetTop + (bottom ? hub.offsetHeight : 0);
    return `M${x * sx} ${y * sy} L${hx * sx} ${hy * sy}`;
  });
  connectorPath.setAttribute('d', segments.join(' '));
}
const networkObserver = new ResizeObserver(updateNetworkConnections);
networkObserver.observe(solutionNetwork);
solutionNetwork.querySelectorAll('article').forEach(card => networkObserver.observe(card));

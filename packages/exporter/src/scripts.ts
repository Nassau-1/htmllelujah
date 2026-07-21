/** Static, content-independent viewer runtime. It never receives deck strings. */
export const STANDALONE_VIEWER_SCRIPT = `(() => {
  "use strict";
  const viewer = document.querySelector("[data-htmllelujah-viewer]");
  if (!(viewer instanceof HTMLElement)) return;
  const stage = viewer.querySelector("[data-export-stage]");
  const counter = viewer.querySelector("[data-slide-counter]");
  const previous = viewer.querySelector("[data-action='previous']");
  const next = viewer.querySelector("[data-action='next']");
  const fullscreen = viewer.querySelector("[data-action='fullscreen']");
  const slides = Array.from(viewer.querySelectorAll("[data-export-slide]"));
  const clickNavigation = viewer.dataset.clickNavigation === "true";
  let index = Math.min(Math.max(Number(viewer.dataset.startIndex) || 0, 0), Math.max(0, slides.length - 1));

  const fit = () => {
    const slide = slides[index];
    if (!(slide instanceof HTMLElement) || !(stage instanceof HTMLElement)) return;
    const surface = slide.querySelector(".hl-slide-surface");
    if (!(surface instanceof HTMLElement)) return;
    const widthPt = Number(surface.dataset.pageWidthPt);
    const heightPt = Number(surface.dataset.pageHeightPt);
    if (!(widthPt > 0 && heightPt > 0)) return;
    const pointPx = 4 / 3;
    const scale = Math.max(0.01, Math.min(stage.clientWidth / (widthPt * pointPx), stage.clientHeight / (heightPt * pointPx)));
    surface.style.transform = "scale(" + String(scale) + ")";
    surface.style.transformOrigin = "center center";
  };

  const show = (requested) => {
    if (slides.length === 0) {
      if (counter) counter.textContent = "0 / 0";
      return;
    }
    index = Math.min(Math.max(requested, 0), slides.length - 1);
    slides.forEach((slide, slideIndex) => {
      if (!(slide instanceof HTMLElement)) return;
      const active = slideIndex === index;
      slide.hidden = !active;
      slide.setAttribute("aria-hidden", active ? "false" : "true");
    });
    if (counter) counter.textContent = String(index + 1) + " / " + String(slides.length);
    if (previous instanceof HTMLButtonElement) previous.disabled = index === 0;
    if (next instanceof HTMLButtonElement) next.disabled = index === slides.length - 1;
    fit();
  };

  const move = (delta) => show(index + delta);
  previous?.addEventListener("click", (event) => { event.stopPropagation(); move(-1); });
  next?.addEventListener("click", (event) => { event.stopPropagation(); move(1); });
  fullscreen?.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {}
  });
  stage?.addEventListener("click", (event) => {
    if (!clickNavigation || slides.length === 0) return;
    if (event.target instanceof HTMLButtonElement) return;
    move(event.clientX < window.innerWidth / 2 ? -1 : 1);
  });
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLButtonElement && (event.key === " " || event.key === "Enter")) return;
    if (["ArrowRight", "PageDown", " "].includes(event.key)) { event.preventDefault(); move(1); }
    else if (["ArrowLeft", "PageUp"].includes(event.key)) { event.preventDefault(); move(-1); }
    else if (event.key === "Home") { event.preventDefault(); show(0); }
    else if (event.key === "End") { event.preventDefault(); show(slides.length - 1); }
    else if (event.key.toLowerCase() === "f") { event.preventDefault(); fullscreen?.click(); }
  });
  window.addEventListener("resize", fit, { passive: true });
  document.addEventListener("fullscreenchange", fit);
  show(index);
})();`;

/** Static print-window readiness runtime with a bounded, content-free status marker. */
export const PRINT_READINESS_SCRIPT = `(() => {
  "use strict";
  const root = document.documentElement;
  const requested = Number(root.dataset.readinessDeadlineMs);
  const deadline = Number.isFinite(requested) ? Math.min(60000, Math.max(100, requested)) : 10000;
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const decodeImages = async () => {
    const images = Array.from(document.images);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < images.length) {
        const image = images[nextIndex++];
        if (typeof image.decode === "function") await image.decode();
        else if (!image.complete) throw new Error("decode");
      }
    };
    const workers = Array.from({ length: Math.min(4, images.length) }, () => worker());
    await Promise.all(workers);
  };
  const geometryIsExact = () => Array.from(document.querySelectorAll(".hl-slide-surface")).every((surface) => {
    if (!(surface instanceof HTMLElement)) return false;
    const widthPt = Number(surface.dataset.pageWidthPt);
    const heightPt = Number(surface.dataset.pageHeightPt);
    const rectangle = surface.getBoundingClientRect();
    return widthPt > 0 && heightPt > 0 && Math.abs(rectangle.width - widthPt * 4 / 3) <= 0.5 && Math.abs(rectangle.height - heightPt * 4 / 3) <= 0.5;
  });
  const work = (async () => {
    if (document.fonts) await document.fonts.ready;
    await decodeImages();
    await frame();
    await frame();
    if (!geometryIsExact()) throw new Error("geometry");
  })();
  let timeout;
  const boundary = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("deadline")), deadline); });
  Promise.race([work, boundary]).then(() => {
    clearTimeout(timeout);
    root.dataset.renderReady = "ready";
    root.dispatchEvent(new Event("htmllelujah:render-ready"));
  }).catch(() => {
    clearTimeout(timeout);
    root.dataset.renderReady = "failed";
    root.dispatchEvent(new Event("htmllelujah:render-failed"));
  });
})();`;

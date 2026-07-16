/** Static renderer CSS. It contains no external URL or document-provided source. */
export const RENDERER_CSS: string = `
.hl-slide-surface {
  position: relative;
  box-sizing: border-box;
  overflow: hidden;
  isolation: isolate;
  color: var(--hl-slide-text, #172033);
  background: var(--hl-slide-background, #ffffff);
  contain: layout paint style;
}
.hl-slide-surface, .hl-slide-surface * { box-sizing: border-box; }
.hl-slide-background-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  user-select: none;
}
.hl-element { margin: 0; }
.hl-text { display: flex; overflow: hidden; }
.hl-text-content { width: 100%; min-width: 0; }
.hl-text-content > :first-child { margin-top: 0; }
.hl-text-content > :last-child { margin-bottom: 0; }
.hl-text-block { margin: 0 0 0.35em; white-space: pre-wrap; overflow-wrap: break-word; }
.hl-list { margin: 0; padding-left: 1.25em; }
.hl-list-item { white-space: pre-wrap; overflow-wrap: break-word; }
.hl-image { overflow: hidden; }
.hl-image img { display: block; width: 100%; height: 100%; user-select: none; }
.hl-missing-asset { display: grid; place-items: center; width: 100%; height: 100%; color: #697386; background: #eef1f5; }
.hl-table { overflow: hidden; }
.hl-table table { width: 100%; height: 100%; border-collapse: collapse; table-layout: fixed; }
.hl-table th, .hl-table td { overflow: hidden; }
.hl-vector, .hl-connector { display: block; overflow: visible; }
.hl-group { overflow: visible; }
.hl-group-space { position: relative; transform-origin: top left; }
.hl-icon { display: grid; place-items: center; overflow: hidden; container-type: size; }
.hl-icon svg { width: 100%; height: 100%; }
.hl-flag { width: 100%; height: 100%; display: grid; place-items: center; overflow: hidden; border-radius: 9999px; background: #eef1f5; line-height: 1; }
.hl-placeholder { display: grid; place-items: center; padding: 6pt; border: 1pt dashed #6f7f98; color: #53647d; background: rgb(255 255 255 / 68%); text-align: center; }
.hl-editor-overlay { position: absolute; inset: 0; z-index: 2147483647; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.hl-selection-outline { fill: none; stroke: #2864dc; vector-effect: non-scaling-stroke; }
.hl-selection-handle { fill: #ffffff; stroke: #2864dc; vector-effect: non-scaling-stroke; }
.hl-smart-guide { stroke: #d42a87; vector-effect: non-scaling-stroke; }
.hl-mode-thumbnail .hl-text-block { text-rendering: geometricPrecision; }
.hl-mode-pdf, .hl-mode-html, .hl-mode-presentation { user-select: none; }
@media print {
  .hl-slide-surface { break-after: page; box-shadow: none !important; }
  .hl-slide-surface:last-child { break-after: auto; }
}
`;

import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type AlignMode,
  type SlideElement,
  type SmartGuides,
} from './model';

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function roundGeometry(value: number): number {
  return Math.round(value * 10) / 10;
}

export function snapToGrid(value: number, enabled: boolean, step = 12): number {
  return enabled ? Math.round(value / step) * step : value;
}

function axes(element: SlideElement): { x: number[]; y: number[] } {
  return {
    x: [element.x, element.x + element.width / 2, element.x + element.width],
    y: [element.y, element.y + element.height / 2, element.y + element.height],
  };
}

export function moveWithSmartGuides(
  element: SlideElement,
  targetX: number,
  targetY: number,
  siblings: SlideElement[],
  threshold: number,
  gridEnabled: boolean,
): { x: number; y: number; guides: SmartGuides } {
  let x = snapToGrid(targetX, gridEnabled);
  let y = snapToGrid(targetY, gridEnabled);
  const probe = { ...element, x, y };
  const movingAxes = axes(probe);
  const targetAxesX = [0, SLIDE_WIDTH / 2, SLIDE_WIDTH];
  const targetAxesY = [0, SLIDE_HEIGHT / 2, SLIDE_HEIGHT];

  for (const sibling of siblings) {
    const siblingAxes = axes(sibling);
    targetAxesX.push(...siblingAxes.x);
    targetAxesY.push(...siblingAxes.y);
  }

  let bestX: { delta: number; guide: number } | undefined;
  let bestY: { delta: number; guide: number } | undefined;

  for (const moving of movingAxes.x) {
    for (const target of targetAxesX) {
      const delta = target - moving;
      if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
        bestX = { delta, guide: target };
      }
    }
  }

  for (const moving of movingAxes.y) {
    for (const target of targetAxesY) {
      const delta = target - moving;
      if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
        bestY = { delta, guide: target };
      }
    }
  }

  if (bestX) x += bestX.delta;
  if (bestY) y += bestY.delta;

  return {
    x: roundGeometry(clamp(x, 0, SLIDE_WIDTH - element.width)),
    y: roundGeometry(clamp(y, 0, SLIDE_HEIGHT - element.height)),
    guides: {
      vertical: bestX ? [bestX.guide] : [],
      horizontal: bestY ? [bestY.guide] : [],
    },
  };
}

export function alignElements(
  elements: SlideElement[],
  selectedIds: string[],
  mode: AlignMode,
): SlideElement[] {
  const selected = elements.filter((element) => selectedIds.includes(element.id));
  if (selected.length < 2) return elements;

  const left = Math.min(...selected.map((element) => element.x));
  const right = Math.max(...selected.map((element) => element.x + element.width));
  const top = Math.min(...selected.map((element) => element.y));
  const bottom = Math.max(...selected.map((element) => element.y + element.height));
  const center = (left + right) / 2;
  const middle = (top + bottom) / 2;

  if (mode === 'distribute-horizontal' || mode === 'distribute-vertical') {
    if (selected.length < 3) return elements;
    const horizontal = mode === 'distribute-horizontal';
    const sorted = [...selected].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    const first = sorted[0];
    const last = sorted.at(-1);
    if (!first || !last) return elements;
    const totalSize = sorted.reduce(
      (sum, element) => sum + (horizontal ? element.width : element.height),
      0,
    );
    const span = horizontal ? last.x + last.width - first.x : last.y + last.height - first.y;
    const gap = (span - totalSize) / (sorted.length - 1);
    let cursor = horizontal ? first.x : first.y;
    const positions = new Map<string, number>();
    for (const element of sorted) {
      positions.set(element.id, cursor);
      cursor += (horizontal ? element.width : element.height) + gap;
    }
    return elements.map((element) => {
      const position = positions.get(element.id);
      if (position === undefined) return element;
      return horizontal
        ? { ...element, x: roundGeometry(position) }
        : { ...element, y: roundGeometry(position) };
    });
  }

  return elements.map((element) => {
    if (!selectedIds.includes(element.id)) return element;
    switch (mode) {
      case 'left':
        return { ...element, x: left };
      case 'center':
        return { ...element, x: roundGeometry(center - element.width / 2) };
      case 'right':
        return { ...element, x: roundGeometry(right - element.width) };
      case 'top':
        return { ...element, y: top };
      case 'middle':
        return { ...element, y: roundGeometry(middle - element.height / 2) };
      case 'bottom':
        return { ...element, y: roundGeometry(bottom - element.height) };
      default:
        return element;
    }
  });
}

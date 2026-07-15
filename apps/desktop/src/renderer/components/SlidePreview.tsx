import type { CSSProperties } from 'react';

import type { Slide, SlideElement } from '../editor/model';

type SlidePreviewProps = {
  slide: Slide;
  index: number;
  selected: boolean;
  onSelect: () => void;
};

type TokenStyle = CSSProperties & Record<`--${string}`, string | number>;

function PreviewElement({ element }: { element: SlideElement }) {
  const style: TokenStyle = {
    '--element-x': `${element.x}px`,
    '--element-y': `${element.y}px`,
    '--element-width': `${element.width}px`,
    '--element-height': `${element.height}px`,
    '--element-rotation': `${element.rotation}deg`,
  };

  if (element.kind === 'text') {
    style['--element-font-size'] = `${element.fontSize}px`;
  }

  return (
    <div
      className={`preview-element preview-${element.kind} fill-${element.fill}`}
      style={style}
      aria-hidden="true"
    >
      {element.kind === 'text' ? element.text : null}
      {element.kind === 'shape' ? element.label : null}
      {element.kind === 'image' ? <div className="preview-image-mark" /> : null}
      {element.kind === 'table' ? (
        <div className="preview-table">
          {element.rows.map((row, rowIndex) =>
            row.map((_cell, columnIndex) => (
              <span
                key={`${rowIndex}-${columnIndex}`}
                className={rowIndex === 0 ? 'is-header' : ''}
              />
            )),
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SlidePreview({ slide, index, selected, onSelect }: SlidePreviewProps) {
  return (
    <button
      type="button"
      className={`slide-thumbnail ${selected ? 'is-selected' : ''}`}
      onClick={onSelect}
      aria-label={`Open slide ${index + 1}: ${slide.title}`}
      aria-current={selected ? 'page' : undefined}
    >
      <span className="slide-number">{index + 1}</span>
      <span className="thumbnail-frame">
        <span className="thumbnail-stage">
          {slide.elements.map((element) => (
            <PreviewElement key={element.id} element={element} />
          ))}
        </span>
      </span>
      <span className="thumbnail-title">{slide.title}</span>
    </button>
  );
}

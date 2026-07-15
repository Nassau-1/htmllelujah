export const SLIDE_WIDTH = 960;
export const SLIDE_HEIGHT = 540;

export type ElementKind = 'text' | 'shape' | 'image' | 'table';
export type ElementFill = 'none' | 'accent' | 'accent-soft' | 'ink' | 'mint' | 'warm';

export type ElementFrame = {
  id: string;
  kind: ElementKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fill: ElementFill;
};

export type TextElement = ElementFrame & {
  kind: 'text';
  text: string;
  fontSize: number;
  fontWeight: 400 | 500 | 600 | 700;
  align: 'left' | 'center' | 'right';
  role: 'title' | 'subtitle' | 'body' | 'caption' | 'metric';
};

export type ShapeElement = ElementFrame & {
  kind: 'shape';
  shape: 'rectangle' | 'rounded' | 'ellipse';
  label: string;
};

export type ImageElement = ElementFrame & {
  kind: 'image';
  label: string;
  caption: string;
};

export type TableElement = ElementFrame & {
  kind: 'table';
  rows: string[][];
};

export type SlideElement = TextElement | ShapeElement | ImageElement | TableElement;

export type Slide = {
  id: string;
  title: string;
  section: string;
  elements: SlideElement[];
};

export type Deck = {
  id: string;
  title: string;
  slides: Slide[];
};

export type SmartGuides = {
  vertical: number[];
  horizontal: number[];
};

export type AlignMode =
  | 'left'
  | 'center'
  | 'right'
  | 'top'
  | 'middle'
  | 'bottom'
  | 'distribute-horizontal'
  | 'distribute-vertical';

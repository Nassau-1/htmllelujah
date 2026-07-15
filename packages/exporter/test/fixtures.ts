import { createHash } from 'node:crypto';

import {
  createNeutralDemoDeck,
  type AssetRef,
  type DeckDocument,
  type ImageElement,
  type Slide,
  type TextElement,
} from '@htmllelujah/document-core';

const visibleBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const hiddenBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZAAAAABJRU5ErkJggg==',
  'base64',
);

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const assetRef = (id: string, bytes: Uint8Array, fileName: string): AssetRef => ({
  id,
  kind: 'image',
  hash: hash(bytes),
  mediaType: 'image/png',
  fileName,
  byteLength: bytes.byteLength,
  widthPx: 1,
  heightPx: 1,
});

const imageElement = (id: string, assetId: string, name: string): ImageElement => ({
  id,
  name,
  type: 'image',
  assetId,
  altText: 'Image " onerror="globalThis.compromised=true',
  fit: 'contain',
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
  frame: { xPt: 700, yPt: 410, widthPt: 100, heightPt: 80, rotationDeg: 0 },
  opacity: 1,
  visible: true,
  locked: false,
});

const hostileText = (element: TextElement): TextElement => ({
  ...element,
  content: {
    blocks: [
      {
        id: '30000000-0000-4000-8000-000000000001',
        type: 'paragraph',
        alignment: 'left',
        runs: [
          {
            text: 'Unicode — 日本語 — 😀 </script><script>globalThis.compromised=true</script>',
            marks: {
              bold: true,
              italic: false,
              underline: false,
              strikethrough: false,
            },
          },
        ],
      },
    ],
  },
});

export const createExportFixture = (): Readonly<{
  deck: DeckDocument;
  assets: ReadonlyMap<string, Uint8Array>;
  visibleAssetId: string;
  hiddenAssetId: string;
  visibleBytes: Uint8Array;
  hiddenBytes: Uint8Array;
}> => {
  const source = createNeutralDemoDeck();
  const visibleAssetId = '40000000-0000-4000-8000-000000000001';
  const hiddenAssetId = '40000000-0000-4000-8000-000000000002';
  const first = source.slides[0];
  const second = source.slides[1];
  const third = source.slides[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error('Neutral fixture is incomplete.');
  }
  const firstText = first.elements.find(
    (element): element is TextElement => element.type === 'text',
  );
  if (firstText === undefined) throw new Error('Neutral fixture text is missing.');
  const visibleSlide: Slide = {
    ...first,
    name: 'Visible </title><script>unsafe</script>',
    elements: [
      ...first.elements.map((element) =>
        element.id === firstText.id ? hostileText(firstText) : element,
      ),
      imageElement('41000000-0000-4000-8000-000000000001', visibleAssetId, 'Visible image'),
    ],
  };
  const hiddenSlide: Slide = {
    ...third,
    hidden: true,
    name: 'HIDDEN_SLIDE_SECRET',
    elements: [
      ...third.elements,
      imageElement('41000000-0000-4000-8000-000000000002', hiddenAssetId, 'HIDDEN_ASSET_SECRET'),
    ],
  };
  const deck: DeckDocument = {
    ...source,
    name: 'Deck </title><script>unsafe</script> & Unicode 😀',
    slides: [visibleSlide, second, hiddenSlide],
    assets: [
      assetRef(visibleAssetId, visibleBytes, 'private-visible.png'),
      assetRef(hiddenAssetId, hiddenBytes, 'private-hidden.png'),
    ],
  };
  return {
    deck,
    assets: new Map([
      [visibleAssetId, visibleBytes],
      [hiddenAssetId, hiddenBytes],
    ]),
    visibleAssetId,
    hiddenAssetId,
    visibleBytes,
    hiddenBytes,
  };
};

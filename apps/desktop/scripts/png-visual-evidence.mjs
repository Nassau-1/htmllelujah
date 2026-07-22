import { inflateSync } from 'node:zlib';

export const visualThresholds = Object.freeze({
  minimumQuantizedColors: 16,
  maximumDominantColorRatio: 0.98,
  minimumLuminanceStandardDeviation: 8,
  minimumDarkPixelRatio: 0.001,
  minimumLightPixelRatio: 0.1,
  minimumEdgeRatio: 0.001,
});

const paeth = (left, up, upperLeft) => {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
};

const decodePng = (bytes) => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error('Visual evidence is not a valid PNG.');
  }
  let offset = 8;
  let header;
  const imageData = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > 32 * 1024 * 1024 || dataEnd + 4 > bytes.length) {
      throw new Error('PNG chunk bounds are invalid.');
    }
    if (type === 'IHDR') header = bytes.subarray(dataStart, dataEnd);
    else if (type === 'IDAT') imageData.push(bytes.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (header?.length !== 13 || imageData.length === 0) {
    throw new Error('PNG header or image data is missing.');
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  if (
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    bitDepth !== 8 ||
    (colorType !== 2 && colorType !== 6) ||
    header[10] !== 0 ||
    header[11] !== 0 ||
    header[12] !== 0
  ) {
    throw new Error('PNG visual evidence uses an unsupported encoding.');
  }
  const channels = colorType === 2 ? 3 : 4;
  const rowBytes = width * channels;
  const expectedInflatedLength = (rowBytes + 1) * height;
  const inflated = inflateSync(Buffer.concat(imageData), {
    maxOutputLength: expectedInflatedLength,
  });
  if (inflated.length !== expectedInflatedLength) {
    throw new Error('PNG visual evidence has an unexpected decoded size.');
  }
  const pixels = Buffer.allocUnsafe(rowBytes * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[sourceOffset++];
    if (filter > 4) throw new Error('PNG visual evidence uses an invalid row filter.');
    const rowOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const encoded = inflated[sourceOffset++];
      const left = column >= channels ? pixels[rowOffset + column - channels] : 0;
      const up = row > 0 ? pixels[rowOffset + column - rowBytes] : 0;
      const upperLeft =
        row > 0 && column >= channels ? pixels[rowOffset + column - rowBytes - channels] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, upperLeft);
      pixels[rowOffset + column] = (encoded + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
};

export const analyzeRgbVisual = ({ width, height, channels, pixels }) => {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    (channels !== 3 && channels !== 4) ||
    pixels.length !== width * height * channels
  ) {
    throw new Error('RGB visual buffer dimensions are invalid.');
  }
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 320));
  const quantizedColors = new Map();
  const previousRow = new Float64Array(Math.ceil(width / stride));
  let sampleCount = 0;
  let luminanceSum = 0;
  let luminanceSquareSum = 0;
  let darkPixels = 0;
  let lightPixels = 0;
  let edgeCount = 0;
  let edgeCandidates = 0;
  let sampleRow = 0;
  for (let y = 0; y < height; y += stride) {
    let previousLuminance;
    let sampleColumn = 0;
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * channels;
      const alpha = channels === 4 ? pixels[offset + 3] / 255 : 1;
      const red = Math.round(pixels[offset] * alpha + 255 * (1 - alpha));
      const green = Math.round(pixels[offset + 1] * alpha + 255 * (1 - alpha));
      const blue = Math.round(pixels[offset + 2] * alpha + 255 * (1 - alpha));
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const colorKey = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
      quantizedColors.set(colorKey, (quantizedColors.get(colorKey) ?? 0) + 1);
      sampleCount += 1;
      luminanceSum += luminance;
      luminanceSquareSum += luminance * luminance;
      if (luminance < 80) darkPixels += 1;
      if (luminance > 240) lightPixels += 1;
      if (previousLuminance !== undefined) {
        edgeCandidates += 1;
        if (Math.abs(luminance - previousLuminance) > 24) edgeCount += 1;
      }
      if (sampleRow > 0) {
        edgeCandidates += 1;
        if (Math.abs(luminance - previousRow[sampleColumn]) > 24) edgeCount += 1;
      }
      previousRow[sampleColumn] = luminance;
      previousLuminance = luminance;
      sampleColumn += 1;
    }
    sampleRow += 1;
  }
  const mean = luminanceSum / sampleCount;
  const variance = Math.max(0, luminanceSquareSum / sampleCount - mean * mean);
  const standardDeviation = variance < 1e-8 ? 0 : Math.sqrt(variance);
  const dominantColorCount = Math.max(...quantizedColors.values());
  const metrics = {
    sampleCount,
    quantizedColorCount: quantizedColors.size,
    dominantColorRatio: dominantColorCount / sampleCount,
    luminanceStandardDeviation: standardDeviation,
    darkPixelRatio: darkPixels / sampleCount,
    lightPixelRatio: lightPixels / sampleCount,
    edgeRatio: edgeCandidates === 0 ? 0 : edgeCount / edgeCandidates,
  };
  const failures = [];
  if (metrics.quantizedColorCount < visualThresholds.minimumQuantizedColors)
    failures.push('quantized colors');
  if (metrics.dominantColorRatio >= visualThresholds.maximumDominantColorRatio)
    failures.push('dominant color');
  if (metrics.luminanceStandardDeviation < visualThresholds.minimumLuminanceStandardDeviation)
    failures.push('luminance variance');
  if (metrics.darkPixelRatio < visualThresholds.minimumDarkPixelRatio) failures.push('dark pixels');
  if (metrics.lightPixelRatio < visualThresholds.minimumLightPixelRatio)
    failures.push('light pixels');
  if (metrics.edgeRatio < visualThresholds.minimumEdgeRatio) failures.push('edges');
  return { ...metrics, passed: failures.length === 0, failures };
};

export const analyzePngVisual = (bytes) => {
  const decoded = decodePng(bytes);
  return {
    widthPx: decoded.width,
    heightPx: decoded.height,
    ...analyzeRgbVisual(decoded),
  };
};

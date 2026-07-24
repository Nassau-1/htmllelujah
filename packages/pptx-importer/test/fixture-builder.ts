import { deflateRawSync } from 'node:zlib';

import { crc32 } from '../src/zip.js';

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;

export interface SyntheticZipEntry {
  readonly name: string;
  readonly content: string | Uint8Array;
  readonly method?: 0 | 8 | number | undefined;
  readonly flags?: number | undefined;
}

const uint16 = (value: number): Buffer => {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
};

const uint32 = (value: number): Buffer => {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
};

export const createSyntheticZip = (entries: readonly SyntheticZipEntry[]): Uint8Array => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const source =
      typeof entry.content === 'string'
        ? Buffer.from(entry.content, 'utf8')
        : Buffer.from(entry.content);
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(source) : source;
    const flags = UTF8_FLAG | (entry.flags ?? 0);
    const checksum = crc32(source);
    const local = Buffer.concat([
      uint32(LOCAL_FILE_SIGNATURE),
      uint16(20),
      uint16(flags),
      uint16(method),
      uint16(0),
      uint16(0),
      uint32(checksum),
      uint32(compressed.byteLength),
      uint32(source.byteLength),
      uint16(name.byteLength),
      uint16(0),
      name,
      compressed,
    ]);
    localParts.push(local);
    centralParts.push(
      Buffer.concat([
        uint32(CENTRAL_FILE_SIGNATURE),
        uint16(20),
        uint16(20),
        uint16(flags),
        uint16(method),
        uint16(0),
        uint16(0),
        uint32(checksum),
        uint32(compressed.byteLength),
        uint32(source.byteLength),
        uint16(name.byteLength),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(localOffset),
        name,
      ]),
    );
    localOffset += local.byteLength;
  }
  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    uint32(END_SIGNATURE),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(central.byteLength),
    uint32(localOffset),
    uint16(0),
  ]);
};

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`;

const rootRelationshipsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
</p:presentation>`;

const presentationRelationshipsXml = (
  extraRelationship = '',
): string => `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  ${extraRelationship}
</Relationships>`;

const masterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld name="Executive master">
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Master title"/><p:cNvSpPr/><p:nvPr><p:ph type="title" idx="0"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="10058400" cy="914400"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:t>Board update</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Footer"/><p:cNvSpPr/><p:nvPr><p:ph type="ftr" idx="10"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="6400800"/><a:ext cx="4572000" cy="228600"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:t>Confidential</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:pic/>
    </p:spTree>
  </p:cSld>
  <p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst>
  <p:hf dt="0" ftr="1" sldNum="1"/>
</p:sldMaster>`;

const masterRelationshipsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;

const layoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="titleAndContent">
  <p:cSld name="Title and content">
    <p:spTree>
      <p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title" idx="0"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="10058400" cy="914400"/></a:xfrm></p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`;

const layoutRelationshipsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;

export const defaultThemeXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Board theme">
  <a:themeElements>
    <a:clrScheme name="Board">
      <a:dk1><a:sysClr val="windowText" lastClr="111827"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:accent1><a:srgbClr val="2563EB"/></a:accent1>
      <a:accent2><a:srgbClr val="14B8A6"/></a:accent2>
    </a:clrScheme>
    <a:fontScheme name="Board fonts">
      <a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont>
      <a:minorFont><a:latin typeface="Aptos"/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`;

const slideXml = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld>
</p:sld>`;

export interface PresentationFixtureOptions {
  readonly method?: 0 | 8 | undefined;
  readonly extraPresentationRelationship?: string | undefined;
  readonly themeXml?: string | undefined;
  readonly extraEntries?: readonly SyntheticZipEntry[] | undefined;
}

export const presentationFixtureEntries = (
  options: PresentationFixtureOptions = {},
): readonly SyntheticZipEntry[] => {
  const method = options.method ?? 0;
  const entry = (name: string, content: string): SyntheticZipEntry => ({
    name,
    content,
    method,
  });
  return [
    entry('[Content_Types].xml', contentTypesXml),
    entry('_rels/.rels', rootRelationshipsXml),
    entry('ppt/presentation.xml', presentationXml),
    entry(
      'ppt/_rels/presentation.xml.rels',
      presentationRelationshipsXml(options.extraPresentationRelationship),
    ),
    entry('ppt/slideMasters/slideMaster1.xml', masterXml),
    entry('ppt/slideMasters/_rels/slideMaster1.xml.rels', masterRelationshipsXml),
    entry('ppt/slideLayouts/slideLayout1.xml', layoutXml),
    entry('ppt/slideLayouts/_rels/slideLayout1.xml.rels', layoutRelationshipsXml),
    entry('ppt/theme/theme1.xml', options.themeXml ?? defaultThemeXml),
    entry('ppt/slides/slide1.xml', slideXml),
    ...(options.extraEntries ?? []),
  ];
};

export const createPresentationFixture = (options: PresentationFixtureOptions = {}): Uint8Array =>
  createSyntheticZip(presentationFixtureEntries(options));

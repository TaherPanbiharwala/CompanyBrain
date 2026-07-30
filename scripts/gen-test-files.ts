// Generates the binary fixtures test/extract.test.ts runs against.
//
// HONEST LIMITATION, stated here so it is not mistaken for coverage: a PDF this script generates is
// the easiest PDF in existence. Real extraction failure lives in two-column layouts, page-spanning
// tables, ligatures, rotated scans, and Devanagari/Tamil text — none of which a generator produces.
// These fixtures prove the PLUMBING works (detect -> spawn -> parse -> blocks -> locators) and prove
// the specific corruption classes the extractors guard against. They do NOT prove the parsers handle
// real documents. Drop genuinely messy files into test/fixtures/formats/ and the suite picks them up.
//
//   bun run gen:test-files
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as XLSX from 'xlsx';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'formats');
mkdirSync(OUT, { recursive: true });

// ── PDF ────────────────────────────────────────────────────────────────────
// Hand-built: PDFs are ASCII-structured, so this needs no dependency and stays reviewable in a diff.
// Page 2 is deliberately EMPTY — that is the scanned-page case (no text layer), and it must show up
// as unitsSkipped rather than as a silent success.
function buildPdf(): Uint8Array {
  const page1 = `BT /F1 14 Tf 72 720 Td (Northstar quarterly revenue was 4.2 crore in Q3.) Tj ET`;
  const page2 = ``; // no text operators at all
  const objs: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 7 0 R >>`,
    `<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
writeFileSync(join(OUT, 'sample.pdf'), buildPdf());

// ── DOCX ───────────────────────────────────────────────────────────────────
// A docx is a zip of three XML parts. Built with `zip` so there is no writer dependency.
const dx = join(OUT, '.docx-build');
rmSync(dx, { recursive: true, force: true });
mkdirSync(join(dx, '_rels'), { recursive: true });
mkdirSync(join(dx, 'word'), { recursive: true });
writeFileSync(
  join(dx, '[Content_Types].xml'),
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
);
writeFileSync(
  join(dx, '_rels', '.rels'),
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
);
writeFileSync(
  join(dx, 'word', 'document.xml'),
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Renewal terms</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>Finch asked for a 12 percent discount on the per-robot fee.</w:t></w:r></w:p>` +
    `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Counter-offer</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>Rohan approved 8 percent for a two-year term.</w:t></w:r></w:p>` +
    `</w:body></w:document>`,
);
await Bun.spawn(['zip', '-qr', join(OUT, 'sample.docx'), '.'], { cwd: dx }).exited;
rmSync(dx, { recursive: true, force: true });

// ── XLSX ───────────────────────────────────────────────────────────────────
// Every hazard the extractor guards against, in one workbook:
//   A1:D1 merged title  -> must NOT become the header
//   blank row 2         -> header is row 3, not row 0
//   a real Date         -> must emit ISO, not the serial 45123
//   an uncached formula -> must count as skipped, not extract as blank
//   a second sheet      -> the search fixture: a value that exists ONLY here
XLSX.set_fs(fs); // required under Bun before writeFile — SheetJS does not auto-bind fs in ESM
const wb = XLSX.utils.book_new();

const s1 = XLSX.utils.aoa_to_sheet([
  ['Q3 Invoice — Northstar Robotics', '', '', ''],
  [],
  ['Item', 'Qty', 'Rate', 'Date'],
  ['Robot arm', 3, 123456, new Date(Date.UTC(2026, 2, 12))],
  ['Gripper', 12, 4200, new Date(Date.UTC(2026, 2, 14))],
]);
s1['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
s1['E4'] = { t: 'n', f: 'B4*C4' } as XLSX.CellObject; // formula, NO cached value
// aoa_to_sheet computed !ref before E4 existed, so the range must be widened or the extractor never
// visits the cell — and the very hazard this fixture exists to prove would go untested.
s1['!ref'] = 'A1:E5';
XLSX.utils.book_append_sheet(wb, s1, 'Invoice');

const s2 = XLSX.utils.aoa_to_sheet([
  ['Region', 'Owner', 'Committed'],
  ...Array.from({ length: 44 }, (_, i) => [`Region ${i + 1}`, `Owner ${i + 1}`, (i + 1) * 1000]),
]);
// Row 40 of the sheet body — the end-to-end search gate looks for this exact token.
s2['B41'] = { t: 's', v: 'zzsentinelrow40' } as XLSX.CellObject;
XLSX.utils.book_append_sheet(wb, s2, 'Territories');
XLSX.writeFile(wb, join(OUT, 'sample.xlsx'));

// ── The library-free formats ───────────────────────────────────────────────
writeFileSync(
  join(OUT, 'sample.csv'),
  'Item,Qty,Rate\nRobot arm,3,123456\nGripper,12,4200\n"Cable, braided",5,900\n',
);
writeFileSync(
  join(OUT, 'sample.json'),
  JSON.stringify({ pricing: { starter: { perRobot: 4500, cap: 10 }, growth: { perRobot: 3900, platformFee: 25000 } } }, null, 2),
);
writeFileSync(
  join(OUT, 'sample.html'),
  `<html><head><title>Routing engine</title></head><body><h1>Routing engine</h1><p>Time-window reservation over a warehouse graph.</p><table><tr><td>Falcon</td><td>shipped</td></tr></table><script>var x=1</script></body></html>`,
);
// Named .txt but actually a PDF — the magic-byte test. An extension-trusting detector chunks this as
// prose and embeds binary noise at real cost.
writeFileSync(join(OUT, 'liar.txt'), buildPdf());
// A format we do not support, for the unsupported_format path.
writeFileSync(join(OUT, 'sample.bin'), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 1, 2, 3]));

console.log(`wrote fixtures to ${OUT}`);

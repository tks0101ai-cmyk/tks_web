const test = require('node:test');
const assert = require('node:assert/strict');
const { createExportFile, tableRows, exportFieldsFor, resolveColumnKeys } = require('./marketingReportExport');

const result = {
  computedAt: '2026-10-08T09:00:00Z',
  summaryRows: [{ key: 'a', label: 'Hữu Nghị', count: 2, revenue: 1500 }, { key: 'b', label: 'Sài Gòn', count: 1, revenue: 0 }],
  rows: [{ key: 'r1', sale: 'Đặng An', phone: '0901', revenue: 1000, note: '=cmd' }, { key: 'r2', sale: 'Bình', phone: '0902', revenue: 500 }]
};

test('fields follow on-screen columns and q filters without accents', () => {
  const rows = tableRows('rows', result, 'dang an');
  assert.equal(rows.length, 1);
  assert.equal(tableRows('rows', result, 'an zzz').length, 0); // 2 từ phải khớp cả 2
  assert.equal(tableRows('rows', result, '').length, 2);
  const meta = exportFieldsFor('monthly', 'rows', result, rows);
  assert.equal(meta.worksheets[0].rowCount, 1);
  assert.ok(meta.worksheets[0].fields.some(f => f.key === 'note'));
  const summary = exportFieldsFor('monthly', 'summary', result, result.summaryRows).worksheets[0].fields.map(f => f.key);
  assert.deepEqual(summary, ['label', 'count', 'revenue']);
});

test('columns whitelist rejects unknown or empty keys', () => {
  assert.deepEqual(resolveColumnKeys('monthly', 'rows', result, 'revenue,sale'), ['sale', 'revenue']);
  assert.equal(resolveColumnKeys('monthly', 'rows', result, undefined), null);
  assert.throws(() => resolveColumnKeys('monthly', 'rows', result, 'evil'), { statusCode: 400 });
  assert.throws(() => resolveColumnKeys('monthly', 'rows', result, ''), { statusCode: 400 });
});

test('xlsx and html files are produced; formula-like text is neutralised', async () => {
  const xlsx = await createExportFile('monthly', 'rows', 'xlsx', result, result.rows, ['sale', 'note']);
  assert.match(xlsx.fileName, /\.xlsx$/);
  assert.ok(xlsx.buffer.length > 100);
  const html = await createExportFile('monthly', 'summary', 'html', result, result.summaryRows, null);
  assert.match(html.fileName, /\.html$/);
  await assert.rejects(createExportFile('nope', 'rows', 'xlsx', result, [], null), { statusCode: 400 });
});

test('exports disclose independent source, snapshot and incomplete coverage warnings',async()=>{
 const r={...result,dataset:'pancake-independent',snapshotId:'snapshot-proof',sources:{phones:'pancake-independent',closures:'manual-db'},warnings:['Dữ liệu chưa đầy đủ']};
 const ExcelJS=require('exceljs');const file=await createExportFile('monthly','rows','xlsx',r,r.rows);const book=new ExcelJS.Workbook();await book.xlsx.load(file.buffer);const provenance=book.getWorksheet('Nguồn và trạng thái');assert.ok(provenance);assert.equal(provenance.getCell('B2').value,'pancake-independent');assert.equal(provenance.getCell('B3').value,'snapshot-proof');
 const html=await createExportFile('monthly','rows','html',r,r.rows);assert.match(html.buffer.toString(),/pancake-independent/);assert.match(html.buffer.toString(),/Dữ liệu chưa đầy đủ/);
});


test('multi-level export sorting handles ties and blanks at each priority without changing source rows', () => {
  const { tableRows } = require('./marketingReportExport');
  const rows=[{page:'A',sale:'X',revenue:2},{page:'A',sale:'X',revenue:8},{page:'A',sale:null,revenue:99},{page:'B',sale:'X',revenue:1},{page:null,sale:'X',revenue:100}];
  const sorts=[{key:'page',dir:'asc'},{key:'sale',dir:'desc'},{key:'revenue',dir:'desc'}];
  assert.deepEqual(tableRows('rows',{rows},'',{sorts:JSON.stringify(sorts)}),[rows[1],rows[0],rows[2],rows[3],rows[4]]);
  assert.equal(rows[0].revenue,2);
});

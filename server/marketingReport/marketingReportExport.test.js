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


test('server pages the full searched/sorted snapshot, clamps pages, and keeps full metadata and search KPI scope', () => {
  const {pageResult,tableRows}=require('./marketingReportExport');
  const rows=Array.from({length:245},(_,i)=>({key:'row:'+i,customer:i>=200?'Khách Đặng An':'Khách khác',sale:'Sale '+i%3,page:'HN',revenue:i+0.25}));
  const snapshot={kind:'monthly',rows,kpis:[{label:'Doanh số tháng',value:30000},{label:'Khách chốt',value:245},{label:'Số nhân viên',value:3}],summaryRows:[{label:'Full summary',closed:245}],charts:[{labels:['Full chart'],values:[245]}],filters:{pages:['HN','SG']},snapshotId:'full-id'};
  const first=pageResult(snapshot,{pageSize:'100'});
  assert.equal(first.rows.length,100);assert.equal(first.totalRows,245);assert.equal(first.page,1);
  const last=pageResult(snapshot,{pageNumber:'999',pageSize:'100'});
  assert.equal(last.page,3);assert.equal(last.rows.length,45);assert.equal(last.rows[0].key,'row:200');
  const query={q:'dang an',sorts:JSON.stringify([{key:'sale',dir:'asc'},{key:'revenue',dir:'desc'},{key:'__proto__',dir:'asc'}]),pageNumber:'2',pageSize:'10'};
  const searched=pageResult(snapshot,query),full=tableRows('rows',snapshot,query.q,query);
  assert.equal(searched.totalRows,45);assert.deepEqual(searched.rows,full.slice(10,20));
  assert.equal(searched.kpis[0].value,full.reduce((n,row)=>n+row.revenue,0));assert.equal(searched.kpis[1].value,45);
  assert.equal(searched.summaryRows,snapshot.summaryRows);assert.equal(searched.filters,snapshot.filters);assert.equal(searched.charts,snapshot.charts);assert.equal(searched.snapshotId,'full-id');
  assert.equal(snapshot.rows.length,245);assert.equal(snapshot.kpis[1].value,245);
  assert.deepEqual(pageResult(snapshot,{q:'notfound',pageNumber:'99'}).rows,[]);
  assert.equal(pageResult(snapshot,{q:'notfound',pageNumber:'99'}).page,1);
  assert.equal(pageResult(snapshot,{pageSize:'9999'}).pageSize,500);
  assert.equal(pageResult(snapshot,{pageSize:'0',pageNumber:'Infinity'}).pageSize,100);
});

test('dates sort by source date across pages, blank last, and unknown sort keys are ignored',()=>{
  const {pageResult}=require('./marketingReportExport');
  const result={kind:'costs',rows:[{key:'a',date:'02/11/2026',totalCost:2},{key:'b',date:'30/10/2026',totalCost:1},{key:'c',date:null,totalCost:3}]};
  const page=pageResult(result,{pageNumber:'2',pageSize:'1',sorts:JSON.stringify([{key:'date',dir:'asc'}])});
  assert.equal(page.rows[0].key,'a');
  assert.equal(pageResult(result,{sorts:JSON.stringify([{key:'key',dir:'desc'}])}).rows[0].key,'a');
});

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('xlsx'),require('./purchase-calculations'));
  else root.PurchaseExcel = factory(root.XLSX,root.PurchaseCalculations);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (XLSX,C) {
  'use strict';
  const numericTypes = new Set(['num', 'num1', 'num2', 'num3', 'num4', 'cny', 'money', 'pct', 'ratio']);
  const labels = { productName: 'Tên SP (Việt)', productNameCn: 'Tên SP (Trung)', literDiff: 'Lệch L/c (%)', gramDiff: 'Lệch g/c (%)' };
  const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const caption = col => labels[col.k] || (col.cn ? col.l + ' · ' + col.cn : col.l);
  const writable = col => col.k === 'rowKey' || !col.d && !col.m && !col.ro && !['container', 'status'].includes(col.k);
  const importColumns = columns => columns.filter(col => writable(col));

  function exportWorkbook(rows, columns, visibleKeys) {
    const selected = new Set(visibleKeys || columns.map(col => col.k));
    const cols = [columns.find(col => col.k === 'rowKey'), ...columns.filter(col => col.k !== 'rowKey' && selected.has(col.k))].filter(Boolean);
    const data = [cols.map(caption), ...rows.map(row => cols.map(col => row[col.k] ?? null))];
    const sheet = XLSX.utils.aoa_to_sheet(data);
    cols.forEach((col,c)=>{if(!numericTypes.has(col.t))return;const digits=col.decimals??({num:0,num1:1,num2:2,num4:4,money:0})[col.t],format=col.t==='ratio'?'0.0%':col.t==='pct'?'+0%;-0%;0%':digits!=null?'#,##0'+(digits?'.'+'0'.repeat(digits):''):'#,##0.##########';rows.forEach((row,r)=>{const cell=sheet[XLSX.utils.encode_cell({r:r+1,c})];if(cell?.t==='n')cell.z=format})});
    cols.forEach((col,c)=>{if(col.t!=='datetime')return;rows.forEach((row,r)=>{const text=dateTimeValue(row[col.k]);if(!text)return;const parts=text.split('T'),ymd=parts[0].split('-').map(Number),hm=(parts[1]||'00:00').split(':').map(Number);const cell=sheet[XLSX.utils.encode_cell({r:r+1,c})];cell.t='n';cell.v=(Date.UTC(ymd[0],ymd[1]-1,ymd[2],hm[0],hm[1])-Date.UTC(1899,11,30))/86400000;cell.z=parts[1]?'dd/mm/yyyy hh:mm':'dd/mm/yyyy'})});
    sheet['!cols'] = cols.map(col => ({ wch: Math.min(44, Math.max(12, caption(col).length + 2)) }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Đặt hàng');
    return workbook;
  }

  function exportImportSnapshot({rows,columns,revision}) {
    if(!/^\d+:\d+$/.test(String(revision||'')))throw Error('Phiên bản snapshot không hợp lệ.');
    const cols=importColumns(columns),keys=cols.filter(col=>col.k!=='rowKey').map(col=>col.k),book=exportWorkbook(rows,columns,keys);
    const kind=col=>numericTypes.has(col.t)?'Số'+(col.decimals!=null?' · tối đa '+col.decimals+' chữ số thập phân':''):['orderedNote','shippedNote','etaNote','arrivedNote'].includes(col.k)?'Ngày ghi chú hoặc khoảng, ví dụ 11-12/11':col.t==='datetime'?'Ngày dd/mm/yyyy hoặc dd/mm/yyyy hh:mm':'Văn bản';
    const required=col=>col.k==='productCode'?'Có · mọi dòng':['productName','qtyPerCarton','cartonCount'].includes(col.k)?'Có · dòng mới':'Không';
    const hints=cols.map(col=>[caption(col),required(col),kind(col),col.k==='rowKey'?'Có Mã dòng: cập nhật dòng đó. Để trống: tạo mã mới.':col.k==='productCode'?'Bắt buộc; không trùng trong file.':col.k==='productName'?'Bắt buộc khi tạo mã mới.':['qtyPerCarton','cartonCount'].includes(col.k)?'Mã mới cần số nguyên dương.':col.t==='datetime'?'Để trống sẽ xóa ngày hiện tại.':'Để trống sẽ xóa giá trị hiện tại.']);
    const exampleKeys=['rowKey','productCode','productName','qtyPerCarton','cartonCount','supplier','unitPriceCny','listedAt'],exampleColumns=exampleKeys.map(key=>cols.find(col=>col.k===key));
    const guide=XLSX.utils.aoa_to_sheet([
      ['HƯỚNG DẪN SỬA FILE THU MUA'],
      ['Đây là snapshot đầy đủ tải từ dữ liệu hiện tại. Sửa sheet “Đặt hàng” rồi tải lại chính file này. Không xóa sheet __TOKOSI.'],
      ['Mỗi dòng là một mã. Mã dòng có sẵn sẽ cập nhật; Mã dòng để trống sẽ tạo mã mới. Mã SP bắt buộc; mã mới cần Tên SP, SL/T và Số thùng.'],
      ['Giá trị ô trống sẽ xóa giá trị hiện tại. Xóa cả dòng khỏi sheet Đặt hàng sẽ xóa mềm mã đó. Xem lại số dòng xóa ở bước xem trước trước khi xác nhận.'],
      ['Nếu dữ liệu trên hệ thống đổi sau lúc tải file, snapshot sẽ bị từ chối; hãy tải snapshot mới, áp lại chỉnh sửa và gửi lại. Một lỗi sẽ chặn toàn bộ file.'],
      [],['CỘT','BẮT BUỘC','KIỂU / ĐỊNH DẠNG','LƯU Ý'],...hints,
      [],['VÍ DỤ DÒNG MỚI (chỉ để xem, không nằm trong sheet Đặt hàng)'],
      exampleColumns.map(caption),
      ['','AC305','Băng dính trong','100','10','Nhà cung cấp mẫu','3.10','12/11/2026']
    ]);
    guide['!cols']=[{wch:30},{wch:18},{wch:34},{wch:88}];
    XLSX.utils.book_append_sheet(book,guide,'Hướng dẫn');
    const meta=XLSX.utils.aoa_to_sheet([['format','TOKOSI_PURCHASE_SNAPSHOT'],['revision',String(revision)]]);
    XLSX.utils.book_append_sheet(book,meta,'__TOKOSI');
    book.Workbook||={};
    book.Workbook.Sheets||=book.SheetNames.map(name=>({name,Hidden:0}));
    book.Workbook.Sheets.find(sheet=>sheet.name==='__TOKOSI').Hidden=1;
    return bytes(book);
  }

  function dateValue(value, date1904) {
    if (typeof value === 'number') {
      const d = XLSX.SSF.parse_date_code(value, { date1904 });
      if (!d || d.y < 1900 || d.y > 2200) return null;
      value = `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
    if (value instanceof Date) value = value.toISOString().slice(0, 10);
    let text = String(value).trim();
    const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (local) text = `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(text + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
  }

  function dateTimeValue(value,date1904=false){
    if(typeof value==='number'){const d=XLSX.SSF.parse_date_code(value,{date1904});if(!d)return null;const date=dateValue(Math.floor(value),date1904);if(!date)return null;const hh=String(d.H).padStart(2,'0'),mm=String(d.M).padStart(2,'0');return d.H||d.M?date+'T'+hh+':'+mm:date}
    const text=String(value??'').trim(),match=/^(.*?)[T ](\d{2}):(\d{2})(?::00(?:\.000)?)?$/.exec(text);
    if(!match)return dateValue(text,date1904);
    const date=dateValue(match[1],date1904);return date&&Number(match[2])<24&&Number(match[3])<60?date+'T'+match[2]+':'+match[3]:null;
  }
  function dateNoteValue(value,date1904=false){
    const text=String(value??'').trim(),range=/^(\d{1,2})\s*-\s*(\d{1,2})\s*\/\s*(\d{1,2})(?:\/(\d{4}))?$/.exec(text);
    if(range){const from=Number(range[1]),to=Number(range[2]),month=Number(range[3]),year=Number(range[4]),maxDays=month<1||month>12?0:year?new Date(Date.UTC(year,month,0)).getUTCDate():month===2?29:[4,6,9,11].includes(month)?30:31;if(from<1||to<from||to>maxDays)return null;return from+'-'+to+'/'+month+(range[4]?'/'+range[4]:'')}
    return dateTimeValue(value,date1904);
  }
  function parseWorkbook(workbook, columns, sheetName, {includeEmpty=false,allowEmpty=false}={}) {
    const name = sheetName || (workbook.SheetNames.includes('Đặt hàng') ? 'Đặt hàng' : workbook.SheetNames[0]);
    const sheet = workbook.Sheets[name];
    if (!sheet || !sheet['!ref']) throw Error('Trang tính không có dữ liệu.');
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (range.e.r > 10000 || range.e.c > 100) throw Error('File vượt giới hạn 10.000 dòng hoặc 101 cột.');
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: true });
    const aliases = new Map();
    function alias(label, col) {
      const key = normalize(label);
      if (!key) return;
      if (aliases.has(key) && aliases.get(key)?.k !== col.k) aliases.set(key, null);
      else if (!aliases.has(key)) aliases.set(key, col);
    }
    columns.forEach(col => { alias(col.k, col); alias(caption(col), col); alias(col.l, col); });
    alias('Tên SP', columns.find(c => c.k === 'productName'));
    // The shared label is intentionally ambiguous unless the exported caption is used.
    aliases.set(normalize('Tên SP'), columns.find(c => c.k === 'productName'));
    const headerIndex = matrix.findIndex((row, i) => i < 10 && row.some(value => aliases.get(normalize(value))?.k === 'productCode'));
    if (headerIndex < 0) throw Error('Không tìm thấy cột Mã SP trong 10 dòng đầu.');
    const header = matrix[headerIndex], mapped = [], seen = new Set(), ignored = [];
    header.forEach((label, index) => {
      if (label === '') return;
      const col = aliases.get(normalize(label));
      if (!col) throw Error('Cột không xác định hoặc trùng nhãn: ' + label);
      if (seen.has(col.k)) throw Error('Cột bị lặp: ' + caption(col));
      seen.add(col.k);
      if (!writable(col)) ignored.push(caption(col));
      mapped.push({ col, index });
    });
    const rows = [];
    matrix.slice(headerIndex + 1).forEach((values, index) => {
      if (!values.some(value => value !== '' && value != null)) return;
      const row = { __sourceRow: range.s.r + headerIndex + index + 2, __cellErrors: {} };
      mapped.forEach(({ col, index: columnIndex }) => {
        if (!writable(col)) return;
        const value = values[columnIndex];
        const address = XLSX.utils.encode_cell({ r: row.__sourceRow - 1, c: range.s.c + columnIndex });
        const cell = sheet[address];
        if (cell?.t === 'e' || (cell?.f && (value === '' || value == null))) {
          row[col.k] = cell.w || '#LỖI';
          row.__cellErrors[col.k] = caption(col) + ': công thức lỗi hoặc chưa có kết quả; sửa thành giá trị';
          return;
        }
        if (value == null || value === '') {if(includeEmpty)row[col.k]=null;return}
        if (numericTypes.has(col.t)) {
          if (!Number.isFinite(C.parse(value))) {
            row[col.k] = String(value); row.__cellErrors[col.k] = caption(col) + ': số không hợp lệ';
          } else row[col.k] = C.parse(value);
        } else if ((col.t === 'date'||col.t==='datetime')) {
          const date = col.t==='datetime'&&['orderedNote','shippedNote','etaNote','arrivedNote'].includes(col.k)?dateNoteValue(value,!!workbook.Workbook?.WBProps?.date1904):(col.t==='datetime'?dateTimeValue:dateValue)(value, !!workbook.Workbook?.WBProps?.date1904);
          row[col.k] = date || String(value);
          if (!date) row.__cellErrors[col.k] = caption(col) + ': ngày không hợp lệ';
        } else row[col.k] = String(value).trim();
      });
      rows.push(row);
    });
    if (!rows.length&&!allowEmpty) throw Error('File không có dòng hàng.');
    return { rows, sheetName: name, ignored, fields: mapped.filter(x => writable(x.col)).map(x => x.col.k) };
  }
  function parseImportSnapshot(data,columns) {
    const book=read(data),meta=book.Sheets.__TOKOSI,values=meta&&XLSX.utils.sheet_to_json(meta,{header:1,defval:''}),revision=values?.find(row=>row[0]==='revision')?.[1];
    if(values?.[0]?.[1]!=='TOKOSI_PURCHASE_SNAPSHOT'||!/^\d+:\d+$/.test(String(revision||'')))throw Error('Tải snapshot dữ liệu hiện tại trước khi import.');
    const parsed=parseWorkbook(book,columns,'Đặt hàng',{includeEmpty:true,allowEmpty:true}),expected=importColumns(columns).map(col=>col.k);
    if(parsed.fields.length!==expected.length||expected.some(key=>!parsed.fields.includes(key)))throw Error('File thiếu cột snapshot. Tải lại dữ liệu hiện tại trước khi import.');
    return {...parsed,revision,fields:expected};
  }
  function read(data) { return XLSX.read(data, { type: 'array', cellDates: false, cellFormula: true }); }
  function bytes(workbook) { return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }); }
  return { caption, numericTypes, dateValue, dateTimeValue, dateNoteValue, exportWorkbook, exportImportSnapshot, parseWorkbook, parseImportSnapshot, read, bytes };
});

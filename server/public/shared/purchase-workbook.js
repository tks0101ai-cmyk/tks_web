(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('xlsx'),require('./purchase-calculations'));
  else root.PurchaseExcel = factory(root.XLSX,root.PurchaseCalculations);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (XLSX,C) {
  'use strict';
  const numericTypes = new Set(['num', 'num1', 'num2', 'num3', 'num4', 'cny', 'money', 'pct', 'ratio']);
  const labels = { productName: 'Tên SP (Việt)', productNameCn: 'Tên SP (Trung)', literDiff: 'Lệch L/c (%)', gramDiff: 'Lệch g/c (%)' };
  const excludedImportFields = new Set(['totalTon','totalM3','netPrice','goodsAmount','freightAmount','totalCny','totalQty','m3Warehouse','literChina','literDiff','ratio','gramChina','gramDiff']);
  const excludedImportLabels = ['Tổng Tấn','Tổng m3','Giá NET','Tiền hàng','Tiền VC','TỔNG TỆ','Tổng SL','M³ kho đo','L/c (TQ)','Lệch L/c','Tỉ lệ','g/c (TQ)','Lệch g/c'];
  const excludedImportDescription = 'Các file mẫu import đều bỏ các cột tính toán/đối chiếu không nhập: '+excludedImportLabels.join(', ')+'.';
  const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const caption = col => labels[col.k] || (col.cn ? col.l + ' · ' + col.cn : col.l);
  const writable = col => col.k === 'rowKey' || !!col.region || !!col.o || !col.d && !col.m && !col.ro && !['container', 'status'].includes(col.k);
  const isExcludedImportColumn = col => !!col.d || !!col.m || excludedImportFields.has(col.k);
  const importColumns = columns => columns.filter(col=>(writable(col)||col.si)&&!isExcludedImportColumn(col));
  const snapshotRequiredColumns = columns => ['rowKey','productCode','productName','qtyPerCarton','cartonCount'].filter(key=>columns.some(col=>col.k===key&&importColumns(columns).includes(col))||key==='rowKey'&&columns.some(col=>col.k===key));
  const newCodeColumns = columns => columns.filter(col=>col.k!=='rowKey'&&(!col.si||col.k==='container')&&!isExcludedImportColumn(col)&&(!col.ro||col.region||col.k==='container'));

  function exportWorkbook(rows, columns, visibleKeys) {
    const selected = new Set(visibleKeys || columns.map(col => col.k));
    const cols = [columns.find(col => col.k === 'rowKey'), ...columns.filter(col => col.k !== 'rowKey' && selected.has(col.k))].filter(Boolean);
    const data = [cols.map(caption), ...rows.map(row => cols.map(col => col.region?(row.regionName??row.regionId??null):(row[col.k]??null)))];
    const sheet = XLSX.utils.aoa_to_sheet(data);
    const decimalPlaces={num:4,num1:1,num2:2,num3:3,num4:4,cny:3,money:2};
    cols.forEach((col,c)=>{rows.forEach((row,r)=>{const cell=sheet[XLSX.utils.encode_cell({r:r+1,c})];if(cell?.t!=='n')return;const whole=Number.isInteger(Number(cell.v)),places=decimalPlaces[col.t];if(col.t==='ratio')cell.z=whole?'0%':'0.00%';else if(col.t==='pct')cell.z=whole?'+0%;-0%;0%':'+0.00%;-0.00%;0%';else if(places!=null){const rounded=Number(Number(cell.v).toFixed(places)),decimals=whole?0:(String(rounded).split('.')[1]||'').length;cell.z=decimals?'#,##0.'+'0'.repeat(decimals):'#,##0'}delete cell.w})});
    cols.forEach((col,c)=>{if(col.t!=='datetime'||col.k==='measuredOn')return;rows.forEach((row,r)=>{const text=dateTimeValue(row[col.k]);if(!text)return;const parts=text.split('T'),ymd=parts[0].split('-').map(Number),hm=(parts[1]||'00:00').split(':').map(Number);const cell=sheet[XLSX.utils.encode_cell({r:r+1,c})];cell.t='n';cell.v=(Date.UTC(ymd[0],ymd[1]-1,ymd[2],hm[0],hm[1])-Date.UTC(1899,11,30))/86400000;cell.z=parts[1]?'dd/mm/yyyy hh:mm':'dd/mm/yyyy';delete cell.w})});
    sheet['!cols'] = cols.map((col,c)=>{let valueWidth=0;rows.forEach((row,r)=>{const cell=sheet[XLSX.utils.encode_cell({r:r+1,c})];if(!cell)return;const value=cell.t==='n'?XLSX.utils.format_cell(cell):String(cell.v??'');valueWidth=Math.max(valueWidth,[...value].length)});const cap=numericTypes.has(col.t)?18:col.t==='datetime'?16:32;return {wch:Math.min(cap,Math.max(8,valueWidth+1))}});
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Đặt hàng');
    return workbook;
  }

  function snapshotFormula(col,row,columns,rowIndex) {
    if(!col.d)return null;
    if(col.o&&row.measurementOverrides&&Object.hasOwn(row.measurementOverrides,col.k))return `=${Number(row.measurementOverrides[col.k])}`;
    const ref=key=>{const index=columns.findIndex(item=>item.k===key);return index<0?null:XLSX.utils.encode_cell({r:rowIndex+1,c:index})};
    const cell=key=>{const address=ref(key);return address?address.replace(/\d+$/,'')+(rowIndex+2):null};
    const q=cell('qtyPerCarton'),n=cell('cartonCount'),kg=cell('kgPerCarton'),m3=cell('m3PerCarton'),price=cell('unitPriceCny'),pre=cell('freightPrepaid'),fx=cell('fxRate'),post=cell('freightPostpaid'),surcharge=cell('surchargePercent');
    const qty=cell('totalQty'),goods=cell('goodsAmount'),freight=cell('freightAmount'),liter=cell('literChina'),gram=cell('gramChina'),literWarehouse=cell('literWarehouse'),gramWarehouse=cell('gramWarehouse'),isBlank=refs=>`OR(${refs.map(address=>`${address}=\"\"`).join(',')})`;
    const formulas={
      totalQty:q&&n?`=IF(${isBlank([q,n])},\"\",IFERROR(${q}*${n},\"\"))`:null,
      totalCny:q&&n&&price&&pre?`=IF(${isBlank([q,n,price])},\"\",IFERROR(${q}*${n}*${price}+${pre},\"\"))`:null,
      goodsAmount:q&&n&&price&&pre&&fx?`=IF(${isBlank([q,n,price,fx])},\"\",IFERROR((${q}*${n}*${price}+${pre})*${fx},\"\"))`:null,
      totalTon:kg&&n?`=IF(${isBlank([kg,n])},\"\",IFERROR(${kg}*${n}/1000,\"\"))`:null,
      totalM3:m3&&n?`=IF(${isBlank([m3,n])},\"\",IFERROR(${m3}*${n},\"\"))`:null,
      freightAmount:m3&&n?`=IF(${isBlank([m3,n])},\"\",IFERROR(${m3}*${n}*${(Number(row.totalM3)>0?Number(row.freightAmount)/Number(row.totalM3):0)},\"\"))`:null,
      netPrice:qty&&goods&&freight&&post&&surcharge?`=IF(OR(${qty}=\"\",${qty}=0,${goods}=\"\"),\"\",IFERROR((${goods}+IF(${surcharge}=\"\",0,${goods}*${surcharge})+IF(${freight}=\"\",0,${freight})+IF(${post}=\"\",0,${post}*${(Number(row.containerFxRate??row.postpaidFxRate)||3900)}))/${qty},\"\"))`:null,
      literChina:row.measurementOverrides&&Object.hasOwn(row.measurementOverrides,'literChina')?`=${Number(row.measurementOverrides.literChina)}`:m3&&q?`=IF(OR(${isBlank([m3,q])},${q}=0),\"\",IFERROR(${m3}*1000/${q},\"\"))`:null,
      gramChina:row.measurementOverrides&&Object.hasOwn(row.measurementOverrides,'gramChina')?`=${Number(row.measurementOverrides.gramChina)}`:kg&&q?`=IF(OR(${isBlank([kg,q])},${q}=0),\"\",IFERROR(${kg}*1000/${q},\"\"))`:null,
      literDiff:row.measurementOverrides&&Object.hasOwn(row.measurementOverrides,'literDiff')?`=${Number(row.measurementOverrides.literDiff)}`:liter&&literWarehouse?`=IF(OR(${isBlank([liter,literWarehouse])},${literWarehouse}=0),\"\",IFERROR((${liter}-${literWarehouse})/${literWarehouse},\"\"))`:null,
      gramDiff:row.measurementOverrides&&Object.hasOwn(row.measurementOverrides,'gramDiff')?`=${Number(row.measurementOverrides.gramDiff)}`:gram&&gramWarehouse?`=IF(OR(${isBlank([gram,gramWarehouse])},${gramWarehouse}=0),\"\",IFERROR((${gram}-${gramWarehouse})/${gramWarehouse},\"\"))`:null,
      ratio:cell('totalTon')&&cell('totalM3')?`=IF(OR(${isBlank([cell('totalTon'),cell('totalM3')])},${cell('totalM3')}=0),\"\",IFERROR(${cell('totalTon')}/${cell('totalM3')},\"\"))`:null
    };
    return formulas[col.k]||null;
  }

  function exportImportSnapshot({rows,columns,revision,regions=[],scope=null,selectedColumns=null}) {
    if(!/^\d+:\d+$/.test(String(revision||'')))throw Error('Phiên bản snapshot không hợp lệ.');
    const allImportable=importColumns(columns),required=snapshotRequiredColumns(columns),chosen=new Set(Array.isArray(selectedColumns)?selectedColumns.filter(key=>allImportable.some(col=>col.k===key)):allImportable.map(col=>col.k));for(const key of required)chosen.add(key);const importable=allImportable.filter(col=>chosen.has(col.k)),cols=[columns.find(col=>col.k==='rowKey'),...importable.filter(col=>col.k!=='rowKey')].filter(Boolean),keys=cols.filter(col=>col.k!=='rowKey').map(col=>col.k),book=exportWorkbook(rows,cols,keys),sheet=book.Sheets['Đặt hàng'];
    cols.forEach((col,c)=>rows.forEach((row,r)=>{const formula=snapshotFormula(col,row,cols,r);if(!formula)return;const address=XLSX.utils.encode_cell({r:r+1,c}),cell=sheet[address]||(sheet[address]={t:'n',v:0});cell.f=formula.slice(1);if(typeof row[col.k]==='number'&&Number.isFinite(row[col.k])){cell.t='n';cell.v=row[col.k]}else{cell.t='str';cell.v=''}}));
    const kind=col=>numericTypes.has(col.t)?'Số'+(col.decimals!=null?' · tối đa '+col.decimals+' chữ số thập phân':''):col.t==='datetime'?'Ngày dd/mm/yyyy hoặc dd/mm/yyyy hh:mm':'Văn bản';
    const requiredLabel=col=>col.k==='productCode'?'Có · mọi dòng':['productName','qtyPerCarton','cartonCount'].includes(col.k)?'Có · dòng mới':'Không';
    const hints=cols.map(col=>[caption(col),requiredLabel(col),col.region?'Tên vùng hoặc mã vùng':kind(col),col.d?'Cột công thức Excel; thay công thức bằng giá trị nếu cần ghi đè.':!importable.includes(col)?'Chỉ xem; không được nhập ngược vào hệ thống.':col.region?'Nhập đúng tên vùng đang dùng; để trống sẽ bỏ gán vùng.':col.k==='container'?'Nhập cont đang hoạt động; để trống hoặc chọn Chờ xếp sẽ đưa vào hàng chờ.':col.k==='rowKey'?'Mã dòng khớp: cập nhật đúng dòng. Mã dòng không tồn tại hoặc để trống: thêm dòng mới; hệ thống cấp Mã dòng mới.':col.k==='productCode'?'Bắt buộc; được phép trùng vì Mã dòng là khóa riêng.':col.k==='productName'?'Bắt buộc khi tạo dòng mới.':['qtyPerCarton','cartonCount'].includes(col.k)?'Dòng mới cần số nguyên dương.':col.t==='datetime'?'Để trống sẽ xóa ngày hiện tại.':'Để trống sẽ xóa giá trị hiện tại.']);
    const exampleKeys=['rowKey','productCode','productName','qtyPerCarton','cartonCount','supplier','unitPriceCny','listedAt'],exampleColumns=exampleKeys.map(key=>cols.find(col=>col.k===key));
    const guide=XLSX.utils.aoa_to_sheet([
      ['HƯỚNG DẪN SỬA FILE THU MUA'],
      [scope?.type==='container'?'File chỉ quản lý các dòng của cont '+(scope.containerName||scope.containerId)+'. Khi nhập lại: Mã dòng có sẵn được cập nhật, Mã dòng để trống tạo dòng mới, dòng không có trong file vẫn được giữ nguyên. Các cont khác không bị thay đổi. '+excludedImportDescription+' Không xóa sheet __TOKOSI.':scope?.type==='rows'?'File chỉ quản lý '+rows.length+' dòng đã chọn. Dòng bị bỏ khỏi file vẫn được giữ nguyên; các dòng khác không đổi. '+excludedImportDescription+' Không xóa sheet __TOKOSI.':'Đây là snapshot các trường đặt hàng tải từ dữ liệu hiện tại. '+excludedImportDescription+' Các trường này được giữ nguyên khi nhập lại. Sửa sheet “Đặt hàng” rồi tải lại chính file này. Không xóa sheet __TOKOSI.'],
      ['Mỗi dòng là một dòng đặt hàng. Mã dòng khớp dòng hiện có sẽ cập nhật đúng dòng. Mã dòng mới, không tìm thấy hoặc để trống sẽ tạo dòng mới và hệ thống cấp Mã dòng. Mã SP được phép lặp. Dòng mới cần Tên SP, SL/T và Số thùng.'],
      [scope?.type==='container'?'Khi nhập file cont, ô trống xử lý theo lựa chọn cột trên giao diện; dòng bị bỏ khỏi file vẫn được giữ nguyên.':scope?.type==='rows'?'Các cột được xuất có thể chỉnh sửa; cột Mã dòng và các trường bắt buộc luôn có. Ô trống xử lý theo lựa chọn cột trên giao diện. Dòng bỏ khỏi file chỉ ảnh hưởng phạm vi dòng đã chọn.':'Ô trống được xử lý theo lựa chọn trên giao diện. Ở chế độ Cập nhật theo Mã dòng, dòng bỏ khỏi file được giữ nguyên; ở mọi chế độ, dòng không có trong file được giữ nguyên.'],
      ['Cột Vùng nhận tên vùng trong danh sách đã cấu hình; không nhập vùng mới trong file. Cột Tên cont nhận tên cont đang hoạt động; để trống hoặc nhập Chờ xếp sẽ gán vào hàng chờ. Trạng thái cont tự tính, không import.'],
      [scope?.type==='container'?'Nếu dữ liệu thay đổi sau khi tải file, hệ thống vẫn ghép theo Mã dòng và áp dụng các giá trị trong file. Phiên bản không chặn nhập.':'Thay đổi phiên bản hệ thống không chặn import. Khi nhập, hệ thống ghép theo Mã dòng hiện có; các giá trị trong file sẽ cập nhật dòng khớp. Mã mới hoặc để trống sẽ tạo dòng mới. Dòng không có trong file được giữ nguyên.'],
      [],['CỘT','BẮT BUỘC','KIỂU / ĐỊNH DẠNG','LƯU Ý'],...hints,
      [],['VÍ DỤ DÒNG MỚI (chỉ để xem, không nằm trong sheet Đặt hàng)'],
      exampleColumns.map(caption),
      ['','AC305','Băng dính trong','100','10','Nhà cung cấp mẫu','3.10','12/11/2026']
    ]);
    guide['!cols']=[{wch:30},{wch:18},{wch:34},{wch:88}];
    XLSX.utils.book_append_sheet(book,guide,'Hướng dẫn');
    const regionSheet=XLSX.utils.aoa_to_sheet([['MÃ VÙNG','TÊN VÙNG','MÀU'],...regions.map(region=>[String(region.id),region.name,region.color||''])]);regionSheet['!cols']=[{wch:16},{wch:28},{wch:12}];XLSX.utils.book_append_sheet(book,regionSheet,'Danh sách vùng');
    const metaRows=[['format','TOKOSI_PURCHASE_SNAPSHOT'],['revision',String(revision)],['columns',JSON.stringify(cols.map(col=>col.k))]];if(scope?.type==='container')metaRows.push(['scope','container'],['containerId',String(scope.containerId)]);else if(scope?.type==='rows')metaRows.push(['scope','rows']);const meta=XLSX.utils.aoa_to_sheet(metaRows);
    XLSX.utils.book_append_sheet(book,meta,'__TOKOSI');
    book.Workbook||={};
    book.Workbook.Sheets||=book.SheetNames.map(name=>({name,Hidden:0}));
    book.Workbook.Sheets.find(sheet=>sheet.name==='__TOKOSI').Hidden=1;
    return bytes(book);
  }

  function exportNewCodesTemplate(columns,regions=[]) {
    const cols=newCodeColumns(columns);
    if(!cols.some(col=>col.k==='productCode'))throw Error('Thiếu cột Mã SP trong cấu hình Thu mua.');
    const sheet=XLSX.utils.aoa_to_sheet([cols.map(caption)]);
    sheet['!cols']=cols.map(col=>({wch:Math.min(28,Math.max(12,[...caption(col)].length+2))}));
    const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'Mã mới');
    const guide=XLSX.utils.aoa_to_sheet([
      ['HƯỚNG DẪN NHẬP FILE THU MUA'],
      ['File này chỉ thêm dòng mới, không chứa snapshot hoặc Mã dòng. '+excludedImportDescription],
      ['Chỉ điền các dòng mới ở sheet “Mã mới”; giữ nguyên tiêu đề cột. Mã SP và Số thùng là bắt buộc. Mã SP được phép trùng; hệ thống tự cấp Mã dòng riêng cho mỗi dòng mới.'],
      ['Giới hạn: tối đa 1.000 dòng mới trong mỗi lần nhập.'],
      ['Tên cont: nhập tên cont đã có để gán mã vào cont đó. Nếu chưa có, cont sẽ được tạo mới trong Vùng đã chọn; để trống Tên cont thì mã vào Chờ xếp. Vùng để trống sẽ dùng vùng AA.'],
      ['Mã SP trùng trong file hoặc trên hệ thống không phải lỗi. Mã dòng riêng do hệ thống cấp cho từng dòng; dữ liệu hiện có không bị cập nhật hoặc xóa.'],
      [],['CỘT','BẮT BUỘC','KIỂU / ĐỊNH DẠNG','LƯU Ý'],
      ...cols.map(col=>[caption(col),['productCode','cartonCount'].includes(col.k)?'Có':'Không',col.region?'Tên vùng hoặc mã vùng':numericTypes.has(col.t)?'Số'+(col.decimals!=null?' · tối đa '+col.decimals+' chữ số thập phân':''):col.t==='date'||col.t==='datetime'?'Ngày':'Văn bản',col.k==='productCode'?'Mã SP được phép trùng. Mỗi dòng mới nhận Mã dòng riêng.':col.k==='cartonCount'?'Số nguyên dương.':col.k==='container'?'Cont đã có sẽ được gán; tên chưa có sẽ tạo cont mới thuộc Vùng đã chọn. Để trống để vào Chờ xếp.':col.region?'Để trống sẽ dùng vùng AA.':'Để trống nếu chưa có dữ liệu.'])
    ]);
    guide['!cols']=[{wch:30},{wch:18},{wch:34},{wch:68}];XLSX.utils.book_append_sheet(book,guide,'Hướng dẫn');
    const regionSheet=XLSX.utils.aoa_to_sheet([['MÃ VÙNG','TÊN VÙNG','MÀU'],...regions.map(region=>[String(region.id),region.name,region.color||''])]);
    regionSheet['!cols']=[{wch:16},{wch:28},{wch:12}];XLSX.utils.book_append_sheet(book,regionSheet,'Danh sách vùng');
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
  function parseWorkbook(workbook, columns, sheetName, {includeEmpty=false,allowEmpty=false,snapshot=false,allowContainer=false}={}) {
    const snapshotKeys=snapshot?new Set(importColumns(columns).map(col=>col.k)):null;
    const canImport=col=>!isExcludedImportColumn(col)&&(snapshot?snapshotKeys.has(col.k):writable(col)||allowContainer&&col.k==='container');
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
      if (!canImport(col)) ignored.push(caption(col));
      mapped.push({ col, index });
    });
    const rows = [];
    matrix.slice(headerIndex + 1).forEach((values, index) => {
      if (!values.some(value => value !== '' && value != null)) return;
      const row = { __sourceRow: range.s.r + headerIndex + index + 2, __cellErrors: {} };
      mapped.forEach(({ col, index: columnIndex }) => {
        if (!canImport(col)) return;
        const value = values[columnIndex];
        const address = XLSX.utils.encode_cell({ r: row.__sourceRow - 1, c: range.s.c + columnIndex });
        const cell = sheet[address];
        // Formula columns are presentation-only in snapshots. Replacing a formula
        // with a literal remains a supported way to enter a measurement override.
        if(snapshot&&col.d&&cell?.f){if(!col.o)return;if(cell.t==='e'){row[col.k]=cell.w||'#LỖI';row.__cellErrors[col.k]=caption(col)+': công thức lỗi hoặc chưa có kết quả; sửa thành giá trị';return}if(value==null||value===''){row[col.k]=null;return}}
        if(col.k==='measuredOn'&&(cell?.f||cell?.t==='e')){row[col.k]=String(cell.w||(cell.f?'='+cell.f:value??'')).trim();return}
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
        } else if (col.k==='measuredOn') {
          row[col.k] = String(cell?.w||value).trim();
        } else if ((col.t === 'date'||col.t==='datetime')) {
          const date = (col.t==='datetime'?dateTimeValue:dateValue)(value, !!workbook.Workbook?.WBProps?.date1904);
          row[col.k] = date || String(value);
          if (!date) row.__cellErrors[col.k] = caption(col) + ': ngày không hợp lệ';
        } else row[col.k] = String(col.k==='measuredOn'&&cell?.w?cell.w:value).trim();
      });
      rows.push(row);
    });
    if (!rows.length&&!allowEmpty) throw Error('File không có dòng hàng.');
    return { rows, sheetName: name, ignored, fields: mapped.filter(x => canImport(x.col)).map(x => x.col.k) };
  }
  function parseImportSnapshot(data,columns) {
    const book=read(data),meta=book.Sheets.__TOKOSI,values=meta&&XLSX.utils.sheet_to_json(meta,{header:1,defval:''}),revision=values?.find(row=>row[0]==='revision')?.[1];
    if(values?.[0]?.[1]!=='TOKOSI_PURCHASE_SNAPSHOT'||!/^\d+:\d+$/.test(String(revision||'')))throw Error('Tải snapshot dữ liệu hiện tại trước khi import.');
    const parsed=parseWorkbook(book,columns,'Đặt hàng',{includeEmpty:true,allowEmpty:true,snapshot:true}),all=importColumns(columns).map(col=>col.k),columnValue=values?.find(row=>row[0]==='columns')?.[1];let expected=all;if(columnValue){try{expected=JSON.parse(String(columnValue))}catch{throw Error('Danh sách cột snapshot không hợp lệ. Tải lại file.')}if(!Array.isArray(expected)||expected.some(key=>!all.includes(key))||new Set(expected).size!==expected.length)throw Error('Danh sách cột snapshot không hợp lệ. Tải lại file.')}const required=snapshotRequiredColumns(columns);if(required.some(key=>!expected.includes(key))||parsed.fields.length!==expected.length||expected.some(key=>!parsed.fields.includes(key)))throw Error('File thiếu cột bắt buộc hoặc cột đã chọn. Tải lại snapshot từ giao diện.');
    const scopeType=values?.find(row=>row[0]==='scope')?.[1],containerId=values?.find(row=>row[0]==='containerId')?.[1];if(scopeType==='container'&&!/^\d+$/.test(String(containerId||'')))throw Error('File theo cont không hợp lệ. Tải lại file của cont.');return {...parsed,revision,scope:['container','rows'].includes(scopeType)?{type:scopeType,containerId:scopeType==='container'?String(containerId):undefined}:null,selectedColumns:expected,fields:expected};
  }
  function read(data) { return XLSX.read(data, { type: 'array', cellDates: false, cellFormula: true }); }
  function bytes(workbook) { return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }); }
  return { caption, numericTypes, importColumns, snapshotRequiredColumns, newCodeColumns, dateValue, dateTimeValue, exportWorkbook, exportImportSnapshot, exportNewCodesTemplate, parseWorkbook, parseImportSnapshot, read, bytes };
});

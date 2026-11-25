'use strict';

// Pure server-side validation/planning. No database writes or key allocation.
// A future API must retain the preview server-side; never trust a client-supplied
// plan. Recheck against locked current rows inside the eventual write transaction.
const calculations=require('../public/shared/purchase-calculations');
const columns = require('../public/shared/purchase-columns');
const workbook = require('../public/shared/purchase-workbook');
const { normalizeName: normalizeContainerKey } = require('./containerNames');
// Cot chi doc duoc danh dau `ro` trong purchase-columns.js — mot nguon duy nhat,
// khong lap danh sach ten cot o hai noi nhu truoc.
const writable = columns.filter(c => !c.d && !c.m && !c.ro);
const overrideColumns=columns.filter(c=>c.o&&!c.d&&!c.m),regionColumn=columns.find(c=>c.region), importable=[...writable,...overrideColumns,...(regionColumn?[regionColumn]:[])];
const snapshotColumns=columns.filter(c=>c.si);
importable.push(...snapshotColumns);
const byKey = new Map(importable.map(c => [c.k, c]));
const keyPattern = /^D\d{5,}(?:\.(?:01|02))*$/;
const integerFields = new Set(['qtyPerCarton', 'cartonCount']);
const signedFields = new Set([...calculations.SIGNED,'literDiff','gramDiff']);
const blank = value => value == null || value === '';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function normalizeImportOptions(options={}){const allowed=new Set(importable.map(column=>column.k).filter(key=>key!=='rowKey'));return {preserveMissing:options.preserveMissing===true,updateExistingByRowKey:options.updateExistingByRowKey===true,updateFields:[...new Set(Array.isArray(options.updateFields)?options.updateFields.filter(key=>allowed.has(key)):[])],clearBlanks:options.clearBlanks===true}}

function version(row) { return row.version ?? row.v; }
function comparable(value, col) {
  return blank(value) ? null : workbook.numericTypes.has(col.t) ? Number(value) : String(value);
}
const normalizeRegionName = value => normalizeContainerKey(String(value ?? '').normalize('NFKC'));
const normalizeContainerLabel = value => String(value ?? '').trim().replace(/^cont\s+/i, '').trim();
function prepareRows(sourceRows, existingRows, { listedAt = today(), snapshot = false, snapshotRevision, snapshotStale = false, archivedRows = [], regions = [], containers = [], allowSparseCreates = false, allowContainerAssignment = false, importOptions = {} } = {}) {
  if (!Array.isArray(sourceRows) || (!sourceRows.length && !snapshot) || sourceRows.length > 10000) throw Error('Đợt nhập phải có 1–10.000 dòng.');
  if (!Array.isArray(existingRows)) throw Error('Thiếu dữ liệu hiện hành để đối chiếu.');
  importOptions=normalizeImportOptions(importOptions);
  if(snapshot)importOptions.preserveMissing=true;
  const existing = new Map(existingRows.map(row => [row.rowKey, row]));
  const archivedByKey = new Map(archivedRows.map(row => [row.rowKey, row]));
  const prefixes = rows => {const found=new Set();for(const row of rows){const parts=String(row.rowKey||'').split('.');while(parts.length>1){parts.pop();found.add(parts.join('.'))}}return found};
  const existingPrefixes=prefixes(existingRows),archivedPrefixes=prefixes(archivedRows);
  const normalizeContainerName=value=>String(value??'').trim().replace(/^cont\s+/i,'').normalize('NFKC').replace(/\s+/g,' ').toLocaleLowerCase('vi');
  const containersById=new Map(),containersByName=new Map();
  for(const container of containers){containersById.set(String(container.id),container);if(container.deleted_at||container.deletedAt)continue;const key=normalizeContainerName(container.name);if(key&&!containersByName.has(key))containersByName.set(key,container)}
  const regionsById=new Map(),regionsByName=new Map();
  const regionsByKey=new Map(),containersByKey=new Map(),plannedRegions=new Map(),plannedContainers=new Map();
  for(const region of regions){regionsById.set(String(region.id),region);const key=String(region.name||'').trim().toLocaleLowerCase('vi');if(key&&!regionsByName.has(key))regionsByName.set(key,region);const normalized=normalizeRegionName(region.name);if(normalized&&!regionsByKey.has(normalized))regionsByKey.set(normalized,region)}
  for(const container of containers){if(container.deleted_at||container.deletedAt)continue;const key=normalizeContainerKey(String(container.name||'').trim().replace(/^cont\s+/i,''));if(key&&!containersByKey.has(key))containersByKey.set(key,container)}
  const counts = new Map();
  const recoveryCounts = new Map();
  sourceRows.forEach(row => { const key = String(row.rowKey ?? '').trim(); if (key) counts.set(key, (counts.get(key) || 0) + 1); });
  sourceRows.forEach(row=>{if(row.recoverArchived===true){const key=String(row.recoverRowKey||row.rowKey||'').trim();if(key)recoveryCounts.set(key,(recoveryCounts.get(key)||0)+1)}});
  const rows = sourceRows.map((source, index) => {
    const rowKey = blank(source.rowKey) ? null : String(source.rowKey).trim();
    const current = rowKey ? existing.get(rowKey) : null;
    const archivedRowByKey=!current&&rowKey?archivedByKey.get(rowKey):null;
    const selectedArchived=source.recoverRowKey?archivedByKey.get(source.recoverRowKey):null;
    const archived=current?null:selectedArchived||archivedRowByKey;
    const candidates=archived?[archived]:[];
    const requestedKey=source.recoverArchived===true?(source.recoverRowKey||archived?.rowKey):null;
    const recovered = !current&&archived&&requestedKey===archived.rowKey;
    // Mã dòng chỉ dùng để ghép với dòng đang có. Mã không tồn tại được xem là
    // một dòng mới và backend sẽ cấp Mã dòng chuẩn khi ghi.
    const effectiveKey=recovered?archived.rowKey:current?.rowKey||null;
    const result = { sourceRow: source.__sourceRow || index + 2, rowKey: effectiveKey, action: recovered?(archived.deletedAt?'restore':'reactivate'):effectiveKey ? 'update' : 'create', errors: [], changes: [] };
    if(archived||candidates.length){result.archivedCandidate=archived?{rowKey:archived.rowKey,productCode:archived.productCode,productName:archived.productName,state:archived.deletedAt?'deleted':'inactive'}:null;result.archivedCandidates=candidates.map(row=>({rowKey:row.rowKey,productCode:row.productCode,productName:row.productName,state:row.deletedAt?'deleted':'inactive'}));if(!recovered)result.action='archived_skip'}
    const matched = current || (recovered?archived:null);
    if (rowKey && (current||archivedRowByKey) && !keyPattern.test(rowKey)) result.errors.push('Khóa dòng sai định dạng.');
    if (rowKey && counts.get(rowKey) > 1) result.errors.push('Khóa dòng trùng trong file.');
    if(recovered&&(recoveryCounts.get(archived.rowKey)||0)>1)result.errors.push('Một dòng lưu trữ chỉ được chọn khôi phục một lần.');
    if (matched && (!Number.isSafeInteger(version(matched)) || version(matched) < 1)) result.errors.push('Không đọc được phiên bản dòng hiện hành.');
    // `measuredOn` is deliberately free-form text. Older preview tokens may still
    // carry a date/formula validation error created before that column changed to
    // text, so do not let that stale parser error keep the row invalid on revise.
    for (const [key,message] of Object.entries(source.__cellErrors || {})) if(key!=='measuredOn') result.errors.push(String(message));
    const values = {};
    for (const col of importable) {
      if(snapshot&&matched&&col.k==='qtyPerCarton'&&Object.hasOwn(source,col.k)&&blank(source[col.k]))result.errors.push(col.l+': phải là số nguyên dương.');
      if(matched&&importOptions.updateExistingByRowKey&&!importOptions.updateFields.includes(col.k))continue;
      if(matched&&importOptions.updateExistingByRowKey&&!importOptions.clearBlanks&&blank(source[col.k]))continue;
      const value = source[col.k];
      if(col.si){
        if(!snapshot&&!allowContainerAssignment)continue;
        const text=String(value??'').trim(),waitingMatch=/^(?:cont\s*)?chờ(?:\s+(?:xếp(?:\s+(.+))?|(.+))|\s*-\s*(.+))?$/i.exec(text),waiting=!text||!!waitingMatch||/^tính giá$/i.test(text);
        if(waiting){
          if(snapshot||allowContainerAssignment)values.contId=null;
          const regionName=(waitingMatch?.[1]||waitingMatch?.[2]||waitingMatch?.[3]||'').replace(/^xếp\s+/i,'').trim();
          if(regionName){const region=regionsByName.get(regionName.toLocaleLowerCase('vi'))||regionsByKey.get(normalizeRegionName(regionName));if(!region||region.isActive===false)result.errors.push('Tên cont: không tìm thấy vùng Chờ xếp đang hoạt động “'+regionName+'”.');else if(values.regionId!=null&&String(values.regionId)!==String(region.id))result.errors.push('Tên cont: vùng Chờ xếp '+region.name+' không khớp với cột Vùng.');else values.regionId=String(region.id)}
          continue;
        }
        let found=containersById.get(text)||containersByName.get(normalizeContainerName(text));
        if(!found){
          if(/^\d+$/.test(text)){result.errors.push('Tên cont: không tìm thấy cont theo mã nội bộ.');continue}
          const name=text.replace(/^cont\s+/i,'').trim(),key=normalizeContainerKey(name);
          if(!name||name.length>200){result.errors.push('Tên cont: tên không hợp lệ (tối đa 200 ký tự).');continue}
          found=containersByKey.get(key)||plannedContainers.get(key);
          if(!found){found={id:'@new-container:'+key,name,isNew:true};plannedContainers.set(key,found)}
        }
        if(found.isNew){
          const requestedRegion=Object.hasOwn(values,'regionId')?values.regionId:matched?.regionId??null,regionKey=requestedRegion!=null&&String(requestedRegion).startsWith('@new-region:')?String(requestedRegion).slice('@new-region:'.length):null,priorRegion=found.regionKey?'@new-region:'+found.regionKey:found.regionId??null;
          if(priorRegion!=null&&requestedRegion!=null&&String(priorRegion)!==String(requestedRegion)){result.errors.push('Tên cont: cùng một cont mới không thể thuộc nhiều vùng trong file.');continue}
          if(regionKey)found.regionKey=regionKey;else if(requestedRegion!=null)found.regionId=String(requestedRegion);
          if(requestedRegion!=null)values.regionId=String(requestedRegion);
          values.contId=String(found.id);continue;
        }
        const isActive=found.is_active!==false&&found.isActive!==false&&!found.inactive_at&&!found.inactiveAt&&!found.deleted_at&&!found.deletedAt;
        if(!isActive&&String(matched?.contId??'')!==String(found.id)){result.errors.push('Tên cont: cont đã ngừng hoạt động hoặc đã xóa.');continue}
        const region=found.region_id??found.regionId??null,requestedRegion=Object.hasOwn(values,'regionId')?values.regionId:matched?.regionId??null;
        if(region!=null&&requestedRegion!=null&&String(region)!==String(requestedRegion)){result.errors.push('Tên cont: vùng không khớp với cột Vùng.');continue}
        if(region!=null&&requestedRegion==null)values.regionId=String(region);
        values.contId=String(found.id);continue;
      }
      if (blank(value)) { if (snapshot) values[col.k] = null; continue; }
      if(col.region){const raw=String(value).trim(),found=regionsById.get(raw)||regionsByName.get(raw.toLocaleLowerCase('vi'))||regionsByKey.get(normalizeRegionName(raw));if(found){if(found.isActive===false&&String(matched?.regionId??'')!==String(found.id))result.errors.push('Vùng: chọn tên vùng đang hoạt động trong danh sách.');else values.regionId=String(found.id)}else if(!raw||raw.length>80)result.errors.push('Vùng: tên không hợp lệ (tối đa 80 ký tự).');else if(/^\d+$/.test(raw))result.errors.push('Vùng: không tìm thấy vùng theo mã nội bộ.');else if(!snapshot&&!allowContainerAssignment)result.errors.push('Vùng: chọn tên vùng đang hoạt động trong danh sách.');else{const key=normalizeRegionName(raw);let planned=plannedRegions.get(key);if(!planned){planned={id:'@new-region:'+key,name:raw};plannedRegions.set(key,planned)}values.regionId=planned.id}continue}
      if(col.k==='measuredOn'){const text=String(value).trim();if(text.length>4000)result.errors.push(col.l+': tối đa 4.000 ký tự.');else values[col.k]=text;continue}
      if(col.k==='listedAt'){const date=workbook.normalizeListedAt(value);if(!date)result.errors.push(col.l+': nhập ngày dd/mm hoặc dd/mm/yyyy, có thể nối nhiều ngày bằng dấu +.');else values[col.k]=date;continue}
      if (workbook.numericTypes.has(col.t)) {
        const number = calculations.parse(value);
        // Chi cac cot co the am duoc khai bao trong signedFields.
        if (!Number.isFinite(number) || number < 0 && !signedFields.has(col.k) || Math.abs(number) > Number.MAX_SAFE_INTEGER) result.errors.push(col.l + ': số không hợp lệ.');
        else if (integerFields.has(col.k) && (!Number.isSafeInteger(number) || number <= 0)) result.errors.push(col.l + ': phải là số nguyên dương.');
        else if(col.k==='fxRate'&&number===0)result.errors.push(col.l+': phải lớn hơn 0 hoặc để trống.');else values[col.k] = number;
      } else if ((col.t === 'date'||col.t==='datetime')) {
        const date = (col.t==='datetime'?workbook.dateTimeValue:workbook.dateValue)(value, false);
        if (!date) result.errors.push(col.l + ': ngày không hợp lệ.');
        else values[col.k] = date;
      } else {
        const text = String(value).trim();
        if (text.length > 4000) result.errors.push(col.l + ': tối đa 4.000 ký tự.');
        else if (text) values[col.k] = text;
        else if (snapshot) values[col.k] = null;
      }
    }
    const effective={...(matched||{}),...values};for(const key of calculations.issues(effective).filter(k=>!['qtyPerCarton','cartonCount'].includes(k))){if(!result.errors.some(e=>e.startsWith((byKey.get(key)?.l||key)+':')))result.errors.push((byKey.get(key)?.l||key)+': số liệu vượt giới hạn tính toán hoặc không hợp lệ.')}
    if (!values.productCode&&!matched?.productCode) result.errors.push('Thiếu Mã SP.');
    if (!effectiveKey && !matched) {
      // Sparse imports may omit the product name, but quantity fields must
      // always be valid positive integers so a newly created row can be
      // exported and imported again through the snapshot update path.
      for (const key of (allowSparseCreates ? ['qtyPerCarton', 'cartonCount'] : ['productName', 'qtyPerCarton', 'cartonCount'])) if (blank(values[key])) result.errors.push('Thiếu ' + byKey.get(key).l + '.');
      if (!values.listedAt) values.listedAt = listedAt;
      result.values = { ...values, contId: values.contId??null };
    } else if (matched) {
      result.id = matched.id;
      result.expectedVersion = version(matched);
      result.values = { ...values };
      for (const [key, next] of Object.entries(values)) {
        if(key==='contId')continue;
        if (comparable(matched[key], byKey.get(key)) !== comparable(next, byKey.get(key))) result.changes.push({ key, label: byKey.get(key).l, before: matched[key] ?? null, after: next });
      }
      if(Object.hasOwn(values,'contId')&&String(matched.contId??'')!==String(values.contId??''))result.changes.push({key:'contId',label:'Tên cont',before:matched.contId??null,after:values.contId});
      if (!recovered&&!result.changes.length && !result.errors.length) result.action = 'unchanged';
    }
    return result;
  });
  for(const row of rows){
    const id=String(row.values?.contId??'');if(!id.startsWith('@new-container:'))continue;
    const container=plannedContainers.get(id.slice('@new-container:'.length)),requestedRegion=row.values.regionId??null;
    if(requestedRegion!=null&&container){
      const requestedKey=String(requestedRegion).startsWith('@new-region:')?String(requestedRegion).slice('@new-region:'.length):null,priorRegion=container.regionKey?'@new-region:'+container.regionKey:container.regionId??null;
      if(priorRegion!=null&&String(priorRegion)!==String(requestedRegion))row.errors.push('Tên cont: cùng một cont mới không thể thuộc nhiều vùng trong file.');
      else if(requestedKey)container.regionKey=requestedKey;else container.regionId=String(requestedRegion);
    }
    const regionId=container?.regionKey?'@new-region:'+container.regionKey:container?.regionId??null;
    if(regionId==null)continue;
    if(row.values.regionId==null)row.values.regionId=regionId;
    if(['update','reactivate','restore'].includes(row.action)){const matched=existingRows.find(current=>String(current.id)===String(row.id))||archivedRows.find(current=>String(current.id)===String(row.id)),change=row.changes.find(entry=>entry.key==='regionId');if(change)change.after=regionId;else if(String(matched?.regionId??'')!==String(regionId))row.changes.push({key:'regionId',label:byKey.get('regionId').l,before:matched?.regionId??null,after:regionId})}
  }
  let preservedCount=0;
  if (snapshot&&!importOptions.preserveMissing) {
    const included = new Set(rows.map(row => row.rowKey).filter(Boolean));
    for (const current of existingRows) if (!included.has(current.rowKey)) rows.push({ sourceRow: null, rowKey: current.rowKey, action: snapshotStale ? 'stale_preserve' : 'delete', id: current.id, expectedVersion: version(current), errors: [], changes: [], values: { ...current } });
  } else if(snapshot&&importOptions.preserveMissing) {
    const included = new Set(rows.map(row => row.rowKey).filter(Boolean));
    preservedCount=existingRows.filter(current=>!included.has(current.rowKey)).length;
  }
  const valid = rows.every(row => row.errors.length === 0);
  const activeRows=rows.filter(row=>!['archived_skip','delete'].includes(row.action)&&!row.errors.length),usedRegions=new Set(),usedContainers=new Set();
  for(const row of activeRows){for(const value of [row.values?.regionId,...row.changes.filter(change=>change.key==='regionId').map(change=>change.after)]){const text=String(value??'');if(text.startsWith('@new-region:'))usedRegions.add(text.slice('@new-region:'.length))}for(const value of [row.values?.contId,...row.changes.filter(change=>change.key==='contId').map(change=>change.after)]){const text=String(value??'');if(text.startsWith('@new-container:'))usedContainers.add(text.slice('@new-container:'.length))}}
  const masterData={regions:[...plannedRegions.entries()].filter(([key])=>usedRegions.has(key)).map(([key,row])=>({key,name:row.name})),containers:[...plannedContainers.entries()].filter(([key])=>usedContainers.has(key)).map(([key,row])=>({key,name:row.name,regionKey:row.regionKey??null,regionId:row.regionId??null}))};
  return {
    valid,
    counts: { create: rows.filter(r => r.action === 'create' && !r.errors.length).length, update: rows.filter(r => r.action === 'update' && !r.errors.length).length, unchanged: rows.filter(r => r.action === 'unchanged').length, reactivate:rows.filter(r=>r.action==='reactivate'&&!r.errors.length).length,restore:rows.filter(r=>r.action==='restore'&&!r.errors.length).length,archivedSkip:rows.filter(r=>r.action==='archived_skip'&&!r.errors.length).length, delete: rows.filter(r => r.action === 'delete').length, preserved: preservedCount+rows.filter(r => r.action === 'stale_preserve').length, error: rows.filter(r => r.errors.length).length },
    rows,
    // Errors anywhere suppress every write operation, including valid rows.
    operations: valid ? rows.filter(row => !['unchanged','archived_skip','stale_preserve'].includes(row.action)) : [],
    sourceRows: sourceRows.map(source => {
      const out = { rowKey: source.rowKey, __sourceRow: source.__sourceRow, __cellErrors: { ...(source.__cellErrors || {}) } };
      if(source.recoverArchived===true)out.recoverArchived=true;
      if(source.recoverRowKey)out.recoverRowKey=String(source.recoverRowKey);
      importable.forEach(col => { if (snapshot || !blank(source[col.k])) out[col.k] = source[col.k] ?? ''; });
      return out;
    }),
    listedAt,
    snapshot,
    importOptions,
    preservedCount,
    snapshotRevision,
    snapshotStale,
    masterData
  };
}

function prepareWorkbook(data, existingRows, { sheetName, ...options } = {}) {
  if (!data || !data.byteLength || data.byteLength > 10 * 1024 * 1024) throw Error('File phải có dữ liệu và không quá 10 MB.');
  const parsed = workbook.parseWorkbook(workbook.read(data), columns, sheetName);
  return { ...prepareRows(parsed.rows, existingRows, options), sheetName: parsed.sheetName, ignoredColumns: parsed.ignored };
}

function prepareSnapshotWorkbook(data, existingRows, { currentRevision, listedAt = today(), archivedRows = [], regions = [], containers = [], allowStale = false, importOptions = {} } = {}) {
  if (!data || !data.byteLength || data.byteLength > 10 * 1024 * 1024) throw Error('File phải có dữ liệu và không quá 10 MB.');
  const parsed = workbook.parseImportSnapshot(data, columns);
  const scoped=!!parsed.scope;let snapshotStale = false,scopedRows=existingRows;
  if(scoped){
    const selectedFields=new Set(parsed.selectedColumns||[]);
    if(parsed.scope.type==='container'){const container=containers.find(item=>String(item.id)===String(parsed.scope.containerId));if(container){const region=regions.find(item=>String(item.id)===String(container.regionId??container.region_id??''));for(const source of parsed.rows){source.container=container.name;if(region)source.region=region.name}}}
    const requested=normalizeImportOptions(importOptions),allowedFields=requested.updateExistingByRowKey?requested.updateFields.filter(key=>selectedFields.has(key)):parsed.selectedColumns||importable.map(column=>column.k),scopedFields=allowedFields.filter(key=>!['rowKey','container','region'].includes(key));
    importOptions={preserveMissing:true,updateExistingByRowKey:true,updateFields:scopedFields,clearBlanks:requested.updateExistingByRowKey?requested.clearBlanks:true};
  }else if(parsed.selectedColumns?.length<importable.length){const requested=normalizeImportOptions(importOptions),selectedFields=new Set(parsed.selectedColumns),fields=requested.updateExistingByRowKey?requested.updateFields.filter(key=>selectedFields.has(key)):parsed.selectedColumns;importOptions={...requested,updateExistingByRowKey:true,updateFields:fields,clearBlanks:requested.updateExistingByRowKey?requested.clearBlanks:true}}
  if(!importOptions.updateExistingByRowKey)importOptions={...normalizeImportOptions(importOptions),preserveMissing:true};
  return { ...prepareRows(parsed.rows, scopedRows, { listedAt, snapshot: true, snapshotRevision: scoped?null:currentRevision, snapshotStale, archivedRows:scoped?[]:archivedRows, regions, containers,importOptions }), sourceSnapshotRevision: parsed.revision,scope:parsed.scope, sheetName: 'Đặt hàng', ignoredColumns: [], fields: parsed.fields };
}

function recheckPreview(preview, currentRows, archivedRows = [], regions = [], containers = []) {
  if (!preview?.valid) throw Error('Toàn bộ file phải hợp lệ trước khi xác nhận.');
  // Re-match by Mã dòng against the latest active rows. Version changes are
  // allowed; the values in the uploaded file intentionally win for those rows.
  return prepareRows(preview.sourceRows, currentRows, { listedAt: preview.listedAt, snapshot: preview.snapshot, snapshotRevision: null, snapshotStale: false, archivedRows, regions, containers,importOptions:{...preview.importOptions,preserveMissing:true} });
}

module.exports = { prepareRows, prepareWorkbook, prepareSnapshotWorkbook, recheckPreview };

'use strict';
const calculations=require('../public/shared/purchase-calculations');
const freightModel=require('../public/shared/purchase-freight');
const { randomUUID } = require('node:crypto');
const { getPool } = require('../db/pool');
const columns = require('../public/shared/purchase-columns');
const { prepareRows, prepareWorkbook, prepareSnapshotWorkbook, recheckPreview } = require('./purchaseOrdersImport');
const { invalidateContainerDetails } = require('../productContainers/repository');
const { projectContainers } = require('./purchaseOrdersProjection');
const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');
// Cot chi doc duoc danh dau `ro` trong purchase-columns.js — mot nguon duy nhat,
// khong lap danh sach ten cot o hai noi nhu truoc.
const writable = columns.filter(c => !c.d && !c.m && !c.ro);
const overrideColumns = columns.filter(c => c.o);
const overrideByKey = new Map(overrideColumns.map(c => [c.k,c]));
writable.push({k:'buyerEmployeeId',t:'text',l:'Nhân viên'});
const snake = key => key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
const dbCols = writable.map(c=>snake(c.k));
const numeric = new Set(['num','num1','num2','num3','num4','cny','money','pct','ratio']);
const fail = (statusCode,code,message,extra={}) => Object.assign(new Error(message),{statusCode,code,...extra});
const { normalizeName } = require('./containerNames');
const employeeColor=value=>{if(typeof value!=='string'||!/^#[0-9A-Fa-f]{6}$/.test(value))throw fail(400,'COLOR_INVALID','Chọn màu RGB hợp lệ.');return value.toUpperCase()};
function measurementFallbacks(row) {
  const perUnit=row.measure_m3_per_unit==null?null:Number(row.measure_m3_per_unit),perCarton=row.measure_per_carton==null?null:Number(row.measure_per_carton),kgPerUnit=row.measure_kg_per_unit==null?null:Number(row.measure_kg_per_unit);
  const literWarehouse=perUnit==null?null:perUnit*1000,gramWarehouse=kgPerUnit==null?null:kgPerUnit*1000;
  const derived=calculations.row({...row,literWarehouse,gramWarehouse,measurementOverrides:{}},null);
  return {literWarehouse,m3Warehouse:perUnit==null||perCarton==null?null:Number((perUnit*perCarton).toFixed(12)),literChina:derived.literChina,literDiff:derived.literDiff,gramWarehouse,gramChina:derived.gramChina,gramDiff:derived.gramDiff,measuredOn:null,ratio:derived.ratio};
}
function jsRow(row) {
  const out={freightAmount:null,id:String(row.id),rowKey:row.row_key,sourceSheet:row.source_sheet??null,sourceRow:row.source_row==null?null:Number(row.source_row),rootKey:row.root_key,splitFromKey:row.split_from_key,contId:row.container_id==null?null:String(row.container_id),version:Number(row.version),buyerEmployeeId:row.buyer_employee_id==null?null:String(row.buyer_employee_id)};
  writable.forEach(c=>{const value=row[snake(c.k)];out[c.k]=value==null?null:c.k==='buyerEmployeeId'?String(value):c.t==='datetime'? (value instanceof Date?([value.getFullYear(),String(value.getMonth()+1).padStart(2,'0'),String(value.getDate()).padStart(2,'0')].join('-')+(value.getHours()||value.getMinutes()?'T'+String(value.getHours()).padStart(2,'0')+':'+String(value.getMinutes()).padStart(2,'0'):'')):String(value).replace(' ','T').replace(/T00:00:00(?:\.000)?$/,'').replace(/:(\d{2}):00$/ ,':$1')) : c.t==='date'?(value instanceof Date?[value.getFullYear(),String(value.getMonth()+1).padStart(2,'0'),String(value.getDate()).padStart(2,'0')].join('-'):String(value).slice(0,10)):numeric.has(c.t)?Number(value):value});
  out.measurementOverrides=row.measurement_overrides&&typeof row.measurement_overrides==='object'&&!Array.isArray(row.measurement_overrides)?row.measurement_overrides:{};
  const fallback=measurementFallbacks({...row,...out});out.measurementDefaults=fallback;Object.defineProperty(out,'_measurementDefaults',{value:fallback});for(const column of overrideColumns)out[column.k]=Object.hasOwn(out.measurementOverrides,column.k)?out.measurementOverrides[column.k]:fallback[column.k];
  return out;
}
function normalizeMeasurementOverride(column,value) {
  if(value==null||typeof value==='string'&&!value.trim())return null;
  if(column.t==='datetime'){
    const parsed=require('../public/shared/purchase-workbook').dateTimeValue(value,false);
    if(!parsed)throw fail(400,'VALIDATION_ERROR',column.l+': ngày không hợp lệ.');
    return parsed;
  }
  const number=calculations.parse(value),signed=['literDiff','gramDiff'].includes(column.k);
  if(!Number.isFinite(number)||number<0&&!signed||Math.abs(number)>Number.MAX_SAFE_INTEGER)throw fail(400,'VALIDATION_ERROR',column.l+': số không hợp lệ.');
  return number;
}
function measurementOverridePlan(current,changes) {
  const values={...current.measurementOverrides},defaults={...(current._measurementDefaults||{})},diff=[];
  const effective={...current,measurementOverrides:{}};
  for(const key of ['literWarehouse','gramWarehouse'])if(Object.hasOwn(changes,key)){const source=normalizeMeasurementOverride(overrideByKey.get(key),changes[key]);effective[key]=source==null?defaults[key]:source}
  const recalculated=calculations.row(effective,null);defaults.literDiff=recalculated.literDiff;defaults.gramDiff=recalculated.gramDiff;
  for(const [key,input] of Object.entries(changes)){
    const column=overrideByKey.get(key);if(!column)continue;
    let next=normalizeMeasurementOverride(column,input),before=Object.hasOwn(values,key)?values[key]:undefined;
    if(next!=null&&defaults[key]!=null&&String(next)===String(defaults[key]))next=null;
    if(next==null){if(before===undefined)continue;delete values[key]}
    else {if(before!==undefined&&String(before)===String(next))continue;values[key]=next}
    diff.push({key,label:column.l,before:current[key]??null,after:next==null?defaults[key]??null:next});
  }
  return {values,diff};
}
function withFreight(rows,containers){const rates=freightModel.rates(rows,containers);return rows.map(r=>({...r,freightAmount:freightModel.rowAmount(r,rates)}))}
function actor(user) { if(!user?.id)throw fail(401,'AUTH_REQUIRED','Chưa đăng nhập.');return {id:String(user.id),name:String(user.hoTen||user.username||user.id)}; }
const MEASURED_ROW_SQL='p.*,sm.m3_per_unit AS measure_m3_per_unit,sm.per_carton AS measure_per_carton,sm.kg_per_unit AS measure_kg_per_unit';
async function readPurchaseRow(client,id,lock=false){return (await client.query(`SELECT ${MEASURED_ROW_SQL} FROM purchase_orders p LEFT JOIN shipping_measures sm ON sm.code_key=lower(btrim(p.product_code)) WHERE p.id=$1${lock?' FOR UPDATE OF p':''}`,[id])).rows[0]}
async function readRows(client,lock=false) { return (await client.query(`SELECT ${MEASURED_ROW_SQL} FROM purchase_orders p LEFT JOIN shipping_measures sm ON sm.code_key=lower(btrim(p.product_code)) WHERE p.deleted_at IS NULL ORDER BY p.id${lock?' FOR UPDATE OF p':''}`)).rows.map(jsRow); }
async function audit(client,user,action,summary) { const who=actor(user);client.purchaseAction=action;await client.query('INSERT INTO purchase_history(action,actor_id,actor_name,summary) VALUES($1,$2,$3,$4)',[action,who.id,who.name,JSON.stringify({...summary,operationId:client.purchaseOperation})]); }
async function insertMany(client,records) {
  if(!records.length)return [];
  const cols=['row_key','root_key','root_order_id','split_from_key','container_id',...dbCols];
  return (await client.query(`INSERT INTO purchase_orders(${cols.join(',')}) SELECT ${cols.join(',')} FROM jsonb_populate_recordset(NULL::purchase_orders,$1::jsonb) RETURNING *`,[JSON.stringify(records)])).rows;
}
async function patchRow(client,row,changes) {
  if(Object.hasOwn(changes,'buyer')&&!Object.hasOwn(changes,'buyer_employee_id'))changes.buyer_employee_id=null;
  const keys=Object.keys(changes).filter(key=>dbCols.includes(key)||['row_key','root_key','split_from_key','container_id','measurement_overrides'].includes(key));
  if(!keys.length)return row;
  const updated=(await client.query(`UPDATE purchase_orders SET ${keys.map((k,i)=>`${k}=$${i+2}${k==='measurement_overrides'?'::jsonb':''}`).join(',')},version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[row.id,...keys.map(k=>changes[k])])).rows[0];
  return readPurchaseRow(client,updated.id);
}
function createPurchaseOrdersService({ pool=getPool(), project=projectContainers, events=dashboardRollupEvents, lockKey=20531015, invalidate=invalidateContainerDetails }={}) {
  async function transaction(user,fn) {
    actor(user);const client=await pool.connect();let committed=false;
    try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[lockKey]);
      const settings=await client.query('SELECT source_mode,integration_enabled FROM purchase_settings WHERE id=1 FOR UPDATE');
      if(settings.rows[0]?.source_mode!=='web')throw fail(503,'PURCHASE_SOURCE_NOT_ACTIVE','Thu mua chưa chuyển nguồn sang web.');
      // Cach ly (integration_enabled=false, xem migration 0117): ghi that vao bang
      // canonical cua Thu mua va van ghi lich su/audit, nhung KHONG cham gi sang
      // du lieu dung chung — khong projection, khong xoa cache cont, khong phat
      // containersChanged. Doc trong cung giao dich da FOR UPDATE nen mot luot ghi
      // khong the vua cach ly vua noi vao he thong.
      const integrated=settings.rows[0]?.integration_enabled===true;
      const request=user._purchaseRequest;if(request){const prior=(await client.query('SELECT fingerprint,result FROM purchase_requests WHERE actor_id=$1 AND request_key=$2',[actor(user).id,request.key])).rows[0];if(prior){if(prior.fingerprint!==request.fingerprint)throw fail(409,'REQUEST_KEY_REUSED','Mã lần lưu đã dùng cho dữ liệu khác.');await client.query('COMMIT');committed=true;return prior.result}}
      const operation=randomUUID();client.purchaseOperation=operation;client.purchaseAction='';await client.query('INSERT INTO purchase_operations(id,actor_id) VALUES($1,$2)',[operation,actor(user).id]);await client.query("SELECT set_config('purchase.operation_id',$1,true)",[operation]);const result=await fn(client);await client.query('UPDATE purchase_operations SET action=$2 WHERE id=$1',[operation,client.purchaseAction||'']);if(result.changed&&integrated){await project(client)}const response=result.changed&&['create','edit','bulk_edit','transfer','balance_plan','delete','restore'].includes(client.purchaseAction)&&result.value&&typeof result.value==='object'?{...result.value,operationId:operation}:result.value;if(request)await client.query('INSERT INTO purchase_requests(actor_id,request_key,fingerprint,result) VALUES($1,$2,$3,$4)',[actor(user).id,request.key,request.fingerprint,JSON.stringify(response)]);await client.query('COMMIT');committed=true;
      if(result.changed){try{if(integrated){invalidate(pool);events.emit('containersChanged',{source:'purchase'})}events.emit('purchase-orders-changed',{})}catch{}}
      return response;
    }catch(error){if(!committed)await client.query('ROLLBACK').catch(()=>{});if(['22P02','22007','23514','23502'].includes(error.code))throw fail(400,'VALIDATION_ERROR','Dữ liệu không hợp lệ.');if(error.code==='42P01')throw fail(503,'PURCHASE_MIGRATION_REQUIRED','Chưa áp dụng migration Thu mua.');throw error}finally{client.release()}
  }
  async function newKey(client) {const value=(await client.query("SELECT nextval('purchase_order_key_seq')::text AS key")).rows[0].key;return 'D'+value.padStart(5,'0');}
  async function allocateKey(client) {
    const pooled=(await client.query("DELETE FROM purchase_key_pool WHERE row_key=(SELECT row_key FROM purchase_key_pool ORDER BY substring(row_key FROM 2)::bigint LIMIT 1) RETURNING row_key")).rows[0];
    return pooled?.row_key||newKey(client);
  }
  async function recordRetiredKey(client,row) {
    await client.query('INSERT INTO purchase_key_history(row_key,order_id,root_order_id,root_key) VALUES($1,$2,$3,$4)',[row.row_key,row.id,row.root_order_id,row.root_key]);
  }
  async function releaseInactiveFamilyKey(client,rootOrderId,rootKey) {
    const family=(await client.query('SELECT min(root_key) AS root_key,bool_or(deleted_at IS NULL) AS active FROM purchase_orders WHERE root_order_id=$1 GROUP BY root_order_id',[rootOrderId])).rows[0];
    if(family?.active)return false;
    const key=family?.root_key||rootKey;
    if(!key)return false;
    await client.query('INSERT INTO purchase_key_pool(row_key) VALUES($1) ON CONFLICT(row_key) DO NOTHING',[key]);
    return true;
  }
  async function ensureFamilyKey(client,rootOrderId,rootKey) {
    const conflict=(await client.query(`SELECT EXISTS(SELECT 1 FROM purchase_orders WHERE root_key=$1 AND deleted_at IS NULL AND root_order_id<>$2)
      OR EXISTS(SELECT 1 FROM purchase_key_reservations WHERE row_key=$1 AND expires_at>now()) AS used`,[rootKey,rootOrderId])).rows[0].used;
    if(!conflict){await client.query('DELETE FROM purchase_key_pool WHERE row_key=$1',[rootKey]);return rootKey;}
    await client.query('DELETE FROM purchase_key_pool WHERE row_key=$1',[rootKey]);
    const next=await allocateKey(client);
    const rows=(await client.query('SELECT id,row_key,split_from_key FROM purchase_orders WHERE root_order_id=$1 FOR UPDATE',[rootOrderId])).rows;
    for(const row of rows){
      const remap=value=>value===rootKey?next:typeof value==='string'&&value.startsWith(rootKey+'.')?next+value.slice(rootKey.length):value;
      await client.query('UPDATE purchase_orders SET row_key=$2,root_key=$3,split_from_key=$4 WHERE id=$1',[row.id,remap(row.row_key),next,remap(row.split_from_key)]);
    }
    return next;
  }
  async function claimKey(client,userId,requested,reservationId,clientId) {
    if(requested==null||String(requested).trim()==='')return allocateKey(client);
    const key=String(requested).trim();
    if(!/^D\d{5,}$/.test(key)||! /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(reservationId||'')))throw fail(400,'ROW_KEY_UNKNOWN','Cần khóa dòng và mã giữ chỗ hợp lệ.');
    const claimed=(await client.query('DELETE FROM purchase_key_reservations WHERE reservation_id=$1 AND actor_id=$2 AND row_key=$3 AND expires_at>now() RETURNING row_key',[reservationId,userId,key])).rows[0];
    if(!claimed){const expired=(await client.query('SELECT 1 FROM purchase_key_reservations WHERE reservation_id=$1 AND actor_id=$2 AND row_key=$3 AND expires_at<=now()',[reservationId,userId,key])).rows[0];if(expired)throw fail(409,'RESERVATION_EXPIRED','Mã giữ chỗ đã hết hạn.',{clientId});throw fail(400,'ROW_KEY_UNKNOWN','Khóa dòng lạ hoặc không còn được giữ.')}
    return key;
  }
  async function reserveKey(user) {
    const who=actor(user),client=await pool.connect();let committed=false;
    try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[lockKey]);const settings=await client.query('SELECT source_mode FROM purchase_settings WHERE id=1 FOR UPDATE');if(settings.rows[0]?.source_mode!=='web')throw fail(503,'PURCHASE_SOURCE_NOT_ACTIVE','Thu mua chưa chuyển nguồn sang web.');
      const expired=(await client.query('DELETE FROM purchase_key_reservations WHERE expires_at<=now() RETURNING row_key')).rows;for(const row of expired)await client.query('INSERT INTO purchase_key_pool(row_key) VALUES($1) ON CONFLICT(row_key) DO NOTHING',[row.row_key]);
      const rowKey=await allocateKey(client),reservationId=randomUUID(),reservation=(await client.query("INSERT INTO purchase_key_reservations(reservation_id,row_key,actor_id,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes') RETURNING expires_at",[reservationId,rowKey,who.id])).rows[0];
      await client.query('COMMIT');committed=true;return {rowKey,reservationId,expiresAt:reservation.expires_at};
    }catch(error){if(!committed)await client.query('ROLLBACK').catch(()=>{});if(error.code==='42P01')throw fail(503,'PURCHASE_MIGRATION_REQUIRED','Chưa áp dụng migration Thu mua.');throw error}finally{client.release()}
  }
  async function releaseKey(user,{reservationId}={}) {
    const who=actor(user),client=await pool.connect();let committed=false;
    try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[lockKey]);
      const row=(await client.query('DELETE FROM purchase_key_reservations WHERE reservation_id=$1 AND actor_id=$2 AND expires_at>now() RETURNING row_key',[reservationId,who.id])).rows[0];
      if(row)await client.query('INSERT INTO purchase_key_pool(row_key) VALUES($1) ON CONFLICT(row_key) DO NOTHING',[row.row_key]);
      await client.query('COMMIT');committed=true;return {released:!!row};
    }catch(error){if(!committed)await client.query('ROLLBACK').catch(()=>{});if(error.code==='42P01')throw fail(503,'PURCHASE_MIGRATION_REQUIRED','Chưa áp dụng migration Thu mua.');throw error}finally{client.release()}
  }
  async function getRow(client,id,version) {const row=await readPurchaseRow(client,id,true);if(!row||row.deleted_at||Number(row.version)!==Number(version))throw fail(409,'VERSION_CONFLICT','Dòng đã thay đổi.');return row;}
  async function getContainer(client,id,version) {if(arguments.length>=3&&(!Number.isSafeInteger(Number(version))||Number(version)<1))throw fail(400,'VERSION_REQUIRED','Cần phiên bản cont đang xem.');if(id==null)return null;const row=(await client.query('SELECT * FROM product_containers WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row||(version!=null&&Number(row.version)!==Number(version)))throw fail(409,'VERSION_CONFLICT','Cont đã thay đổi.');return row;}
  async function split(client,row,quantity,destination) {
    if(!Number.isSafeInteger(quantity)||quantity<=0||quantity>=Number(row.carton_count))throw fail(400,'SPLIT_QUANTITY_INVALID','Số thùng tách phải nhỏ hơn số hiện có.');
    const before=row.row_key,root=row.root_key;
    await recordRetiredKey(client,row);
    const remaining=await patchRow(client,row,{row_key:before+'.01',split_from_key:before,carton_count:Number(row.carton_count)-quantity,freight_prepaid:null,freight_postpaid:null,freight_amount:null});
    const child={...row,row_key:before+'.02',root_key:root,root_order_id:row.root_order_id,split_from_key:before,container_id:destination,carton_count:quantity,freight_prepaid:null,freight_postpaid:null,freight_amount:null};
    const created=(await insertMany(client,[child]))[0];return {remaining,created,previousKey:before,previousCosts:{freightPrepaid:row.freight_prepaid,freightPostpaid:row.freight_postpaid,freightAmount:row.freight_amount}};
  }
  async function resolveEmployee(client,changes,current=null){
    if(!changes||typeof changes!=='object')return;
    if(Object.hasOwn(changes,'buyerEmployeeId'))throw fail(400,'EMPLOYEE_INVALID','Chọn tên trong danh mục nhân viên Thu mua.');
    if(!Object.hasOwn(changes,'buyer'))return;
    if(changes.buyer==null)changes.buyer='';
    if(typeof changes.buyer!=='string')throw fail(400,'EMPLOYEE_INVALID','Chọn nhân viên Thu mua.');
    if(current&&changes.buyer===(current.buyer??''))return;
    const name=changes.buyer.trim();if(!name){changes.buyer='';return}
    const e=(await client.query('SELECT name FROM purchase_employees WHERE name=$1 AND is_active FOR SHARE',[name])).rows[0];
    if(!e)throw fail(400,'EMPLOYEE_INVALID','Chọn nhân viên đang hoạt động trong danh mục Thu mua.');
    changes.buyer=e.name;
  }
  const employeeSelect='id::text,name,color,is_active AS "isActive",version';
  function employeeName(name){if(typeof name!=='string'||!name.trim()||name.trim().length>200)throw fail(400,'NAME_INVALID','Tên nhân viên phải có 1–200 ký tự.');return name.trim()}
  async function validateImportEmployees(client,plan,current){
    for(const row of plan.rows){
      const changes=row.action==='create'?row.values:Object.fromEntries(row.changes.map(c=>[c.key,c.after]));
      try{await resolveEmployee(client,changes,current.find(r=>r.rowKey===row.rowKey))}catch(error){if(error.code!=='EMPLOYEE_INVALID')throw error;row.errors.push(error.message)}
    }
    plan.valid=plan.rows.every(r=>!r.errors.length);
    plan.counts={create:plan.rows.filter(r=>r.action==='create'&&!r.errors.length).length,update:plan.rows.filter(r=>r.action==='update'&&!r.errors.length).length,unchanged:plan.rows.filter(r=>r.action==='unchanged'&&!r.errors.length).length,delete:plan.rows.filter(r=>r.action==='delete'&&!r.errors.length).length,error:plan.rows.filter(r=>r.errors.length).length};
    plan.operations=plan.valid?plan.rows.filter(r=>r.action!=='unchanged'):[];
    return plan;
  }
  async function editPlanFields(client,raw,changes={}) {
    if(!changes||typeof changes!=='object'||Array.isArray(changes))throw fail(400,'PLAN_INVALID','Thay đổi không hợp lệ.');
    if(Object.keys(changes).some(k=>k!=='contId'&&!writable.some(c=>c.k===k)&&!overrideByKey.has(k)))throw fail(400,'FIELD_NOT_WRITABLE','Trường không được sửa.');
    const normal=Object.fromEntries(Object.entries(changes).filter(([k])=>writable.some(c=>c.k===k)||k==='contId'));
    await resolveEmployee(client,normal,raw);const current=jsRow(raw),plan=prepareRows([{rowKey:current.rowKey,productCode:current.productCode,...normal}],[current]);
    if(!plan.valid)throw fail(400,'VALIDATION_ERROR','Phương án chưa hợp lệ.',{rows:plan.rows});
    const diff=plan.rows[0].changes;
    for(const [key,value] of Object.entries(normal)){if(key==='contId'){const id=value==null||value===''?null:String(value);await getContainer(client,id);if(current.contId!==id)diff.push({key,label:'Tên cont',before:current.contId,after:id})}else if(value===null||value===''){if(['productCode','productName','qtyPerCarton','cartonCount'].includes(key))throw fail(400,'VALIDATION_ERROR','Không được xóa trường bắt buộc.');const next=(key==='listedAt'||key==='buyerEmployeeId')||numeric.has(writable.find(c=>c.k===key).t)?null:'';if(current[key]!==next)diff.push({key,before:current[key],after:next})}}
    const override=measurementOverridePlan(current,changes);diff.push(...override.diff);const patch={};diff.forEach(c=>{if(writable.some(w=>w.k===c.key)||c.key==='contId')patch[c.key==='contId'?'container_id':snake(c.key)]=c.after});if(override.diff.length)patch.measurement_overrides=JSON.stringify(override.values);const updated=diff.length?await patchRow(client,raw,patch):raw;return {row:updated,diff};
  }
  return {
    async employees(user){actor(user);return (await pool.query('SELECT '+employeeSelect+' FROM purchase_employees ORDER BY name,id')).rows},
    async saveEmployees(user,{entries}){
      if(!Array.isArray(entries)||entries.length>500)throw fail(400,'EMPLOYEES_INVALID','Danh sách nhân viên không hợp lệ.');
      return transaction(user,async client=>{const rows=[];let changed=false;for(const entry of entries){
        if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).some(k=>!['id','version','name','color','isActive'].includes(k)))throw fail(400,'EMPLOYEES_INVALID','Dữ liệu nhân viên không hợp lệ.');
        const name=employeeName(entry.name),color=employeeColor(entry.color);if(typeof entry.isActive!=='boolean')throw fail(400,'VALIDATION_ERROR','Trạng thái nhân viên không hợp lệ.');
        if(entry.id==null){let row;try{row=(await client.query('INSERT INTO purchase_employees(name,color,is_active) VALUES($1,$2,$3) RETURNING '+employeeSelect,[name,color,entry.isActive])).rows[0]}catch(error){if(error.code==='23505')throw fail(409,'EMPLOYEE_EXISTS','Tên nhân viên đã có.');throw error}await audit(client,user,'employee_create',{after:row});rows.push(row);changed=true;continue}
        if(!/^\d+$/.test(String(entry.id))||!Number.isSafeInteger(Number(entry.version))||Number(entry.version)<1)throw fail(400,'VERSION_REQUIRED','Cần phiên bản nhân viên đang xem.');
        const before=(await client.query('SELECT '+employeeSelect+' FROM purchase_employees WHERE id=$1 FOR UPDATE',[entry.id])).rows[0];if(!before)throw fail(404,'EMPLOYEE_NOT_FOUND','Không có nhân viên.');if(Number(before.version)!==Number(entry.version))throw fail(409,'VERSION_CONFLICT','Danh sách nhân viên đã thay đổi. Tải lại rồi thử lại.');
        if(name===before.name&&color===before.color&&entry.isActive===before.isActive){rows.push(before);continue}
        let row;try{row=(await client.query('UPDATE purchase_employees SET name=$2,color=$3,is_active=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING '+employeeSelect,[entry.id,name,color,entry.isActive])).rows[0]}catch(error){if(error.code==='23505')throw fail(409,'EMPLOYEE_EXISTS','Tên nhân viên đã có.');throw error}await audit(client,user,'employee_edit',{before,after:row});rows.push(row);changed=true;
      }return {changed,value:{rows}}})
    },
    async createEmployee(user,{name,color='#2563EB'}){return transaction(user,async client=>{
      let row;try{row=(await client.query('INSERT INTO purchase_employees(name,color) VALUES($1,$2) RETURNING '+employeeSelect,[employeeName(name),employeeColor(color)])).rows[0]}catch(error){if(error.code==='23505')throw fail(409,'EMPLOYEE_EXISTS','Tên nhân viên đã có.');throw error}
      await audit(client,user,'employee_create',{after:row});return {changed:true,value:row};
    })},
    async updateEmployee(user,id,{version,changes={}}){return transaction(user,async client=>{
      if(!Number.isSafeInteger(Number(version))||Number(version)<1)throw fail(400,'VERSION_REQUIRED','Cần phiên bản nhân viên đang xem.');
      if(!changes||typeof changes!=='object'||Array.isArray(changes)||!Object.keys(changes).length||Object.keys(changes).some(k=>!['name','isActive','color'].includes(k)))throw fail(400,'FIELD_NOT_WRITABLE','Trường nhân viên không được sửa.');
      const before=(await client.query('SELECT '+employeeSelect+' FROM purchase_employees WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!before)throw fail(404,'EMPLOYEE_NOT_FOUND','Không có nhân viên.');
      if(Number(before.version)!==Number(version))throw fail(409,'VERSION_CONFLICT','Nhân viên đã thay đổi.');
      const name=Object.hasOwn(changes,'name')?employeeName(changes.name):before.name;
      if(Object.hasOwn(changes,'isActive')&&typeof changes.isActive!=='boolean')throw fail(400,'VALIDATION_ERROR','Trạng thái nhân viên không hợp lệ.');
      const active=changes.isActive??before.isActive,color=Object.hasOwn(changes,'color')?employeeColor(changes.color):before.color;
      if(name===before.name&&active===before.isActive&&color===before.color)return {changed:false,value:before};
      let row;try{row=(await client.query('UPDATE purchase_employees SET name=$2,is_active=$3,color=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING '+employeeSelect,[id,name,active,color])).rows[0]}catch(error){if(error.code==='23505')throw fail(409,'EMPLOYEE_EXISTS','Tên nhân viên đã có.');throw error}
      await audit(client,user,'employee_edit',{before,after:row});return {changed:true,value:row};
    })},
    async trash(user){actor(user);return (await pool.query(`SELECT ${MEASURED_ROW_SQL} FROM purchase_orders p LEFT JOIN shipping_measures sm ON sm.code_key=lower(btrim(p.product_code)) WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC LIMIT 500`)).rows.map(jsRow)},
    async operations(user){const items=(await pool.query("SELECT id,action,created_at,(SELECT jsonb_agg(COALESCE(r.after_row->>'row_key',r.before_row->>'row_key')) FROM purchase_operation_rows r WHERE r.operation_id=p.id) row_keys FROM purchase_operations p WHERE actor_id=$1 AND undone_by IS NULL AND action IN ('create','edit','bulk_edit','transfer','balance_plan','delete','restore') AND EXISTS(SELECT 1 FROM purchase_operation_rows r WHERE r.operation_id=p.id) ORDER BY created_at DESC LIMIT 50",[actor(user).id])).rows;if(items[0]){const changes=(await pool.query('SELECT before_row,after_row FROM purchase_operation_rows WHERE operation_id=$1 ORDER BY row_id',[items[0].id])).rows;items[0].preview=changes.map(x=>{const before=x.before_row?jsRow(x.before_row):null,after=x.after_row?jsRow(x.after_row):null;const diff=before&&after?[...writable,...overrideColumns,{k:'contId',l:'Tên cont'},{k:'rowKey',l:'Mã dòng'}].filter(c=>String(before[c.k]??'')!==String(after[c.k]??'')).map(c=>({field:c.k,label:c.l||c.k,from:after[c.k],to:before[c.k]})):[];if(x.before_row&&x.after_row&&!!x.before_row.deleted_at!==!!x.after_row.deleted_at)diff.push({field:'deleted',label:'Trạng thái dòng',from:x.after_row.deleted_at?'Đã xóa':'Đang dùng',to:x.before_row.deleted_at?'Đã xóa':'Đang dùng'});return {rowKey:after?.rowKey||before?.rowKey,productCode:after?.productCode||before?.productCode,action:!before?'Xóa mã mới':'Khôi phục trước thao tác',changes:diff}})}return items},
    async remove(user,{rows}){return transaction(user,async client=>{if(!Array.isArray(rows)||!rows.length||rows.length>500||rows.some(r=>!r||!Number.isSafeInteger(Number(r.id))||Number(r.id)<1||!Number.isSafeInteger(Number(r.version))||Number(r.version)<1)||new Set(rows.map(r=>String(r.id))).size!==rows.length)throw fail(400,'DELETE_INVALID','Chọn 1–500 dòng không trùng.');const locked=[];for(const r of rows)locked.push(await getRow(client,r.id,r.version));for(const r of locked){await recordRetiredKey(client,r);await client.query('UPDATE purchase_orders SET deleted_at=now(),version=version+1,updated_at=now() WHERE id=$1',[r.id])}for(const family of new Map(locked.map(r=>[String(r.root_order_id),r])).values())await releaseInactiveFamilyKey(client,family.root_order_id,family.root_key);await audit(client,user,'delete',{rows:locked.map(r=>({id:String(r.id),rowKey:r.row_key,productCode:r.product_code}))});return {changed:true,value:{deleted:locked.length}}})},
    async restore(user,{id,version}){return transaction(user,async client=>{const r=(await client.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!r?.deleted_at||Number(r.version)!==Number(version))throw fail(409,'VERSION_CONFLICT','Dòng đã thay đổi hoặc đã khôi phục.');await ensureFamilyKey(client,r.root_order_id,r.root_key);await client.query('UPDATE purchase_orders SET deleted_at=NULL,version=version+1,updated_at=now() WHERE id=$1',[id]);await audit(client,user,'restore',{id:String(id),rootOrderId:String(r.root_order_id),rowKey:r.row_key});return {changed:true,value:{restored:String(id)}}})},
    async undo(user,{operationId}){return transaction(user,async client=>{
      const op=(await client.query('SELECT * FROM purchase_operations WHERE id=$1 FOR UPDATE',[operationId])).rows[0];
      if(!op||op.actor_id!==actor(user).id||op.undone_by||!['create','edit','bulk_edit','transfer','balance_plan','delete','restore'].includes(op.action))throw fail(409,'UNDO_INVALID','Không thể hoàn tác thao tác này.');
      const changes=(await client.query('SELECT * FROM purchase_operation_rows WHERE operation_id=$1 ORDER BY row_id',[operationId])).rows;
      if(!changes.length)throw fail(409,'UNDO_INVALID','Thao tác không thay đổi dòng.');
      for(const x of changes){
        const current=(await client.query('SELECT to_jsonb(o) snapshot FROM purchase_orders o WHERE id=$1 FOR UPDATE',[x.row_id])).rows[0]?.snapshot||null;
        const expected=(await client.query('SELECT expected_row FROM purchase_undo_expected WHERE operation_id=$1 AND row_id=$2',[operationId,x.row_id])).rows[0]?.expected_row||x.after_row;
        if(JSON.stringify(current)!==JSON.stringify(expected))throw fail(409,'VERSION_CONFLICT','Dòng đã được sửa tiếp; chưa hoàn tác.');
      }
      const familyKeys=new Map();
      for(const x of changes.filter(x=>x.before_row&&!x.before_row.deleted_at)){
        const b=x.before_row,rootId=String(b.root_order_id??x.root_order_id);
        if(!familyKeys.has(rootId))familyKeys.set(rootId,await ensureFamilyKey(client,rootId,b.root_key));
      }
      for(const x of changes.filter(x=>!x.before_row)){
        const current=(await client.query('SELECT * FROM purchase_orders WHERE id=$1',[x.row_id])).rows[0];
        if(current){await recordRetiredKey(client,current);await client.query('DELETE FROM purchase_orders WHERE id=$1',[x.row_id]);await releaseInactiveFamilyKey(client,current.root_order_id,current.root_key)}
      }
      for(const x of changes.filter(x=>x.before_row)){
        const b={...x.before_row},rootId=String(b.root_order_id??x.root_order_id),next=familyKeys.get(rootId);
        if(next&&next!==b.root_key){const oldRoot=b.root_key,remap=value=>value===oldRoot?next:typeof value==='string'&&value.startsWith(oldRoot+'.')?next+value.slice(oldRoot.length):value;b.row_key=remap(b.row_key);b.split_from_key=remap(b.split_from_key);b.root_key=next}
        const keys=Object.keys(b).filter(k=>!['id','version','updated_at','created_at'].includes(k));
        await client.query('UPDATE purchase_orders SET '+keys.map((k,i)=>k+'=$'+(i+2)).join(',')+',version=version+1,updated_at=now() WHERE id=$1',[x.row_id,...keys.map(k=>b[k])]);
        if(x.after_row&&!x.after_row.deleted_at&&b.deleted_at)await recordRetiredKey(client,{...b,id:x.row_id});
      }
      for(const family of new Map(changes.filter(x=>x.before_row?.deleted_at).map(x=>[String(x.before_row.root_order_id??x.root_order_id),x.before_row])).values())await releaseInactiveFamilyKey(client,family.root_order_id,family.root_key);
      await client.query("UPDATE purchase_operations SET undone_by=current_setting('purchase.operation_id')::uuid WHERE id=$1",[operationId]);
      await client.query("INSERT INTO purchase_undo_expected(operation_id,row_id,expected_row) SELECT p.id,r.row_id,to_jsonb(o) FROM purchase_operations p JOIN purchase_operation_rows r ON r.operation_id=p.id JOIN purchase_orders o ON o.id=r.row_id WHERE p.actor_id=$1 AND p.undone_by IS NULL AND p.id<>$2 AND r.row_id=ANY($3::bigint[]) AND (r.after_row-'version'-'updated_at')=(to_jsonb(o)-'version'-'updated_at') ON CONFLICT(operation_id,row_id) DO UPDATE SET expected_row=EXCLUDED.expected_row",[actor(user).id,operationId,changes.map(x=>x.row_id)]);
      await audit(client,user,'undo',{operationId,rows:changes.map(x=>({rowKey:x.before_row?.row_key||x.after_row?.row_key}))});
      return {changed:true,value:{undone:operationId}};
    })},
    async revision(user) {actor(user);return {revision:(await pool.query("SELECT COALESCE(max(id),0)::text || ':' || count(*)::text AS version FROM purchase_history")).rows[0].version}},
    async changes(user,after) {
      actor(user);const client=await pool.connect();let committed=false;
      try{
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const settings=(await client.query('SELECT source_mode,integration_enabled FROM purchase_settings WHERE id=1')).rows[0];
        const current=(await client.query("SELECT COALESCE(max(id),0)::text AS max_id,count(*)::text AS count,COALESCE(max(id),0)::text || ':' || count(*)::text AS revision FROM purchase_history")).rows[0];
        const containers=(await client.query('SELECT * FROM product_containers ORDER BY id')).rows;
        const metadata={revision:current.revision,rows:[],deletedIds:[],containers,sourceMode:settings?.source_mode||null,integrationEnabled:settings?.integration_enabled===true,employeesChanged:false};
        const match=typeof after==='string'&&/^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(after);
        const cursorId=match?Number(match[1]):NaN,cursorCount=match?Number(match[2]):NaN;
        const maxId=Number(current.max_id),historyCount=Number(current.count);
        if(!match||!Number.isSafeInteger(cursorId)||!Number.isSafeInteger(cursorCount)||cursorId>maxId||cursorCount>historyCount||cursorId===maxId&&cursorCount!==historyCount||cursorId===0&&cursorCount!==0){
          metadata.reset=true;metadata.employeesChanged=true;await client.query('COMMIT');committed=true;return metadata;
        }
        const countAfterCursor=Number((await client.query('SELECT count(*)::text AS count FROM purchase_history WHERE id>$1',[cursorId])).rows[0].count);
        const countAtCursor=historyCount-countAfterCursor;
        if(countAtCursor!==cursorCount){metadata.reset=true;metadata.employeesChanged=true;await client.query('COMMIT');committed=true;return metadata}
        const changes=(await client.query(`SELECT r.row_id::text AS id
          FROM purchase_history h JOIN purchase_operation_rows r ON r.operation_id::text=h.summary->>'operationId'
          WHERE h.id>$1 GROUP BY r.row_id ORDER BY r.row_id LIMIT 501`,[cursorId])).rows;
        if(changes.length>500){metadata.reset=true;metadata.employeesChanged=true;await client.query('COMMIT');committed=true;return metadata}
        metadata.employeesChanged=(await client.query("SELECT EXISTS(SELECT 1 FROM purchase_history WHERE id>$1 AND action IN ('employee_create','employee_edit')) AS changed",[cursorId])).rows[0].changed;
        if(changes.length){
          const ids=changes.map(row=>row.id);
          metadata.rows=(await client.query(`SELECT ${MEASURED_ROW_SQL} FROM purchase_orders p LEFT JOIN shipping_measures sm ON sm.code_key=lower(btrim(p.product_code)) WHERE p.deleted_at IS NULL AND p.id=ANY($1::bigint[]) ORDER BY p.id`,[ids])).rows.map(jsRow);
          const active=new Set(metadata.rows.map(row=>row.id));metadata.deletedIds=ids.filter(id=>!active.has(id));
        }
        metadata.reset=false;await client.query('COMMIT');committed=true;return metadata;
      }catch(error){if(!committed)await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
    },
    async list(user) {actor(user);const client=await pool.connect();try{const settings=(await client.query('SELECT source_mode,integration_enabled FROM purchase_settings WHERE id=1')).rows[0];const source=settings?.source_mode;const revision=(await client.query("SELECT COALESCE(max(id),0)::text || ':' || count(*)::text AS version FROM purchase_history")).rows[0].version;const containers=(await client.query('SELECT * FROM product_containers ORDER BY id')).rows;return {revision,sourceMode:source,integrationEnabled:settings?.integration_enabled===true,rows:withFreight(await readRows(client),containers),containers}}finally{client.release()}},
    async importSnapshot(user) {actor(user);const client=await pool.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const settings=(await client.query('SELECT source_mode FROM purchase_settings WHERE id=1')).rows[0];if(settings?.source_mode!=='web')throw fail(503,'PURCHASE_SOURCE_NOT_ACTIVE','Thu mua chưa chuyển nguồn sang web.');const revision=(await client.query("SELECT COALESCE(max(id),0)::text || ':' || count(*)::text AS version FROM purchase_history")).rows[0].version,rows=await readRows(client);await client.query('COMMIT');return {revision,rows}}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}},
    async latest(user,code) {actor(user);if(!String(code||'').trim())throw fail(400,'CODE_REQUIRED','Nhập Mã SP.');const result=await pool.query(`SELECT ${MEASURED_ROW_SQL} FROM purchase_orders p LEFT JOIN shipping_measures sm ON sm.code_key=lower(btrim(p.product_code)) WHERE p.deleted_at IS NULL AND lower(btrim(p.product_code))=lower(btrim($1)) ORDER BY p.listed_at DESC NULLS LAST,p.id DESC LIMIT 1`,[String(code).trim()]);return result.rows[0]?jsRow(result.rows[0]):null},
    // nextval khong quay lui khi rollback, nen dat cho lam thung day so — dung quy tac khong tai su dung khoa.
    reserveKey,
    releaseKey,
    async create(user,input) {return transaction(user,async client=>{const normal=Object.fromEntries(Object.entries(input).filter(([k])=>writable.some(c=>c.k===k)));await resolveEmployee(client,normal);const plan=prepareRows([{...normal,rowKey:undefined}],[],{});if(!plan.valid)throw fail(400,'VALIDATION_ERROR','Dữ liệu chưa hợp lệ.',{rows:plan.rows});if(Object.keys(input).some(k=>!columns.some(c=>c.k===k)&&!['rowKey','contId','reservationId'].includes(k)))throw fail(400,'FIELD_NOT_WRITABLE','Trường không được sửa.');const key=await claimKey(client,actor(user).id,input.rowKey,input.reservationId),data={...plan.rows[0].values,buyerEmployeeId:input.buyerEmployeeId??null};const row={row_key:key,root_key:key,container_id:null};writable.forEach(c=>row[snake(c.k)]=data[c.k]??null);let created=(await insertMany(client,[row]))[0];if(overrideColumns.some(c=>Object.hasOwn(input,c.k))){const measured=await readPurchaseRow(client,created.id),override=measurementOverridePlan(jsRow(measured),input);if(override.diff.length)created=await patchRow(client,measured,{measurement_overrides:JSON.stringify(override.values)})}await audit(client,user,'create',{row:jsRow(created)});return {changed:true,value:jsRow(created)}})},
    async update(user,id,{version,before={},changes={}}) {return transaction(user,async client=>{const raw=await readPurchaseRow(client,id,true);if(!raw||raw.deleted_at)throw fail(404,'ROW_NOT_FOUND','Không có dòng hàng.');const current=jsRow(raw);for(const key of Object.keys(changes)){if(key!=='contId'&&!writable.some(c=>c.k===key)&&!overrideByKey.has(key))throw fail(400,'FIELD_NOT_WRITABLE','Trường không được sửa.');if(Number(raw.version)!==Number(version)&&(!Object.hasOwn(before,key)||String(current[key]??'')!==String(before[key]??'')))throw fail(409,'VERSION_CONFLICT','Ô đã được người khác sửa.')}
      const result=await editPlanFields(client,raw,changes);if(!result.diff.length)return {changed:false,value:current};await audit(client,user,'edit',{rowKey:current.rowKey,changes:result.diff});return {changed:true,value:jsRow(await readPurchaseRow(client,id))}})},
    async createContainer(user,input) {return transaction(user,async client=>{const name=String(input.name||'').trim();if(!name||name.length>200)throw fail(400,'NAME_INVALID','Tên cont chưa hợp lệ.');const truck=typeof input.truckName==='string'?input.truckName.trim():'';if(input.truckName!=null&&typeof input.truckName!=='string'||truck.length>80)throw fail(400,'TRUCK_INVALID','Loại xe tối đa 80 ký tự.');let row;try{row=(await client.query('INSERT INTO product_containers(name,name_key,truck_name,carrier,loader,freight_mode) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[name,normalizeName(name),truck,String(input.carrier||''),String(input.loader||''),'formula'])).rows[0]}catch(error){if(error.code==='23505')throw fail(409,'CONTAINER_EXISTS','Tên cont đã có.');throw error}await audit(client,user,'container_create',{id:row.id,name});return {changed:true,value:row}})},

    async updateContainer(user,id,{version,changes={},rows}) {
      return transaction(user,async client=>{
        if(!changes||typeof changes!=='object'||Array.isArray(changes))throw fail(400,'VALIDATION_ERROR','Thay đổi cont không hợp lệ.');
        if(Object.hasOwn(changes,'freight')&&changes.freight===null){changes.freightMode='formula';changes.freightBase=202000000;changes.freightCapacity=170}else if(Object.hasOwn(changes,'freight')&&!Object.hasOwn(changes,'freightMode'))changes.freightMode='manual';
        const container=await getContainer(client,id,version);
        if(!container)throw fail(404,'CONTAINER_NOT_FOUND','Không có cont.');
        const fields={truckName:'truck_name',arrivalNote:'arrival_note',arrivalDate:'arrival_date',maxTon:'max_ton',m3Min:'m3_min',m3Max:'m3_max',name:'name',carrier:'carrier',loader:'loader',nameCn:'name_cn',loading:'loading',freight:'freight',freightMode:'freight_mode',freightBase:'freight_base',freightCapacity:'freight_capacity'};
        const entries=[];
        for(const [key,value] of Object.entries(changes)){
          if(!fields[key])throw fail(400,'FIELD_NOT_WRITABLE','Trường cont không được sửa.');
          if(key==='freightMode'&&!['manual','formula'].includes(value))throw fail(400,'VALIDATION_ERROR','Chọn chế độ cước hợp lệ.');
          if(['freightBase','freightCapacity'].includes(key)&&(calculations.number(value)==null||Number(value)<0||key==='freightCapacity'&&Number(value)<=0||value===''||value==null))throw fail(400,'VALIDATION_ERROR','Tiền chuẩn không âm và m³ chuẩn phải lớn hơn 0.');
          if(key==='freight'&&value!==null&&(!Number.isFinite(Number(value))||Number(value)<0))throw fail(400,'VALIDATION_ERROR','Cước cont không hợp lệ.');
          if(key==='name'&&(!String(value||'').trim()||String(value).length>200))throw fail(400,'VALIDATION_ERROR','Tên cont không hợp lệ.');
          if(key==='truckName'&&(typeof value!=='string'||value.length>80))throw fail(400,'TRUCK_INVALID','Loại xe tối đa 80 ký tự.');
          if(['maxTon','m3Min','m3Max'].includes(key)&&(value==null||value===''||calculations.number(value)==null||Number(value)<0||key==='maxTon'&&Number(value)<=0))throw fail(400,'VALIDATION_ERROR','Sức chứa cont không hợp lệ.');
          if(['name','carrier','loader','nameCn','loading','arrivalNote'].includes(key)&&typeof value!=='string')throw fail(400,'VALIDATION_ERROR','Thông tin cont không hợp lệ.');
          if(['arrivalNote','arrivalDate'].includes(key)&&value!==null&&value!==''&&!(key==='arrivalNote'?require('../public/shared/purchase-workbook').dateTimeValue:require('../public/shared/purchase-workbook').dateValue)(value,false))throw fail(400,'VALIDATION_ERROR','Ngày cont không hợp lệ.');
          entries.push([fields[key],key==='arrivalDate'?(value?require('../public/shared/purchase-workbook').dateValue(value,false):null):key==='arrivalNote'?(value?require('../public/shared/purchase-workbook').dateTimeValue(value,false):''):['name','truckName'].includes(key)?value.trim():value]);if(key==='name')entries.push(['name_key',normalizeName(value)]);
        }
        if(Number(changes.m3Max??container.m3_max)<Number(changes.m3Min??container.m3_min))throw fail(400,'VALIDATION_ERROR','m³ tối đa phải lớn hơn hoặc bằng tối thiểu.');
        if(!entries.length)return {changed:false,value:container};
        const shared=Object.hasOwn(changes,'arrivalNote')||Object.hasOwn(changes,'arrivalDate'),details=[];
        if(shared){
          const actual=(await client.query('SELECT * FROM purchase_orders WHERE deleted_at IS NULL AND container_id=$1 ORDER BY id FOR UPDATE',[id])).rows;
          if(!Array.isArray(rows)||rows.length!==actual.length||rows.some(r=>!r||!Number.isSafeInteger(Number(r.version))||Number(r.version)<1)||new Set(rows.map(r=>String(r.id))).size!==actual.length||actual.some(r=>!rows.some(x=>String(x.id)===String(r.id)&&Number(x.version)===Number(r.version))))throw fail(409,'VERSION_CONFLICT','Danh sách hoặc phiên bản dòng trong cont đã thay đổi.');
          for(const raw of actual){const patch={};if(Object.hasOwn(changes,'arrivalNote'))patch.eta_note=entries.find(([key])=>key==='arrival_note')[1]||null;if(Object.hasOwn(changes,'arrivalDate'))patch.arrived_note=entries.find(([key])=>key==='arrival_date')[1]||null;
            const updated=await patchRow(client,raw,patch);details.push({before:jsRow(raw),after:jsRow(updated)});
          }
        }
        let row;
        try{
          const assignments=entries.map(([key],i)=>key+'=$'+(i+2)).join(',');
          row=(await client.query('UPDATE product_containers SET '+assignments+',version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,...entries.map(([,value])=>value)])).rows[0];
        }catch(error){if(error.code==='23505')throw fail(409,'CONTAINER_EXISTS','Tên cont đã có.');throw error;}
        await audit(client,user,'container_edit',{containerId:id,before:container,after:row,changes,rows:details});
        return {changed:true,value:row};
      });
    },
    async applyPlan(user,{rows=[],splits=[],creates=[]}) {return transaction(user,async client=>{
      if(!Array.isArray(rows)||!Array.isArray(splits)||!Array.isArray(creates)||!rows.length&&!splits.length&&!creates.length||rows.length>500||splits.length>100||creates.length>100)throw fail(400,'PLAN_INVALID','Phương án có quá nhiều hoặc không có thay đổi.');
      const requests=[...rows,...splits];if(new Set(requests.map(r=>String(r.id))).size!==requests.length)throw fail(400,'PLAN_DUPLICATE','Một dòng chỉ được xuất hiện một lần trong phương án.');
      const locked=new Map();for(const requested of requests)locked.set(String(requested.id),await getRow(client,requested.id,requested.version));
      const detail=[],branches=[],created=[],createdRows=[];
      for(const requested of rows){const result=await editPlanFields(client,locked.get(String(requested.id)),requested.changes);if(result.diff.length)detail.push({rowKey:result.row.row_key,changes:result.diff})}
      for(const requested of splits){let raw=locked.get(String(requested.id));const parentQty=Number(requested.sourceQty),quantity=Number(requested.quantity),sourceQty=requested.manual?parentQty+quantity:parentQty;if(!Number.isSafeInteger(parentQty)||parentQty<=0||!Number.isSafeInteger(sourceQty)||!Number.isSafeInteger(quantity)||quantity<=0||quantity>=sourceQty)throw fail(400,'SPLIT_QUANTITY_INVALID','Số thùng tách không hợp lệ.');
        const source=await editPlanFields(client,raw,{...(requested.sourceValues||{}),cartonCount:sourceQty});raw=source.row;const destination=requested.destinationId==null||requested.destinationId===''?null:String(requested.destinationId);await getContainer(client,destination);const part=await split(client,raw,quantity,destination);
        const parentChanges=requested.parentChanges||{},childChanges=requested.childChanges||{};if(Object.hasOwn(parentChanges,'cartonCount')&&Number(parentChanges.cartonCount)!==sourceQty-quantity||Object.hasOwn(childChanges,'cartonCount')&&Number(childChanges.cartonCount)!==quantity)throw fail(400,'SPLIT_TOTAL_INVALID','Tổng hai phần phải bằng số thùng trước tách.');
        await editPlanFields(client,part.remaining,parentChanges);await editPlanFields(client,part.created,childChanges);branches.push({previousKey:part.previousKey,parentKey:part.remaining.row_key,childKey:part.created.row_key,sourceQty,quantity,from:raw.container_id,to:destination,previousCosts:part.previousCosts});
      }
      for(const input of creates){const values=input.values||input,normal=Object.fromEntries(Object.entries(values).filter(([k])=>writable.some(c=>c.k===k)));await resolveEmployee(client,normal);const plan=prepareRows([{...normal,rowKey:undefined}],[],{});if(!plan.valid)throw fail(400,'VALIDATION_ERROR','Mã mới chưa hợp lệ.',{rows:plan.rows});if(Object.keys(values).some(k=>!columns.some(c=>c.k===k)&&!['rowKey','contId','id','version'].includes(k)))throw fail(400,'FIELD_NOT_WRITABLE','Trường không được sửa.');if(input.clientId!=null&&(typeof input.clientId!=='string'||input.clientId.length>128))throw fail(400,'CLIENT_ID_INVALID','Mã dòng mới không hợp lệ.');const key=await claimKey(client,actor(user).id,values.rowKey,input.reservationId,input.clientId),record={row_key:key,root_key:key,container_id:null};writable.forEach(c=>record[snake(c.k)]=(c.k==='buyerEmployeeId'?values.buyerEmployeeId:plan.rows[0].values[c.k])??null);const raw=(await insertMany(client,[record]))[0];if(overrideColumns.some(c=>Object.hasOwn(values,c.k))){const measured=await readPurchaseRow(client,raw.id);await editPlanFields(client,measured,Object.fromEntries(overrideColumns.filter(c=>Object.hasOwn(values,c.k)).map(c=>[c.k,values[c.k]])))}created.push(key);createdRows.push({clientId:input.clientId??null,id:String(raw.id),rowKey:key})}
      await audit(client,user,'balance_plan',{rows:detail,splits:branches,createdKeys:created});return {changed:true,value:{updated:detail.length,split:branches,createdKeys:created,createdRows}};
    })},
    async changeStatus(user,{containerId,version,status}) {return transaction(user,async client=>{const next=Number(status);if(!Number.isInteger(next)||next<1||next>4)throw fail(400,'STATUS_INVALID','Trạng thái không hợp lệ.');const c=await getContainer(client,containerId,version);if(!c)throw fail(404,'CONTAINER_NOT_FOUND','Không có cont.');if(c.status===next)return {changed:false,value:c};const updated=(await client.query('UPDATE product_containers SET status=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[containerId,next])).rows[0];await audit(client,user,'status_edit',{containerId,before:c.status,after:next});return {changed:true,value:updated}})},
    async schedule(user,{containerId,version,loading}) {return transaction(user,async client=>{const c=await getContainer(client,containerId,version);if(!c||c.status!==1)throw fail(409,'CONTAINER_STATE','Cont không ở trạng thái chưa có lịch.');if(!String(loading||'').trim())throw fail(400,'VALIDATION_ERROR','Nhập lịch bốc.');const row=(await client.query('UPDATE product_containers SET status=2,loading=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[containerId,String(loading).trim()])).rows[0];await audit(client,user,'schedule',{containerId,loading});return {changed:true,value:row}})},
    async bulkEdit(user,{rows,changes}) {return transaction(user,async client=>{if(!Array.isArray(rows)||!rows.length||rows.length>500||!changes||typeof changes!=='object'||!Object.keys(changes).length||new Set(rows.map(r=>String(r.id))).size!==rows.length)throw fail(400,'BULK_INVALID','Chọn 1–500 dòng không trùng và trường cần sửa.');if(Object.keys(changes).some(key=>!writable.some(c=>c.k===key)))throw fail(400,'FIELD_NOT_WRITABLE','Trường không được sửa.');const results=[],details=[];for(const requested of rows){const raw=(await client.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE',[requested.id])).rows[0];if(!raw||raw.deleted_at){results.push({id:requested.id,status:'conflict'});continue}await resolveEmployee(client,changes,raw);const current=jsRow(raw);if(Number(raw.version)!==Number(requested.version)&&Object.keys(changes).some(k=>!Object.hasOwn(requested.before||{},k)||String(current[k]??'')!==String(requested.before[k]??''))){results.push({id:requested.id,status:'conflict'});continue}const plan=prepareRows([{rowKey:current.rowKey,productCode:current.productCode,...changes}],[current]);if(!plan.valid){results.push({id:requested.id,status:'invalid',errors:plan.rows[0].errors});continue}const diff=plan.rows[0].changes;for(const key of Object.keys(changes)){if(changes[key]===''||changes[key]===null){if(['productCode','productName','qtyPerCarton','cartonCount'].includes(key))throw fail(400,'VALIDATION_ERROR','Không được xóa thông tin bắt buộc.');const next=(key==='listedAt'||key==='buyerEmployeeId')||numeric.has(writable.find(c=>c.k===key).t)?null:'';if(current[key]!==next)diff.push({key,before:current[key],after:next})}}if(!diff.length){results.push({id:requested.id,status:'unchanged'});continue}const patch={};diff.forEach(c=>patch[snake(c.key)]=c.after);await patchRow(client,raw,patch);results.push({id:requested.id,status:'updated'});details.push({rowKey:current.rowKey,changes:diff})}if(details.length)await audit(client,user,'bulk_edit',{rows:details});return {changed:details.length>0,value:{results}}})},
    async reviseImport(user,token,inputRows) {return transaction(user,async client=>{const saved=(await client.query('SELECT *,expires_at>now() AS live FROM purchase_import_previews WHERE token=$1 AND actor_id=$2 FOR UPDATE',[token,actor(user).id])).rows[0];if(!saved||!saved.live||saved.result)throw fail(409,'PREVIEW_NOT_EDITABLE','Bản xem trước không còn sửa được.');if(!Array.isArray(inputRows)||inputRows.length!==saved.payload.sourceRows.length)throw fail(400,'IMPORT_ROW_COUNT','Phải sửa toàn bộ file, không được bỏ dòng lỗi.');const clean=inputRows.map((row,i)=>{const out={rowKey:row.rowKey,__sourceRow:saved.payload.sourceRows[i].__sourceRow};writable.forEach(c=>{if(Object.hasOwn(row,c.k))out[c.k]=row[c.k]});return out});const current=await readRows(client),revision=(await client.query("SELECT COALESCE(max(id),0)::text || ':' || count(*)::text AS version FROM purchase_history")).rows[0].version;if(saved.payload.snapshotRevision&&revision!==saved.payload.snapshotRevision)throw fail(409,'IMPORT_SNAPSHOT_STALE','Dữ liệu đã thay đổi. Tải snapshot mới rồi sửa lại.');const plan=await validateImportEmployees(client,prepareRows(clean,current,{listedAt:saved.payload.listedAt,snapshot:saved.payload.snapshot,snapshotRevision:saved.payload.snapshotRevision}),current);await client.query('UPDATE purchase_import_previews SET payload=$2 WHERE token=$1',[token,JSON.stringify(plan)]);return {changed:false,value:{token,valid:plan.valid,counts:plan.counts,rows:plan.rows,inputRows:plan.sourceRows}}})},
    async transfer(user,{id,version,quantity,destinationId=null}) {return transaction(user,async client=>{const row=await getRow(client,id,version);await getContainer(client,destinationId);if(String(row.container_id)===String(destinationId))throw fail(400,'SAME_CONTAINER','Nguồn và đích trùng nhau.');const qty=Number(quantity);let result;if(qty===Number(row.carton_count))result={row:jsRow(await patchRow(client,row,{container_id:destinationId}))};else{const parts=await split(client,row,qty,destinationId);result={previousKey:parts.previousKey,remaining:jsRow(parts.remaining),created:jsRow(parts.created),previousCosts:parts.previousCosts}}await audit(client,user,'transfer',{from:row.container_id,to:destinationId,...result});return {changed:true,value:result}})},
    async depart(user,{containerId,version,rows}) {return transaction(user,async client=>{const container=await getContainer(client,containerId,version);if(!container||container.status>=3)throw fail(409,'CONTAINER_STATE','Cont không ở trạng thái chờ xuất.');const actual=(await client.query('SELECT * FROM purchase_orders WHERE deleted_at IS NULL AND container_id=$1 ORDER BY id FOR UPDATE',[containerId])).rows;if(!Array.isArray(rows)||!actual.length||rows.length!==actual.length||new Set(rows.map(r=>String(r.id))).size!==actual.length)throw fail(409,'VERSION_CONFLICT','Danh sách thực xuất không khớp.');let total=0;for(const row of actual){const input=rows.find(r=>String(r.id)===String(row.id));if(!input||Number(input.version)!==Number(row.version)||!Number.isSafeInteger(input.actual)||input.actual<0||input.actual>Number(row.carton_count))throw fail(409,'VERSION_CONFLICT','Số lượng hoặc phiên bản thực xuất không hợp lệ.');total+=input.actual}if(!total)throw fail(400,'EMPTY_DEPARTURE','Chưa có hàng thực xuất.');const details=[];for(const row of actual){const input=rows.find(r=>String(r.id)===String(row.id));if(input.actual===0)await patchRow(client,row,{container_id:null});else if(input.actual<Number(row.carton_count)){const parts=await split(client,row,Number(row.carton_count)-input.actual,null);details.push({previousKey:parts.previousKey,remainingKey:parts.remaining.row_key,waitingKey:parts.created.row_key})}}
      const snapshot=(await client.query('SELECT * FROM purchase_orders WHERE container_id=$1 ORDER BY id',[containerId])).rows.map(jsRow),who=actor(user);await client.query('INSERT INTO purchase_departures(container_id,snapshot,actor_id,actor_name) VALUES($1,$2,$3,$4)',[containerId,JSON.stringify(snapshot),who.id,who.name]);await client.query('UPDATE product_containers SET status=3,version=version+1,updated_at=now() WHERE id=$1',[containerId]);await audit(client,user,'depart',{containerId,rows:snapshot,details});return {changed:true,value:{containerId,status:3,rows:snapshot}}})},
    async arrive(user,{containerId,version,date,warehouse}) {return transaction(user,async client=>{const c=await getContainer(client,containerId,version);const parsed=require('../public/shared/purchase-workbook').dateValue(date,false);if(!c||c.status!==3)throw fail(409,'CONTAINER_STATE','Cont chưa ở trạng thái đã xuất.');if(!parsed||!String(warehouse||'').trim())throw fail(400,'ARRIVAL_INVALID','Nhập ngày về và kho nhận.');const who=actor(user);const row=(await client.query('UPDATE product_containers SET status=4,arrival_date=$2,arrival_warehouse=$3,arrival_by=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[containerId,parsed,String(warehouse).trim(),who.name])).rows[0];await audit(client,user,'arrive',{containerId,date:parsed,warehouse,confirmedBy:who.name});return {changed:true,value:row}})},
    async previewImport(user,{buffer}) {return transaction(user,async client=>{const revision=(await client.query("SELECT COALESCE(max(id),0)::text || ':' || count(*)::text AS version FROM purchase_history")).rows[0].version,current=await readRows(client),plan=await validateImportEmployees(client,prepareSnapshotWorkbook(buffer,current,{currentRevision:revision}),current),token=randomUUID();await client.query('INSERT INTO purchase_import_previews(token,actor_id,payload) VALUES($1,$2,$3)',[token,actor(user).id,JSON.stringify(plan)]);return {changed:false,value:{token,valid:plan.valid,counts:plan.counts,rows:plan.rows,inputRows:plan.sourceRows}}})},
    async commitImport(user,token) {return transaction(user,async client=>{const saved=(await client.query('SELECT *,expires_at>now() AS live FROM purchase_import_previews WHERE token=$1 AND actor_id=$2 FOR UPDATE',[token,actor(user).id])).rows[0];if(!saved)throw fail(404,'PREVIEW_NOT_FOUND','Không có bản xem trước.');if(saved.result)return {changed:false,value:saved.result};if(!saved.live)throw fail(410,'PREVIEW_EXPIRED','Bản xem trước đã hết hạn.');if(!saved.payload.valid)throw fail(400,'IMPORT_INVALID','Toàn bộ file phải hợp lệ.');const revision=(await client.query("SELECT COALESCE(max(id),0)::text || ':' || count(*)::text AS version FROM purchase_history")).rows[0].version;if(saved.payload.snapshotRevision&&revision!==saved.payload.snapshotRevision)throw fail(409,'IMPORT_SNAPSHOT_STALE','Dữ liệu đã thay đổi. Tải snapshot mới rồi sửa lại.');const current=await readRows(client,true),plan=recheckPreview(saved.payload,current);if(!plan.valid)throw fail(409,'VERSION_CONFLICT','Dữ liệu đã thay đổi. Không ghi dòng nào.',{conflicts:plan.conflicts});const creates=[],updates=[],deletes=[];for(const operation of plan.operations){if(operation.action==='delete'){deletes.push(operation);continue}if(operation.action==='create'){await resolveEmployee(client,operation.values);const key=await newKey(client),record={row_key:key,root_key:key,container_id:null};writable.forEach(c=>record[snake(c.k)]=operation.values[c.k]??null);creates.push(record)}else{const record={...current.find(r=>String(r.id)===String(operation.id))};const assignment=Object.fromEntries(operation.changes.map(c=>[c.key,c.after]));await resolveEmployee(client,assignment,record);operation.changes.forEach(change=>record[change.key]=assignment[change.key]);const data={id:record.id};writable.forEach(c=>data[snake(c.k)]=record[c.k]??null);if(Object.hasOwn(assignment,'buyer'))data.buyer_employee_id=null;updates.push(data)}}
      await insertMany(client,creates);if(updates.length)await client.query(`UPDATE purchase_orders o SET ${dbCols.map(c=>`${c}=s.${c}`).join(',')},version=o.version+1,updated_at=now() FROM jsonb_populate_recordset(NULL::purchase_orders,$1::jsonb) s WHERE o.id=s.id`,[JSON.stringify(updates)]);for(const operation of deletes)await client.query('UPDATE purchase_orders SET deleted_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND deleted_at IS NULL',[operation.id]);const result={counts:plan.counts,createdKeys:creates.map(r=>r.row_key)};if(plan.operations.length)await audit(client,user,'import',{...result,changes:plan.rows.filter(r=>r.action==='update').map(r=>({rowKey:r.rowKey,changes:r.changes})),deleted:deletes.map(r=>r.rowKey)});await client.query('UPDATE purchase_import_previews SET result=$2 WHERE token=$1',[token,JSON.stringify(result)]);return {changed:plan.operations.length>0,value:result}})},
    async exportRows(user) {
      actor(user);const containers=(await pool.query('SELECT * FROM product_containers')).rows,rows=withFreight(await readRows(pool),containers);
      const byId=new Map(containers.map(c=>[String(c.id),c]));return rows.map(row=>{const c=byId.get(String(row.contId));return {...row,container:c?.name||'CONT CHỜ XẾP',status:c?.status||0,...calculations.row(row,row.freightAmount)}});
    },
    async history(user,orderId) {actor(user);if(!/^[1-9]\d*$/.test(String(orderId||''))||BigInt(orderId)>9223372036854775807n)throw fail(400,'ORDER_ID_INVALID','Mã dòng nội bộ không hợp lệ.');const root=(await pool.query('SELECT root_order_id FROM purchase_orders WHERE id=$1',[String(orderId)])).rows[0]?.root_order_id;if(root==null)return [];return (await pool.query("SELECT h.* FROM purchase_history h WHERE EXISTS(SELECT 1 FROM purchase_operation_rows r WHERE r.operation_id::text=h.summary->>'operationId' AND r.root_order_id=$1) ORDER BY h.id DESC LIMIT 500",[root])).rows}
  };
}
module.exports = { createPurchaseOrdersService, jsRow, normalizeName };

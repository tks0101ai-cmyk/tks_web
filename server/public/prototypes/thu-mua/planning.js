/* Private planning on the order table. Canonical rows change only on confirmation. */
const planning = {seq:0,target:null,goals:{},splits:new Map()};
packingSection.hidden=true;
packingSection.style.display='none';
packingButton.remove();
openOrdersPacking=function(){document.querySelector('[data-tab="orders"]').click();renderPacking()};
const planningBaseFiltered=normalFiltered;
function planningRows(){return ROWS.map(r=>({...r,...bulkDrafts.get(r.id)?.changes}))}
filtered=function(){
  const snapshots=ROWS.map(r=>({...r}));
  try{ROWS.forEach(r=>Object.assign(r,bulkDrafts.get(r.id)?.changes));return planningBaseFiltered()}
  finally{ROWS.forEach((r,i)=>{Object.keys(r).forEach(k=>delete r[k]);Object.assign(r,snapshots[i])})}
};
contStats=function(id){const raw=planningRows().filter(r=>String(r.contId??'')===String(id??'')),rs=raw.map(derive),s=PurchaseCalculations.stats(raw);return {...s,rs,vc:PurchaseCalculations.sum(rs.map(r=>r.freightAmount)),ratio:s.missing?null:PurchaseCalculations.divide(s.ton,s.m3)}};
function stagePlanningCell(row,key,next){
  if(['productCode','productName'].includes(key)&&!String(next||'').trim())return false;
  if(['cartonCount','qtyPerCarton'].includes(key)&&(!Number.isSafeInteger(next)||next<=0))return false;
  const col=colByKey(key);if(PurchaseCalculations.issues({...row,...bulkDrafts.get(row.id)?.changes,[key]:next}).some(k=>['totalQty','totalCny','goodsAmount','totalTon','totalM3'].includes(k)))return false;if(col&&isNum(col.t)&&next!=null&&(PurchaseCalculations.number(next)==null||next<0||key==='fxRate'&&next===0))return false;
  if(col?.t==='datetime'&&next&&!PurchaseExcel.dateTimeValue(next))return false;
  const ids=bulkMode&&state.picked.has(row.id)?[...state.picked]:[row.id];
  ids.forEach(id=>{const r=ROWS.find(x=>x.id===id);if(!r)return;const d=bulkDrafts.get(id)||{v:r.v,before:{},changes:{}};if(!Object.hasOwn(d.before,key))d.before[key]=r[key]??'';if(String(d.before[key]??'')===String(next??'')){delete d.before[key];delete d.changes[key]}else d.changes[key]=next;if(Object.keys(d.changes).length)bulkDrafts.set(id,d);else bulkDrafts.delete(id)});
  bulkPending=null;bulkPanel.hidden=true;bulkToolbar();renderConts();return true;
}
// Capture real UI edits; existing domain functions remain available to history/import tools.
mainRows.addEventListener('click',e=>{
  const td=e.target.closest('td'),tr=td?.closest('tr');if(!td||e.target.closest('[data-row-transfer]'))return;if(td.querySelector('input,select')){e.stopImmediatePropagation();return;}
  const r=ROWS.find(x=>x.id===Number(tr.dataset.id)),col=colByKey(td.dataset.k);if(!r||!col||(!col.e&&col.k!=='productCode')||col.m||col.d)return;
  if(bulkMode&&!state.picked.has(r.id))return;
  e.stopImmediatePropagation();if(planning.splits.has(r.id)&&['freightPrepaid','freightPostpaid','freightAmount'].includes(col.k)){toast('Sửa phần tách bằng nút Tách dòng; chi phí nhập lại sau khi lưu tách.',true);return}const key=col.k==='container'?'contId':col.k,current={...r,...bulkDrafts.get(r.id)?.changes};
  const input=document.createElement(key==='contId'?'select':'input');input.className='cell-input';
  if(key==='contId'){input.innerHTML='<option value="">Cont chờ xếp</option>'+CONTAINERS.map(c=>'<option value="'+c.id+'">'+pe(c.name)+'</option>').join('');input.value=current.contId??''}
  else{input.type=col.t==='datetime'?'datetime-local':isNum(col.t)?'number':'text';if(input.type==='number')input.step='any';input.value=col.t==='datetime'&&current[key]&&String(current[key]).length===10?current[key]+'T00:00':current[key]??''}
  td.replaceChildren(input);input.focus();if(input.tagName==='INPUT'&&['text','number'].includes(input.type)){try{input.select()}catch{}}
  const stage=()=>{const raw=input.value,next=key==='contId'?(raw===''?null:Number(raw)):isNum(col.t)?(raw===''?null:Number(raw)):raw;const ok=stagePlanningCell(r,key,next);input.setCustomValidity(ok?'':'Giá trị không hợp lệ');return ok};
  const previousDraft=bulkDrafts.has(r.id)?JSON.parse(JSON.stringify(bulkDrafts.get(r.id))):null;
  input.oninput=()=>{if(!stage())return;if(key==='productCode'){const source=ROWS.filter(x=>!x.__trialNew&&x.id!==r.id&&String(x.productCode).trim().toUpperCase()===input.value.trim().toUpperCase()).sort((a,b)=>String(b.listedAt||'').localeCompare(String(a.listedAt||'')))[0];for(const field of ['productName','supplier','qtyPerCarton','unitPriceCny','kgPerCarton','m3PerCarton']){if(source)stagePlanningCell(r,field,source[field]??(isNum(colByKey(field)?.t)?null:''));else if(['kgPerCarton','m3PerCarton'].includes(field))stagePlanningCell(r,field,null)}}};input.onchange=()=>{stage();if(key==='contId')render()};input.onblur=()=>{if(!stage())toast('Giá trị không hợp lệ; giữ bản nháp trước đó.',true);render()};input.onkeydown=ev=>{if(ev.key==='Enter'){ev.preventDefault();input.blur()}if(ev.key==='Escape'){input.onblur=null;if(previousDraft)bulkDrafts.set(r.id,previousDraft);else bulkDrafts.delete(r.id);input.blur();render()}};
},true);
const planningBaseToolbar=bulkToolbar;
bulkToolbar=function(){planningBaseToolbar();if(bulkMode){if(ROWS.some(r=>r.__trialNew)){const confirm=document.querySelector('#bulkActions .btn-primary');if(confirm){confirm.disabled=false;confirm.onclick=planningCheck}}return;}const actions=document.getElementById('bulkActions'),count=new Set([...bulkDrafts.keys(),...ROWS.filter(r=>r.__trialNew).map(r=>r.id)]).size;if(count)actions.insertAdjacentHTML('beforeend','<button class="btn-primary" onclick="planningCheck()">Xác nhận ('+count+')</button><button class="ghost" onclick="bulkCancel()">Hủy bản nháp</button><span class="crumb">Chỉ số cont đang tính theo bản nháp · Chưa lưu</span>')};
function planningCheck(){bulkCheck();if(ROWS.some(r=>r.__trialNew)){bulkPanel.hidden=false;bulkPanel.insertAdjacentHTML('afterbegin','<p>Thêm '+ROWS.filter(r=>r.__trialNew).length+' mã mới · Chưa cấp khóa chính thức.</p>')}}
const planningBaseCommit=bulkCommit;
bulkCommit=function(){if(!bulkPending)return;const created=ROWS.filter(r=>r.__trialNew).length;planningBaseCommit();ROWS.filter(r=>r.__trialNew).forEach(r=>{r.id=++rowSeq;r.rowKey=nextKey();r.rootKey=r.rowKey;delete r.__trialNew;logIt({action:'create',rowKey:r.rowKey,orderId:r.id,productCode:r.productCode,contName:contById(r.contId)?.name||'Cont chờ xếp',summary:'Thêm mã sau khi kiểm tra phương án cont',new:r.cartonCount+' thùng'})});if(created&&bulkPanel.querySelector('h2'))bulkPanel.querySelector('h2').textContent+=' · '+created+' mã mới';render();syncContSelects()};
const planningBaseCancel=bulkCancel;
bulkCancel=function(){ROWS=ROWS.filter(r=>!r.__trialNew);planningBaseCancel()};
// Reuse the existing latest-list prefill; manual Add now stages a row in the selected container.
const planningBaseOpenAdd=openAdd;
openAdd=function(){planningBaseOpenAdd();aCont.innerHTML='<option value="0">Cont chờ xếp</option>'+CONTAINERS.map(c=>'<option value="'+c.id+'">'+pe(c.name)+'</option>').join('');aCont.value=fCont.value||'0'};
const planningBaseSaveDraft=saveDraft;
saveDraft=function(){if(draft.some(r=>r.__import||r.__mode==='update'))return planningBaseSaveDraft();if(!draft.length)return;const errors=validateImportBatch(draft);if(errors.length){toast(errors[0],true);return}draft.forEach(r=>{ROWS.unshift({...r,id:--planning.seq,rowKey:'MỚI '+(-planning.seq),v:1,contId:Number(aCont.value)||null,__trialNew:true})});draft=[];bulkPending=null;bulkPanel.hidden=true;closeModal('addBackdrop');syncContSelects();render();toast('Đã thêm vào phương án thử. Xác nhận để lưu, hoặc Hủy bản nháp.')};
function setPlanningStatus(id,value){const c=contById(id),next=Number(value);if(!c||![1,2,3,4].includes(next)||next===c.step)return;const old=c.step;c.step=next;c.version++;logIt({action:'status_change',contName:c.name,old:STATUS_LABEL[old],new:STATUS_LABEL[next],summary:'Đổi trực tiếp tại bảng Chỉ số cont'});syncContSelects();render()}
const planningBaseCellHtml=cellHtml;
cellHtml=function(r,c){
  if(c.k==='buyer'&&!r.__splitPreview){const names=[...new Set([...ROWS.map(x=>x.buyer),...OTHERS.map(x=>x.name),r.buyer].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'vi'));return '<select class="cell-input" data-row-buyer="'+r.id+'" aria-label="Nhân viên của '+pe(r.rowKey)+'"><option value="">Chọn NV</option>'+names.map(name=>'<option value="'+pe(name)+'" '+(name===r.buyer?'selected':'')+'>'+pe(name)+'</option>').join('')+'</select>'}

  if(c.k==='container'&&!r.__splitPreview)return '<select class="cell-input" data-row-cont="'+r.id+'" aria-label="Tên cont của '+pe(r.rowKey)+'"><option value="" '+(r.contId==null?'selected':'')+'>Cont chờ xếp</option>'+CONTAINERS.map(x=>'<option value="'+x.id+'" '+(String(x.id)===String(r.contId)?'selected':'')+'>'+pe(x.name)+'</option>').join('')+'</select>';

  if(c.k==='status'&&r.contId!=null){const container=contById(r.contId);if(container)return '<select class="pill s'+container.step+'" data-row-container-status="'+container.id+'" aria-label="Trạng thái cont của '+pe(r.rowKey)+'" title="Đổi trạng thái toàn bộ '+pe(container.name)+'">'+[1,2,3,4].map(n=>'<option value="'+n+'" '+(n===container.step?'selected':'')+'>'+STATUS_LABEL[n]+'</option>').join('')+'</select>'}
  return planningBaseCellHtml(r,c);
};
mainRows.addEventListener('change',event=>{const id=event.target.dataset.rowContainerStatus;if(id)setPlanningStatus(Number(id),event.target.value)});
const planningBaseRenderConts=renderConts;
renderConts=function(){planningBaseRenderConts();contFull.querySelectorAll('tr.cont-pick').forEach(tr=>{
  const match=tr.getAttribute('onclick')?.match(/pickCont\('([0-9]+)'\)/),id=Number(match?.[1]),c=contById(id);if(!c)return;
  tr.cells[1].innerHTML='<select class="pill s'+c.step+'" aria-label="Trạng thái '+pe(c.name)+'" onclick="event.stopPropagation()" onchange="setPlanningStatus('+id+',this.value)">'+[1,2,3,4].map(n=>'<option value="'+n+'" '+(n===c.step?'selected':'')+'>'+STATUS_LABEL[n]+'</option>').join('')+'</select>';
  const stats=contStats(id),truck=truckOf(c.truck),missing=stats.rs.filter(r=>!(r.kgPerCarton>0&&r.m3PerCarton>0)).length,changed=ROWS.some(r=>r.__trialNew&&r.contId===id)||[...bulkDrafts].some(([rid,d])=>ROWS.find(r=>r.id===rid)?.contId===id||d.changes.contId===id);
  const warning=missing?'Thiếu số đo '+missing+' mã · chưa đủ cơ sở đánh giá':stats.ton>truck.maxTon?'Vượt tải '+nf(stats.ton-truck.maxTon,2)+' T':stats.m3>truck.m3Max?'Vượt khối '+nf(stats.m3-truck.m3Max,2)+' m³':stats.m3<truck.m3Min?'Trong tải · còn '+nf(truck.m3Min-stats.m3,2)+' m³ tới '+truck.m3Min:'Trong ngưỡng tải / khối tham chiếu';
  tr.cells[3].title=warning;tr.cells[4].title=warning;tr.lastElementChild.hidden=true;
});const heads=contFull.closest('table').querySelectorAll('thead th');if(heads.length)heads[heads.length-1].hidden=true};
const planningBaseSplit=openSplit;openSplit=function(id){const r=ROWS.find(x=>x.id===id);if(r?.__trialNew||bulkDrafts.has(id)){toast('Xác nhận hoặc hủy bản nháp của dòng trước khi tách.',true);return}planningBaseSplit(id)};
const planningBaseCellClass=cellClass;
cellClass=function(r,c){const classes=planningBaseCellClass(r,c);if(r.__trialNew||Object.hasOwn(bulkDrafts.get(r.id)?.changes||{},c.k==='container'?'contId':c.k))classes.push('planning-draft');return classes};
const planningStyle=document.createElement('style');planningStyle.textContent='#mainTable td.planning-draft{background:color-mix(in srgb,var(--primary) 12%,var(--panel));}';document.head.append(planningStyle);
render();

mainRows.addEventListener('change',event=>{if(!event.target.matches('[data-row-cont]'))return;const r=ROWS.find(r=>r.id===Number(event.target.dataset.rowCont));if(!r)return;const id=event.target.value===''?null:Number(event.target.value);stagePlanningCell(r,'contId',id);planning.target=id;render()});

mainRows.addEventListener('change',event=>{if(!event.target.matches('[data-row-buyer]'))return;const r=ROWS.find(r=>r.id===Number(event.target.dataset.rowBuyer));if(r){stagePlanningCell(r,'buyer',event.target.value);render()}});

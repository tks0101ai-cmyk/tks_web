/* Five operation shortcuts, using the same draft state as the order table. */
planning.onlyDirty=false;
function planningTaskContainers(){return CONTAINERS.map(c=>({...truckOf(c.truck),id:c.id,name:c.name,statusLabel:STATUS_LABEL[c.step]}))}
function planningDirtyIds(){return new Set([...bulkDrafts.keys(),...planning.splits.keys(),...ROWS.filter(r=>r.__trialNew).map(r=>r.id)])}
const tasksBaseRows=planningRows;
planningRows=function(){const out=[];tasksBaseRows().forEach(r=>{const part=planning.splits.get(r.id);if(!part){out.push(r);return}const costs={freightPrepaid:null,freightPostpaid:null,freightAmount:null};out.push({...r,...costs,rowKey:r.rowKey+'.01',splitFromKey:r.rowKey,splitDisplayOrder:1e9,cartonCount:part.manual?r.cartonCount:r.cartonCount-part.quantity});out.push({...r,...costs,id:'split-'+r.id,rowKey:r.rowKey+'.02',splitFromKey:r.rowKey,splitDisplayOrder:1e9,cartonCount:part.quantity,contId:part.destinationId,__splitPreview:true})});return out};
filtered=function(){const original=ROWS;try{ROWS=planningRows();if(planning.onlyDirty)return ROWS.filter(r=>planningDirtyIds().has(r.id)||r.__splitPreview).map(derive).sort(splitFirst);return planningBaseFiltered()}finally{ROWS=original}};
function openPlanningTransfer(id){const r=ROWS.find(r=>r.id===Number(id));if(!r||r.__trialNew||planning.splits.has(r.id))return;planning.splits.set(r.id,{version:r.v,quantity:null,destinationId:r.contId,manual:true});bulkPending=null;bulkPanel.hidden=true;render();toast('Đã tạo hai mã nhánh. Nhập số thùng mã con và sửa mã cha trên bảng trước khi lưu.')}
function planningChanges(){const ids=planningDirtyIds();return [...ids].map(id=>{const before=ROWS.find(r=>r.id===id),after={...before,...bulkDrafts.get(id)?.changes};return {key:before.rowKey,kind:before.__trialNew?'new':'edit',before:before.__trialNew?null:before,after,split:planning.splits.get(id),fields:Object.fromEntries(Object.entries(bulkDrafts.get(id)?.changes||{}).map(([k,v])=>[k,{label:colByKey(k)?.l||(k==='contId'?'Tên cont':k),before:bulkDrafts.get(id).before[k],after:v}]))}})}
const taskMount=document.createElement('div');taskMount.id='planningTaskMount';orderPanel.before(taskMount);
const taskBar=PurchaseTasks.mountBar(document,taskMount,{onTarget:c=>{planning.target=c.id;refreshPlanningTasks()},onDirty:on=>{planning.onlyDirty=on;state.page=1;render()},onFind:()=>{planning.onlyDirty=true;state.page=1;render();mainRows.querySelector('tr')?.scrollIntoView({block:'center',behavior:'smooth'})},onReview:()=>planningCheck()});
function refreshPlanningTasks(){
  if(!document.body)return;const containers=planningTaskContainers();if(planning.target===undefined)planning.target=null;
  taskBar.render({targetId:planning.target,containers,rows:planningRows(),dirtyCount:planningDirtyIds().size,onlyDirty:planning.onlyDirty});
  mainRows.querySelectorAll('tr[data-id]').forEach(tr=>tr.classList.toggle('task-draft-row',planningDirtyIds().has(Number(tr.dataset.id))||tr.dataset.id.startsWith('split-')));
  PurchaseTasks.actions(mainRows,openPlanningTransfer,id=>{const r=ROWS.find(x=>String(x.id)===id);return !!r&&!r.__trialNew});
  try{sessionStorage.setItem('purchase:mock-planning:v2',JSON.stringify({drafts:[...bulkDrafts],splits:[...planning.splits],newRows:ROWS.filter(r=>r.__trialNew),seq:planning.seq,target:planning.target,onlyDirty:planning.onlyDirty}))}catch{}
}
const taskBaseRender=render;render=function(...args){taskBaseRender(...args);refreshPlanningTasks()};
const taskBaseRenderConts=renderConts;renderConts=function(){taskBaseRenderConts();refreshPlanningTasks()};
mainRows.addEventListener('change',e=>{const id=e.target.dataset.splitQty||e.target.dataset.splitCont;if(!id)return;const p=planning.splits.get(Number(id));if(!p)return;if(e.target.dataset.splitQty)p.quantity=e.target.value===''?null:Number(e.target.value);else p.destinationId=e.target.value===''?null:Number(e.target.value);bulkPending=null;render()});
const taskCell=cellHtml;cellHtml=function(r,c){if(r.__splitPreview&&c.k==='cartonCount')return '<input class="cell-input split-quantity-input" type="text" inputmode="numeric" data-split-qty="'+String(r.id).slice(6)+'" value="'+(r.cartonCount??'')+'" placeholder="Nhập số thùng" aria-label="Số thùng mã con">';if(r.__splitPreview&&c.k==='container')return '<select data-split-cont="'+String(r.id).slice(6)+'"><option value="">Cont chờ xếp</option>'+CONTAINERS.map(x=>'<option value="'+x.id+'" '+(x.id===r.contId?'selected':'')+'>'+pe(x.name)+'</option>').join('')+'</select>';return taskCell(r,c)};
const taskBasePickCont=pickCont;pickCont=function(id){planning.target=Number(id)||null;taskBasePickCont(id);refreshPlanningTasks()};
planningCheck=function(){
  if([...planning.splits.values()].some(p=>!Number.isSafeInteger(p.quantity)||p.quantity<=0)){toast('Nhập số thùng nguyên dương cho mã con trước khi lưu.',true);return}bulkCheck();for(const [id,part] of planning.splits)if(!bulkPending.some(r=>r.id===id))bulkPending.push({id,v:part.version,changes:{},before:{}});
  bulkPanel.hidden=false;bulkPanel.innerHTML=PurchaseTasks.review({changes:planningChanges(),rows:planningRows(),savedRows:ROWS.filter(r=>!r.__trialNew),containers:planningTaskContainers()})+'<p><button class="btn-primary" onclick="bulkCommit()">Lưu thay đổi</button><button class="ghost" onclick="bulkPanel.hidden=true">Quay lại</button></p>';bulkPanel.scrollIntoView({block:'nearest',behavior:'smooth'});
};
const taskBaseCommit=bulkCommit;
bulkCommit=function(){
  if(!bulkPending)return;if(!planning.splits.size){taskBaseCommit();refreshPlanningTasks();return}
  const requests=bulkPending,splitEntries=[...planning.splits];
  if(requests.some(x=>{const r=ROWS.find(r=>r.id===x.id);return !r||r.v!==x.v})||splitEntries.some(([id,p])=>{const r=ROWS.find(r=>r.id===id),qty=bulkDrafts.get(id)?.changes.cartonCount??r?.cartonCount;return !r||r.v!==p.version||(!Number.isSafeInteger(p.quantity)||p.quantity<=0||(!p.manual&&p.quantity>=qty))})){toast('Dòng đã thay đổi. Chưa lưu thay đổi; bản nháp vẫn giữ.',true);return}
  const backup=JSON.parse(JSON.stringify(ROWS)),oldSeq=rowSeq,draftBackup=[...bulkDrafts];try{
  const detail=[];requests.forEach(x=>{const r=ROWS.find(r=>r.id===x.id);Object.assign(r,x.changes);r.v++;bulkDrafts.delete(x.id)});
  splitEntries.forEach(([id,p])=>{const r=ROWS.find(r=>r.id===id),keys=branchRowKeys(r),child={...r,id:++rowSeq,rowKey:keys.child,contId:p.destinationId,cartonCount:p.quantity,v:1};if(!p.manual)r.cartonCount-=p.quantity;ROWS.push(child);detail.push({label:keys.previous,old:'Trước tách',new:r.rowKey+' + '+child.rowKey+' · '+p.quantity+' thùng chuyển'})});
  ROWS.filter(r=>r.__trialNew).forEach(r=>{r.id=++rowSeq;r.rowKey=nextKey();r.rootKey=r.rowKey;delete r.__trialNew});logIt({action:'packing_batch',summary:'Lưu thay đổi Đặt hàng',detail});planning.splits.clear();bulkPending=null;bulkMode=false;state.picked.clear();bulkPanel.hidden=true;syncContSelects();render();toast('Đã lưu thay đổi; số lượng theo nhân viên nhập.')}catch(e){ROWS=backup;rowSeq=oldSeq;bulkDrafts.clear();draftBackup.forEach(([id,d])=>bulkDrafts.set(id,d));splitEntries.forEach(([id,p])=>planning.splits.set(id,p));render();toast('Chưa lưu thay đổi: '+e.message,true)}
};
const taskBaseCancel=bulkCancel;bulkCancel=function(){planning.splits.clear();taskBaseCancel();refreshPlanningTasks()};

window.addEventListener('beforeunload',e=>{if(planningDirtyIds().size){e.preventDefault();e.returnValue=''}});
try{const saved=JSON.parse(sessionStorage.getItem('purchase:mock-planning:v2')||'null');if(saved){saved.newRows?.forEach(r=>{if(!ROWS.some(x=>x.id===r.id))ROWS.unshift(r)});saved.drafts?.forEach(([id,d])=>{if(ROWS.some(r=>r.id===id))bulkDrafts.set(id,d)});saved.splits?.forEach(([id,p])=>{if(ROWS.some(r=>r.id===id))planning.splits.set(id,p)});planning.seq=saved.seq||0;planning.target=saved.target??null;planning.onlyDirty=!!saved.onlyDirty}}catch{}
const simpleToolbar=bulkToolbar;bulkToolbar=function(){simpleToolbar();const actions=document.getElementById('bulkActions'),n=planningDirtyIds().size;actions.querySelectorAll('.btn-primary').forEach(b=>{b.textContent='Lưu thay đổi ('+n+')';b.disabled=!n;b.onclick=planningCheck});if(n&&!actions.querySelector('.btn-primary'))actions.insertAdjacentHTML('beforeend','<button class="btn-primary" onclick="planningCheck()">Lưu thay đổi ('+n+')</button><button class="ghost" onclick="bulkCancel()">Hủy thay đổi</button>');if(n||planning.onlyDirty){const b=document.createElement('button');b.className='ghost';b.textContent=planning.onlyDirty?'Xem tất cả dòng':'Xem các dòng đã sửa';b.onclick=()=>{planning.onlyDirty=!planning.onlyDirty;state.page=1;render()};actions.append(b)}};
render();

openSplit=openPlanningTransfer;

mainRows.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('[data-split-qty]')){e.preventDefault();e.target.dispatchEvent(new Event('change',{bubbles:true}))}});

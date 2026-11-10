(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./purchase-grid'));else root.PurchaseGridUI=factory(root.PurchaseGrid)})(typeof globalThis!=='undefined'?globalThis:this,function(Grid){
 'use strict';
 function create({root,getRows,getColumns,getCellValue,apply,notice=()=>{},onAnchor=()=>{}}){
  const doc=root.ownerDocument;let anchor=null,focus=null,dragging=false,filling=false,fillTarget=null,moved=false;
  const status=doc.createElement('p');status.id='purchaseSelectionStatus';status.className='purchase-selection-status';status.setAttribute('role','status');root.after(status);
  const position=target=>{const td=target.closest?.('td[data-field]'),tr=td?.closest('tr[data-id]');return td&&tr?{id:tr.dataset.id,key:td.dataset.field}:null};
  const columns=()=>getColumns().filter(c=>!c.hidden);
  const cells=()=>anchor&&focus?Grid.range({rows:getRows(),columns:columns(),anchor,focus}):[];
  function paint(){
   root.querySelectorAll('.purchase-cell-selected').forEach(e=>e.classList.remove('purchase-cell-selected'));root.querySelectorAll('.purchase-fill-handle').forEach(e=>e.remove());
   const selected=cells();if(!selected.length){status.textContent='';return}const byId=new Map(getRows().map(r=>[String(r.id),r])),lookup=new Map(selected.map(c=>[JSON.stringify([String(c.id),c.key]),c]));
   for(const td of root.querySelectorAll('td[data-field]'))if(lookup.has(JSON.stringify([td.closest('tr').dataset.id,td.dataset.field])))td.classList.add('purchase-cell-selected');
   const data=selected.map(c=>{const row=byId.get(String(c.id)),v=getCellValue(row,c.key);return {text:v??'',number:typeof v==='number'?v:null}}),summary=Grid.summarize(data);
   status.textContent=selected.length>1?'Chọn '+selected.length+' ô · Có dữ liệu '+summary.count+(summary.numeric?' · Tổng '+summary.sum.toLocaleString('vi-VN')+' · Trung bình '+summary.average.toLocaleString('vi-VN'):''):'';
   if(selected.length&&selected.every(cell=>{const c=columns().find(c=>c.k===cell.key);return c&&!c.d&&!c.m&&!c.ro&&c.k!=='buyer'})){const last=selected.at(-1),td=[...root.querySelectorAll('td[data-field]')].find(td=>td.closest('tr').dataset.id===String(last.id)&&td.dataset.field===last.key);if(td){const handle=doc.createElement('button');handle.type='button';handle.className='purchase-fill-handle';handle.tabIndex=-1;handle.setAttribute('aria-label','Kéo để điền xuống');handle.title='Kéo để điền; Ctrl+D điền từ dòng đầu vùng chọn';td.append(handle)}}
  }
  function choose(pos,extend){if(!pos)return;anchor=extend&&anchor?anchor:pos;focus=pos;onAnchor(anchor);paint()}
  function restoreAnchorFocus(){if(!anchor)return;const td=[...root.querySelectorAll('td[data-field]')].find(td=>td.closest('tr').dataset.id===String(anchor.id)&&td.dataset.field===anchor.key);(td?.querySelector('input:not(:disabled),select:not(:disabled),.code-label,.date-label')||td)?.focus({preventScroll:true})}
  function run(plan,label){if(!plan.length)return;try{apply(plan,label);paint();restoreAnchorFocus()}catch(error){notice('Chưa sửa: '+error.message)}}
  function paste(text,at=anchor){if(!at)throw Error('Chọn ô bắt đầu trước khi dán.');const plan=Grid.planPaste({text,rows:getRows(),columns:columns(),anchor:at,focus:anchor&&at.id===anchor.id&&at.key===anchor.key?focus:at});apply(plan,'Dán Excel');paint();restoreAnchorFocus();return plan.length}
  root.addEventListener('mousedown',e=>{if(e.button!==0)return;const pos=position(e.target);if(!pos)return;if(e.target.closest('.purchase-fill-handle')){filling=true;fillTarget=null;e.preventDefault();e.stopPropagation();return}if(e.target.closest('button,.code-label,.date-label,select')&&!e.shiftKey)return;dragging=true;moved=false;choose(pos,e.shiftKey);if(e.shiftKey){e.preventDefault();e.stopPropagation()}},true);
  root.addEventListener('mousemove',e=>{if(!dragging&&!filling)return;const pos=position(e.target);if(!pos)return;if(filling){fillTarget=pos;return}if(focus?.id===pos.id&&focus.key===pos.key)return;moved=true;focus=pos;paint();e.preventDefault()});
  function finish(){if(filling&&fillTarget){const rows=getRows(),ops=Grid.fill({rows,columns:columns(),anchor,focus,target:fillTarget}).map(c=>({id:c.id,key:c.key,raw:String(getCellValue(rows.find(r=>String(r.id)===String(c.fromId)),c.fromKey)??'')}));run(ops,'Kéo điền')}dragging=false;filling=false;fillTarget=null}
  doc.addEventListener('mouseup',finish);root.addEventListener('click',e=>{if(e.target.closest('.purchase-fill-handle')){e.preventDefault();e.stopPropagation();return}const pos=position(e.target);if(!pos)return;if(e.shiftKey){choose(pos,true);e.preventDefault();e.stopPropagation()}else if(moved){moved=false;e.preventDefault();e.stopPropagation()}else choose(pos,false)},true);
  root.addEventListener('copy',e=>{if(!anchor||!focus||e.target.dataset?.gridEditing)return;const selected=cells();if(!selected.length)return;const rowIds=[...new Set(selected.map(c=>String(c.id)))],keys=[...new Set(selected.map(c=>c.key))],rows=getRows();const matrix=rowIds.map(id=>keys.map(key=>String(getCellValue(rows.find(r=>String(r.id)===id),key)??'')));if(!e.clipboardData)return;e.clipboardData.setData('text/plain',Grid.serializeTSV(matrix));e.preventDefault()});
  root.addEventListener('paste',e=>{if(e.target.dataset?.gridEditing)return;const text=e.clipboardData?.getData('text/plain');if(text==null)return;const destination=position(e.target);if(destination&&!cells().some(c=>String(c.id)===destination.id&&c.key===destination.key))choose(destination,false);if(!/[\t\n]/.test(text)&&cells().length<2)return;e.preventDefault();e.stopImmediatePropagation();try{const n=paste(text);notice('Đã dán '+n+' ô; chưa lưu.')}catch(error){notice('Chưa dán: '+error.message)}},true);
  root.addEventListener('keydown',e=>{
   if(e.isComposing||e.target.dataset?.gridEditing)return;
   if(e.shiftKey&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)&&focus){const rows=getRows(),cols=columns(),ri=rows.findIndex(r=>String(r.id)===String(focus.id)),ci=cols.findIndex(c=>c.k===focus.key),nr=ri+(e.key==='ArrowDown'?1:e.key==='ArrowUp'?-1:0),nc=ci+(e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0);if(rows[nr]&&cols[nc]){focus={id:String(rows[nr].id),key:cols[nc].k};paint()}e.preventDefault();e.stopPropagation();return}
   if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='d'&&anchor&&focus){const selected=cells(),rows=getRows(),first=selected[0],last=selected.at(-1);if(first&&last&&first.id!==last.id){const topRight={id:first.id,key:last.key},ops=Grid.fill({rows,columns:columns(),anchor:first,focus:topRight,target:last}).map(c=>({id:c.id,key:c.key,raw:String(getCellValue(rows.find(r=>String(r.id)===String(c.fromId)),c.fromKey)??'')}));run(ops,'Điền xuống')}e.preventDefault();e.stopPropagation()}
   else if(e.key==='Delete'&&cells().length>1){run(cells().map(c=>({...c,raw:''})),'Xóa vùng');e.preventDefault();e.stopPropagation()}
   else if(e.key==='Escape'&&cells().length>1){anchor=focus=null;paint();e.preventDefault();e.stopPropagation()}
  },true);
  return {paint,paste,select:choose,get selection(){return {anchor,focus}},destroy(){doc.removeEventListener('mouseup',finish);status.remove()}};
 }
 return {create};
});

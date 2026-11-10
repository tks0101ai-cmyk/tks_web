(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PurchaseRealtime=factory()})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const scopes=['orderTable','containerTable','watchedContainer'];
  const selector='input,select,textarea';
  function inputKey(el){
    const scope=el.closest('#orderTable,#containerTable,#watchedContainer');
    if(!scope)return null;
    const d=el.dataset,row=el.closest('[data-id]');
    const field=d.containerField||d.edit||d.status|| (d.contFreight!==undefined?'freight':d.childQty!==undefined?'childQty':d.childCont!==undefined?'childCont':null);
    const id=d.containerId||d.contFreight||d.childQty||d.childCont||row?.dataset.id;
    return field!=null&&id!=null?JSON.stringify([scope.id,String(id),field]):null;
  }
  function captureFocus(root,getKey=inputKey){
    const doc=root.ownerDocument||root,el=doc.activeElement;
    if(!el||!root.contains(el))return null;
    const key=getKey(el);if(key==null)return null;
    const baselineValue=el.tagName==='SELECT'?Array.from(el.options).find(o=>o.defaultSelected)?.value??el.options[0]?.value:el.defaultValue;
    return {key,value:el.value,baselineValue,gridDirty:el.dataset.gridDirty,gridEditing:el.dataset.gridEditing,start:el.selectionStart,end:el.selectionEnd,direction:el.selectionDirection,scrollTop:el.scrollTop,scrollLeft:el.scrollLeft};
  }
  function restoreFocus(root,state,getKey=inputKey){
    if(!state)return false;
    const el=Array.from(root.querySelectorAll(selector)).find(e=>getKey(e)===state.key);
    if(!el)return false;
    el.focus({preventScroll:true});el.value=state.value;
    for(const key of ['gridDirty','gridEditing'])if(state[key]!==undefined)el.dataset[key]=state[key];
    if(state.start!=null&&typeof el.setSelectionRange==='function')try{el.setSelectionRange(state.start,state.end,state.direction)}catch{}
    el.scrollTop=state.scrollTop;el.scrollLeft=state.scrollLeft;return true;
  }
  // Never mutate the optimistic-lock version or original per-cell baseline.
  function mergeRows(remoteRows,drafts={}){
    const conflicts=[],seen=new Set();
    const equal=(a,b)=>String(a??'')===String(b??'');
    const rows=remoteRows.map(remote=>{
      const id=String(remote.id),draft=drafts[id];seen.add(id);
      if(!draft)return {...remote};
      for(const [field,local] of Object.entries(draft.changes||{}))if(!equal(remote[field],draft.before?.[field])&&!equal(remote[field],local))conflicts.push({id,field,before:draft.before?.[field],local,remote:remote[field],deleted:false});
      return {...remote,...draft.changes};
    });
    for(const [id,draft] of Object.entries(drafts))if(!seen.has(String(id)))conflicts.push({id,deleted:true,draft});
    return {rows,conflicts};
  }
  function createScheduler({refresh,isHidden=()=>false,gapMs=3000,onError=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}){
    let dirty=false,running=false,stopped=false,timer=null,last=-Infinity;
    function schedule(){
      if(stopped||!dirty||running||isHidden()||timer!==null)return;
      const delay=Math.max(0,last+gapMs-now());
      if(delay){timer=setTimer(()=>{timer=null;schedule()},delay);return}
      dirty=false;running=true;last=now();
      let result;try{result=refresh()}catch(error){result=Promise.reject(error)}
      Promise.resolve(result).catch(error=>{try{onError(error)}catch{}}).finally(()=>{running=false;schedule()});
    }
    return {trigger(){if(!stopped){dirty=true;schedule()}},visible(){schedule()},destroy(){stopped=true;dirty=false;if(timer!==null)clearTimer(timer);timer=null}};
  }
  function createCoordinator(options){
    const {fetchSnapshot,applySnapshot,getRoot=()=>document,getKey=inputKey,onConflict=()=>{},getDrafts=()=>({})}=options;
    let running=null,pending=false,stopped=false,lastRevision=null,baseline=null;
    function captureBaseline(snapshot){baseline=snapshot;lastRevision=snapshot?.revision??lastRevision}
    function older(revision){return revision!=null&&lastRevision!=null&&/^\d+$/.test(String(revision))&&/^\d+$/.test(String(lastRevision))&&BigInt(revision)<BigInt(lastRevision)}
    async function drain(){
      while(pending&&!stopped){
        pending=false;
        const next=await fetchSnapshot();if(stopped)break;
        // Apply a valid response even when invalidated; the queued fetch follows it.
        if(older(next.revision))continue;
        const root=getRoot(),focus=captureFocus(root,getKey),merged=mergeRows(next.rows||[],getDrafts());
        try{
          await applySnapshot(next,{...merged,baseline});
          if(focus){
            const replacement=Array.from(root.querySelectorAll(selector)).find(e=>getKey(e)===focus.key);
            if(!replacement)merged.conflicts.push({key:focus.key,local:focus.value,deleted:true,focused:true});
            else if(focus.value!==focus.baselineValue&&replacement.value!==focus.baselineValue&&replacement.value!==focus.value)merged.conflicts.push({key:focus.key,before:focus.baselineValue,local:focus.value,remote:replacement.value,deleted:false,focused:true});
          }
        }finally{restoreFocus(root,focus,getKey)}
        captureBaseline(next);onConflict(merged.conflicts);
      }
    }
    function refresh(){
      if(stopped)return Promise.resolve();pending=true;
      if(!running)running=drain().finally(()=>{running=null});
      return running;
    }
    return {refresh,captureBaseline,destroy(){stopped=true;pending=false},get revision(){return lastRevision}};
  }
  return {createScheduler,createCoordinator,mergeRows,captureFocus,restoreFocus,inputKey,scopes};
});

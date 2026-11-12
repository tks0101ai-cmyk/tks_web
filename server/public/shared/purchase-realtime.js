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
  function mergeDelta(current,delta,drafts={}){
    const conflicts=[],equal=(a,b)=>String(a??'')===String(b??''),currentRows=current?.rows||[];let rows=currentRows.slice();const index=new Map(rows.map((row,i)=>[String(row.id),i]));
    for(const remote of delta.rows||[]){const id=String(remote.id),i=index.get(id),old=i===undefined?null:rows[i];if(old&&Number.isFinite(Number(old.version))&&Number.isFinite(Number(remote.version))&&Number(remote.version)<Number(old.version))continue;
      const draft=drafts[id];if(draft)for(const [field,local] of Object.entries(draft.changes||{}))if(!equal(remote[field],draft.before?.[field])&&!equal(remote[field],local))conflicts.push({id,field,before:draft.before?.[field],local,remote:remote[field],deleted:false});
      const merged={...(old||{}),...remote,...(draft?.changes||{})};if(i===undefined){index.set(id,rows.length);rows.push(merged)}else rows[i]=merged;
    }
    const deleted=new Set((delta.deletedIds||[]).map(String));if(deleted.size)rows=rows.filter(row=>!deleted.has(String(row.id)));for(const id of deleted){const draft=drafts[id];if(draft)conflicts.push({id,deleted:true,draft})}
    return {...current,...delta,rows,conflicts,revision:delta.revision,containers:delta.containers??current?.containers};
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
    const {fetchSnapshot,fetchDelta,applySnapshot,applyDelta,getRoot=()=>document,getKey=inputKey,onConflict=()=>{},getDrafts=()=>({})}=options;
    let running=null,pending=false,stopped=false,lastRevision=null,baseline=null;
    function captureBaseline(snapshot){baseline=snapshot?{...snapshot,rows:(snapshot.rows||[]).slice(),containers:snapshot.containers}:snapshot;lastRevision=snapshot?.revision??lastRevision}
    function compareRevision(a,b){if(a==null||b==null)return 0;const parse=value=>String(value).split(':');const aa=parse(a),bb=parse(b);if(aa.length!==bb.length||aa.some(v=>!/^\d+$/.test(v))||bb.some(v=>!/^\d+$/.test(v)))return 0;for(let i=0;i<aa.length;i++){const x=BigInt(aa[i]),y=BigInt(bb[i]);if(x!==y)return x<y?-1:1}return 0}
    function validDelta(delta){return delta&&/^\d+:\d+$/.test(String(delta.revision))&&Array.isArray(delta.rows)&&Array.isArray(delta.deletedIds)&&Array.isArray(delta.containers)&&typeof delta.sourceMode==='string'&&typeof delta.integrationEnabled==='boolean'&&typeof delta.employeesChanged==='boolean'&&typeof delta.reset==='boolean'}
    async function applyFull(next){
      if(stopped)return;
      if(compareRevision(next.revision,lastRevision)<0)return;
      const root=getRoot(),focus=captureFocus(root,getKey),merged=mergeRows(next.rows||[],getDrafts());
      try{await applySnapshot(next,{...merged,baseline});if(focus){const replacement=Array.from(root.querySelectorAll(selector)).find(e=>getKey(e)===focus.key);if(!replacement)merged.conflicts.push({key:focus.key,local:focus.value,deleted:true,focused:true});else if(focus.value!==focus.baselineValue&&replacement.value!==focus.baselineValue&&replacement.value!==focus.value)merged.conflicts.push({key:focus.key,before:focus.baselineValue,local:focus.value,remote:replacement.value,deleted:false,focused:true})}}finally{restoreFocus(root,focus,getKey)}
      captureBaseline(next);onConflict(merged.conflicts);
    }
    async function drain(){
      while(pending&&!stopped){
        pending=false;
        if(baseline&&lastRevision!=null&&fetchDelta&&applyDelta){
          let delta;try{delta=await fetchDelta(lastRevision)}catch{delta=null}
          if(stopped)break;
          const metadataChanged=validDelta(delta)&&((baseline.sourceMode!=null&&delta.sourceMode!==baseline.sourceMode)||(baseline.integrationEnabled!=null&&delta.integrationEnabled!==baseline.integrationEnabled));
          if(validDelta(delta)&&!delta.reset&&!metadataChanged){if(compareRevision(delta.revision,lastRevision)<0)continue;const root=getRoot(),focus=captureFocus(root,getKey),merged=mergeDelta(baseline,delta,getDrafts());let applied=false;try{await applyDelta(delta,merged);applied=true;if(focus){const replacement=Array.from(root.querySelectorAll(selector)).find(e=>getKey(e)===focus.key);if(!replacement)merged.conflicts.push({key:focus.key,local:focus.value,deleted:true,focused:true});else if(focus.value!==focus.baselineValue&&replacement.value!==focus.baselineValue&&replacement.value!==focus.value)merged.conflicts.push({key:focus.key,before:focus.baselineValue,local:focus.value,remote:replacement.value,deleted:false,focused:true})}}catch{}finally{restoreFocus(root,focus,getKey)}if(applied){captureBaseline(mergeDelta(baseline,delta));lastRevision=delta.revision;onConflict(merged.conflicts);continue}}
        }
        const next=await fetchSnapshot();if(stopped)break;await applyFull(next);
      }
    }
    function refresh(){
      if(stopped)return Promise.resolve();pending=true;
      if(!running)running=drain().finally(()=>{running=null});
      return running;
    }
    return {refresh,captureBaseline,destroy(){stopped=true;pending=false},get revision(){return lastRevision}};
  }
  return {createScheduler,createCoordinator,mergeRows,mergeDelta,captureFocus,restoreFocus,inputKey,scopes};
});

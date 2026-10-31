/* Chỉ định vị trí cho đơn "Đã gửi kế toán" trên trang Vòng đời đơn hàng (quyền shipment.pick).
   Dữ liệu và giữ chỗ nằm ở máy chủ (/api/shipment/pick): popup chỉ chọn vị trí/số lượng, máy chủ kiểm lại và giữ chỗ.
   Luồng: Chỉ định (Đang nhặt, giữ chỗ) → Xác nhận nhặt (trừ thùng thật, trạng thái cuối) hoặc Hủy nhặt (trả lại).
   Đang nhặt và Hủy nhặt luôn sửa được ngay trong hộp (không có nút Chỉ định lại): Đang nhặt lưu bằng reassign một giao dịch; Đã bốc chỉ xem.
   Hàm thuần dùng chung: shared/carton.js (PickingCarton) và shared/pick-rules.js (PickingRules). */
(function(){
  'use strict';
  const R=window.PickingRules,C=window.PickingCarton;
  const API='/api/shipment/pick';
  const STATUS_LABEL={picking:'Đang nhặt',confirmed:'Xác nhận nhặt',cancelled:'Hủy nhặt'};
  // Khu vực kho chính thức: ký tự đầu của Vị trí -> tên kho, theo cơ sở của đơn (HN và SG không dùng chung ký tự).
  const ZONES={
    HN:{A:'Kho chính to',B:'Kho chính nhỏ (có hầm)',C:'Sân sau chính',F:'Sân tôn mát',G:'Rặng dừa',P:'Kho 8',V:'Kho Vin',X:'Kho Thạch Thất (dự kiến)'},
    SG:{H:'Kho chính',K:'Kho bên cạnh',L:'Lầu 2',Q:'Kho ngoài cổng'}
  };
  const zoneOf=(branch,location)=>{const key=String(location||'').trim().charAt(0).toUpperCase(),name=(ZONES[branch]||{})[key];return name?{key,name}:{key:'',name:''};};
  const REFETCH_CODES=['VERSION_CONFLICT','INVALID_STATE','INSUFFICIENT_AVAILABLE','STOCK_CHANGED','ALREADY_ASSIGNED','ALREADY_CONFIRMED'];
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=v=>Number(v||0).toLocaleString('en-US',{maximumFractionDigits:3});
  const fmtSt=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:2});
  const key=v=>R.key(v);
  const round6=n=>Math.round(n*1e6)/1e6;
  // latest = chỉ định mới nhất của đơn; assignment = latest khi Đã bốc (chỉ xem); reassignOf = latest khi Đang nhặt (đang sửa, lưu bằng reassign).
  const state={listOrder:null,order:null,cand:{},needs:{},latest:null,assignment:null,allocations:{},suggestions:{},busy:false,needsSync:true,requestEpoch:0,reassignOf:null,reopened:false,onChange:null,sort:null,manual:null,drag:null};

  const DIALOGS_HTML='<dialog id="pickingDialog" aria-labelledby="pickingTitle"><div class="dp-head"><div class="dp-head-text"><h2 class="dp-title" id="pickingTitle"></h2><p class="dp-subtitle">Chọn vị trí và điều chỉnh số lượng nhặt. Nhấn giữ dòng (hoặc ba chấm đầu dòng) rồi kéo lên/xuống để đổi thứ tự (phiếu in theo thứ tự này); "Xóa dòng" và số lượng cần nhặt sửa tay đều được ghi lên đơn KiotViet. Dòng bôi đỏ là tổng chọn chưa khớp số lượng cần nhặt; vị trí được giữ chỗ cho đơn này sau khi xác nhận.</p></div><button id="pickingClose" type="button" class="dp-close" aria-label="Đóng chỉ định vị trí">×</button></div>'
    +'<div class="picking-body"><div class="picking-status-bar"><span id="pickingOrderStatus" class="picking-order-status" data-status="">Chưa chỉ định</span><button id="pickingConfirmPick" type="button" class="btn-primary" hidden>Xác nhận nhặt</button><button id="pickingCancelPick" type="button" hidden>Hủy nhặt</button><button id="pickingReopen" type="button" hidden>Chỉ định lại</button><button id="pickingReprint" type="button" hidden>In đơn</button></div>'
    +'<p id="pickingSource" class="picking-source"></p><div class="picking-table-wrap"><table class="dp-table picking-table" data-table-key="picking-table" data-table-sort="off"><thead><tr><th data-column-key="code" data-default-width="150" data-min-width="130">Mã hàng</th><th data-column-key="name" data-default-width="210">Tên hàng</th><th data-column-key="note" data-default-width="170" title="Ghi chú của dòng hàng trong đơn Kiot">Ghi chú</th><th data-column-key="need" data-default-width="190" data-min-width="180">Cần nhặt</th><th data-column-key="st" data-default-width="150" title="Số thùng thực nhặt theo chỉ định (SL nhặt / SL mỗi thùng). Trống khi dòng chưa chỉ định đủ SL; lẻ hiện đỏ.">ST</th><th data-column-key="stock" data-default-width="115" title="Tổng khả dụng cùng mã tại cơ sở sau giữ chỗ của các đơn khác">Có thể bốc</th><th data-column-key="locations" data-default-width="760" data-min-width="320">Vị trí kho</th></tr></thead><tbody id="pickingRows"></tbody></table></div><p id="pickingStatus" role="status"></p></div>'
    +'<div class="picking-footer"><span id="pickingProgress"></span><div><button id="pickingReload" type="button" hidden>Tải lại</button><button id="pickingSuggest" type="button">Gợi ý lại</button><button id="pickingConfirm" type="button" class="btn-primary">Xác nhận &amp; In phiếu nhặt</button></div></div></dialog>'
    +'<dialog id="pickingPrintDialog" aria-labelledby="pickingPrintTitle"><div class="dp-head"><div><p class="dp-kicker">PHIẾU NHẶT HÀNG</p><h2 class="dp-title" id="pickingPrintTitle">Xem trước phiếu nhặt</h2></div><div><button id="pickingPrintBtn" type="button" class="btn-primary">In phiếu</button><button id="pickingPrintClose" type="button" class="dp-close" aria-label="Đóng bản in">×</button></div></div><div class="print-preview-stage"><div id="pickingPrintSheet"></div></div></dialog>';

  // ---------- Gọi API ----------
  async function api(method,url,body){
    const res=await fetch(url,{method,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
    const data=await res.json();
    return {ok:!!res.ok,status:res.status,data:data||{}};
  }

  // ---------- Dữ liệu dòng đơn và vị trí ----------
  /* Dòng cần nhặt: `quantity` = SL cần nhặt đang dùng (người dùng có thể sửa tay trong state.needs), `kiotQuantity` = SL trên đơn Kiot.
     Mọi phép kiểm/gợi ý/tô đỏ dùng `quantity` nên tự theo SL đã sửa. */
  const lines=()=>(state.order&&state.order.lines||[]).filter(l=>!key(l.productCode).startsWith('vat'))
    .map(l=>({...l,kiotQuantity:l.quantity,quantity:Object.hasOwn(state.needs,key(l.productCode))?state.needs[key(l.productCode)]:l.quantity}));
  // SL cần nhặt đã lưu theo chỉ định (snapshot, cộng các dòng cùng mã): { mã chữ thường: SL }.
  function needsFromAssignment(a){
    const out={};
    ((a&&a.snapshot&&a.snapshot.lines)||[]).forEach(l=>{if(key(l.productCode))out[key(l.productCode)]=(out[key(l.productCode)]||0)+(Number(l.quantity)||0);});
    return out;
  }
  // Chỉ giữ SL khác SL Kiot (khớp Kiot thì không cần lưu SL sửa).
  function editedNeeds(source){
    const out={};
    (state.order&&state.order.lines||[]).forEach(l=>{const k=key(l.productCode);if(Object.hasOwn(source,k)&&source[k]!==l.quantity)out[k]=source[k];});
    return out;
  }
  // Hiển thị quy cách đã chuẩn hóa: bỏ hậu tố c ("2T x 20c" -> "2T x 20"); chuỗi không đọc được giữ nguyên để người dùng thấy lỗi. Dữ liệu lưu không đổi.
  const displaySpec=(notes,spec)=>spec&&spec.terms.length?C.normalizeNote(notes).replace(/(\d)c\b/g,'$1'):(notes||'');
  function mapRow(c){
    const spec=C?C.parseSpec(c.notes):null,terms=spec&&spec.terms.length?spec.terms:null;
    return {id:String(c.positionId),code:c.code,name:c.name,location:c.location||'',available:c.available===null||c.available===undefined?null:Number(c.available),
      specText:displaySpec(c.notes,spec),warnings:Array.isArray(c.warnings)?c.warnings:[],terms,loose:spec?spec.loose:0,perCarton:terms?terms[0].perCarton:null,spec};
  }
  // Vị trí của đúng mã và đúng cơ sở của đơn (máy chủ đã lọc). Đã chỉ định mà vị trí không còn trong danh sách (vd hết hàng bị xóa) vẫn hiện để xem/in.
  function rowsFor(l){
    const base=(state.cand[key(l.productCode)]||[]).map(mapRow);
    const saved=state.assignment||state.reassignOf;
    if(!saved)return base;
    const ids=new Set(base.map(r=>r.id));
    return base.concat(saved.lines.filter(j=>key(j.productCode)===key(l.productCode)&&!ids.has(String(j.positionId)))
      .map(j=>({id:String(j.positionId),code:j.productCode,name:'',location:j.location||'',available:null,specText:j.stText||'',warnings:[],terms:null,loose:0,perCarton:null,spec:null})));
  }
  /* Thứ tự hiển thị vị trí của một dòng = thứ tự ưu tiên bốc của thuật toán: vị trí được gợi ý trước (nhiều SL trước),
     rồi các vị trí còn hàng theo cùng luật best-fit của R.suggest (đủ SL cần trước, ít dư nhất trước), hết hàng/chưa rõ SL xuống cuối.
     Dựa trên state.suggestions (chỉ đổi khi gợi ý lại) nên thẻ không nhảy chỗ khi người dùng sửa số lượng. */
  function priorityRows(l,i){
    const need=l.quantity,picked=new Map((state.suggestions[i]||[]).map(p=>[p.id,p.quantity]));
    const avail=r=>R.quantity(r.available)||0;
    const rank=r=>picked.has(r.id)?0:avail(r)>0?1:2;
    const locale=(a,b)=>String(a.location).localeCompare(String(b.location),'vi',{numeric:true});
    return rowsFor(l).map((r,n)=>({r,n})).sort((x,y)=>{
      const a=x.r,b=y.r,ra=rank(a),rb=rank(b);
      if(ra!==rb)return ra-rb;
      if(ra===0&&picked.get(b.id)!==picked.get(a.id))return picked.get(b.id)-picked.get(a.id);
      if(ra===1){
        const fa=avail(a)>=need,fb=avail(b)>=need;
        if(fa!==fb)return fa?-1:1;
        if(avail(a)!==avail(b))return fa?avail(a)-avail(b):avail(b)-avail(a);
      }
      return locale(a,b)||x.n-y.n;
    }).map(e=>e.r);
  }
  // Sort chỉ đổi thứ tự trình bày; chỉ số dòng gốc vẫn dùng cho mọi thao tác phân bổ.
  /* Thứ tự kéo-thả (state.manual = mảng mã hàng chữ thường) chỉ sống trong lần mở hộp này; mở lại về thứ tự Kiot. Mã không có trong mảng
     (vd đơn vừa tải lại) xếp sau cùng theo thứ tự Kiot. Phiếu in theo đúng thứ tự này (printPick). */
  const manualRank=l=>{const at=state.manual.indexOf(key(l.productCode));return at<0?state.manual.length:at;};
  function displayLines(){
    const entries=lines().map((l,i)=>({l,i}));
    if(state.manual)return entries.sort((a,b)=>manualRank(a.l)-manualRank(b.l)||a.i-b.i);
    if(!state.sort)return entries;
    const {column,dir}=state.sort;
    const value=({l,i})=>{
      if(column==='code')return l.productCode;
      if(column==='name')return l.productName;
      if(column==='note')return l.note;
      if(column==='need')return Number(l.quantity);
      if(column==='st')return stOfLine(l,i,state.allocations[i]||[])?.cartons??null;
      const rows=priorityRows(l,i);
      if(column==='stock')return rows.some(r=>R.quantity(r.available)===null)?null:rows.reduce((sum,r)=>sum+(R.quantity(r.available)||0),0);
      return rows.find(r=>(state.allocations[i]||[]).some(p=>p.id===r.id&&p.quantity>0))?.location||'';
    };
    return entries.map(e=>({...e,value:value(e)})).sort((a,b)=>{
      const empty=v=>v===null||v===undefined||v==='';
      if(empty(a.value)!==empty(b.value))return empty(a.value)?1:-1;
      const cmp=typeof a.value==='number'&&typeof b.value==='number'?a.value-b.value:String(a.value??'').localeCompare(String(b.value??''),'vi',{numeric:true,sensitivity:'base'});
      return cmp*dir||a.i-b.i;
    });
  }
  function updateSortHeaders(){
    document.querySelectorAll('.picking-table th[data-column-key]').forEach(th=>{
      const active=state.sort?.column===th.dataset.columnKey;
      th.setAttribute('aria-sort',active?(state.sort.dir===1?'ascending':'descending'):'none');
      th.querySelector('.picking-sort-indicator').textContent=active?(state.sort.dir===1?'↑':'↓'):'↕';
    });
  }
  function allLocations(){
    const seen=new Map();lines().forEach(l=>rowsFor(l).forEach(r=>{if(!seen.has(r.id))seen.set(r.id,r);}));
    return [...seen.values()];
  }
  const editable=()=>!!state.order&&!state.assignment&&state.order.eligible!==false&&!state.busy&&!state.needsSync;
  // Xóa dòng ghi ngược lên đơn Kiot nên cho ở mọi trạng thái (kể cả Đã bốc), miễn đơn còn ít nhất 2 mã hàng.
  const canRemove=()=>!!state.order&&!state.busy&&!state.needsSync&&lines().length>1;

  // ---------- Gợi ý phân bổ ----------
  function suggest(){
    state.allocations={};const used=new Map();
    lines().forEach((line,i)=>{
      const available=rowsFor(line).map(r=>({...r,available:R.quantity(r.available)===null?null:Math.max(0,r.available-(used.get(r.id)||0))}));
      const cartoned=C?available.filter(c=>c.available>0):[];
      const byCarton=cartoned.length&&cartoned.every(c=>c.terms&&c.terms.length)?C.suggest(line.quantity,cartoned.map(c=>({id:c.id,available:c.available,terms:c.terms,loose:c.loose}))):null;
      state.allocations[i]=(byCarton||R.suggest(line.quantity,available)).picks;
      state.allocations[i].forEach(p=>used.set(p.id,(used.get(p.id)||0)+p.quantity));
    });
    state.suggestions=JSON.parse(JSON.stringify(state.allocations));
  }
  function allocationsFromAssignment(a){
    state.allocations={};
    lines().forEach((l,i)=>{state.allocations[i]=a.lines.filter(j=>key(j.productCode)===key(l.productCode)).map(j=>({id:String(j.positionId),quantity:Number(j.plannedQty)||0}));});
  }

  /* ST của một dòng: {cartons (tổng thùng), text (đầy đủ, đã gộp mọi vị trí: "5T x 100 + 2T x 50 - 30"), excess}.
     Lấy từ bản ghi chỉ định (đủ SL, chưa Hủy) hoặc tính từ phân bổ đang chọn khi đủ SL. text trống khi chuỗi ST không đọc được (chỉ còn số thùng). */
  function stOfLine(l,i,picks){
    const a=state.assignment;
    if(a){
      if(a.status==='cancelled')return null;
      const jobs=a.lines.filter(j=>key(j.productCode)===key(l.productCode));
      if(!jobs.length||jobs.some(j=>typeof j.stCartons!=='number'))return null;
      const merged=C.mergeSt(jobs.map(j=>j.stText));
      return {cartons:round6(jobs.reduce((n,j)=>n+j.stCartons,0)),text:merged?merged.text:'',excess:merged?merged.excess:0};
    }
    if(R.validate([l],allLocations(),{0:picks}).length)return null;
    const rows=rowsFor(l);
    const sts=picks.map(p=>{const row=rows.find(r=>r.id===p.id);return row&&row.spec?C.stFor(row.spec,p.quantity):null;});
    if(!sts.length||sts.some(v=>v===null))return null;
    const merged=C.mergeSt(sts.map(v=>v.text));
    return {cartons:round6(sts.reduce((n,v)=>n+v.cartons,0)),text:merged?merged.text:'',excess:merged?merged.excess:0};
  }
  // Ô ST: dòng đầu là quy cách đầy đủ (mỗi số hạng một dòng), dòng nhỏ là tổng số thùng; thiếu thùng (mở thùng không lấy hết) hiện đỏ.
  function stCell(st){
    if(st===null)return '<td class="picking-st" data-st=""><strong></strong></td>';
    if(!st.text)return `<td class="picking-st" data-st="${st.cartons}"><strong class="${C.isWhole(st.cartons)?'':'picking-st-frac'}">${fmtSt(st.cartons)}</strong></td>`;
    const m=/^(.*?)(?: - (\d+))?$/.exec(st.text),parts=m[1].split(' + ').map((t,k)=>k?'+ '+t:t).concat(m[2]?['- '+m[2]]:[]);
    return `<td class="picking-st" data-st="${st.cartons}" data-st-text="${esc(st.text)}" title="${esc(st.text)}"><strong class="picking-st-text ${st.excess>0||!C.isWhole(st.cartons)?'picking-st-frac':''}">${parts.map(p=>'<span>'+esc(p)+'</span>').join(' ')}</strong><small class="picking-st-short" title="Tổng số thùng phải chạm tới">Tổng ${fmtSt(st.cartons)} thùng</small></td>`;
  }
  function lineOk(i){
    const line=lines()[i],picks=state.allocations[i]||[];
    // Đã bốc đã trừ tồn: đánh giá phân bổ đã lưu, không kiểm lại với tồn hiện tại.
    // Chỉ định lại bỏ state.assignment nên vẫn kiểm khả dụng như đơn đang sửa.
    if(state.assignment?.status==='confirmed')return round6(picks.reduce((sum,p)=>sum+p.quantity,0))===round6(line.quantity);
    return !R.validate([line],allLocations(),{0:picks}).length;
  }
  // Đang nhặt: phân bổ trên màn hình khác bản đã lưu trên máy chủ → phải Cập nhật chỉ định trước khi Xác nhận nhặt / In đơn.
  function dirty(){
    const saved=state.reassignOf;if(!saved)return false;
    const want=new Map(),have=new Map();
    saved.lines.forEach(j=>want.set(String(j.positionId),(want.get(String(j.positionId))||0)+(Number(j.plannedQty)||0)));
    lines().forEach((l,i)=>(state.allocations[i]||[]).forEach(p=>{if(p.quantity>0)have.set(p.id,(have.get(p.id)||0)+p.quantity);}));
    const savedNeeds=needsFromAssignment(saved);
    const needChanged=lines().some(l=>l.quantity!==(Object.hasOwn(savedNeeds,key(l.productCode))?savedNeeds[key(l.productCode)]:l.kiotQuantity));
    return needChanged||want.size!==have.size||[...want].some(([id,qty])=>have.get(id)!==qty);
  }

  // ---------- Vẽ popup ----------
  function setStatus(text,isError){const node=$('pickingStatus');if(!node)return;node.textContent=text||'';node.dataset.error=String(!!isError);}
  function render(){
    if(!$('pickingDialog'))return;
    const a=state.assignment,order=state.order,ls=order?lines():[],picking=!!state.reassignOf;
    updateSortHeaders();
    $('pickingRows').innerHTML=displayLines().map(({l,i})=>{
      const picks=state.allocations[i]||[],total=picks.reduce((s,p)=>s+p.quantity,0),rows=priorityRows(l,i);
      const unknown=rows.some(r=>R.quantity(r.available)===null&&!a);
      const before=rows.reduce((s,r)=>s+(R.quantity(r.available)||0),0);
      const selected=ls.reduce((s,line,j)=>s+(key(line.productCode)===key(l.productCode)?(state.allocations[j]||[]).reduce((n,p)=>n+p.quantity,0):0),0);
      const shared=unknown?null:before,st=stOfLine(l,i,picks);
      const uncertainty=unknown?' (chưa xác định)':'';
      // Số chọn khác SL khách đặt (thiếu, thừa hoặc chưa chọn) → bôi đỏ cả dòng.
      const mismatch=round6(total)!==round6(l.quantity);
      const needCell=editable()?`<div class="picking-need-stepper"><button type="button" data-need-step="-1" data-need-line="${i}" aria-label="Giảm SL cần nhặt ${esc(l.productCode)}" ${l.quantity<=1?'disabled':''}>−</button><input type="text" inputmode="numeric" class="picking-need-input" data-need data-need-line="${i}" value="${fmt(l.quantity)}" aria-label="SL cần nhặt ${esc(l.productCode)}" title="Sửa số lượng cần nhặt (khác số trên đơn Kiot sẽ được ghi lên đơn Kiot khi bấm xác nhận và in)"><button type="button" data-need-step="1" data-need-line="${i}" aria-label="Tăng SL cần nhặt ${esc(l.productCode)}" ${l.quantity>=Number.MAX_SAFE_INTEGER?'disabled':''}>+</button></div>`:`<strong>${fmt(l.quantity)}</strong>`;
      const kiotNote=l.kiotQuantity!==l.quantity?`<small class="picking-kiot" title="Số lượng trên đơn Kiot">Kiot: ${fmt(l.kiotQuantity)}</small>`:'';
      const removeBtn=canRemove(i)?`<button type="button" class="picking-remove" data-remove-line="${i}" title="Xóa dòng hàng này khỏi đơn KiotViet" aria-label="Xóa ${esc(l.productCode)} khỏi đơn">Xóa dòng</button>`:'';
      return `<tr data-line="${i}"${mismatch?' class="picking-mismatch" data-mismatch="true"':''}><td class="picking-code"><span class="picking-grip" role="img" aria-label="Nhấn giữ và kéo để đổi thứ tự" title="Nhấn giữ và kéo lên/xuống để đổi thứ tự (phiếu in theo thứ tự này)">⋮⋮</span><span class="picking-code-text">${esc(l.productCode)}</span>${removeBtn}</td><td>${esc(l.productName)}</td><td class="picking-note">${esc(l.note)}</td><td class="picking-need">${needCell}<small class="picking-allocation ${lineOk(i)?'picking-good':'picking-bad'}" data-allocated="${total}"><span aria-hidden="true" class="picking-allocation-icon">${lineOk(i)?'✓':'!'}</span> Đã phân bổ ${fmt(total)}/${fmt(l.quantity)}</small>${kiotNote}</td>${stCell(st)}<td class="picking-total" data-total-code="${esc(l.productCode)}" data-shared-available="${shared===null?'unknown':shared}" data-remaining="${unknown?'unknown':before-selected}"><strong class="${shared===null?'picking-bad':'picking-good'}">${fmt(before)}${uncertainty}</strong><small class="picking-pickable" data-pickable="${Math.max(0,before-selected)}" title="Số lượng có thể bốc trừ phần đang chọn cho đơn này">Còn sau chỉ định: ${fmt(Math.max(0,before-selected))}${uncertainty}</small></td><td><div class="picking-locations">${rows.map(r=>{
        const take=picks.find(p=>p.id===r.id)?.quantity||0,available=R.quantity(r.available),hint=(state.suggestions[i]||[]).some(p=>p.id===r.id);
        const off=!editable()||available===null||!r.location||!available?'disabled':'';
        const zone=zoneOf((state.order||{}).branch,r.location),locTitle=r.location?(zone.name?r.location+' · '+zone.name:r.location):'Chưa có vị trí';
        const specNote=r.specText&&available!==null?`<small class="picking-spec ${r.warnings.length?'picking-st-frac':''}" title="${esc(r.warnings.map(w=>C.WARNING_LABEL[w]||w).join(', '))}">${esc(r.specText)}</small>`:'';
        const label=available===null?(r.warnings.length?esc(C.WARNING_LABEL[r.warnings[0]]||r.warnings[0]):(a?esc(r.specText):'Chưa rõ SL')):fmt(available);
        return `<div class="picking-loc ${take?'selected':''}" data-zone="${zone.key}"><button type="button" class="picking-location ${take?'selected':''} ${hint?'suggested':''}" data-line="${i}" data-location="${esc(r.id)}" aria-pressed="${!!take}" ${off}><strong title="${esc(locTitle)}">${esc(r.location||'Chưa có vị trí')}</strong><span title="Số lượng có thể bốc tại vị trí sau khi trừ giữ chỗ của các đơn khác"${available===null?' class="picking-warn"':''}>${label}</span></button><div class="picking-qty"><div class="picking-stepper"><button type="button" data-step="-1" data-qline="${i}" data-qloc="${esc(r.id)}" aria-label="Giảm SL nhặt ${esc(l.productCode)} ${esc(r.location)}" ${off}>−</button><input type="text" inputmode="numeric" step="1" data-qty data-qline="${i}" data-qloc="${esc(r.id)}" value="${fmt(take)}" aria-label="SL nhặt ${esc(l.productCode)} ${esc(r.location)}" ${off}><button type="button" data-step="1" data-qline="${i}" data-qloc="${esc(r.id)}" aria-label="Tăng SL nhặt ${esc(l.productCode)} ${esc(r.location)}" ${off}>+</button></div></div>${specNote}</div>`;
      }).join('')||'<span class="picking-bad">Chưa tìm thấy vị trí của mã này.</span>'}</div></td></tr>`;
    }).join('');
    const errors=order?allocErrors():['no-order'];
    const mism=order&&!errors.length?mismatchList():[];
    $('pickingProgress').textContent=ls.filter((l,i)=>lineOk(i)).length+'/'+ls.length+' mã hàng đã phân bổ đủ';
    const busy=state.busy||state.needsSync;
    $('pickingReload').hidden=!state.needsSync;
    $('pickingReload').disabled=state.busy;
    $('pickingSuggest').disabled=!!a||!editable()||busy;
    const isDirty=dirty();
    $('pickingConfirm').disabled=!!a||!editable()||busy||!!errors.length;
    $('pickingConfirm').textContent=a?'Đã xác nhận vị trí':state.reopened?'Chỉ định lại & In phiếu':picking?'Cập nhật chỉ định & In phiếu':'Xác nhận & In phiếu nhặt';
    const status=state.latest?state.latest.status:'';
    $('pickingOrderStatus').textContent=status?STATUS_LABEL[status]:'Chưa chỉ định';$('pickingOrderStatus').dataset.status=status;
    $('pickingConfirmPick').hidden=status!=='picking';$('pickingConfirmPick').disabled=busy||isDirty;
    // Đã bốc không hủy được, nhưng bấm Chỉ định lại thì mở khóa: lưu bằng reassign (hoàn thùng đã trừ + hủy lượt cũ + lượt mới trong một giao dịch). Đang bốc sửa ngay trong hộp, lưu cũng bằng reassign.
    $('pickingCancelPick').hidden=status!=='picking';$('pickingCancelPick').disabled=busy;
    $('pickingReopen').hidden=status!=='confirmed'||state.reopened;$('pickingReopen').disabled=busy;
    $('pickingReprint').hidden=!(status==='picking'||status==='confirmed')||state.reopened;$('pickingReprint').disabled=busy||isDirty;
    if(!order)return;
    const validationErrors=Array.isArray(order.validationErrors)?order.validationErrors:[];
    const hint=validationErrors.length?validationErrors.join('; '):a?'Đã chỉ định bởi '+(a.assignedByName||'—')+'. Bản ghi được giữ chỗ trên máy chủ.'
      
      :state.reopened&&editable()?'Đang chỉ định lại đơn đã bốc: khi lưu, số thùng đã trừ được hoàn về vị trí cũ rồi giữ chỗ theo chỉ định mới.'
      :picking&&editable()?(isDirty?'Có thay đổi chưa lưu: bấm “Cập nhật chỉ định & In phiếu” để đổi vị trí đã giữ chỗ.':'Đã chỉ định bởi '+(state.reassignOf.assignedByName||'—')+'. Đang nhặt vẫn đổi được vị trí/số lượng: sửa rồi bấm “Cập nhật chỉ định & In phiếu”.')
      :editable()?(mism.length?'Cảnh báo: '+mism.map(m=>m.productCode+' '+(m.kind==='short'?'thiếu ':'thừa ')+fmt(m.diff)).join('; ')+'. Vẫn chỉ định được, hệ thống sẽ hỏi xác nhận trước khi lưu.':'Gợi ý mới: chọn vị trí đủ hàng có lượng khả dụng sát số cần nhất.'):'Đơn chưa đủ điều kiện chỉ định vị trí.';
    $('pickingSource').textContent=hint;
  }

  // ---------- Tải dữ liệu ----------
  const current=epoch=>epoch===state.requestEpoch;
  async function load(epoch=state.requestEpoch){
    const o=state.listOrder;
    const r=await api('GET',API+'/candidates?branch='+encodeURIComponent(o.branch)+'&order='+encodeURIComponent(o.orderCode));
    if(!current(epoch))return false;
    if(!r.ok||!r.data.order)throw new Error(r.data.error||'Không tải được dữ liệu chỉ định.');
    state.order=r.data.order;state.cand=r.data.candidates||{};
    const latest=r.data.assignment||null;
    // Chỉ Đã bốc là khóa (chỉ xem). Đang nhặt và Đã hủy sửa được ngay: Đang nhặt giữ lại để gửi reassign kèm version.
    state.latest=latest;state.reopened=false;
    state.assignment=latest&&latest.status==='confirmed'?latest:null;
    state.reassignOf=latest&&latest.status==='picking'?latest:null;
    state.needsSync=false;
    // SL cần nhặt: chỉ định Đang nhặt/Đã bốc dùng SL đã lưu (có thể đã sửa tay), còn lại lấy SL đơn Kiot.
    state.needs=editedNeeds(state.assignment||state.reassignOf?needsFromAssignment(state.assignment||state.reassignOf):{});
    if(state.assignment)allocationsFromAssignment(state.assignment);
    else{
      if(state.order.eligible!==false)suggest();else state.allocations={};
      // Đang nhặt: hiện đúng bản đã chỉ định (thứ tự và gợi ý vẫn theo thuật toán).
      if(state.reassignOf)allocationsFromAssignment(state.reassignOf);
    }
    return true;
  }
  async function reloadCurrent(epoch=state.requestEpoch,message='',changed=false){
    if(!current(epoch))return false;
    state.busy=true;state.needsSync=true;render();
    try{
      const ok=await load(epoch);
      if(!ok)return false;
      if(changed)notify();
      setStatus(message?message+' Đã tải lại dữ liệu mới nhất.':'',!!message);
      return true;
    }catch(error){
      if(current(epoch)){
        state.needsSync=true;
        setStatus((message?message+' ':'')+'Không kết nối được để xác minh trạng thái. Hãy Tải lại trước khi thao tác tiếp.',true);
      }
      return false;
    }finally{
      if(current(epoch)){state.busy=false;render();}
    }
  }
  async function open(listOrder){
    ensureDialogs();
    const epoch=++state.requestEpoch;
    state.sort=null;state.manual=null;state.drag=null;state.listOrder=listOrder;state.reassignOf=null;state.reopened=false;state.order=null;state.needs={};state.latest=null;state.assignment=null;state.allocations={};state.suggestions={};state.busy=false;state.needsSync=true;
    $('pickingTitle').textContent=listOrder.orderCode+' · '+(listOrder.branch==='SG'?'Sài Gòn':'Hà Nội');
    setStatus('Đang tải…');render();
    if(!$('pickingDialog').open)$('pickingDialog').showModal();
    await reloadCurrent(epoch);
  }
  function notify(){if(state.onChange)state.onChange(state.latest);}

  // A rejected POST can already have committed. Only reads may be retried automatically.
  async function write(url,body){
    const epoch=state.requestEpoch;
    state.busy=true;render();
    try{
      const r=await api('POST',url,body);
      if(!current(epoch))return false;
      if(r.status>=500)throw new Error('Chưa xác định được kết quả thao tác.');
      if(!r.ok){
        const message=r.data.error||'Không thực hiện được. Thử lại sau.';
        if(REFETCH_CODES.includes(r.data.code))await reloadCurrent(epoch,message,true);
        else setStatus(message,true);
        return false;
      }
      if(!r.data.assignment)throw new Error('Phản hồi không có trạng thái chỉ định.');
      const next=r.data.assignment;
      state.latest=next;state.reopened=false;state.assignment=next.status==='confirmed'?next:null;state.reassignOf=next.status==='picking'?next:null;state.needsSync=false;
      if(next.status==='picking'||next.status==='confirmed')state.needs=editedNeeds(needsFromAssignment(next));
      if(state.assignment)allocationsFromAssignment(state.assignment);
      setStatus('');notify();return true;
    }catch(error){
      // Không rõ máy chủ đã ghi chưa: tải lại để hiện đúng trạng thái thật, không tự gửi lần nữa.
      if(current(epoch))await reloadCurrent(epoch,'Chưa xác định được kết quả thao tác do lỗi kết nối.',true);
      return false;
    }finally{
      if(current(epoch)){state.busy=false;render();}
    }
  }

  // ---------- Thao tác ----------
  // Lệch SL (thiếu/thừa) vẫn chỉ định được nhưng phải được người dùng xác nhận qua cảnh báo.
  const allocErrors=()=>R.validate(lines(),allLocations(),state.allocations,{allowMismatch:true});
  const mismatchList=()=>R.mismatches(lines(),allLocations(),state.allocations);
  function mismatchWarning(list){
    const rows=list.map(m=>'• '+m.productCode+': '+(m.kind==='short'?'THIẾU ':'THỪA ')+fmt(m.diff)+' (chỉ định '+fmt(m.total)+'/'+fmt(m.need)+')');
    return 'Cảnh báo: số lượng chỉ định không khớp số cần nhặt.\n'+rows.join('\n')+'\n\nVẫn chỉ định vị trí và in phiếu?';
  }
  async function submitAssign(){
    if(!editable()||allocErrors().length)return;
    const mismatched=mismatchList();
    if(mismatched.length&&!window.confirm(mismatchWarning(mismatched)))return;
    const allocations=[];
    lines().forEach((l,i)=>(state.allocations[i]||[]).forEach(p=>{if(p.quantity>0)allocations.push({productCode:l.productCode,positionId:Number(p.id),qty:p.quantity});}));
    // In lại đơn Đang bốc: một lệnh hủy lượt cũ + giữ chỗ lượt mới (lỗi ở bước sau thì lượt cũ giữ nguyên).
    const reassign=state.reassignOf?{reassign:true,version:state.reassignOf.version}:{};
    const needs={};
    lines().forEach(l=>{if(l.quantity!==l.kiotQuantity)needs[l.productCode]=l.quantity;});
    // SL cần nhặt khác đơn Kiot được GHI LÊN ĐƠN KIOT khi lưu chỉ định (máy chủ sửa Kiot trước, rồi mới tạo chỉ định).
    const edited=lines().filter(l=>l.quantity!==l.kiotQuantity);
    if(edited.length&&!window.confirm('Ghi lên đơn KiotViet?\n'+edited.map(l=>'• '+l.productCode+': '+fmt(l.kiotQuantity)+' → '+fmt(l.quantity)).join('\n')+'\n\nSố lượng trên đơn Kiot sẽ được sửa theo số lượng cần nhặt và không hoàn tác được. Tiếp tục?'))return;
    if(!await write(API,{branch:state.order.branch,orderCode:state.order.orderCode,allocations,...(Object.keys(needs).length?{needs}:{}),...(mismatched.length?{allowMismatch:true}:{}),...reassign}))return;
    // Kiot đã đổi theo SL cần nhặt: tải lại để dòng đơn trong hộp khớp Kiot (hết nhãn "Kiot: …") trước khi in.
    if(edited.length&&!await reloadCurrent(state.requestEpoch,'',true))return;
    $('pickingDialog').close();
    await printPick();
  }
  async function changeStatus(action){
    const a=state.latest;if(!a||state.busy||state.needsSync)return false;
    const epoch=state.requestEpoch;
    if(!await write(API+'/'+encodeURIComponent(a.id)+'/'+action,{version:a.version}))return false;
    // Hủy nhặt: tải lại để có gợi ý mới theo tồn vừa được trả giữ chỗ, sẵn sàng chỉ định lại ngay.
    if(action==='cancel')await reloadCurrent(epoch);
    return true;
  }
  // Đã bốc → mở khóa để chỉ định lại. Chưa gọi máy chủ: chỉ khi lưu (reassign) thùng đã trừ mới được hoàn lại.
  function reopenConfirmed(){
    const a=state.latest;if(!a||a.status!=='confirmed'||state.busy||state.needsSync)return;
    if(!window.confirm('Chỉ định lại đơn ĐÃ BỐC?'+String.fromCharCode(10)+'Khi lưu, số thùng đã trừ khỏi các vị trí sẽ được hoàn lại, rồi đơn được chỉ định mới (Đang bốc).'))return;
    state.reopened=true;state.assignment=null;state.reassignOf=a;allocationsFromAssignment(a);
    render();
  }
  async function printPick(){
    const a=state.latest;
    if(!a||!window.PickingInvoice)return;
    try{
      // Phiếu in giữ thứ tự dòng của đơn Kiot (snapshot), không theo sort đang chọn trong hộp; chỉ khi người dùng kéo-thả
      // đổi thứ tự trong hộp này thì phiếu theo đúng thứ tự đó (mã ngoài danh sách kéo-thả xếp sau, giữ thứ tự cũ).
      const snapshot={...a.snapshot,orderCode:a.orderCode,branch:a.branch};
      if(state.manual&&state.listOrder&&state.listOrder.orderCode===a.orderCode){
        const rank=l=>{const at=state.manual.indexOf(key(l.productCode));return at<0?state.manual.length:at;};
        snapshot.lines=(snapshot.lines||[]).map((l,i)=>({l,i})).sort((x,y)=>rank(x.l)-rank(y.l)||x.i-y.i).map(e=>e.l);
      }
      await window.PickingInvoice.show(snapshot,a);
    }
    catch(error){
      if(!$('pickingDialog').open)$('pickingDialog').showModal();
      setStatus('Không mở được phiếu in: '+(error&&error.message||'lỗi'),true);
    }
  }
  const parseQty=text=>{
    const raw=String(text).trim();
    if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw))return null;
    const n=Number(raw.replace(/,/g,''));return Number.isSafeInteger(n)&&n>=0?n:null;
  };
  // SL nhặt tại một vị trí: không âm, không vượt tồn khả dụng của vị trí và không làm tổng của dòng vượt SL cần nhặt.
  function setQty(i,id,value){
    const line=lines()[i],rows=rowsFor(line),row=rows.find(r=>r.id===id),available=R.quantity(row&&row.available);
    if(!line||available===null||!Number.isSafeInteger(value)||value<0)return;
    const picks=state.allocations[i]||[],others=picks.filter(p=>p.id!==id).reduce((s,p)=>s+p.quantity,0);
    const usedByOtherLines=lines().reduce((s,_,j)=>s+(j===i?0:(state.allocations[j]||[]).filter(p=>p.id===id).reduce((n,p)=>n+p.quantity,0)),0);
    // Chỉ chặn theo tồn khả dụng của vị trí; nhặt vượt SL cần (thừa hàng) được phép và sẽ có cảnh báo khi chỉ định.
    const cap=Math.max(0,available-usedByOtherLines);
    const qty=round6(Math.min(Math.max(0,value),cap));
    state.allocations[i]=[...picks.filter(p=>p.id!==id),...(qty>0?[{id,quantity:qty}]:[])].sort((x,y)=>rows.findIndex(r=>r.id===x.id)-rows.findIndex(r=>r.id===y.id));
  }

  function onRowsClick(event){
    if(!editable())return;
    const needStep=event.target.closest('[data-need-step]');
    if(needStep){
      const i=Number(needStep.dataset.needLine),line=lines()[i];
      if(!line)return;
      const qty=Math.max(1,line.quantity+Number(needStep.dataset.needStep));
      if(!Number.isSafeInteger(qty))return;
      setStatus('');setNeed(i,qty);render();
      $('pickingRows').querySelector(`[data-need-step="${needStep.dataset.needStep}"][data-need-line="${i}"]:not(:disabled)`)?.focus({preventScroll:true});
      return;
    }
    const step=event.target.closest('[data-step]');
    if(step){
      const i=Number(step.dataset.qline),id=step.dataset.qloc,now=(state.allocations[i]||[]).find(p=>p.id===id)?.quantity||0;
      const unit=rowsFor(lines()[i]).find(r=>r.id===id)?.perCarton||1;
      setQty(i,id,now+Number(step.dataset.step)*unit);render();return;
    }
    const button=event.target.closest('[data-location]');if(!button)return;
    const i=Number(button.dataset.line),line=lines()[i],row=rowsFor(line).find(r=>r.id===button.dataset.location),picks=state.allocations[i]||[];
    if(!row)return;
    if(picks.some(p=>p.id===row.id))state.allocations[i]=picks.filter(p=>p.id!==row.id);
    else{
      const total=picks.reduce((s,p)=>s+p.quantity,0);
      // Đang đủ hàng ở nơi khác thì chuyển sang tách tay từ đầu; chưa đủ thì bổ sung thêm vị trí.
      const base=total>=line.quantity?[]:picks;
      state.allocations[i]=[...base,{id:row.id,quantity:Math.min(row.available,line.quantity-base.reduce((s,p)=>s+p.quantity,0))}];
    }
    render();
  }
  // SL cần nhặt sửa tay: số nguyên dương; trùng SL Kiot thì bỏ SL sửa. Phân bổ đã chọn giữ nguyên (lệch thì dòng đỏ).
  function setNeed(i,value){
    const line=lines()[i];if(!line)return;
    if(value===line.kiotQuantity)delete state.needs[key(line.productCode)];else state.needs[key(line.productCode)]=value;
  }
  function onNeedChange(event){
    const qty=parseQty(event.target.value);
    if(qty===null||qty<1){setStatus('Số lượng cần nhặt phải là số nguyên dương.',true);render();return;}
    setStatus('');setNeed(Number(event.target.dataset.needLine),qty);render();
  }
  function onRowsChange(event){
    if(!editable())return;
    if(event.target.matches('[data-need]'))return onNeedChange(event);
    if(!event.target.matches('[data-qty]'))return;
    const qty=parseQty(event.target.value);
    if(qty===null){setStatus('Số lượng nhặt phải là số nguyên không âm.',true);render();return;}
    setStatus('');setQty(Number(event.target.dataset.qline),event.target.dataset.qloc,qty);render();
  }

  // ---------- Xóa dòng hàng (ghi ngược lên đơn Kiot) ----------
  async function removeLine(i){
    const line=lines()[i];if(!line||!canRemove())return;
    const o=state.order,status=state.latest?state.latest.status:'';
    const unsaved=Object.keys(state.needs).length>0||dirty();
    const text='Xóa dòng hàng khỏi đơn KiotViet?\n\n• '+line.productCode+' · '+(line.productName||'')+' (SL '+fmt(line.kiotQuantity)+')\n• Đơn '+o.orderCode+' trên KiotViet bị sửa ngay và KHÔNG hoàn tác được.'
      +(status==='picking'||status==='confirmed'?'\n• Đơn đang có chỉ định vị trí ('+STATUS_LABEL[status]+'): sau khi xóa, '+(status==='confirmed'?'bấm Chỉ định lại':'bấm Cập nhật chỉ định')+' để bỏ vị trí của mã này.':'')
      +(unsaved?'\n• Thay đổi chưa lưu trong hộp này sẽ bị bỏ.':'')+'\n\nVẫn xóa?';
    if(!window.confirm(text))return;
    const epoch=state.requestEpoch;
    state.busy=true;setStatus('Đang xóa dòng trên KiotViet…');render();
    let r;
    try{r=await api('POST',API+'/order-lines/remove',{branch:o.branch,orderCode:o.orderCode,productCode:line.productCode});}
    catch(error){r=null;}
    if(!current(epoch))return;
    // Không rõ kết quả (lỗi mạng / 5xx): tải lại để hiện đúng trạng thái đơn, không tự gửi lần nữa.
    if(!r||r.status>=500){await reloadCurrent(epoch,'Chưa xác định được kết quả xóa dòng do lỗi kết nối.',true);return;}
    if(!r.ok){state.busy=false;render();setStatus(r.data.error||'Không xóa được dòng hàng.',true);return;}
    if(state.manual)state.manual=state.manual.filter(k=>k!==key(line.productCode));
    if(await reloadCurrent(epoch,'',true))setStatus('Đã xóa '+line.productCode+' khỏi đơn KiotViet.');
  }

  // ---------- Kéo-thả đổi thứ tự dòng hàng ----------
  /* Nhấn giữ (tay nắm ⋮⋮ kéo ngay; vùng trống của dòng giữ ~0,35 giây) rồi kéo lên/xuống thả vào dòng khác. Chỉ đổi thứ tự trình bày
     trong lần mở hộp này (state.manual) và thứ tự dòng trên phiếu in; không lưu, không ghi lên Kiot. Chỉ số dòng gốc cho phân bổ không đổi. */
  const HOLD_MS=350,MOVE_PX=6,EDGE_PX=48,INTERACTIVE='button,input,select,textarea,a,label,.picking-qty,.picking-stepper';
  function moveLine(fromCode,toCode,after){
    if(!fromCode||!toCode||fromCode===toCode)return false;
    const before=displayLines().map(e=>key(e.l.productCode)),order=before.slice();
    if(!order.includes(fromCode)||!order.includes(toCode))return false;
    order.splice(order.indexOf(fromCode),1);
    order.splice(order.indexOf(toCode)+(after?1:0),0,fromCode);
    if(order.every((k,n)=>k===before[n]))return false;
    state.manual=order;state.sort=null;return true;
  }
  const codeOfRow=row=>{const l=lines()[Number(row.dataset.line)];return l?key(l.productCode):'';};
  function dragCleanup(){
    const d=state.drag;if(!d)return;
    clearTimeout(d.timer);cancelAnimationFrame(d.raf);
    document.removeEventListener('pointermove',d.move);document.removeEventListener('pointerup',d.up);document.removeEventListener('pointercancel',d.cancel);
    document.removeEventListener('keydown',d.esc,true);document.removeEventListener('touchmove',d.touch);
    $('pickingRows').querySelectorAll('.picking-dragging,.picking-drop-before,.picking-drop-after').forEach(el=>el.classList.remove('picking-dragging','picking-drop-before','picking-drop-after'));
    document.body.classList.remove('picking-drag-active');
    state.drag=null;
  }
  function rowAt(y){
    const rows=[...$('pickingRows').querySelectorAll('tr[data-line]')];
    if(!rows.length)return null;
    const first=rows[0].getBoundingClientRect(),last=rows[rows.length-1].getBoundingClientRect();
    if(y<=first.top)return {row:rows[0],after:false};
    if(y>=last.bottom)return {row:rows[rows.length-1],after:true};
    for(const row of rows){const r=row.getBoundingClientRect();if(y>=r.top&&y<=r.bottom)return {row,after:y>r.top+r.height/2};}
    return null;
  }
  function dragBegin(row){
    const d=state.drag;if(!d||d.active)return;
    d.active=true;row.classList.add('picking-dragging');document.body.classList.add('picking-drag-active');
    document.addEventListener('touchmove',d.touch,{passive:false});
    const tick=()=>{ // cuộn tự động khi kéo sát mép khung
      if(!state.drag||!state.drag.active)return;
      for(const box of [row.closest('.picking-table-wrap'),row.closest('.picking-body')]){
        if(!box)continue;const r=box.getBoundingClientRect();
        if(d.y<r.top+EDGE_PX)box.scrollTop-=Math.ceil((r.top+EDGE_PX-d.y)/4);else if(d.y>r.bottom-EDGE_PX)box.scrollTop+=Math.ceil((d.y-(r.bottom-EDGE_PX))/4);
      }
      d.raf=requestAnimationFrame(tick);
    };
    d.raf=requestAnimationFrame(tick);
  }
  function dragMark(){
    const d=state.drag;if(!d||!d.active)return;
    $('pickingRows').querySelectorAll('.picking-drop-before,.picking-drop-after').forEach(el=>el.classList.remove('picking-drop-before','picking-drop-after'));
    const hit=rowAt(d.y);d.target=hit&&hit.row!==d.row?hit:null;
    if(d.target)d.target.row.classList.add(d.target.after?'picking-drop-after':'picking-drop-before');
  }
  function onRowsPointerDown(event){
    if(state.drag||state.busy||state.needsSync||!state.order||(event.pointerType==='mouse'&&event.button!==0))return;
    const row=event.target.closest('tr[data-line]');if(!row)return;
    const grip=event.target.closest('.picking-grip');
    if(!grip&&event.target.closest(INTERACTIVE))return;
    const d={row,x0:event.clientX,y0:event.clientY,y:event.clientY,active:false,target:null,timer:0,raf:0};
    d.move=e=>{
      d.y=e.clientY;
      // Nhúc nhích trước khi giữ đủ lâu = đang cuộn/chọn chữ, không phải kéo-thả.
      if(!d.active){if(Math.abs(e.clientX-d.x0)>MOVE_PX||Math.abs(e.clientY-d.y0)>MOVE_PX)dragCleanup();return;}
      dragMark();
    };
    d.up=()=>{
      const drop=d.active&&d.target?{from:codeOfRow(d.row),to:codeOfRow(d.target.row),after:d.target.after}:null;
      dragCleanup();
      if(drop&&moveLine(drop.from,drop.to,drop.after)){setStatus('Đã đổi thứ tự dòng hàng (phiếu in theo thứ tự này, mở lại hộp sẽ về thứ tự Kiot).');render();}
    };
    d.cancel=()=>dragCleanup();
    d.esc=e=>{if(e.key==='Escape'&&state.drag){e.stopImmediatePropagation();dragCleanup();}};
    d.touch=e=>{if(state.drag&&state.drag.active)e.preventDefault();};
    state.drag=d;
    document.addEventListener('pointerup',d.up);document.addEventListener('pointercancel',d.cancel);document.addEventListener('keydown',d.esc,true);
    if(grip){event.preventDefault();dragBegin(row);d.move=e=>{d.y=e.clientY;dragMark();};}
    else d.timer=setTimeout(()=>dragBegin(row),HOLD_MS);
    document.addEventListener('pointermove',d.move);
  }

  let bound=false;
  function ensureDialogs(){
    if($('pickingDialog'))return;
    const wrap=document.createElement('div');wrap.innerHTML=DIALOGS_HTML;
    while(wrap.firstChild)document.body.appendChild(wrap.firstChild);
    if(bound)return;bound=true;
    document.querySelectorAll('.picking-table th[data-column-key]').forEach(th=>{
      const button=document.createElement('button');button.type='button';button.className='picking-sort';
      button.append(document.createTextNode(th.textContent+' '));
      const indicator=document.createElement('span');indicator.className='picking-sort-indicator';indicator.setAttribute('aria-hidden','true');button.append(indicator);
      th.replaceChildren(button);
      button.addEventListener('click',()=>{
        const column=th.dataset.columnKey;
        state.manual=null;state.sort={column,dir:state.sort?.column===column?-state.sort.dir:1};render();
      });
    });
    $('pickingRows').addEventListener('pointerdown',onRowsPointerDown);
    $('pickingRows').addEventListener('click',event=>{
      const remove=event.target.closest('[data-remove-line]');
      if(remove){removeLine(Number(remove.dataset.removeLine));return;}
      onRowsClick(event);
    });
    $('pickingRows').addEventListener('change',onRowsChange);
    $('pickingSuggest').addEventListener('click',()=>{if(!editable())return;suggest();render();});
    $('pickingConfirm').addEventListener('click',submitAssign);
    $('pickingConfirmPick').addEventListener('click',()=>changeStatus('confirm'));
    $('pickingCancelPick').addEventListener('click',()=>changeStatus('cancel'));
    $('pickingReopen').addEventListener('click',reopenConfirmed);
    $('pickingReprint').addEventListener('click',()=>printPick());
    $('pickingReload').addEventListener('click',()=>{if(!state.busy)reloadCurrent(state.requestEpoch,'',true);});
    $('pickingClose').addEventListener('click',()=>$('pickingDialog').close());
    $('pickingDialog').addEventListener('close',()=>{dragCleanup();state.requestEpoch++;state.busy=false;state.needsSync=true;});
    $('pickingPrintClose').addEventListener('click',()=>$('pickingPrintDialog').close());
    // Esc chỉ đóng hộp chỉ định/phiếu đang mở, không đóng luôn hộp chi tiết đơn bên dưới.
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&['pickingDialog','pickingPrintDialog'].some(id=>$(id)&&$(id).open))event.stopImmediatePropagation();},true);
    if(window.PickingPrint)window.PickingPrint.init();
  }

  // ---------- Gắn vào hộp chi tiết đơn ----------
  /* opts: {order (đơn đang xem, có summary.code và pickStatus), host (#lcDetailKiot), buttonHost (đầu hộp, bên trái nút đóng), canPick, assignment (nếu đã tải), onChange(assignment)}.
     Nút "Chỉ định vị trí" chỉ hiện với người có quyền ở mọi trạng thái đơn (để xem/in);
     chip "Đã chỉ định · <trạng thái>" hiện cho mọi người xem được hộp. */
  function attach(opts){
    const host=opts&&opts.host;if(!host)return;
    const buttonHost=opts.buttonHost;
    if(buttonHost)buttonHost.replaceChildren();
    state.onChange=opts.onChange||null;
    host.querySelectorAll('#pickingActions').forEach(node=>node.remove());
    const o=opts.order||{},status=opts.assignment?opts.assignment.status:(o.pickStatus||null);
    const canOpen=!!opts.canPick;
    if(!canOpen&&!status)return;
    const head=host.querySelector('.dp-section-head');if(!head)return;
    const controls=document.createElement('span');controls.id='pickingActions';controls.className='picking-actions';
    if(canOpen){
      const button=document.createElement('button');button.type='button';button.id='openPickingBtn';button.className='picking-open-btn';button.textContent='Chỉ định vị trí';
      button.addEventListener('click',()=>open(o));(buttonHost||controls).appendChild(button);
    }
    if(status){
      const chip=document.createElement('span');chip.className='picking-confirmed';chip.dataset.status=status;chip.textContent='✓ Đã chỉ định · '+(STATUS_LABEL[status]||status);controls.appendChild(chip);
    }
    if(controls.childNodes.length)head.appendChild(controls);
  }
  // Tải chỉ định mới nhất của đơn (null nếu chưa có hoặc lỗi) — hộp chi tiết dùng để vẽ cột ST.
  async function loadAssignment(o){
    try{
      const r=await api('GET',API+'?branch='+encodeURIComponent(o.branch)+'&order='+encodeURIComponent(o.orderCode));
      return r.ok?(r.data.assignment||null):null;
    }catch(error){return null;}
  }

  window.TKSPick={attach,open,loadAssignment,STATUS_LABEL,_state:state,_moveLine:(from,to,after)=>{const moved=moveLine(key(from),key(to),after);if(moved)render();return moved;}};
})();

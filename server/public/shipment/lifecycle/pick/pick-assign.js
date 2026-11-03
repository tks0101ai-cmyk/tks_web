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
  // Sửa VT trong hộp: lỗi này nghĩa là dữ liệu trên màn hình đã cũ → đóng ô sửa và tải lại; lỗi khác (BELOW_HELD, VALIDATION…) giữ ô sửa để người dùng chỉnh.
  const POS_REFETCH_CODES=['VERSION_CONFLICT','NOT_FOUND','INVALID_STATE'];
  const normLoc=v=>String(v??'').replace(/\s+/g,'').toLocaleUpperCase('vi');
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=v=>Number(v||0).toLocaleString('en-US',{maximumFractionDigits:3});
  const fmtSt=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:2});
  const key=v=>R.key(v);
  const round6=n=>Math.round(n*1e6)/1e6;
  // latest = chỉ định mới nhất của đơn; assignment = latest khi Đã bốc (chỉ xem); reassignOf = latest khi Đang nhặt (đang sửa, lưu bằng reassign).
  /* canEditPositions = quyền sửa VT (máy chủ gửi kèm candidates); posEdit = ô sửa VT đang mở {line, id ('new' khi thêm), code, notes, location, before, version, held, error};
     touched = id vị trí đơn này đang giữ chỗ (Đang nhặt) đã bị sửa/xóa trên VT trong lần mở hộp → bắt buộc Cập nhật chỉ định trước khi Xác nhận nhặt/In đơn. */
  const state={listOrder:null,order:null,cand:{},needs:{},removed:new Set(),latest:null,assignment:null,allocations:{},suggestions:{},busy:false,needsSync:true,requestEpoch:0,reassignOf:null,reopened:false,onChange:null,sort:null,manual:null,drag:null,canEditPositions:false,posEdit:null,touched:new Set()};
  let posEscGuard=false; // Esc vừa đóng ô sửa VT: chặn luôn sự kiện cancel của dialog phát ngay sau phím đó.

  const DIALOGS_HTML='<dialog id="pickingDialog" aria-labelledby="pickingTitle"><div class="dp-head"><div class="dp-head-text"><h2 class="dp-title" id="pickingTitle"></h2><p class="dp-subtitle">Chọn vị trí và điều chỉnh số lượng nhặt. Nhấn giữ dòng (hoặc ba chấm đầu dòng) rồi kéo lên/xuống hoặc bấm tiêu đề cột để đổi thứ tự (phiếu in theo đúng thứ tự đang hiển thị); "Xóa dòng" và số lượng cần nhặt sửa tay chỉ lưu trong chỉ định và phiếu in, không sửa đơn KiotViet. Dòng bôi đỏ là tổng chọn chưa khớp số lượng cần nhặt; vị trí được giữ chỗ cho đơn này sau khi xác nhận. Nút ✎ / 🗑 / + Thêm vị trí sửa thẳng VT Hà Nội / VT Sài Gòn (cần quyền sửa VT), gợi ý của mã đó tự cập nhật theo tồn mới.</p></div><button id="pickingClose" type="button" class="dp-close" aria-label="Đóng chỉ định vị trí">×</button></div>'
    +'<div class="picking-body"><div class="picking-status-bar"><span id="pickingOrderStatus" class="picking-order-status" data-status="">Chưa chỉ định</span><button id="pickingConfirmPick" type="button" class="btn-primary" hidden>Xác nhận nhặt</button><button id="pickingCancelPick" type="button" hidden>Hủy nhặt</button><button id="pickingReopen" type="button" hidden>Chỉ định lại</button><button id="pickingReprint" type="button" hidden>In đơn</button></div>'
    +'<p id="pickingSource" class="picking-source"></p><div class="picking-table-wrap"><table class="dp-table picking-table" data-table-key="picking-table" data-table-sort="off"><thead><tr><th data-column-key="code" data-default-width="150" data-min-width="130">Mã hàng</th><th data-column-key="name" data-default-width="210">Tên hàng</th><th data-column-key="note" data-default-width="170" title="Ghi chú của dòng hàng trong đơn Kiot">Ghi chú</th><th data-column-key="need" data-default-width="190" data-min-width="180">Cần nhặt</th><th data-column-key="st" data-default-width="150" title="Số thùng thực nhặt theo chỉ định (SL nhặt / SL mỗi thùng). Trống khi dòng chưa chỉ định đủ SL; lẻ hiện đỏ.">ST</th><th data-column-key="stock" data-default-width="115" title="Tổng khả dụng cùng mã tại cơ sở sau giữ chỗ của các đơn khác">Có thể bốc</th><th data-column-key="locations" data-default-width="760" data-min-width="320">Vị trí kho</th></tr></thead><tbody id="pickingRows"></tbody></table></div><p id="pickingRemoved" class="picking-removed" hidden></p><p id="pickingStatus" role="status"></p></div>'
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
     Mọi phép kiểm/gợi ý/tô đỏ dùng `quantity` nên tự theo SL đã sửa. Mã đã bấm "Xóa dòng" (state.removed) không nằm trong danh sách. */
  const lines=()=>(state.order&&state.order.lines||[]).filter(l=>!key(l.productCode).startsWith('vat')&&!state.removed.has(key(l.productCode)))
    .map(l=>({...l,kiotQuantity:l.quantity,quantity:Object.hasOwn(state.needs,key(l.productCode))?state.needs[key(l.productCode)]:l.quantity}));
  // SL cần nhặt đã lưu theo chỉ định (snapshot, cộng các dòng cùng mã): { mã chữ thường: SL }.
  function needsFromAssignment(a){
    const out={};
    ((a&&a.snapshot&&a.snapshot.lines)||[]).forEach(l=>{if(key(l.productCode))out[key(l.productCode)]=(out[key(l.productCode)]||0)+(Number(l.quantity)||0);});
    return out;
  }
  // Mã đã bỏ khỏi chỉ định: có trên đơn Kiot nhưng không có trong snapshot đã lưu (Set mã chữ thường).
  function removedFromAssignment(a){
    const saved=new Set(((a&&a.snapshot&&a.snapshot.lines)||[]).map(l=>key(l.productCode)));
    return new Set(saved.size?(state.order&&state.order.lines||[]).map(l=>key(l.productCode)).filter(k=>k&&!k.startsWith('vat')&&!saved.has(k)):[]);
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
    // real/version/notes/held: dùng cho ô sửa VT (dòng giữ chỗ cũ không còn trên VT ở rowsFor có real=false, không sửa/xóa được).
    return {id:String(c.positionId),code:c.code,name:c.name,location:c.location||'',available:c.available===null||c.available===undefined?null:Number(c.available),
      specText:displaySpec(c.notes,spec),warnings:Array.isArray(c.warnings)?c.warnings:[],terms,loose:spec?spec.loose:0,perCarton:terms?terms[0].perCarton:null,spec,
      real:true,version:c.version,notes:c.notes??'',held:Number(c.held)||0};
  }
  // Vị trí của đúng mã và đúng cơ sở của đơn (máy chủ đã lọc). Đã chỉ định mà vị trí không còn trong danh sách (vd hết hàng bị xóa) vẫn hiện để xem/in.
  function rowsFor(l){
    const base=(state.cand[key(l.productCode)]||[]).map(mapRow);
    const saved=state.assignment||state.reassignOf;
    if(!saved)return base;
    const ids=new Set(base.map(r=>r.id));
    return base.concat(saved.lines.filter(j=>key(j.productCode)===key(l.productCode)&&!ids.has(String(j.positionId)))
      .map(j=>({id:String(j.positionId),code:j.productCode,name:'',location:j.location||'',available:null,specText:j.stText||'',warnings:[],terms:null,loose:0,perCarton:null,spec:null,real:false,version:null,notes:'',held:0})));
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
     (vd đơn vừa tải lại) xếp sau cùng theo thứ tự Kiot. Phiếu in theo đúng thứ tự đang hiển thị: kéo-thả hoặc sort cột (printOrderKeys). */
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
  // Xóa dòng chỉ bỏ mã khỏi chỉ định (không sửa đơn Kiot), lưu cùng lần chỉ định nên chỉ khi đang sửa được; còn ít nhất 2 mã hàng.
  const canRemove=()=>editable()&&lines().length>1;
  // Sửa VT trong hộp (✎/🗑/+ Thêm vị trí): cần quyền sửa VT, không theo eligible; Đã bốc (kể cả đang Chỉ định lại) chỉ xem. posShown bỏ điều kiện bận để ô sửa vẫn hiện (khóa) khi đang lưu.
  const posShown=()=>state.canEditPositions&&!!state.order&&!state.needsSync&&!state.assignment&&state.latest?.status!=='confirmed';
  const posEditable=()=>posShown()&&!state.busy;
  const ownHeld=id=>!!state.reassignOf&&state.reassignOf.lines.some(j=>String(j.positionId)===String(id));

  // ---------- Gợi ý phân bổ ----------
  // Gợi ý cho một dòng với tồn đã bị các dòng khác dùng (used: Map id vị trí -> SL).
  function suggestFor(line,used){
    const available=rowsFor(line).map(r=>({...r,available:R.quantity(r.available)===null?null:Math.max(0,r.available-(used.get(r.id)||0))}));
    const cartoned=C?available.filter(c=>c.available>0):[];
    const byCarton=cartoned.length&&cartoned.every(c=>c.terms&&c.terms.length)?C.suggest(line.quantity,cartoned.map(c=>({id:c.id,available:c.available,terms:c.terms,loose:c.loose}))):null;
    return (byCarton||R.suggest(line.quantity,available)).picks;
  }
  function suggest(){
    state.allocations={};const used=new Map();
    lines().forEach((line,i)=>{
      state.allocations[i]=suggestFor(line,used);
      state.allocations[i].forEach(p=>used.set(p.id,(used.get(p.id)||0)+p.quantity));
    });
    state.suggestions=JSON.parse(JSON.stringify(state.allocations));
  }
  // Gợi ý lại riêng dòng i (sau khi sửa VT của mã đó): tồn đã dùng = phân bổ hiện tại của các dòng khác.
  function suggestLine(i){
    const used=new Map();
    lines().forEach((_,j)=>{if(j!==i)(state.allocations[j]||[]).forEach(p=>used.set(p.id,(used.get(p.id)||0)+p.quantity));});
    state.allocations[i]=suggestFor(lines()[i],used);
    state.suggestions[i]=JSON.parse(JSON.stringify(state.allocations[i]));
  }
  /* Tồn VT của một mã vừa đổi: các dòng mã khác giữ phân bổ tay nhưng cắt về khả dụng mới (dòng trước được tính trước),
     các dòng của mã đó bỏ phân bổ cũ rồi gợi ý lại lần lượt. */
  function resuggestCode(code){
    const ls=lines(),k=key(code),targets=ls.map((l,i)=>key(l.productCode)===k?i:-1).filter(i=>i>=0),used=new Map();
    ls.forEach((l,i)=>{
      if(targets.includes(i))return;
      const rows=rowsFor(l);
      state.allocations[i]=(state.allocations[i]||[]).map(p=>{
        const row=rows.find(r=>r.id===p.id),avail=row?R.quantity(row.available):0;
        const qty=avail===null?p.quantity:round6(Math.min(p.quantity,Math.max(0,avail-(used.get(p.id)||0))));
        used.set(p.id,(used.get(p.id)||0)+qty);return {...p,quantity:qty};
      }).filter(p=>p.quantity>0);
    });
    targets.forEach(i=>{state.allocations[i]=[];});
    targets.forEach(i=>suggestLine(i));
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
    const savedRemoved=removedFromAssignment(saved);
    const removedChanged=savedRemoved.size!==state.removed.size||[...state.removed].some(k=>!savedRemoved.has(k));
    return needChanged||removedChanged||touchedOwn()||want.size!==have.size||[...want].some(([id,qty])=>have.get(id)!==qty);
  }
  // Vị trí đơn này đang giữ chỗ vừa bị sửa/xóa trên VT: giữ chỗ cũ không còn khớp tồn → phải lưu lại chỉ định.
  const touchedOwn=()=>!!state.reassignOf&&state.reassignOf.lines.some(j=>state.touched.has(String(j.positionId)));

  // ---------- Vẽ popup ----------
  function setStatus(text,isError){const node=$('pickingStatus');if(!node)return;node.textContent=text||'';node.dataset.error=String(!!isError);}

  // ---------- Sửa VT ngay trong hộp (✎ / 🗑 / + Thêm vị trí) ----------
  /* Xem trước ô sửa: notes = ghi chú sẽ gửi (đã chuẩn hóa như khi lưu VT), text/tone = dòng xem trước, hint = khu kho / cộng vào vị trí sẵn có / giữ chỗ của đơn này,
     block = khóa nút Lưu. Gõ "+…" khi sửa = cộng thêm vào ghi chú hiện có bằng PickingCarton.mergeNotes (thêm mới thì máy chủ tự cộng nếu trùng vị trí). */
  function posDraft(e){
    const out={notes:null,location:'',text:'',tone:'ok',hint:'',block:false,unchanged:false},isNew=e.id==='new',hints=[];
    if(isNew){
      out.location=normLoc(e.location);
      const zone=zoneOf(state.order&&state.order.branch,out.location),line=lines()[e.line];
      if(zone.name)hints.push(zone.name);
      const same=line&&out.location?rowsFor(line).find(r=>r.real&&normLoc(r.location)===out.location):null;
      if(same)hints.push('Sẽ cộng vào vị trí '+same.location+' sẵn có');
    }else if(ownHeld(e.id))hints.push('Vị trí đang giữ chỗ cho đơn này: sau khi lưu cần bấm “Cập nhật chỉ định & In phiếu”.');
    out.hint=hints.join(' · ');
    const raw=String(e.notes??'').trim();
    let notes=raw,merged=false;
    if(raw.startsWith('+')){
      const rest=raw.slice(1).trim();
      if(isNew)notes=rest;
      else{
        const sum=rest&&typeof C.mergeNotes==='function'?C.mergeNotes(e.before||'',rest):null;
        if(sum===null)return {...out,text:'Phần cộng thêm sai định dạng (vd +1T x 50).',tone:'bad',block:true};
        notes=sum;merged=true;
      }
    }
    // Kho hay gõ "0" khi hết hàng: hiểu như ghi chú rỗng (= Hết hàng → xóa vị trí), không coi là sai định dạng.
    out.notes=C.normalizeStoredNote(/^0+$/.test(notes)?'':notes);
    if(isNew&&!out.location)return {...out,text:'Nhập vị trí (vd A07).',tone:'warn',block:true};
    const spec=C.parseSpec(out.notes),held=isNew?0:Number(e.held)||0,prefix=merged?'Sau khi cộng: '+out.notes+' ':'';
    if(!isNew&&out.notes===C.normalizeStoredNote(e.before||''))out.unchanged=true;
    if(!spec){
      const label=C.warnings(out.notes).map(w=>C.WARNING_LABEL[w]||w).join(', ')||C.WARNING_LABEL.unreadable;
      // Không tính được SL thì không kiểm được phần đơn khác đang giữ → chặn khi có giữ chỗ; thêm mới mà sai định dạng thì vô ích cho chỉ định → chặn.
      if(isNew)return {...out,text:label+' (vd 2T x 50).',tone:'bad',block:true};
      return held>0?{...out,text:label+': đơn khác đang giữ '+fmt(held)+' tại vị trí này.',tone:'bad',block:true}:{...out,text:prefix+label+' (vị trí sẽ không chỉ định nhặt được).',tone:'warn'};
    }
    if(spec.quantity<held)return {...out,text:'Đơn khác đang giữ '+fmt(held)+' tại vị trí này, không hạ dưới '+fmt(held)+'.',tone:'bad',block:true};
    if(spec.quantity===0)return isNew?{...out,text:'Nhập ghi chú số thùng có số lượng lớn hơn 0 (vd 2T x 50).',tone:'warn',block:true}:{...out,text:prefix+'= 0 → vị trí sẽ bị xóa khỏi VT.',tone:'bad'};
    const extra=C.warnings(out.notes).filter(w=>w==='multi'||w==='loose').map(w=>C.WARNING_LABEL[w]||w);
    return {...out,text:prefix+'= '+fmt(spec.quantity)+' chiếc'+(spec.terms.length?' · '+fmtSt(spec.cartons)+' thùng':'')+(extra.length?' · '+extra.join(', '):'')+(out.unchanged?' (chưa đổi)':''),tone:'ok'};
  }
  function posEditorHtml(l,i,r){
    const e=state.posEdit,isNew=e.id==='new',d=posDraft(e),dis=state.busy?'disabled':'';
    const zone=zoneOf((state.order||{}).branch,isNew?d.location:r.location);
    const head=isNew?`<label class="picking-pos-field"><span>Vị trí mới</span><input type="text" data-pos-input="location" value="${esc(e.location)}" placeholder="vd A07" autocomplete="off" spellcheck="false" aria-label="Vị trí mới của ${esc(l.productCode)}" ${dis}></label>`
      :`<strong class="picking-pos-title" title="${esc(zone.name?r.location+' · '+zone.name:r.location)}">${esc(r.location||'Chưa có vị trí')}</strong>`;
    return `<div class="picking-loc picking-pos-editor" data-zone="${zone.key}" data-pos-editor data-pos-line="${i}" data-pos-id="${esc(e.id)}" role="group" aria-label="${isNew?'Thêm vị trí cho ':'Sửa ghi chú số thùng '}${esc(l.productCode)}">${head}`
      +`<label class="picking-pos-field"><span>Ghi chú số thùng</span><input type="text" data-pos-input="notes" value="${esc(e.notes)}" placeholder="vd 3T x 100 - 20 · +1T x 50 để cộng thêm" autocomplete="off" spellcheck="false" aria-label="Ghi chú số thùng ${esc(l.productCode)}" ${dis}></label>`
      +`<small class="picking-pos-preview" data-pos-preview data-tone="${d.tone}" aria-live="polite">${esc(d.text)}</small><small class="picking-pos-hint" data-pos-hint>${esc(d.hint)}</small>`
      +`<small class="picking-pos-error" data-pos-error role="alert">${esc(e.error||'')}</small>`
      +`<div class="picking-pos-actions"><button type="button" class="btn-primary" data-pos-save ${d.block||state.busy?'disabled':''}>${state.busy?'Đang lưu…':'Lưu'}</button><button type="button" data-pos-cancel ${dis}>Hủy</button></div></div>`;
  }
  function posToolsHtml(l,i,r){
    if(!r.real||!posEditable())return '';
    const name=esc(l.productCode)+' '+esc(r.location),held=r.held>0;
    return `<div class="picking-pos-tools"><button type="button" class="picking-pos-btn" data-pos-edit data-pos-line="${i}" data-pos-id="${esc(r.id)}" title="Sửa ghi chú số thùng của vị trí này trên VT" aria-label="Sửa ghi chú số thùng ${name}">✎</button>`
      +`<button type="button" class="picking-pos-btn picking-pos-del" data-pos-delete data-pos-line="${i}" data-pos-id="${esc(r.id)}" title="${held?'Đơn khác đang giữ '+fmt(r.held)+' tại vị trí này, không xóa được':'Xóa vị trí này khỏi VT'}" aria-label="Xóa vị trí ${name} khỏi VT" ${held?'disabled':''}>🗑</button></div>`;
  }
  function posAddHtml(l,i){
    const e=state.posEdit;
    if(e&&e.id==='new'&&e.line===i&&posShown())return posEditorHtml(l,i,null);
    if(!posEditable())return '';
    return `<button type="button" class="picking-pos-add" data-pos-add data-pos-line="${i}" title="Thêm vị trí mới cho mã này trên VT" aria-label="Thêm vị trí cho ${esc(l.productCode)}">+ Thêm vị trí</button>`;
  }
  // Gõ trong ô sửa: chỉ cập nhật dòng xem trước + nút Lưu tại chỗ (không vẽ lại cả bảng để giữ con trỏ).
  function updatePosPreview(){
    const e=state.posEdit,box=$('pickingRows')&&$('pickingRows').querySelector('[data-pos-editor]');
    if(!e||!box)return;
    const d=posDraft(e),preview=box.querySelector('[data-pos-preview]');
    preview.textContent=d.text;preview.dataset.tone=d.tone;
    box.querySelector('[data-pos-hint]').textContent=d.hint;
    box.querySelector('[data-pos-error]').textContent=e.error||'';
    box.querySelector('[data-pos-save]').disabled=d.block||state.busy;
    if(e.id==='new')box.dataset.zone=zoneOf((state.order||{}).branch,d.location).key;
  }
  function focusPos(field){
    const input=$('pickingRows')&&$('pickingRows').querySelector(`[data-pos-editor] [data-pos-input="${field||(state.posEdit&&state.posEdit.id==='new'&&!state.posEdit.location?'location':'notes')}"]`);
    if(!input)return;
    input.focus({preventScroll:false});
    if(input.setSelectionRange){const n=input.value.length;input.setSelectionRange(n,n);}
  }
  function startPosEdit(i,id){
    const line=lines()[i];if(!line||!posEditable())return;
    if(id==='new')state.posEdit={line:i,id:'new',code:line.productCode,notes:'',location:'',before:'',version:null,held:0,error:''};
    else{
      const r=rowsFor(line).find(x=>x.id===id);if(!r||!r.real)return;
      state.posEdit={line:i,id:r.id,code:line.productCode,notes:r.notes,location:r.location,before:r.notes,version:r.version,held:r.held,error:''};
    }
    setStatus('');render();focusPos();
  }
  function closePosEdit(){if(!state.posEdit||state.busy)return;state.posEdit=null;setStatus('');render();}
  const posErrorText=d=>{
    const list=(Array.isArray(d.orders)?d.orders:[]).map(o=>typeof o==='string'?o:(o&&(o.orderCode||o.order_code))||'').filter(Boolean);
    const message=d.error||'Không lưu được VT. Thử lại sau.';
    return list.length&&!list.every(o=>message.includes(o))?message+' (Đơn: '+list.join(', ')+')':message;
  };
  /* Ghi VT qua /api/shipment/pick/positions (cùng mẫu epoch/bận của write()). Lỗi mạng/5xx: không rõ máy chủ đã ghi chưa → đóng ô sửa, tải lại, KHÔNG tự gửi lại.
     meta = {code, id ('new' khi thêm), location}. Thành công: đánh dấu vị trí đơn này đang giữ (touched) rồi refreshCode chỉ gợi ý lại mã đó. */
  async function posWrite(method,url,body,meta){
    const epoch=state.requestEpoch;
    state.busy=true;if(state.posEdit)state.posEdit.error='';setStatus('Đang lưu VT…');render();
    let r=null;
    try{r=await api(method,url,body);}catch(error){r=null;}
    if(!current(epoch))return false;
    if(!r||r.status>=500){state.posEdit=null;await reloadCurrent(epoch,'Chưa xác định được kết quả sửa VT do lỗi kết nối.',true);return false;}
    if(!r.ok){
      const d=r.data||{},message=posErrorText(d);
      if(d.code==='WOULD_AUTO_DELETE'&&method==='PATCH'&&!body.confirmEmpty){
        state.busy=false;render();
        if(window.confirm('Số lượng về 0: vị trí '+(meta.location||'(không tên)')+' của mã '+meta.code+' sẽ bị XÓA khỏi VT.\n\nVẫn lưu?'))return posWrite(method,url,{...body,confirmEmpty:true},meta);
        setStatus('Chưa lưu: vị trí giữ nguyên.');focusPos();return false;
      }
      if(POS_REFETCH_CODES.includes(d.code)){state.posEdit=null;await reloadCurrent(epoch,message,true);return false;}
      // Mất quyền sửa VT (403 FEATURE_FORBIDDEN): đóng ô sửa, ẩn các nút sửa VT, báo lỗi.
      if(d.code==='FEATURE_FORBIDDEN'){state.posEdit=null;state.canEditPositions=false;state.busy=false;render();setStatus(message,true);return false;}
      state.busy=false;if(state.posEdit)state.posEdit.error=message;render();setStatus(message,true);focusPos();return false;
    }
    const d=r.data||{},row=d.row||null,ids=[meta.id,row&&row.id,d.id].filter(x=>x!==undefined&&x!==null&&x!=='new').map(String);
    ids.forEach(id=>{if(ownHeld(id))state.touched.add(id);});
    const where=(row&&row.location)||meta.location||'';
    const message=d.deleted?'Đã xóa vị trí '+where+' của mã '+meta.code+' khỏi VT.'
      :d.merged?'Đã cộng vào vị trí '+where+' sẵn có: '+(row&&row.notes||'')+'.'
      :meta.id==='new'?'Đã thêm vị trí '+where+' cho mã '+meta.code+': '+(row&&row.notes||'')+'.'
      :'Đã lưu VT '+where+': '+(row&&row.notes||'')+'.';
    state.posEdit=null;
    try{await refreshCode(meta.code,message,epoch);}
    finally{if(current(epoch)){state.busy=false;render();}}
    return true;
  }
  /* Sau khi ghi VT: tải lại candidates, chỉ thay tồn (state.cand) + đơn, giữ phân bổ/SL cần nhặt/thứ tự của các mã khác và chỉ gợi ý lại mã vừa sửa.
     Chỉ định của đơn đổi ở nơi khác (id/version/trạng thái) hoặc dòng đơn Kiot đổi → tải lại toàn bộ như reloadCurrent. */
  async function refreshCode(code,message,epoch){
    const o=state.listOrder,prev=state.latest,codesOf=order=>((order&&order.lines)||[]).map(l=>key(l.productCode)).join('|');
    let r=null;
    try{r=await api('GET',API+'/candidates?branch='+encodeURIComponent(o.branch)+'&order='+encodeURIComponent(o.orderCode));}catch(error){r=null;}
    if(!current(epoch))return false;
    if(!r||!r.ok||!r.data.order){state.needsSync=true;setStatus(message+' Không tải lại được tồn vị trí: bấm Tải lại trước khi thao tác tiếp.',true);return false;}
    const next=r.data.assignment||null;
    const same=(!prev&&!next)||(!!prev&&!!next&&prev.id===next.id&&prev.version===next.version&&prev.status===next.status);
    if(!same||codesOf(r.data.order)!==codesOf(state.order))return reloadCurrent(epoch,message+' '+(same?'Dòng hàng của đơn Kiot vừa thay đổi.':'Chỉ định của đơn vừa thay đổi ở nơi khác.'),true);
    state.order=r.data.order;state.cand=r.data.candidates||{};state.canEditPositions=r.data.canEditPositions===true;
    if(!state.assignment&&state.latest?.status!=='confirmed'&&state.order.eligible!==false)resuggestCode(code);
    setStatus(message);return true;
  }
  async function savePos(){
    const e=state.posEdit;if(!e||!posEditable())return;
    const d=posDraft(e),o=state.order;
    if(d.block)return;
    if(e.id==='new')return posWrite('POST',API+'/positions',{branch:o.branch,orderCode:o.orderCode,productCode:e.code,location:d.location,notes:d.notes},{code:e.code,id:'new',location:d.location});
    if(d.unchanged){closePosEdit();return;}
    return posWrite('PATCH',API+'/positions/'+encodeURIComponent(e.id),{branch:o.branch,orderCode:o.orderCode,notes:d.notes,version:e.version},{code:e.code,id:e.id,location:e.location});
  }
  async function deletePos(i,id){
    const line=lines()[i],r=line&&rowsFor(line).find(x=>x.id===id);
    if(!r||!r.real||!posEditable()||r.held>0)return;
    const o=state.order;
    const text='Xóa vị trí '+(r.location||'(không tên)')+' của mã '+line.productCode+' khỏi VT '+(o.branch==='SG'?'Sài Gòn':'Hà Nội')+'?\n\n• Ghi chú số thùng hiện tại: '+(r.notes||'(trống)')
      +(ownHeld(id)?'\n• Vị trí này đang giữ chỗ cho chính đơn này: sau khi xóa cần bấm “Cập nhật chỉ định & In phiếu”.':'')+'\n\nVẫn xóa?';
    if(!window.confirm(text))return;
    state.posEdit=null;
    return posWrite('DELETE',API+'/positions/'+encodeURIComponent(id)+'?branch='+encodeURIComponent(o.branch)+'&order='+encodeURIComponent(o.orderCode)+'&version='+encodeURIComponent(r.version),null,{code:line.productCode,id,location:r.location});
  }
  // Click ✎ / 🗑 / + Thêm vị trí / Lưu / Hủy (xử lý trước kiểm tra editable(): sửa VT không phụ thuộc đơn đủ điều kiện chỉ định). true = đã xử lý.
  function onPosClick(event){
    const target=event.target.closest('[data-pos-edit],[data-pos-delete],[data-pos-add],[data-pos-save],[data-pos-cancel]');
    if(!target)return false;
    if(target.matches('[data-pos-save]'))savePos();
    else if(target.matches('[data-pos-cancel]'))closePosEdit();
    else if(target.matches('[data-pos-add]'))startPosEdit(Number(target.dataset.posLine),'new');
    else if(target.matches('[data-pos-edit]'))startPosEdit(Number(target.dataset.posLine),target.dataset.posId);
    else deletePos(Number(target.dataset.posLine),target.dataset.posId);
    return true;
  }
  function onPosInput(event){
    const field=event.target.dataset&&event.target.dataset.posInput;
    if(!field||!state.posEdit)return;
    state.posEdit[field]=event.target.value;state.posEdit.error='';
    updatePosPreview();
  }
  function onPosKeydown(event){
    if(event.key!=='Enter'||!event.target.matches('[data-pos-input]'))return;
    event.preventDefault();savePos();
  }

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
      const needCell=editable()?`<div class="picking-need-stepper"><button type="button" data-need-step="-1" data-need-line="${i}" aria-label="Giảm SL cần nhặt ${esc(l.productCode)}" ${l.quantity<=1?'disabled':''}>−</button><input type="text" inputmode="numeric" class="picking-need-input" data-need data-need-line="${i}" value="${fmt(l.quantity)}" aria-label="SL cần nhặt ${esc(l.productCode)}" title="Sửa số lượng cần nhặt (chỉ lưu trong chỉ định và phiếu in, không sửa đơn Kiot)"><button type="button" data-need-step="1" data-need-line="${i}" aria-label="Tăng SL cần nhặt ${esc(l.productCode)}" ${l.quantity>=Number.MAX_SAFE_INTEGER?'disabled':''}>+</button></div>`:`<strong>${fmt(l.quantity)}</strong>`;
      const kiotNote=l.kiotQuantity!==l.quantity?`<small class="picking-kiot" title="Số lượng trên đơn Kiot">Kiot: ${fmt(l.kiotQuantity)}</small>`:'';
      const removeBtn=canRemove(i)?`<button type="button" class="picking-remove" data-remove-line="${i}" title="Bỏ dòng này khỏi chỉ định và phiếu in (không sửa đơn Kiot)" aria-label="Bỏ ${esc(l.productCode)} khỏi chỉ định">Xóa dòng</button>`:'';
      return `<tr data-line="${i}"${mismatch?' class="picking-mismatch" data-mismatch="true"':''}><td class="picking-code"><span class="picking-grip" role="img" aria-label="Nhấn giữ và kéo để đổi thứ tự" title="Nhấn giữ và kéo lên/xuống để đổi thứ tự (phiếu in theo thứ tự này)">⋮⋮</span><span class="picking-code-text">${esc(l.productCode)}</span>${removeBtn}</td><td>${esc(l.productName)}</td><td class="picking-note">${esc(l.note)}</td><td class="picking-need">${needCell}<small class="picking-allocation ${lineOk(i)?'picking-good':'picking-bad'}" data-allocated="${total}"><span aria-hidden="true" class="picking-allocation-icon">${lineOk(i)?'✓':'!'}</span> Đã phân bổ ${fmt(total)}/${fmt(l.quantity)}</small>${kiotNote}</td>${stCell(st)}<td class="picking-total" data-total-code="${esc(l.productCode)}" data-shared-available="${shared===null?'unknown':shared}" data-remaining="${unknown?'unknown':before-selected}"><strong class="${shared===null?'picking-bad':'picking-good'}">${fmt(before)}${uncertainty}</strong><small class="picking-pickable" data-pickable="${Math.max(0,before-selected)}" title="Số lượng có thể bốc trừ phần đang chọn cho đơn này">Còn sau chỉ định: ${fmt(Math.max(0,before-selected))}${uncertainty}</small></td><td><div class="picking-locations">${rows.map(r=>{
        if(state.posEdit&&state.posEdit.line===i&&state.posEdit.id===r.id&&r.real&&posShown())return posEditorHtml(l,i,r);
        const take=picks.find(p=>p.id===r.id)?.quantity||0,available=R.quantity(r.available),hint=(state.suggestions[i]||[]).some(p=>p.id===r.id);
        const off=!editable()||available===null||!r.location||!available?'disabled':'';
        const zone=zoneOf((state.order||{}).branch,r.location),locTitle=r.location?(zone.name?r.location+' · '+zone.name:r.location):'Chưa có vị trí';
        const specNote=r.specText&&available!==null?`<small class="picking-spec ${r.warnings.length?'picking-st-frac':''}" title="${esc(r.warnings.map(w=>C.WARNING_LABEL[w]||w).join(', '))}">${esc(r.specText)}</small>`:'';
        const label=available===null?(r.warnings.length?esc(C.WARNING_LABEL[r.warnings[0]]||r.warnings[0]):(a?esc(r.specText):'Chưa rõ SL')):fmt(available);
        return `<div class="picking-loc ${take?'selected':''}" data-zone="${zone.key}"><button type="button" class="picking-location ${take?'selected':''} ${hint?'suggested':''}" data-line="${i}" data-location="${esc(r.id)}" aria-pressed="${!!take}" ${off}><strong title="${esc(locTitle)}">${esc(r.location||'Chưa có vị trí')}</strong><span title="Số lượng có thể bốc tại vị trí sau khi trừ giữ chỗ của các đơn khác"${available===null?' class="picking-warn"':''}>${label}</span></button><div class="picking-qty"><div class="picking-stepper"><button type="button" data-step="-1" data-qline="${i}" data-qloc="${esc(r.id)}" aria-label="Giảm SL nhặt ${esc(l.productCode)} ${esc(r.location)}" ${off}>−</button><input type="text" inputmode="numeric" step="1" data-qty data-qline="${i}" data-qloc="${esc(r.id)}" value="${fmt(take)}" aria-label="SL nhặt ${esc(l.productCode)} ${esc(r.location)}" ${off}><button type="button" data-step="1" data-qline="${i}" data-qloc="${esc(r.id)}" aria-label="Tăng SL nhặt ${esc(l.productCode)} ${esc(r.location)}" ${off}>+</button></div></div>${specNote}${posToolsHtml(l,i,r)}</div>`;
      }).join('')||'<span class="picking-bad">Chưa tìm thấy vị trí của mã này.</span>'}${posAddHtml(l,i)}</div></td></tr>`;
    }).join('');
    const errors=order?allocErrors():['no-order'];
    const mism=order&&!errors.length?mismatchList():[];
    $('pickingProgress').textContent=ls.filter((l,i)=>lineOk(i)).length+'/'+ls.length+' mã hàng đã phân bổ đủ';
    renderRemoved();
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
      :picking&&editable()&&touchedOwn()?'Vị trí đang giữ chỗ cho đơn này vừa được sửa trên VT: bấm “Cập nhật chỉ định & In phiếu” để giữ chỗ lại theo tồn mới trước khi Xác nhận nhặt / In đơn.'
      :picking&&editable()?(isDirty?'Có thay đổi chưa lưu: bấm “Cập nhật chỉ định & In phiếu” để đổi vị trí đã giữ chỗ.':'Đã chỉ định bởi '+(state.reassignOf.assignedByName||'—')+'. Đang nhặt vẫn đổi được vị trí/số lượng: sửa rồi bấm “Cập nhật chỉ định & In phiếu”.')
      :editable()?(mism.length?'Cảnh báo: '+mism.map(m=>m.productCode+' '+(m.kind==='short'?'thiếu ':'thừa ')+fmt(m.diff)).join('; ')+'. Vẫn chỉ định được, hệ thống sẽ hỏi xác nhận trước khi lưu.':'Gợi ý mới: chọn vị trí đủ hàng có lượng khả dụng sát số cần nhất.'):'Đơn chưa đủ điều kiện chỉ định vị trí.';
    $('pickingSource').textContent=hint;
  }

  // ---------- Tải trước candidates ----------
  /* Hộp chi tiết đơn gọi prefetch khi mở: bấm "Thay đổi chỉ định" trong 30 giây dùng lại kết quả (đang tải dở thì chờ đúng request đó).
     Chỉ giữ 1 mục (đơn đang xem gần nhất) và chỉ dùng 1 lần; tồn có thể cũ vài giây nhưng khi lưu máy chủ vẫn kiểm lại (REFETCH_CODES). */
  const PREFETCH_MS=30000;
  let prefetched=null; // {key, at, promise}
  const prefetchKey=o=>o.branch+'|'+key(o.orderCode);
  const candidatesUrl=o=>API+'/candidates?branch='+encodeURIComponent(o.branch)+'&order='+encodeURIComponent(o.orderCode);
  function prefetch(o){
    if(!o||!o.branch||!o.orderCode)return;
    const promise=api('GET',candidatesUrl(o));
    promise.catch(()=>{});
    prefetched={key:prefetchKey(o),at:Date.now(),promise};
  }
  function forgetPrefetch(){prefetched=null;}
  function takePrefetched(o){
    const hit=prefetched&&prefetched.key===prefetchKey(o)&&Date.now()-prefetched.at<=PREFETCH_MS?prefetched.promise:null;
    prefetched=null;
    return hit;
  }

  // ---------- Tải dữ liệu ----------
  const current=epoch=>epoch===state.requestEpoch;
  async function load(epoch=state.requestEpoch){
    const o=state.listOrder;
    const early=takePrefetched(o);
    let r=early?await early.catch(()=>null):null;
    if(!r||!r.ok)r=await api('GET',candidatesUrl(o));
    if(!current(epoch))return false;
    if(!r.ok||!r.data.order)throw new Error(r.data.error||'Không tải được dữ liệu chỉ định.');
    state.order=r.data.order;state.cand=r.data.candidates||{};
    // Tải lại toàn bộ thì bỏ ô sửa VT đang mở (vị trí có thể đã đổi); touched giữ nguyên tới khi lưu chỉ định hoặc mở lại hộp.
    state.canEditPositions=r.data.canEditPositions===true;state.posEdit=null;
    const latest=r.data.assignment||null;
    // Chỉ Đã bốc là khóa (chỉ xem). Đang nhặt và Đã hủy sửa được ngay: Đang nhặt giữ lại để gửi reassign kèm version.
    state.latest=latest;state.reopened=false;
    state.assignment=latest&&latest.status==='confirmed'?latest:null;
    state.reassignOf=latest&&latest.status==='picking'?latest:null;
    state.needsSync=false;
    // Mã đã bỏ + SL cần nhặt: chỉ định Đang nhặt/Đã bốc dùng bản đã lưu (có thể đã sửa tay), còn lại theo đơn Kiot.
    state.removed=removedFromAssignment(state.assignment||state.reassignOf);
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
    state.sort=null;state.manual=null;state.drag=null;state.listOrder=listOrder;state.reassignOf=null;state.reopened=false;state.order=null;state.needs={};state.removed=new Set();state.latest=null;state.assignment=null;state.allocations={};state.suggestions={};state.busy=false;state.needsSync=true;
    state.canEditPositions=false;state.posEdit=null;state.touched=new Set();
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
      if(next.status==='picking'||next.status==='confirmed'){state.removed=removedFromAssignment(next);state.needs=editedNeeds(needsFromAssignment(next));}
      if(state.assignment)allocationsFromAssignment(state.assignment);
      // Chỉ định vừa lưu đã giữ chỗ theo tồn VT mới nhất → bỏ dấu "vị trí đã sửa".
      state.touched=new Set();
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
    // SL cần nhặt sửa tay và mã bỏ dòng chỉ lưu trong chỉ định (snapshot + phiếu in), không sửa đơn Kiot.
    const needs={};
    lines().forEach(l=>{if(l.quantity!==l.kiotQuantity)needs[l.productCode]=l.quantity;});
    const removed=(state.order.lines||[]).filter(l=>state.removed.has(key(l.productCode))).map(l=>l.productCode);
    // Chụp thứ tự in trước khi lưu: sort theo Vị trí/ST dựa vào phân bổ đang chọn.
    const printKeys=printOrderKeys();
    if(!await write(API,{branch:state.order.branch,orderCode:state.order.orderCode,allocations,...(Object.keys(needs).length?{needs}:{}),...(removed.length?{removed}:{}),...(mismatched.length?{allowMismatch:true}:{}),...reassign}))return;
    $('pickingDialog').close();
    await printPick(printKeys);
  }
  // Hủy nhặt: tồn khả dụng không đổi (candidates không trừ giữ chỗ của chính đơn đang xem) → làm đúng nhánh "chưa có chỉ định"
  // của load() ngay tại chỗ, không tải lại /candidates.
  function applyCancelled(){
    state.assignment=null;state.reassignOf=null;state.posEdit=null;state.removed=new Set();state.needs=editedNeeds({});
    if(state.order&&state.order.eligible!==false)suggest();else state.allocations={};
    render();
  }
  async function changeStatus(action){
    const a=state.latest;if(!a||state.busy||state.needsSync)return false;
    const epoch=state.requestEpoch;
    if(!await write(API+'/'+encodeURIComponent(a.id)+'/'+action,{version:a.version}))return false;
    if(action==='cancel'&&current(epoch))applyCancelled();
    return true;
  }
  // Đã bốc → mở khóa để chỉ định lại. Chưa gọi máy chủ: chỉ khi lưu (reassign) thùng đã trừ mới được hoàn lại.
  function reopenConfirmed(){
    const a=state.latest;if(!a||a.status!=='confirmed'||state.busy||state.needsSync)return;
    if(!window.confirm('Chỉ định lại đơn ĐÃ BỐC?'+String.fromCharCode(10)+'Khi lưu, số thùng đã trừ khỏi các vị trí sẽ được hoàn lại, rồi đơn được chỉ định mới (Đang bốc).'))return;
    state.reopened=true;state.assignment=null;state.reassignOf=a;allocationsFromAssignment(a);
    render();
  }
  // Thứ tự mã trên phiếu in = thứ tự đang hiển thị trong hộp khi có kéo-thả hoặc sort cột; không có thì null (giữ thứ tự đơn Kiot).
  const printOrderKeys=()=>state.manual||state.sort?displayLines().map(e=>key(e.l.productCode)):null;
  async function printPick(keys=printOrderKeys()){
    const a=state.latest;
    if(!a||!window.PickingInvoice)return;
    try{
      // Phiếu in theo thứ tự hộp đang hiển thị (keys); mã ngoài danh sách xếp sau, giữ thứ tự snapshot.
      const snapshot={...a.snapshot,orderCode:a.orderCode,branch:a.branch};
      if(keys&&state.listOrder&&state.listOrder.orderCode===a.orderCode){
        const rank=l=>{const at=keys.indexOf(key(l.productCode));return at<0?keys.length:at;};
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

  // ---------- Xóa dòng (chỉ trong chỉ định, không sửa đơn Kiot) ----------
  /* Đổi tập mã đã bỏ: phân bổ / gợi ý đang theo chỉ số dòng của lines() nên gom theo mã rồi gắn lại theo danh sách mới. */
  function changeRemoved(mutate){
    const before=new Map(lines().map((l,i)=>[key(l.productCode),{a:state.allocations[i]||[],s:state.suggestions[i]||[]}]));
    mutate();
    state.allocations={};state.suggestions={};state.posEdit=null;
    lines().forEach((l,i)=>{const hit=before.get(key(l.productCode));state.allocations[i]=hit?hit.a:[];state.suggestions[i]=hit?hit.s:[];});
  }
  function removeLine(i){
    const line=lines()[i];if(!line||!canRemove())return;
    if(!window.confirm('Bỏ '+line.productCode+' · '+(line.productName||'')+' khỏi chỉ định và phiếu in?\nĐơn KiotViet không bị sửa. Bấm lưu chỉ định để áp dụng.'))return;
    const k=key(line.productCode);
    changeRemoved(()=>{state.removed.add(k);delete state.needs[k];});
    if(state.manual)state.manual=state.manual.filter(m=>m!==k);
    setStatus('');render();
  }
  // Hoàn tác Xóa dòng: đưa mã trở lại và gợi ý vị trí cho riêng dòng đó.
  function restoreLine(code){
    const k=key(code);if(!editable()||!state.removed.has(k))return;
    changeRemoved(()=>state.removed.delete(k));
    const at=lines().findIndex(l=>key(l.productCode)===k);
    if(at>=0&&state.order.eligible!==false)suggestLine(at);
    render();
  }
  function renderRemoved(){
    const node=$('pickingRemoved');if(!node)return;
    const gone=(state.order&&state.order.lines||[]).filter(l=>state.removed.has(key(l.productCode)));
    node.hidden=!gone.length;
    node.innerHTML=gone.length?'Đã bỏ khỏi chỉ định: '+gone.map(l=>editable()
      ?`<button type="button" class="picking-restore" data-restore-line="${esc(l.productCode)}" title="Đưa ${esc(l.productCode)} trở lại chỉ định">${esc(l.productCode)} ↺</button>`
      :`<span>${esc(l.productCode)}</span>`).join(', '):'';
  }

  // ---------- Kéo-thả đổi thứ tự dòng hàng ----------
  /* Nhấn giữ (tay nắm ⋮⋮ kéo ngay; vùng trống của dòng giữ ~0,35 giây) rồi kéo lên/xuống thả vào dòng khác. Chỉ đổi thứ tự trình bày
     trong lần mở hộp này (state.manual) và thứ tự dòng trên phiếu in; không lưu, không ghi lên Kiot. Chỉ số dòng gốc cho phân bổ không đổi. */
  const HOLD_MS=350,MOVE_PX=6,EDGE_PX=48,INTERACTIVE='button,input,select,textarea,a,label,.picking-qty,.picking-stepper,.picking-pos-editor';
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
      if(onPosClick(event))return;
      const remove=event.target.closest('[data-remove-line]');
      if(remove){removeLine(Number(remove.dataset.removeLine));return;}
      onRowsClick(event);
    });
    $('pickingRows').addEventListener('change',onRowsChange);
    $('pickingRemoved').addEventListener('click',event=>{const b=event.target.closest('[data-restore-line]');if(b)restoreLine(b.dataset.restoreLine);});
    $('pickingRows').addEventListener('input',onPosInput);
    $('pickingRows').addEventListener('keydown',onPosKeydown);
    // Esc khi đang sửa VT chỉ đóng ô sửa: chặn sự kiện cancel (đóng dialog) của trình duyệt.
    $('pickingDialog').addEventListener('cancel',event=>{if(state.posEdit||posEscGuard)event.preventDefault();});
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
    document.addEventListener('keydown',event=>{
      if(event.key!=='Escape'||!['pickingDialog','pickingPrintDialog'].some(id=>$(id)&&$(id).open))return;
      event.stopImmediatePropagation();
      // Đang sửa VT: Esc = Hủy ô sửa, hộp chỉ định vẫn mở (chặn cả keydown lẫn cancel phát ngay sau đó).
      if(state.posEdit&&$('pickingDialog').open&&!$('pickingPrintDialog').open){event.preventDefault();posEscGuard=true;setTimeout(()=>{posEscGuard=false;},0);closePosEdit();}
    },true);
    if(window.PickingPrint)window.PickingPrint.init();
  }

  // ---------- Gắn vào hộp chi tiết đơn ----------
  /* opts: {order (đơn đang xem, có summary.code và pickStatus), host (#lcDetailKiot), buttonHost (đầu hộp, bên trái nút đóng), canPick, assignment (nếu đã tải), onChange(assignment)}.
     Nút "Chỉ định vị trí" chỉ hiện với người có quyền ở mọi trạng thái đơn (để xem/in);
     chip "Đã chỉ định · <trạng thái>" hiện cho mọi người xem được hộp. */
  function openButton(o,status){
    const button=document.createElement('button');button.type='button';button.id='openPickingBtn';button.className='picking-open-btn';button.textContent=status==='picking'?'Thay đổi chỉ định':'Chỉ định vị trí';
    if(status==='picking')button.title='Đổi vị trí hoặc số lượng rồi lưu bằng Cập nhật chỉ định & In phiếu.';
    button.addEventListener('click',()=>open(o));
    return button;
  }
  // Gắn sớm nút mở hộp vào đầu hộp chi tiết khi bảng hàng chưa về: opts {order, buttonHost, canPick, status (pickStatus của dòng), onChange(assignment)}.
  // onChange gắn ngay như attach(): bấm nút sớm rồi lưu vẫn cập nhật đúng đơn đang xem, không dính callback của đơn trước.
  function attachButton(opts){
    const host=opts&&opts.buttonHost;if(!host)return;
    state.onChange=opts.onChange||null;
    host.replaceChildren();
    if(opts.canPick)host.appendChild(openButton(opts.order||{},opts.status||null));
  }
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
    if(canOpen)(buttonHost||controls).appendChild(openButton(o,status));
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

  window.TKSPick={attach,attachButton,open,prefetch,forgetPrefetch,loadAssignment,STATUS_LABEL,_state:state,_moveLine:(from,to,after)=>{const moved=moveLine(key(from),key(to),after);if(moved)render();return moved;}};
})();

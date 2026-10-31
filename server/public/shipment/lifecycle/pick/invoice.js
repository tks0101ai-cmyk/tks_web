/* Phiếu nhặt hàng (mẫu "PHIẾU ĐẶT HÀNG" 9 cột) cho Chỉ định vị trí của trang Vòng đời.
   Dữ liệu từ bản ghi chỉ định trên máy chủ: assignment.snapshot (đơn lúc chỉ định) + assignment.lines (vị trí đã chỉ định),
   nên in lại luôn ra đúng nội dung. Mẫu HTML, CSS và 3 ảnh QR nằm cạnh file này; ảnh được nhúng dạng data URI để file HTML tải về vẫn đủ ảnh. */
(function(){
'use strict';
const BASE='/shipment/lifecycle/pick/';
const CDN=/https:\/\/cdn2-retail-images\.kiotviet\.vn\/2026\/10\/05\/chhanoi\/([a-f0-9]+)\.jpg/g;
const key=v=>String(v??'').trim().toLowerCase();
const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const qtyText=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:3});
const stText=v=>v===null||v===undefined?'':Number(v).toLocaleString('en-US',{maximumFractionDigits:2});
// Decimal strings from snapshot v2 are rounded only for display, without losing large integer digits.
const decimal=v=>{
  if(v===null||v===undefined||v==='')return null;
  const s=String(v),m=/^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  return m?{negative:m[1]==='-',whole:m[2],fraction:m[3]||''}:null;
};
const money=v=>{
  const d=decimal(v);if(!d)return '—';
  let whole=BigInt(d.whole);if(d.fraction[0]>='5')whole+=1n;
  return(d.negative&&whole!==0n?'-':'')+whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
};
const sumMoney=(a,b)=>{
  const x=decimal(a),y=decimal(b);if(!x||!y)return null;
  const scale=Math.max(x.fraction.length,y.fraction.length);
  const coefficient=d=>BigInt(d.whole+d.fraction.padEnd(scale,'0'))*(d.negative?-1n:1n);
  const n=coefficient(x)+coefficient(y),digits=(n<0n?-n:n).toString().padStart(scale+1,'0');
  return(n<0n?'-':'')+(scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits);
};
// SĐT người bán in dạng nội địa: "+84923170904" → "0923170904".
const localPhone=v=>{const raw=String(v??'').trim(),m=/^(?:\+84|0084|84)0?(\d{9})$/.exec(raw.replace(/[\s.\-()]/g,''));return m?'0'+m[1]:raw;};
const replace=(html,values)=>html.replace(/\{([^{}]+)\}/g,(token,k)=>Object.hasOwn(values,k)?esc(values[k]):token);
const byName=(a,b)=>String(a).localeCompare(String(b),'vi',{numeric:true,sensitivity:'base'});
let assetsPromise=null;
const pageFooter='<p class="invoice-notice" style="text-align: center;"><span><strong><em>Lưu ý: Vui lòng&nbsp;kiểm hàng thừa/thiếu/vỡ trong vòng 3 ngày.<br>Nếu có vấn đề vui lòng báo lại <u>kèm ảnh/video</u> nhận hàng.&nbsp;Xin cảm ơn !</em></strong></span></p>';
// Mẫu giao hàng không có giá; cùng nguồn dòng hàng/vị trí với phiếu đặt hàng.
const deliveryTemplate=`<div class="delivery-heading"><strong class="delivery-title">PHIẾU XÁC NHẬN GIAO HÀNG</strong><p>Mã đặt hàng: {Ma_Don_Hang}</p></div>
<div class="delivery-contacts"><p><strong><u>Người gửi:</u></strong><br>{Nguoi_Gui}</p>
<p><strong><u>Người nhận:</u></strong><br>Khách hàng: {Khach_Hang}<br>SĐT KH: {So_Dien_Thoai}<br>Địa chỉ: {Dia_Chi_Khach_Hang}<br>NV Bán hàng: {Nhan_Vien_Ban_Hang}<span class="invoice-telegram-slot"></span></p></div>
<table class="invoice-goods" data-table-controls="off" data-table-sort="off"><colgroup><col style="width:5%"><col style="width:39%"><col style="width:8%"><col style="width:14%"><col style="width:18%"><col style="width:16%"></colgroup>
<thead><tr><td>TT</td><td>Tên hàng</td><td>SL</td><td>Vị trí</td><td>Thùng</td><td>Thực nhặt</td></tr></thead>
<tbody><tr><td>{STT}</td><td>{Ten_Hang_Hoa_Don_Gian}</td><td>{So_Luong}</td><td class="invoice-location">{Vi_Tri_Hang_Hoa}</td><td class="invoice-st">{ST}</td><td class="invoice-actual">{Thuc_Te_Nhat}</td></tr></tbody></table>
<table class="invoice-layout-table delivery-note" data-print-table="deliveryNote" data-table-controls="off" data-table-sort="off"><colgroup><col style="width:100%"></colgroup><tbody><tr><td><strong><u>Quý khách vui lòng kiểm tra hàng khi nhận, gọi trước cho khách, báo sale thu tiền.</u></strong></td></tr></tbody></table>
<table class="invoice-layout-table delivery-signatures" data-print-table="deliverySignatures" data-table-controls="off" data-table-sort="off"><colgroup><col style="width:30%"><col style="width:30%"><col style="width:40%"></colgroup><tbody><tr><td><strong>Người nhận hàng</strong></td><td><strong>Nhân viên nhặt hàng</strong></td><td><em>Ngày {Ngay} tháng {Thang} năm {Nam}</em><br><strong>Nhân viên xuất hàng</strong></td></tr></tbody></table>`;
let currentPrint=null;

async function fetchText(url){
  const res=await fetch(url,{credentials:'same-origin'});
  if(!res.ok)throw new Error('Không tải được '+url);
  return res.text();
}
// Ảnh → data URI; lỗi thì giữ đường dẫn (bản in trực tiếp vẫn hiện, chỉ file HTML tải về thiếu ảnh).
async function dataUri(url){
  try{
    const res=await fetch(url,{credentials:'same-origin'});
    if(!res.ok||typeof res.blob!=='function')return url;
    const blob=await res.blob();
    return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(blob);});
  }catch(error){return url;}
}
function loadAssets(){
  if(window.PickingInvoiceTemplate&&window.PickingPrintCSS)return Promise.resolve();
  if(!assetsPromise){
    assetsPromise=(async()=>{
      const [template,css]=await Promise.all([fetchText(BASE+'order-template.tpl?v=20261029-7'),fetchText(BASE+'invoice-a4.css?v=20261029-7')]);
      let out=template;
      for(const id of new Set([...template.matchAll(CDN)].map(m=>m[1]))){
        const uri=await dataUri(BASE+'invoice-assets/'+id+'.jpg');
        out=out.split('https://cdn2-retail-images.kiotviet.vn/2026/10/05/chhanoi/'+id+'.jpg').join(uri);
      }
      window.PickingInvoiceTemplate=out;
      window.PickingPrintCSS=css;
    })().catch(error=>{assetsPromise=null;throw error;});
  }
  return assetsPromise;
}

/* order: assignment.snapshot (+ orderCode, branch); record: assignment. Trả Promise (nạp mẫu lần đầu cần mạng). */
async function show(order,record,template='order'){
  await loadAssets();
  let style=document.getElementById('pickingInvoiceStyle');
  if(!style){style=document.createElement('style');style.id='pickingInvoiceStyle';document.head.append(style);}
  style.textContent=window.PickingPrintCSS;
  const root=document.createElement('div');
  const delivery=template==='delivery';
  root.className='tokosi-invoice'+(delivery?' delivery-slip':'');
  root.dataset.template=delivery?'delivery':'order';
  root.innerHTML=delivery?deliveryTemplate:window.PickingInvoiceTemplate;
  // Thay lưu ý cũ trong luồng nội dung bằng footer dùng chung cho cả hai mẫu.
  root.querySelectorAll('.invoice-notice,.invoice-demo').forEach(el=>el.remove());
  root.insertAdjacentHTML('beforeend',pageFooter);
  // Mẫu có selector toàn cục; stylesheet của popup đã giới hạn phạm vi cho nó.
  root.querySelectorAll('style').forEach(el=>el.remove());
  const row=[...root.querySelectorAll('tr')].find(el=>el.textContent.includes('{STT}'));
  const table=row.closest('table');table.classList.add('invoice-goods');
  let total=0,totalKnown=true,index=0;
  const v2=order.schemaVersion===2,seenCodes=new Map();
  const jobsOf=line=>(record.lines||[]).filter(j=>key(j.productCode)===key(line.productCode));
  // Dòng in giữ thứ tự được truyền từ bảng lựa chọn (mặc định thứ tự Kiot); STT đánh lại từ 1.
  const ordered=order.lines||[];
  ordered.forEach(line=>{
    const jobs=jobsOf(line);
    const qty=Number(line.quantity);
    if(!(qty>0))return;
    const unit=v2?line.unitPrice:(typeof line.price==='number'&&Number.isFinite(line.price)?line.price-(line.discount??0):null);
    const amount=v2?line.amount:(unit===null?null:unit*qty);
    if(amount===null||amount===undefined)totalKnown=false;else if(!v2)total+=amount;
    // Cùng tên vị trí cộng gộp SL. Một vị trí: chỉ tên vị trí (số thùng đã có ở cột Thùng). Từ hai vị trí: mỗi vị trí một dòng "VT: SL", SL in đậm.
    const zones=[];
    jobs.forEach(j=>{
      const name=j.location||'—',zone=zones.find(z=>z.name===name),planned=Number(j.plannedQty)||0;
      if(zone)zone.qty+=planned;else zones.push({name,qty:planned});
    });
    zones.sort((a,b)=>(a.name==='—')-(b.name==='—')||byName(a.name,b.name));
    const multiZone=zones.length>1;
    const priorLine=seenCodes.get(key(line.productCode));
    const placement=!jobs.length?'':priorLine?'Vị trí/Thùng: xem dòng '+priorLine:zones.map(z=>z.name).join(' / ');
    // ST lấy từ bản ghi chỉ định nên in lại ra cùng số; trống khi đã Hủy nhặt hoặc chưa có quy cách thùng.
    const cancelled=record.status==='cancelled';
    // Chỉ gộp quy cách trong cùng khu/vị trí; khác khu nối cộng theo thứ tự cột Vị trí.
    const stParts=zones.map(zone=>{
      const zoneJobs=jobs.filter(j=>(j.location||'—')===zone.name);
      const texts=zoneJobs.map(j=>j.stText).filter(Boolean);
      const merged=window.PickingCarton&&texts.length?window.PickingCarton.mergeSt(texts):null;
      const cartons=zoneJobs.every(j=>typeof j.stCartons==='number')?zoneJobs.reduce((n,j)=>n+j.stCartons,0):null;
      const text=merged?merged.text:(texts.join(' + ')||stText(cartons));
      return {text,fractional:text.includes('-')||(!texts.length&&cartons!==null&&!Number.isInteger(cartons))};
    });
    const stLabel=cancelled||priorLine?'':stParts.map(part=>part.text).filter(Boolean).join(' + ');
    const rendered=document.createElement('tbody');
    rendered.innerHTML=replace(row.outerHTML,{
      STT:++index,Ten_Hang_Hoa_Don_Gian:line.productName||'',
      So_Luong:qtyText(qty),Don_Gia_Sau_Chiet_Khau:money(unit),Thanh_Tien:money(amount),
      Vi_Tri_Hang_Hoa:placement,Ghi_Chu_Hang_Hoa:line.note||'',Thuc_Te_Nhat:'',ST:stLabel
    });
    const item=rendered.firstElementChild;
    if(!priorLine&&!cancelled&&stParts.some(part=>part.fractional))item.querySelector('td.invoice-st')?.classList.add('invoice-st-frac');
    const locationCell=item.querySelector('td.invoice-location');
    if(multiZone&&!priorLine&&locationCell)locationCell.replaceChildren(...zones.map(z=>{
      const div=document.createElement('div'),qtyNode=document.createElement('b');
      div.className='invoice-loc-line';qtyNode.textContent=z.qty.toLocaleString('en-US',{useGrouping:false,maximumFractionDigits:3});
      div.append(z.name+':',qtyNode);return div;
    }));
    row.before(item);
    if(!priorLine)seenCodes.set(key(line.productCode),index);
  });
  row.remove();
  const discount=order.invoiceDiscount,prior=order.priorDebt;
  if(v2){total=order.goodsTotal;totalKnown=decimal(total)!==null;}
  const payable=v2?order.payable:(totalKnown&&typeof discount==='number'&&Number.isFinite(discount)?total-discount:null);
  const debt=sumMoney(payable,prior);
  const now=new Date();
  const dateParts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',day:'numeric',month:'numeric',year:'numeric'}).formatToParts(now);
  const datePart=name=>dateParts.find(part=>part.type===name).value;
  root.innerHTML=replace(root.innerHTML,{
    // Bản in ghi cả ID Telegram cạnh tên sale, đúng dạng KiotViet lưu: "<tên> - <ID>".
    Nhan_Vien_Ban_Hang:order.saleName||'',Dien_Thoai_Nguoi_Ban:localPhone(order.sellerPhone),
    Ma_Don_Hang:order.orderCode,Khach_Hang:order.customerName,So_Dien_Thoai:order.customerPhone,Dia_Chi_Khach_Hang:order.customerAddress,
    Nguoi_Gui:order.branch==='SG'?'TỔNG KHO GIA DỤNG SÀI GÒN':'TỔNG KHO GIA DỤNG HÀ NỘI',
    Tong_Tien_Hang:money(totalKnown?total:null),Chiet_Khau_Hoa_Don:money(discount),Tong_Cong:money(payable),Du_No_Truoc:money(prior),
    Du_No_Hoa_Don:money(debt),Du_No_Tam_Tinh:money(debt),
    Ghi_Chu:order.note||'',Ngay:datePart('day'),Thang:datePart('month'),Nam:datePart('year')
  });
  root.querySelectorAll('.invoice-telegram-slot').forEach(slot=>{
    if(!order.saleTelegramId){slot.remove();return;}
    const id=document.createElement('strong');id.className='invoice-telegram';id.textContent=order.saleTelegramId;
    slot.replaceChildren(document.createTextNode(' - '),id);
  });
  const title=delivery?'PHIẾU XÁC NHẬN GIAO HÀNG':'PHIẾU ĐẶT HÀNG';
  const heading=[...root.querySelectorAll('strong')].find(el=>/HÓA ĐƠN\s*BÁN\s*HÀNG/.test(el.textContent.replace(/ /g,' ')));
  if(heading)heading.textContent=title;
  if(!v2&&!delivery){const warning=document.createElement('p');warning.className='invoice-legacy';warning.textContent='Phiếu cũ chưa lưu dòng gốc; tiền hiển thị theo dữ liệu đã lưu, chưa đối chiếu được chi tiết ban đầu.';root.prepend(warning);}
  root.setAttribute('contenteditable','false');
  root.setAttribute('aria-label','Nội dung phiếu chỉ đọc');
  root.setAttribute('spellcheck','false');
  const printMessage=document.getElementById('pickingPrintMessage');if(printMessage)printMessage.textContent='';
  const titleEl=document.getElementById('pickingPrintTitle'),codeEl=document.createElement('span');
  codeEl.className='print-order-code';codeEl.textContent=order.orderCode;
  titleEl.replaceChildren(document.createTextNode(title+' · '),codeEl);
  document.getElementById('pickingPrintSheet').replaceChildren(root);
  currentPrint={order,record};
  await window.PickingPrint?.prepare?.();
  const dialog=document.getElementById('pickingPrintDialog');
  if(!dialog.open)dialog.showModal();
}
window.PickingInvoice={show,loadAssets,changeTemplate:template=>currentPrint?show(currentPrint.order,currentPrint.record,template):Promise.resolve()};
})();

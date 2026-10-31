/* Read-only demo transport for the ORIGINAL lifecycle page. No requests can write to the system. */
(function(){
  'use strict';
  let data=structuredClone(window.PickingDemo);
  const key=o=>o.branch+'|'+o.orderCode;
  function prepare(input){
    const orders=input.orders.map((o,i)=>{
      const when='23/10/2026 10:'+String(15-i).padStart(2,'0');
      const lines=o.lines.map((l,j)=>({...l,price:l.price||4900+j*1000,discount:0,onHand:Math.max(l.quantity,100),inTransit:0,sellableQty:l.quantity,sellableAmount:l.quantity*(l.price||4900+j*1000),amount:l.quantity*(l.price||4900+j*1000)}));
      const total=lines.reduce((s,l)=>s+l.quantity*l.price,0);
      return {...o,lines,orderDate:o.orderDate||when,saleSentAt:o.status.code==='SENT_TO_ACCOUNTANT'?when:'',summary:{...o.status,at:when},kiotStatus:'Phiếu tạm',source:'sheet',orderTotal:total,sellableValue:total,warnings:[],flow:'DELIVERY',note:o.note||'Đơn mô phỏng — không phải dữ liệu vận hành'};
    });
    return {orders,locations:input.locations.map((r,i)=>({...r,id:'loc-'+i}))};
  }
  data=prepare(data);
  window.PickingData={get:()=>data,key,replace(input){data=prepare(input);},source:'MÔ PHỎNG'};
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  const realFetch=window.fetch.bind(window);
  window.fetch=async function(resource,options={}){
    const origin=location.protocol==='file:'?'http://prototype.local':location.origin;
    const url=new URL(typeof resource==='string'?resource:resource.url,origin);
    if(url.origin!==origin||!url.pathname.startsWith('/api/'))return realFetch(resource,options);
    // Chỉ endpoint ĐỌC của VT Hà Nội / VT Sài Gòn đi ra server thật khi prototype được phục vụ qua http(s); mở file trực tiếp thì dùng dữ liệu demo bên dưới.
    if(url.pathname==='/api/stock-positions'&&location.protocol!=='file:'&&(options.method||'GET').toUpperCase()==='GET')return realFetch(resource,options);
    if((options.method||'GET').toUpperCase()!=='GET')return reply({error:'Prototype chỉ đọc, không ghi hệ thống.'},403);
    if(url.pathname==='/api/auth/me')return reply({id:'prototype-accountant',username:'prototype',hoTen:'Kế toán · Mô phỏng',vaiTro:'Kế toán',coSo:'Cả hai',trangThai:'Đang hoạt động',permissions:['shipment.lifecycle','shipment.lookup','shipment.history','shipment.export','stockLocationsV2.view','account.profile'],pageFeatures:[]});
    if(url.pathname==='/api/shipment/lifecycle/order-detail'){
      const o=data.orders.find(o=>o.orderCode===url.searchParams.get('code')&&o.branch===url.searchParams.get('branch'));
      return o?reply({detail:{...o,code:o.orderCode,phieuTam:true,status:'Phiếu tạm',total:o.orderTotal,lineCount:o.lines.length,totalQuantity:o.lines.reduce((s,l)=>s+l.quantity,0)}}):reply({error:'Không có đơn'},404);
    }
    if(url.pathname==='/api/shipment/lifecycle/history')return reply({history:[]});
    if(url.pathname==='/api/shipment/lifecycle/containers')return reply({containers:[],items:[]});
    if(url.pathname==='/api/shipment/lifecycle'){
      let orders=data.orders.slice();const p=url.searchParams;
      if(p.get('status'))orders=orders.filter(o=>o.summary.code===p.get('status'));
      if(p.get('branch'))orders=orders.filter(o=>o.branch===p.get('branch'));
      if(p.get('q')){const q=p.get('q').toLowerCase();orders=orders.filter(o=>(o.orderCode+' '+o.customerName+' '+o.saleName).toLowerCase().includes(q));}
      if(p.get('kiotStatus'))orders=orders.filter(o=>o.kiotStatus===p.get('kiotStatus'));
      for(const [name,lower] of [['from',true],['to',false]])if(p.get(name))orders=orders.filter(o=>(lower?'2026-10-23'>=p.get(name):'2026-10-23'<=p.get(name)));
      const sort=p.get('sort')||'orderDate',dir=p.get('dir')==='asc'?1:-1;
      orders.sort((a,b)=>typeof a[sort]==='number'?(a[sort]-b[sort])*dir:String(a[sort]||'').localeCompare(String(b[sort]||''),'vi',{numeric:true})*dir);
      const page=Number(p.get('page'))||1,pageSize=Number(p.get('pageSize'))||100;
      return reply({orders:orders.slice((page-1)*pageSize,page*pageSize),total:data.orders.length,filteredTotal:orders.length,page,pageSize,totalPages:Math.max(1,Math.ceil(orders.length/pageSize)),kiotStatuses:['Phiếu tạm'],kiot:{ok:true,stale:false,count:data.orders.length,fetchedAt:new Date().toISOString()}});
    }
    if(url.pathname.startsWith('/api/shipment/lifecycle/')){
      const code=decodeURIComponent(url.pathname.split('/').pop());const o=data.orders.find(o=>o.orderCode===code);return o?reply({order:o,detail:o,summary:o.summary}):reply({error:'Không có đơn'},404);
    }
    if(url.pathname==='/api/stock-positions')return reply({rows:data.locations.filter(r=>r.branch===url.searchParams.get('branch')),stale:false,syncedAt:new Date().toISOString()});
    if(url.pathname.includes('notifications'))return reply({notifications:[],unreadCount:0});
    return reply({items:[],branches:['Hà Nội','Sài Gòn']});
  };
})();

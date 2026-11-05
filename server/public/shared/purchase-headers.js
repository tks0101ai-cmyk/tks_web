(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PurchaseHeaders=factory()})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const zh={rowKey:'行编号',productCode:'商品编码',productName:'越文品名',productNameCn:'中文品名',supplier:'供应商',container:'货柜名称',status:'货柜状态',color:'颜色',saleNote:'销售备注',vatNote:'增值税备注',buyNote:'采购备注',buyer:'采购员',paymentNote:'付款备注',listedAt:'下单日期',orderedNote:'订货情况',shippedNote:'发货情况',etaNote:'预计到货',arrivedNote:'到货情况',qtyPerCarton:'装箱数',cartonCount:'箱数',totalQty:'总数量',unitPriceCny:'人民币单价',freightPrepaid:'已付运费',totalCny:'人民币总额',fxRate:'汇率',freightPostpaid:'到付运费',kgPerCarton:'每箱重量',m3PerCarton:'每箱体积',totalTon:'总重量（吨）',totalM3:'总体积（m³）',netPrice:'到仓单价',goodsAmount:'货款金额',freightAmount:'运费金额',taxAmount:'税额',literWarehouse:'仓库体积（升/件）',literChina:'中国体积（升/件）',literDiff:'体积偏差',gramWarehouse:'仓库重量（克/件）',gramChina:'中国重量（克/件）',gramDiff:'重量偏差',measuredOn:'测量日期',ratio:'重量体积比',extraNote:'其他备注'};
  const other={'Mã hàng / tên hàng':'商品编码 / 品名','Mã / Tên hàng':'商品编码 / 品名','Thùng':'箱数','Tấn':'吨','Tên cont':'货柜名称','Trạng thái':'状态','Loại xe':'车型','Tổng tấn':'总重量（吨）','Tổng m³':'总体积（m³）','Cước cont':'整柜运费','Dòng':'行数','Nhà VC':'运输商','Người xếp':'装柜员','Người xếp cont':'装柜员','Cont TQ':'中国柜号','Dự kiến':'计划','Dự kiến (thùng)':'计划箱数','Thực xuất':'实际出货','Thực xuất (thùng)':'实际出货箱数','Khóa dòng / Mã hàng':'行编号 / 商品编码','Phần':'部分','Giữ lại':'保留','Trường':'字段','Thay thế':'替换','Kết quả':'结果'};
  function mount({button,columns,document:doc,storage,selector='#mainHead th, #orderTable th',onChange=()=>{}}){
    let lang='vi';try{lang=storage.getItem('purchase:header-language')==='zh'?'zh':'vi'}catch{}
    const originals=new WeakMap();
    function apply(){
      doc.querySelectorAll(selector).forEach(th=>{
        const key=th.dataset.k||th.dataset.columnKey||th.dataset.key,col=columns.find(c=>c.k===key);
        const node=[...th.childNodes].find(n=>n.nodeType===3&&n.textContent.trim());if(!node)return;
        if(!originals.has(node))originals.set(node,node.textContent.trim());const vi=col?.l||originals.get(node),match=Object.keys(other).find(k=>k.toLocaleLowerCase()===vi.toLocaleLowerCase()),text=lang==='zh'?(zh[key]||other[match]||vi):vi;
        if(node.textContent!==text)node.textContent=text;
        th.querySelectorAll('.cn').forEach(el=>{if(!el.hidden)el.hidden=true;if(el.style.display!=='none')el.style.display='none'});
      });
      const label=lang==='zh'?'中文 ▾':'Tiếng Việt ▾';if(button.textContent!==label)button.textContent=label;button.setAttribute('aria-label','Ngôn ngữ tiêu đề: '+(lang==='zh'?'中文':'Tiếng Việt'));
    }
    button.onclick=()=>{lang=lang==='vi'?'zh':'vi';try{storage.setItem('purchase:header-language',lang)}catch{}onChange(lang);apply()};
    const observer=new doc.defaultView.MutationObserver(apply);observer.observe(doc.body,{childList:true,subtree:true});apply();
    return {apply,get language(){return lang},disconnect:()=>observer.disconnect()};
  }
  return {mount,zh};
});

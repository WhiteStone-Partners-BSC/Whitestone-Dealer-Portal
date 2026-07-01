/* Menu Shop (Customer View) — menu-selling presentation. Display only. Retail only. */
(function () {
  var DEFAULT_RETAIL = { 1: 3699, 2: 6798, 3: 9297 };
  var cvSelected = 3, cvPresenting = false;

  function monthly(P, apr, n){ if(!P||!n)return 0; var r=(apr/100)/12; if(r===0)return P/n; var f=Math.pow(1+r,n); return P*r*f/(f-1); }
  function money(x){ return Math.round(x).toLocaleString('en-US'); }
  function priceFor(y){ var el=document.querySelector('#cv-opt-'+y+' input'); return el?(Number(el.value)||0):0; }
  function num(id){ var el=document.getElementById(id); return el?(Number(el.value)||0):0; }

  function cvRecalc(){
    var P=num('cv-amt'), apr=num('cv-apr'), n=num('cv-term');
    var base=monthly(P,apr,n);
    var ad=document.getElementById('cv-amt-disp'); if(ad) ad.textContent='$'+money(P);
    var rd=document.getElementById('cv-apr-disp'); if(rd) rd.textContent=apr+'%';
    var td=document.getElementById('cv-term-disp'); if(td) td.textContent=n+' months';
    [1,2,3].forEach(function(y){
      var o=document.getElementById('cv-opt-'+y); if(!o) return;
      var pv=o.querySelector('.cv-pv'); if(pv) pv.textContent=money(priceFor(y));
      var d=Math.max(0, monthly(P+priceFor(y),apr,n)-base);
      var de=document.getElementById('cv-d'+y); if(de) de.textContent='+$'+money(d);
    });
    var res=document.getElementById('cv-res'), lbl=document.getElementById('cv-res-lbl'), co=document.getElementById('cv-callout');
    if(!res) return;
    if(cvSelected===0){
      lbl.textContent='Monthly payment'; res.innerHTML='$'+money(base)+'<small>/mo</small>';
      co.className='cv-callout cv-empty'; co.textContent='No coverage selected';
    } else {
      var wp=monthly(P+priceFor(cvSelected),apr,n), d=Math.max(0,wp-base);
      lbl.textContent='New monthly payment'; res.innerHTML='$'+money(wp)+'<small>/mo</small>';
      co.className='cv-callout'; co.innerHTML=cvSelected+' years of covered maintenance for just <b>+$'+money(d)+'</b>/mo';
    }
  }
  function cvSelect(y){
    if(cvPresenting) return;               // locked in customer view
    cvSelected=y;
    [0,1,2,3].forEach(function(k){ var o=document.getElementById('cv-opt-'+k); if(o) o.classList.toggle('cv-sel',k===y); });
    cvRecalc();
  }
  function cvToggleMode(){
    cvPresenting=!cvPresenting;
    var root=document.getElementById('cv-root'); if(!root) return;
    root.classList.toggle('cv-customer',cvPresenting);
    document.getElementById('cv-mode-switch').classList.toggle('on',cvPresenting);
    document.getElementById('cv-mode-label').textContent=cvPresenting?'Customer view':'Manager view';
    document.getElementById('cv-mode-sub').textContent=cvPresenting?'view only \u2014 tap to edit':'editing \u2014 tap to present';
    root.querySelectorAll('input').forEach(function(i){ i.readOnly=cvPresenting; });
  }

  window.loadCustomerViewTab=function(){
    var retail=Object.assign({},DEFAULT_RETAIL);
    try{ if(typeof window.pricingCurrentRetail==='function'){ [1,2,3].forEach(function(y){ var v=Number(window.pricingCurrentRetail(y)); if(v>0) retail[y]=v; }); } }catch(e){}
    [1,2,3].forEach(function(y){ var o=document.getElementById('cv-opt-'+y); if(!o) return; o.querySelector('input').value=retail[y]; o.querySelector('.cv-pv').textContent=money(retail[y]); });
    cvPresenting=false;
    var root=document.getElementById('cv-root'); if(root){ root.classList.remove('cv-customer'); root.querySelectorAll('input').forEach(function(i){ i.readOnly=false; }); }
    var sw=document.getElementById('cv-mode-switch'); if(sw) sw.classList.remove('on');
    var ml=document.getElementById('cv-mode-label'); if(ml) ml.textContent='Manager view';
    var ms=document.getElementById('cv-mode-sub'); if(ms) ms.textContent='editing \u2014 tap to present';
    cvSelect(3);
  };
  window.cvRecalc=cvRecalc; window.cvSelect=cvSelect; window.cvToggleMode=cvToggleMode;
})();

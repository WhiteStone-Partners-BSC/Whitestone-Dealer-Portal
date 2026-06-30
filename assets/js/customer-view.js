/* Customer View — menu-selling payment calculator. Display only. Retail only. */
(function () {
  var DEFAULT_RETAIL = { 1: 3699, 2: 6798, 3: 9297 };
  var cvSelected = 3, cvEditing = false, cvPresenting = false;

  function cvMonthly(P, apr, n) {
    if (!P || !n) return 0;
    var r = (apr / 100) / 12;
    if (r === 0) return P / n;
    var f = Math.pow(1 + r, n);
    return P * r * f / (f - 1);
  }
  function money(x){ return Math.round(x).toLocaleString('en-US'); }
  function priceFor(y){
    var el = document.querySelector('#cv-opt-' + y + ' input');
    return el ? (Number(el.value) || 0) : 0;
  }
  function num(id){ return Number(document.getElementById(id).value) || 0; }

  function cvRecalc(){
    var P = num('cv-amt'), apr = num('cv-apr'), n = num('cv-term');
    var base = cvMonthly(P, apr, n);
    document.getElementById('cv-base').textContent = '$' + money(base) + '/mo';
    [1,2,3].forEach(function(y){
      var d = Math.max(0, cvMonthly(P + priceFor(y), apr, n) - base);
      var el = document.getElementById('cv-d' + y); if (el) el.textContent = '+$' + money(d);
    });
    var resAmt = document.getElementById('cv-res'), resLbl = document.getElementById('cv-res-lbl'),
        co = document.getElementById('cv-callout');
    if (cvSelected === 0){
      resLbl.textContent = 'Monthly payment';
      resAmt.innerHTML = '$' + money(base) + '<small>/mo</small>';
      co.className = 'cv-callout cv-empty'; co.innerHTML = 'No coverage selected';
    } else {
      var wp = cvMonthly(P + priceFor(cvSelected), apr, n), d = Math.max(0, wp - base);
      resLbl.textContent = 'New monthly payment';
      resAmt.innerHTML = '$' + money(wp) + '<small>/mo</small>';
      co.className = 'cv-callout';
      co.innerHTML = cvSelected + ' years of covered maintenance for just <b>+$' + money(d) + '</b>/mo';
    }
  }
  function cvSelect(y){
    cvSelected = y;
    [0,1,2,3].forEach(function(k){
      var o = document.getElementById('cv-opt-' + k); if (o) o.classList.toggle('cv-sel', k === y);
    });
    cvRecalc();
  }
  function cvToggleEdit(){
    cvEditing = !cvEditing;
    [1,2,3].forEach(function(y){
      var o = document.getElementById('cv-opt-' + y); if (!o) return;
      o.querySelector('.cv-pv').style.display = cvEditing ? 'none' : 'inline';
      o.querySelector('input').style.display = cvEditing ? 'inline-block' : 'none';
      if (!cvEditing) o.querySelector('.cv-pv').textContent = money(priceFor(y));
    });
    document.getElementById('cv-editlink').textContent = cvEditing ? '\u2713 Done editing' : '\u270e Edit plan prices';
    if (!cvEditing) cvRecalc();
  }
  function cvToggleMode(){
    cvPresenting = !cvPresenting;
    document.getElementById('cv-controls').classList.toggle('cv-hide', cvPresenting);
    document.getElementById('cv-mode-switch').classList.toggle('on', cvPresenting);
    document.getElementById('cv-mode-label').textContent = cvPresenting ? 'Customer view' : 'Manager view';
  }

  window.loadCustomerViewTab = function(){
    // auto-pull retail if available, else defaults
    var retail = Object.assign({}, DEFAULT_RETAIL);
    try {
      if (typeof window.pricingCurrentRetail === 'function') {
        [1,2,3].forEach(function(y){ var v = Number(window.pricingCurrentRetail(y)); if (v > 0) retail[y] = v; });
      }
    } catch (e) { /* fall back to defaults */ }
    [1,2,3].forEach(function(y){
      var o = document.getElementById('cv-opt-' + y); if (!o) return;
      o.querySelector('input').value = retail[y];
      o.querySelector('.cv-pv').textContent = money(retail[y]);
    });
    cvSelect(3);
  };

  // expose handlers used by inline onclick/oninput
  window.cvRecalc = cvRecalc; window.cvSelect = cvSelect;
  window.cvToggleEdit = cvToggleEdit; window.cvToggleMode = cvToggleMode;
})();

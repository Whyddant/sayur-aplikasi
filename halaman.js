/* Fungsi bersama untuk halaman menu kebab. Tidak memuat data apa pun sendiri. */
(function () {
  var Hal = {};
  Hal.$ = function (id) { return document.getElementById(id); };

  var tt;
  Hal.toast = function (teks) {
    var el = Hal.$('toast');
    if (!el) return;
    el.textContent = teks;
    el.classList.add('show');
    clearTimeout(tt);
    tt = setTimeout(function () { el.classList.remove('show'); }, 2600);
  };

  Hal.kembali = function () {
    if (history.length > 1 && document.referrer && document.referrer.indexOf(location.origin) === 0) history.back();
    else location.href = './';
  };

  Hal.rp = function (n) { return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID'); };

  Hal.salin = function (teks) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(teks).then(function () { return true; }, function () { return salinLama(teks); });
    }
    return Promise.resolve(salinLama(teks));
  };
  function salinLama(teks) {
    try {
      var t = document.createElement('textarea');
      t.value = teks; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(t);
      return ok;
    } catch (e) { return false; }
  }

  /* Mode gelap: 'sistem' | 'terang' | 'gelap'. Kunci sama dengan aplikasi utama (sayur_dark: 1 / 0). */
  Hal.modeGelap = function () {
    var v = null;
    try { v = localStorage.getItem('sayur_dark'); } catch (e) {}
    return v === '1' ? 'gelap' : (v === '0' ? 'terang' : 'sistem');
  };
  Hal.setModeGelap = function (mode) {
    try {
      if (mode === 'gelap') localStorage.setItem('sayur_dark', '1');
      else if (mode === 'terang') localStorage.setItem('sayur_dark', '0');
      else localStorage.removeItem('sayur_dark');
    } catch (e) {}
    var gelap = mode === 'gelap' || (mode === 'sistem' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', gelap);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = gelap ? '#1B261B' : '#2F5233';
  };

  document.addEventListener('DOMContentLoaded', function () {
    var b = Hal.$('btnBack');
    if (b) b.addEventListener('click', Hal.kembali);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && document.documentElement.classList.contains('dark')) meta.content = '#1B261B';
  });

  window.Hal = Hal;
})();

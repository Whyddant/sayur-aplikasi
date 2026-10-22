/**
 * SAYUR APP — sw.js  (service worker)
 *  - Cangkang aplikasi disimpan di HP supaya bisa dibuka tanpa internet.
 *  - Halaman & skrip: ambil dari internet dulu (agar pembaruan cepat masuk), bila gagal pakai simpanan.
 *  - Gambar/ikon: pakai simpanan dulu, perbarui di belakang layar.
 *  - Permintaan ke Google (data aplikasi) TIDAK pernah disimpan di sini; itu urusan storage.js.
 *
 *  Setiap kali Anda mengubah file aplikasi, naikkan angka VERSI di bawah.
 */
var VERSI = 'sayur-app-v7';

var INTI = [
  './', './index.html', './sayur-app.html', './storage.js', './manifest.json',
  './halaman.css', './halaman.js',
  './pengaturan.html', './panduan.html', './tentang.html', './bantuan.html',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png', './icons/favicon-48.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSI).then(function (cache) {
      /* satu per satu: file yang tidak ada (mis. index.html bila Anda memakai nama lain) tidak menggagalkan semuanya */
      return Promise.all(INTI.map(function (u) {
        return cache.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (n) { return n !== VERSI; }).map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function dariJaringanDulu(req) {
  /* Sinyal lemah: bila jaringan tidak menjawab dalam 6 detik, pakai simpanan agar aplikasi tidak menggantung */
  var batas = new Promise(function (_, tolak) { setTimeout(function () { tolak('lambat'); }, 6000); });
  var jaringan = fetch(req).then(function (res) {
    if (res && res.ok) {
      var salin = res.clone();
      caches.open(VERSI).then(function (c) { c.put(req, salin); });
    }
    return res;
  });
  return Promise.race([jaringan, batas]).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || jaringan;      /* tidak ada simpanan: tunggu jaringan sampai selesai */
    });
  });
}

function simpananDulu(req) {
  return caches.match(req).then(function (hit) {
    var segar = fetch(req).then(function (res) {
      if (res && res.ok) { var salin = res.clone(); caches.open(VERSI).then(function (c) { c.put(req, salin); }); }
      return res;
    }).catch(function () { return hit; });
    return hit || segar;
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        /* Google Apps Script, font, dll: biarkan langsung */

  if (req.mode === 'navigate') {
    e.respondWith(
      dariJaringanDulu(req).catch(function () {
        return caches.match('./index.html').then(function (a) { return a || caches.match('./sayur-app.html'); })
          .then(function (b) { return b || caches.match('./'); });
      })
    );
    return;
  }
  if (/\.(js|css|json|html)$/.test(url.pathname)) { e.respondWith(dariJaringanDulu(req)); return; }
  e.respondWith(simpananDulu(req));
});

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

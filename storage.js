/**
 * ============================================================
 *  SAYUR APP — storage.js  (Bagian 3)
 *  Jembatan antara aplikasi (HTML) dan backend Google Apps Script.
 *
 *  - get(action, params)   : ambil data dari server
 *  - post(action, data)    : kirim perubahan; bila offline / server sibuk
 *                            otomatis masuk ANTREAN di HP lalu dikirim ulang
 *  - queue / processQueue  : antrean kirim (dipakai ikon sinkron di aplikasi)
 *  - pengaturan.get()      : pengaturan lapak (NamaLapak, dst.)
 *  - config                : alamat server + token (diisi di halaman Pengaturan)
 *
 *  Aturan penting:
 *   * post() TIDAK menolak saat offline; ia mengembalikan {success:true, queued:true}.
 *   * post() menolak (reject) hanya bila server menjawab "tidak bisa" (mis. data salah).
 *   * Antrean menjaga URUTAN kirim (pesanan dulu, baru itemnya).
 *   * Backend idempoten pada ID, jadi kirim ulang tidak membuat data ganda.
 * ============================================================
 */
(function (root) {
  'use strict';

  /* Isi di sini ATAU lewat halaman Pengaturan (lebih mudah, tersimpan di HP). */
  var DEFAULT_API_URL = '';   // contoh: 'https://script.google.com/macros/s/XXXX/exec'
  var DEFAULT_TOKEN   = '';

  var K = {
    url: 'sayur_api_url', token: 'sayur_api_token',
    queue: 'sayur_queue_v1', cache: 'sayur_c1:', set: 'sayur_pengaturan_v1'
  };
  var TIMEOUT_GET = 25000, TIMEOUT_POST = 30000, TIMEOUT_PING = 12000;
  var MAKS_COBA = 10;          // percobaan kirim sebelum antrean ditandai "gagal"
  var CACHE_MAKS_UMUR = 14 * 24 * 3600 * 1000;

  /* Action baca yang boleh memakai salinan lama bila offline */
  var BOLEH_BASI = {
    getPengaturan: 1, getHargaMaster: 1, getNamaBarangMaster: 1, getBelanja: 1,
    getPesanan: 1, getNotaList: 1, getNota: 1, getHariLibur: 1
  };

  /* ---------- localStorage aman ---------- */
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { root.localStorage.removeItem(k); } catch (e) {} }
  function jsonGet(k, def) {
    var v = lsGet(k);
    if (!v) return def;
    try { return JSON.parse(v); } catch (e) { return def; }
  }
  function lsKeys(prefix) {
    var out = [];
    try {
      for (var i = 0; i < root.localStorage.length; i++) {
        var k = root.localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) out.push(k);
      }
    } catch (e) {}
    return out;
  }

  /* ---------- konfigurasi ---------- */
  var config = {
    get: function () {
      return {
        url: (lsGet(K.url) || DEFAULT_API_URL || '').trim(),
        token: (lsGet(K.token) || DEFAULT_TOKEN || '').trim()
      };
    },
    set: function (c) {
      c = c || {};
      if (c.url !== undefined) { c.url ? lsSet(K.url, String(c.url).trim()) : lsDel(K.url); }
      if (c.token !== undefined) { c.token ? lsSet(K.token, String(c.token).trim()) : lsDel(K.token); }
      try { root.dispatchEvent(new Event('sayur:config')); } catch (e) {}
    },
    isReady: function () {
      var c = config.get();
      var urlOk = /^https:\/\/script\.google\.com\/.+\/exec$/.test(c.url) ||
                  /^https:\/\/script\.googleusercontent\.com\//.test(c.url);
      return urlOk && !!c.token;
    }
  };

  /* ---------- galat berjenis ---------- */
  function galat(pesan, jenis) {
    var e = new Error(pesan);
    e.kind = jenis;           // 'network' | 'transient' | 'auth' | 'business' | 'config'
    e.transient = (jenis === 'network' || jenis === 'transient');
    return e;
  }

  /* ---------- HTTP ---------- */
  function withTimeout(promiseFn, ms) {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return promiseFn(ctl ? ctl.signal : undefined).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  function parseRespons(res) {
    return res.text().then(function (txt) {
      if (res.status >= 500) throw galat('Server sedang bermasalah (' + res.status + ')', 'transient');
      var j;
      try { j = JSON.parse(txt); } catch (e) {
        /* halaman HTML dari Google (mis. sedang sibuk / izin belum diberikan) */
        throw galat('Server tidak mengirim data yang benar. Periksa URL Web App & izin "Siapa saja".', 'transient');
      }
      if (j && j.success === false) {
        var msg = String(j.error || 'Permintaan ditolak server');
        if (j.code === 'AUTH') throw galat(msg, 'auth');
        if (/lock|timed out|too many|quota|service invoked|sibuk/i.test(msg)) throw galat(msg, 'transient');
        throw galat(msg, 'business');
      }
      return j;
    });
  }

  function kirimHttp(metode, params, body, ms) {
    var c = config.get();
    if (!config.isReady()) return Promise.reject(galat('Alamat server atau token belum diisi (menu Pengaturan)', 'config'));
    if (root.navigator && root.navigator.onLine === false) return Promise.reject(galat('Tidak ada koneksi internet', 'network'));
    var url = c.url, opsi;
    if (metode === 'GET') {
      var q = ['token=' + encodeURIComponent(c.token)];
      Object.keys(params || {}).forEach(function (k) {
        var v = params[k];
        if (v === undefined || v === null) return;
        q.push(encodeURIComponent(k) + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v));
      });
      url += (url.indexOf('?') === -1 ? '?' : '&') + q.join('&');
      opsi = { method: 'GET', redirect: 'follow', cache: 'no-store' };
    } else {
      /* text/plain = "permintaan sederhana": tanpa preflight CORS, yang tidak didukung Apps Script */
      opsi = {
        method: 'POST', redirect: 'follow', cache: 'no-store',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ token: c.token }, body))
      };
    }
    return withTimeout(function (signal) {
      if (signal) opsi.signal = signal;
      return root.fetch(url, opsi);
    }, ms).then(parseRespons, function (e) {
      if (e && e.kind) throw e;
      throw galat(e && e.name === 'AbortError' ? 'Server terlalu lama menjawab' : 'Gagal menghubungi server', 'network');
    });
  }

  /* ---------- salinan baca (cache) ---------- */
  function stabil(o) {
    if (!o || typeof o !== 'object') return '';
    return Object.keys(o).sort().map(function (k) { return k + '=' + o[k]; }).join('&');
  }
  function kunciCache(action, params) { return K.cache + action + '?' + stabil(params); }

  function cacheSimpan(action, params, nilai) {
    var kunci = kunciCache(action, params), isi = JSON.stringify({ t: Date.now(), v: nilai });
    if (lsSet(kunci, isi)) return;
    /* penuh: buang salinan terlama lalu coba lagi */
    var daftar = lsKeys(K.cache).map(function (k) { return { k: k, t: (jsonGet(k, {}) || {}).t || 0 }; })
      .sort(function (a, b) { return a.t - b.t; });
    for (var i = 0; i < daftar.length && i < 20; i++) lsDel(daftar[i].k);
    lsSet(kunci, isi);
  }
  function cacheBaca(action, params) {
    var c = jsonGet(kunciCache(action, params), null);
    if (!c || Date.now() - (c.t || 0) > CACHE_MAKS_UMUR) return undefined;
    return c.v;
  }

  /* ---------- GET ---------- */
  function get(action, params) {
    params = params || {};
    return kirimHttp('GET', Object.assign({ action: action }, params), null, TIMEOUT_GET).then(function (j) {
      var data = j ? j.data : null;
      cacheSimpan(action, params, data);
      return data;
    }, function (e) {
      if (e && e.transient && BOLEH_BASI[action]) {
        var lama = cacheBaca(action, params);
        if (lama !== undefined) return lama;
      }
      throw e;
    });
  }

  /* ---------- ANTREAN ---------- */
  function qBaca() { var q = jsonGet(K.queue, []); return Array.isArray(q) ? q : []; }
  function qTulis(q) { lsSet(K.queue, JSON.stringify(q)); try { root.dispatchEvent(new Event('sayur:queue')); } catch (e) {} }
  function idJob() { return 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7); }

  var queue = {
    list: function () { return qBaca(); },
    failedCount: function () { return qBaca().filter(function (j) { return j.failed; }).length; },
    remove: function (id) { qTulis(qBaca().filter(function (j) { return j.qid !== id; })); },
    resetFailed: function () {
      qTulis(qBaca().map(function (j) { if (j.failed) { j.failed = false; j.tries = 0; j.lastError = ''; } return j; }));
    },
    clear: function () { qTulis([]); }
  };

  function masukAntrean(action, data) {
    var q = qBaca(), idData = data && data.id ? String(data.id) : '';
    if (idData) {
      for (var i = 0; i < q.length; i++) {
        if (q[i].action === action && q[i].data && String(q[i].data.id) === idData) {
          q[i].data = data; q[i].failed = false; q[i].tries = 0; q[i].lastError = '';
          qTulis(q);
          return q[i].qid;
        }
      }
    }
    var job = { qid: idJob(), action: action, data: data || {}, ts: Date.now(), tries: 0, failed: false, lastError: '' };
    q.push(job);
    qTulis(q);
    return job.qid;
  }

  function adaAntreanAktif() { return qBaca().some(function (j) { return !j.failed; }); }

  /* ---------- POST ---------- */
  function post(action, data) {
    data = data || {};
    /* Jaga urutan: bila masih ada antrean, ikut antre. */
    if (adaAntreanAktif()) {
      masukAntrean(action, data);
      processQueue();
      return Promise.resolve({ success: true, queued: true });
    }
    return kirimHttp('POST', null, { action: action, data: data }, TIMEOUT_POST).then(function (j) {
      return { success: true, data: j ? j.data : null };
    }, function (e) {
      if (e && e.kind === 'business') throw e;                 /* ditolak: jangan diulang otomatis */
      var qid = masukAntrean(action, data);
      if (e && e.kind === 'auth') { tandaiGagal(qid, e.message); throw e; }
      if (e && e.kind === 'config') { return { success: true, queued: true, alasan: 'belum-diatur' }; }
      return { success: true, queued: true };
    });
  }

  function tandaiGagal(qid, pesan) {
    qTulis(qBaca().map(function (j) { if (j.qid === qid) { j.failed = true; j.lastError = pesan || ''; } return j; }));
  }

  /* ---------- kirim antrean ---------- */
  var sedangKirim = null;

  function prosesAntrean() {
    var terkirim = 0, gagal = 0;
    function lanjut() {
      var q = qBaca(), job = null;
      for (var i = 0; i < q.length; i++) { if (!q[i].failed) { job = q[i]; break; } }
      if (!job) return Promise.resolve();
      return kirimHttp('POST', null, { action: job.action, data: job.data }, TIMEOUT_POST).then(function () {
        queue.remove(job.qid); terkirim++;
        return lanjut();
      }, function (e) {
        if (e && e.kind === 'config') return;                  /* belum diatur: berhenti, jangan tandai gagal */
        if (e && e.transient) {                                /* jaringan/server sibuk: berhenti, coba lagi nanti */
          var q2 = qBaca().map(function (j) {
            if (j.qid === job.qid) { j.tries = (j.tries || 0) + 1; j.lastError = e.message; if (j.tries >= MAKS_COBA) { j.failed = true; gagal++; } }
            return j;
          });
          qTulis(q2);
          return;
        }
        /* ditolak server (data salah / token salah): tandai gagal, lanjut ke item berikutnya */
        tandaiGagal(job.qid, e && e.message); gagal++;
        return lanjut();
      });
    }
    return lanjut().then(function () {
      var sisa = qBaca();
      if (terkirim > 0) { try { root.dispatchEvent(new Event('sayur:sync')); } catch (e) {} }
      return { sent: terkirim, failed: gagal, remaining: sisa.length, skipped: false };
    });
  }

  function processQueue() {
    if (sedangKirim) return sedangKirim;
    if (!qBaca().some(function (j) { return !j.failed; })) return Promise.resolve({ sent: 0, failed: 0, remaining: qBaca().length, skipped: false });
    if (!config.isReady()) return Promise.resolve({ skipped: true, reason: 'config' });
    if (root.navigator && root.navigator.onLine === false) return Promise.resolve({ skipped: true, reason: 'offline' });

    var jalan = function () { return prosesAntrean(); };
    var p;
    if (root.navigator && root.navigator.locks && root.navigator.locks.request) {
      p = root.navigator.locks.request('sayur-queue', { ifAvailable: true }, function (lock) {
        return lock ? jalan() : { skipped: true, reason: 'tab-lain' };
      });
    } else {
      p = jalan();
    }
    sedangKirim = p.then(function (r) { sedangKirim = null; return r; }, function (e) { sedangKirim = null; throw e; });
    return sedangKirim;
  }

  function discardFailed() { qTulis(qBaca().filter(function (j) { return !j.failed; })); }

  /* ---------- pengaturan lapak ---------- */
  var pengaturan = {
    /* Salinan di HP dipakai langsung (cepat), lalu diperbarui di belakang layar. */
    get: function () {
      var lokal = jsonGet(K.set, null);
      var segar = get('getPengaturan').then(function (s) {
        if (s && typeof s === 'object') lsSet(K.set, JSON.stringify(s));
        return s || {};
      });
      if (lokal) { segar.catch(function () {}); return Promise.resolve(lokal); }
      return segar.catch(function () { return {}; });
    },
    set: function (obj) {
      return post('setPengaturan', obj).then(function (r) {
        var lama = jsonGet(K.set, {}) || {};
        lsSet(K.set, JSON.stringify(Object.assign(lama, obj)));
        return r;
      });
    }
  };

  /* ---------- tes koneksi (untuk halaman Pengaturan) ---------- */
  function ping() {
    return kirimHttp('GET', { action: 'ping' }, null, TIMEOUT_PING).then(function (j) { return j.data; });
  }

  /* ---------- init ---------- */
  var sudahInit = false;
  function init() {
    if (sudahInit) return;
    sudahInit = true;
    try {
      root.addEventListener('online', function () { processQueue(); });
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.visibilityState === 'visible') processQueue();
      });
      root.addEventListener('sayur:config', function () { processQueue(); });
      setInterval(function () { if (qBaca().length) processQueue(); }, 60000);
    } catch (e) {}
    try {
      var h = root.location && root.location.hostname;
      if (root.navigator && 'serviceWorker' in root.navigator &&
          (root.location.protocol === 'https:' || h === 'localhost' || h === '127.0.0.1')) {
        root.navigator.serviceWorker.register('./sw.js').catch(function () {});
      }
    } catch (e) {}
    setTimeout(function () { processQueue(); }, 1500);
  }

  var API = {
    init: init, get: get, post: post, ping: ping,
    config: config,
    cache: {
      load: function (key) { return jsonGet('sayur_user_cache:' + key, null); },
      save: function (key, val) { lsSet('sayur_user_cache:' + key, JSON.stringify(val)); }
    },
    queue: queue, processQueue: processQueue, discardFailed: discardFailed,
    pengaturan: pengaturan, versi: '1.0.0'
  };

  root.SayurStorage = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);

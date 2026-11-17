'use strict';
/*
 * MRH P6 Studio - proje ozeti hesaplari (pano ve MCP araclari ortak kullanir)
 * (c) Merih Dogan
 */

const gun = s => s ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5 + (+s.slice(11, 13) || 0) / 24 : null;
const yuvarla = (n, b = 1) => n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** b) / 10 ** b;

function oran(b, s, t) {
  if (!b || !s) return 0;
  const x = gun(b), y = gun(s);
  if (t <= x) return 0;
  if (t >= y) return 1;
  return y > x ? (t - x) / (y - x) : 1;
}

const normal = A => A.filter(a => a.tur !== 'TT_LOE' && a.tur !== 'TT_WBS');
const agirlik = a => Math.max(a.od || 0, a.tur === 'TT_Mile' || a.tur === 'TT_FinMile' ? 0 : 0.5);

function projeOzeti(yuk) {
  const A = yuk.aktiviteler, N = normal(A);
  const top = N.reduce((s, a) => s + agirlik(a), 0) || 1;
  const dd = gun(yuk.proje.veriTarihi);
  const ilerleme = N.reduce((s, a) => s + agirlik(a) * (a.pct || 0) / 100, 0) / top * 100;
  const planli = dd && yuk.tabanId ? N.reduce((s, a) => s + agirlik(a) * oran(a.bs, a.bf, dd), 0) / top * 100 : null;
  const bitis = A.reduce((m, a) => a.bit && a.bit > m ? a.bit : m, '') || null;
  const tabanBitis = A.reduce((m, a) => a.bf && a.bf > m ? a.bf : m, '') || null;
  const say = st => A.filter(a => a.st === st).length;

  const kok = yuk.wbs.find(w => w.kok);
  const cocuk = new Map();
  for (const w of yuk.wbs) { if (!cocuk.has(w.ust)) cocuk.set(w.ust, []); cocuk.get(w.ust).push(w.id); }
  const alt = id => [id, ...(cocuk.get(id) || []).flatMap(alt)];
  const wbs = yuk.wbs.filter(w => kok ? w.ust === kok.id : !w.ust).map(w => {
    const ids = new Set(alt(w.id));
    const L = normal(A.filter(a => ids.has(a.w)));
    const t = L.reduce((s, a) => s + agirlik(a), 0);
    return {
      kod: w.kod, ad: w.ad, aktivite: L.length,
      ilerleme: t ? yuvarla(L.reduce((s, a) => s + agirlik(a) * (a.pct || 0) / 100, 0) / t * 100) : null,
      planli: t && dd && yuk.tabanId ? yuvarla(L.reduce((s, a) => s + agirlik(a) * oran(a.bs, a.bf, dd), 0) / t * 100) : null
    };
  }).filter(w => w.aktivite);

  return {
    proje: { id: yuk.proje.id, kod: yuk.proje.kod, ad: yuk.proje.ad, veriTarihi: yuk.proje.veriTarihi, tabanProjeId: yuk.tabanId },
    aktivite: A.length, iliski: yuk.iliskiler.length,
    durum: { baslamadi: say('TK_NotStart'), devamEdiyor: say('TK_Active'), tamamlandi: say('TK_Complete') },
    ilerlemeYuzde: yuvarla(ilerleme), tabanPlanliYuzde: yuvarla(planli),
    tahminiBitis: bitis, tabanBitis,
    bitisSapmasiGun: bitis && tabanBitis ? Math.round(gun(tabanBitis) - gun(bitis)) : null,
    kritikAcik: A.filter(a => a.kr).length,
    negatifBolluk: A.filter(a => a.st !== 'TK_Complete' && a.tf != null && a.tf < 0).length,
    wbs
  };
}

function kayanlar(yuk, limit = 25) {
  return yuk.aktiviteler.filter(a => a.bf && a.bit && a.tur !== 'TT_LOE')
    .map(a => ({ kod: a.kod, ad: a.ad, durum: a.st, tabanBitis: a.bf, guncelBitis: a.bit, sapmaGun: Math.round(gun(a.bf) - gun(a.bit)), kritik: a.kr }))
    .filter(x => x.sapmaGun < 0).sort((x, y) => x.sapmaGun - y.sapmaGun).slice(0, limit);
}

function onumuzdeki(yuk, gunSayisi = 30) {
  const dd = gun(yuk.proje.veriTarihi);
  if (!dd) return [];
  const son = dd + gunSayisi;
  const L = [];
  for (const a of yuk.aktiviteler) {
    if (a.st === 'TK_Complete') continue;
    if (a.st === 'TK_NotStart' && a.bas && gun(a.bas) >= dd && gun(a.bas) <= son) L.push({ olay: 'baslayacak', tarih: a.bas, kod: a.kod, ad: a.ad, bolluk: a.tf, kritik: a.kr });
    if (a.bit && gun(a.bit) >= dd && gun(a.bit) <= son) L.push({ olay: 'bitecek', tarih: a.bit, kod: a.kod, ad: a.ad, bolluk: a.tf, kritik: a.kr });
  }
  return L.sort((x, y) => x.tarih.localeCompare(y.tarih));
}

/**
 * Ilerleme egrisi (S-egrisi): sure agirlikli kumulatif yuzde.
 * taban = taban plan tarihlerine gore planli, guncel = guncel plan, fiili = veri tarihine kadar gerceklesen.
 */
function ilerlemeEgrisi(yuk, nokta = 48) {
  const A = normal(yuk.aktiviteler);
  let mn = Infinity, mx = -Infinity;
  for (const a of A) for (const t of [a.bas, a.bit, a.bs, a.bf]) if (t) { const g = gun(t); if (g < mn) mn = g; if (g > mx) mx = g; }
  if (!Number.isFinite(mn) || mx <= mn) return { noktalar: [], veriTarihi: yuk.proje.veriTarihi };
  const top = A.reduce((s, a) => s + agirlik(a), 0) || 1;
  const dd = gun(yuk.proje.veriTarihi);
  const tabanVar = A.some(a => a.bs && a.bf);
  const iso = g => new Date(g * 864e5).toISOString().slice(0, 10);
  const noktalar = [];
  for (let i = 0; i <= nokta; i++) {
    const t = mn + (mx - mn) * i / nokta;
    const guncel = A.reduce((s, a) => s + agirlik(a) * (a.st === 'TK_Complete' ? oran(a.as || a.bas, a.af || a.bit, t) : oran(a.bas, a.bit, t)), 0) / top * 100;
    const taban = tabanVar ? A.reduce((s, a) => s + agirlik(a) * oran(a.bs, a.bf, t), 0) / top * 100 : null;
    let fiili = null;
    if (dd && t <= dd + 1e-9) {
      fiili = A.reduce((s, a) => {
        if (a.st === 'TK_NotStart' || (!a.as && !a.af)) return s;
        const son = a.st === 'TK_Complete' ? (a.af || a.as) : iso(dd) + ' 00:00';
        return s + agirlik(a) * (a.pct || 0) / 100 * oran(a.as || a.af, son, t);
      }, 0) / top * 100;
    }
    noktalar.push({ tarih: iso(t), taban: yuvarla(taban), guncel: yuvarla(guncel), fiili: yuvarla(fiili) });
  }
  return { noktalar, veriTarihi: yuk.proje.veriTarihi, tabanVar };
}

/** Acik kritik aktiviteler, baslangica gore sirali. */
function kritikler(yuk, limit = 200) {
  const W = new Map(yuk.wbs.map(w => [w.id, w]));
  const yol = id => { const p = []; let w = W.get(id), g = 0; while (w && !w.kok && g++ < 50) { p.unshift(w.kod); w = W.get(w.ust); } return p.join('.'); };
  return yuk.aktiviteler.filter(a => a.kr && a.st !== 'TK_Complete' && a.tur !== 'TT_LOE')
    .sort((x, y) => (x.bas || '').localeCompare(y.bas || '') || (x.bit || '').localeCompare(y.bit || ''))
    .slice(0, limit)
    .map(a => ({ kod: a.kod, ad: a.ad, wbs: yol(a.w), durum: a.st, baslangic: a.bas, bitis: a.bit, kalanGun: a.rd, toplamBolluk: a.tf, tabanBitis: a.bf || null }));
}

module.exports = { projeOzeti, kayanlar, onumuzdeki, ilerlemeEgrisi, kritikler };

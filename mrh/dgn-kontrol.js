'use strict';
/*
 * MRH P6 Studio - Plan Sagligi
 * Proje yuku (projeYukle ciktisi) uzerinde calisan 15 kontrol.
 * (c) Merih Dogan
 */

const KATI_KISIT = new Set(['CS_MSO', 'CS_MEO', 'CS_MANDSTART', 'CS_MANDFIN']);
const ESIK_GUN = 44;

function planSagligi(yuk) {
  const { aktiviteler: A, iliskiler: R, proje } = yuk;
  const dd = proje.veriTarihi;
  const acik = A.filter(a => a.st !== 'TK_Complete' && a.tur !== 'TT_LOE' && a.tur !== 'TT_WBS');
  const N = acik.length;
  const byId = new Map(A.map(a => [a.id, a]));
  const onc = new Map(), ard = new Map();
  for (const r of R) {
    if (!onc.has(r.ardil)) onc.set(r.ardil, []);
    onc.get(r.ardil).push(r);
    if (!ard.has(r.oncul)) ard.set(r.oncul, []);
    ard.get(r.oncul).push(r);
  }
  const acikR = R.filter(r => byId.get(r.ardil)?.st !== 'TK_Complete');
  const K = [];
  const ekle = (kod, ad, aciklama, idler, payda, esikYuzde, tip = 'oran') => {
    const deger = idler.length;
    const oran = payda > 0 ? deger / payda * 100 : 0;
    let durum;
    if (tip === 'bilgi') durum = 'bilgi';
    else if (tip === 'sifir') durum = deger === 0 ? 'gecti' : 'kaldi';
    else durum = oran <= esikYuzde ? 'gecti' : 'kaldi';
    K.push({ kod, ad, aciklama, deger, payda, oran: Math.round(oran * 10) / 10, esik: tip === 'sifir' ? 0 : esikYuzde, tip, durum, idler: idler.slice(0, 5000) });
  };

  // 1 Eksik mantik
  const eksik = acik.filter(a => !(onc.get(a.id) || []).length || !(ard.get(a.id) || []).length).map(a => a.id);
  ekle('mantik', 'Eksik mantık', 'Öncülü ya da ardılı olmayan açık aktiviteler (açık uçlar). Proje başı ve sonu kilometre taşları için 1-2 tane normaldir.', eksik, N, 5);
  // 2 Negatif gecikme
  const oncu = acikR.filter(r => r.gecikme < 0);
  ekle('oncu', 'Negatif gecikme (lead)', 'Gecikmesi sıfırın altında olan ilişkiler; mantığı gizler, kullanılmamalı.', oncu.map(r => r.ardil), acikR.length, 0, 'sifir');
  // 3 Pozitif gecikme
  const gecikme = acikR.filter(r => r.gecikme > 0);
  ekle('gecikme', 'Pozitif gecikme (lag)', 'Gecikme içeren ilişkiler. İlişkilerin %5\'ini geçmemesi önerilir.', gecikme.map(r => r.ardil), acikR.length, 5);
  // 4 Iliski turleri
  const fsDisi = acikR.filter(r => r.tur !== 'PR_FS');
  ekle('iliskiTuru', 'FS dışı ilişkiler', 'Bitiş-Başlangıç (FS) dışındaki ilişkiler. FS oranının %90 ve üzeri olması önerilir.', fsDisi.map(r => r.ardil), acikR.length, 10);
  // 5 SF
  const sf = acikR.filter(r => r.tur === 'PR_SF');
  ekle('sf', 'Başlangıç-Bitiş (SF) ilişkileri', 'SF ilişkileri ters mantık kurar ve neredeyse hiç gerekmez.', sf.map(r => r.ardil), acikR.length, 0, 'sifir');
  // 6 Kati kisitlar
  const kisit = acik.filter(a => KATI_KISIT.has(a.ks)).map(a => a.id);
  ekle('kisit', 'Katı kısıtlar', 'Zorunlu ve "tarihinde" kısıtları CPM mantığını bozar. Açık aktivitelerin %5\'ini geçmemeli.', kisit, N, 5);
  // 7 Yuksek bolluk
  const yuksek = acik.filter(a => a.tf != null && a.tf > ESIK_GUN).map(a => a.id);
  ekle('bolluk', `Yüksek toplam bolluk (>${ESIK_GUN} gün)`, 'Aşırı bolluk genellikle eksik ardıl ilişkisine işarettir.', yuksek, N, 5);
  // 8 Negatif bolluk
  const neg = acik.filter(a => a.tf != null && a.tf < 0).map(a => a.id);
  ekle('negatif', 'Negatif bolluk', 'Negatif toplam bolluk projenin bir kısıtı karşılayamadığını gösterir.', neg, N, 0, 'sifir');
  // 9 Uzun sure
  const uzun = acik.filter(a => a.tur !== 'TT_Mile' && a.tur !== 'TT_FinMile' && (a.rd ?? a.od ?? 0) > ESIK_GUN).map(a => a.id);
  ekle('uzun', `Uzun süreli aktiviteler (>${ESIK_GUN} gün)`, 'Uzun aktiviteler bölünerek izlenebilir hale getirilmeli.', uzun, N, 5);
  // 10 Gecersiz tarihler
  let gecersiz = [];
  if (dd) {
    gecersiz = A.filter(a => (a.as && a.as > dd) || (a.af && a.af > dd) ||
      (a.st === 'TK_NotStart' && a.bas && a.bas < dd) || (a.st === 'TK_Active' && a.bit && a.bit < dd)).map(a => a.id);
  }
  ekle('gecersiz', 'Geçersiz tarihler', 'Veri tarihinden sonraki fiili tarihler ya da veri tarihinden önce kalan tahmini tarihler. Genellikle F9 yapılmamıştır.', gecersiz, A.length, 0, 'sifir');
  // 11 Durum tutarsizligi
  const tutarsiz = A.filter(a =>
    (a.st === 'TK_Complete' && (a.rd || 0) > 0) ||
    (a.st === 'TK_Active' && !a.as) ||
    (a.st === 'TK_NotStart' && (a.as || a.af)) ||
    (a.st !== 'TK_Complete' && a.pt === 'CP_Phys' && a.pct >= 100)).map(a => a.id);
  ekle('durum', 'Durum tutarsızlıkları', 'Tamamlandı ama kalan süreli, devam ediyor ama fiili başlangıçsız, ya da %100 olup tamamlanmamış aktiviteler.', tutarsiz, A.length, 0, 'sifir');
  // 12 Kopya iliski
  const cift = new Map();
  for (const r of R) { const k = r.oncul + '>' + r.ardil; cift.set(k, (cift.get(k) || []).concat(r)); }
  const kopya = [...cift.values()].filter(x => x.length > 1).flat().map(r => r.ardil);
  ekle('kopya', 'Aynı iki aktivite arasında birden fazla ilişki', 'Aynı öncül-ardıl çifti arasında birden fazla ilişki (örneğin SS ve FF birlikte). Kasıtlı değilse temizlenmeli.', [...new Set(kopya)], R.length, 0, 'sifir');
  // 13 Dongu
  const dongu = donguBul(A, ard);
  ekle('dongu', 'Döngüler', 'Kendine geri dönen mantık zinciri. P6 hesaplamasını engeller.', dongu, A.length, 0, 'sifir');
  // 14 Gereksiz FS
  const gereksiz = gereksizFS(R);
  ekle('gereksiz', 'Gereksiz FS ilişkileri', 'Başka bir FS zinciriyle zaten sağlanan doğrudan FS ilişkileri (A->B varken A->C->B). Sadeleştirilebilir.', gereksiz.map(r => r.ardil), R.length, 5, 'bilgi');
  // 15 Kritik yol
  const kritik = acik.filter(a => a.kr).map(a => a.id);
  K.push({ kod: 'kritik', ad: 'Kritik aktiviteler', aciklama: 'Toplam bolluğu sıfır ya da altı olan (veya en uzun yoldaki) açık aktiviteler.', deger: kritik.length,
    payda: N, oran: N ? Math.round(kritik.length / N * 1000) / 10 : 0, esik: null, tip: 'bilgi',
    durum: N && !kritik.length ? 'kaldi' : 'bilgi', idler: kritik });

  const puanli = K.filter(k => k.durum !== 'bilgi');
  const gecen = puanli.filter(k => k.durum === 'gecti').length;
  return { puan: puanli.length ? Math.round(gecen / puanli.length * 100) : 100, gecen, toplam: puanli.length, acik: N, kontroller: K, veriTarihi: dd };
}

function donguBul(A, ard) {
  // Tarjan - guclu bagli bilesenler (yinelemesiz)
  let idx = 0;
  const no = new Map(), low = new Map(), yiginda = new Set(), yigin = [], sonuc = [];
  for (const a of A) {
    if (no.has(a.id)) continue;
    const is = [[a.id, 0]];
    no.set(a.id, idx); low.set(a.id, idx); idx++; yigin.push(a.id); yiginda.add(a.id);
    while (is.length) {
      const ust = is[is.length - 1];
      const [v, i] = ust;
      const kom = (ard.get(v) || []).map(r => r.ardil);
      if (i < kom.length) {
        ust[1]++;
        const w = kom[i];
        if (!no.has(w)) { no.set(w, idx); low.set(w, idx); idx++; yigin.push(w); yiginda.add(w); is.push([w, 0]); }
        else if (yiginda.has(w)) low.set(v, Math.min(low.get(v), no.get(w)));
      } else {
        is.pop();
        if (is.length) { const u = is[is.length - 1][0]; low.set(u, Math.min(low.get(u), low.get(v))); }
        if (low.get(v) === no.get(v)) {
          const bilesen = [];
          let w;
          do { w = yigin.pop(); yiginda.delete(w); bilesen.push(w); } while (w !== v);
          if (bilesen.length > 1) sonuc.push(...bilesen);
        }
      }
    }
  }
  return sonuc;
}

function gereksizFS(R) {
  if (R.length > 30000) return [];
  const fs = R.filter(r => r.tur === 'PR_FS' && !r.gecikme);
  const kom = new Map();
  for (const r of fs) { if (!kom.has(r.oncul)) kom.set(r.oncul, []); kom.get(r.oncul).push(r.ardil); }
  const sonuc = [];
  let butce = 400000;
  for (const r of fs) {
    // r.oncul'dan, dogrudan kenari kullanmadan r.ardil'a ulasilabiliyor mu?
    const gorulen = new Set([r.oncul]);
    const yigin = (kom.get(r.oncul) || []).filter(x => x !== r.ardil);
    let bulundu = false;
    while (yigin.length && butce-- > 0) {
      const x = yigin.pop();
      if (x === r.ardil) { bulundu = true; break; }
      if (gorulen.has(x)) continue;
      gorulen.add(x);
      for (const y of kom.get(x) || []) if (!gorulen.has(y)) yigin.push(y);
    }
    if (bulundu) sonuc.push(r);
    if (butce <= 0) break;
  }
  return sonuc;
}

module.exports = { planSagligi };

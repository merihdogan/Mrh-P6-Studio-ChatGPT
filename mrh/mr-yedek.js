'use strict';
/*
 * MRH P6 Studio - yedekleme
 * Yedekler veritabaninin yanindaki "mrh_yedekler\<ad>" klasorune gzip olarak yazilir.
 * (c) Merih Dogan
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { MrhHata } = require('./dgn-p6');

const SAKLA = Number(process.env.MRH_YEDEK_SAKLA || 20);
const iki = n => String(n).padStart(2, '0');

function klasor(dbDosya) {
  const ad = path.basename(dbDosya).replace(/\.[^.]+$/, '');
  return path.join(path.dirname(dbDosya), 'mrh_yedekler', ad);
}

function damga() {
  const d = new Date();
  return `${d.getFullYear()}${iki(d.getMonth() + 1)}${iki(d.getDate())}_${iki(d.getHours())}${iki(d.getMinutes())}${iki(d.getSeconds())}`;
}

async function al(p6, neden = 'otomatik') {
  const dir = klasor(p6.dosya);
  fs.mkdirSync(dir, { recursive: true });
  const temiz = String(neden).replace(/[^a-z0-9-]+/gi, '-').slice(0, 30) || 'yedek';
  const ad = `${path.basename(p6.dosya).replace(/\.[^.]+$/, '')}_${damga()}_${temiz}.db.gz`;
  const gecici = path.join(dir, `.gecici_${process.pid}_${Date.now()}.db`);
  try {
    // VACUUM INTO acik baglanti varken bile tutarli bir kopya uretir
    p6.db.exec(`VACUUM INTO '${gecici.replace(/'/g, "''")}'`);
    await pipeline(fs.createReadStream(gecici), zlib.createGzip({ level: 6 }), fs.createWriteStream(path.join(dir, ad)));
  } catch (e) {
    throw new MrhHata('Yedek alınamadı: ' + e.message, 500);
  } finally {
    fs.rmSync(gecici, { force: true });
  }
  budama(dir);
  return { ad, boyut: fs.statSync(path.join(dir, ad)).size };
}

function liste(dbDosya) {
  const dir = klasor(dbDosya);
  if (!fs.existsSync(dir)) return { klasor: dir, yedekler: [] };
  const yedekler = fs.readdirSync(dir).filter(f => /\.db(\.gz)?$/i.test(f) && !f.startsWith('.')).map(f => {
    const st = fs.statSync(path.join(dir, f));
    return { ad: f, boyut: st.size, zaman: st.mtime.toISOString() };
  }).sort((a, b) => b.zaman.localeCompare(a.zaman));
  return { klasor: dir, yedekler };
}

function budama(dir) {
  const l = fs.readdirSync(dir).filter(f => /\.db(\.gz)?$/i.test(f) && !f.startsWith('.'))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const x of l.slice(SAKLA)) fs.rmSync(path.join(dir, x.f), { force: true });
}

/** Yedegi gecici dosyaya acar; cagiran baglantiyi kapatip tasir. */
async function ac(dbDosya, ad) {
  if (!/^[^\\/]+\.db(\.gz)?$/i.test(ad)) throw new MrhHata('Geçersiz yedek adı');
  const kaynak = path.join(klasor(dbDosya), ad);
  if (!fs.existsSync(kaynak)) throw new MrhHata('Yedek bulunamadı', 404);
  const hedef = dbDosya + '.mrh-geri';
  if (/\.gz$/i.test(ad)) await pipeline(fs.createReadStream(kaynak), zlib.createGunzip(), fs.createWriteStream(hedef));
  else fs.copyFileSync(kaynak, hedef);
  const bas = Buffer.alloc(16);
  const fd = fs.openSync(hedef, 'r'); fs.readSync(fd, bas, 0, 16, 0); fs.closeSync(fd);
  if (bas.toString('latin1') !== 'SQLite format 3\u0000') { fs.rmSync(hedef, { force: true }); throw new MrhHata('Yedek dosyası bozuk'); }
  return hedef;
}

function yerlestir(dbDosya, gecici) {
  const eski = dbDosya + '.mrh-eski';
  fs.rmSync(eski, { force: true });
  try { fs.renameSync(dbDosya, eski); }
  catch (e) { fs.rmSync(gecici, { force: true }); throw new MrhHata('Veritabanı dosyası başka bir program tarafından kullanılıyor. P6\'yi kapatıp tekrar deneyin.', 409); }
  try { fs.renameSync(gecici, dbDosya); }
  catch (e) { fs.renameSync(eski, dbDosya); throw new MrhHata('Geri yükleme tamamlanamadı: ' + e.message, 500); }
  for (const ek of ['-journal', '-wal', '-shm']) fs.rmSync(dbDosya + ek, { force: true });
  fs.rmSync(eski, { force: true });
}

module.exports = { al, liste, ac, yerlestir, klasor };

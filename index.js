const https = require('https');
const http = require('http');

// ── Config ──────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN  || '8780430108:AAHysfwi4_XvOzW-HEs7QZWumon4V8xfiPs';
const CHAT_ID    = process.env.CHAT_ID    || '1475632521';
const THRESHOLD  = parseFloat(process.env.THRESHOLD || '3');
const INTERVAL   = parseInt(process.env.INTERVAL    || '120000'); // 2 dəq

// Stablecoin siyahısı
const STABLE_IDS = [
  'tether','usd-coin','dai','binance-usd','true-usd','frax','usdd',
  'pax-dollar','neutrino','fei-usd','liquity-usd','vai','usdn',
  'united-stables','tether-eurt','stasis-eurs','celo-dollar','reserve'
];

let prevVolumes  = {};
let sentAlerts   = {};
let checkCount   = 0;

// ── Helpers ─────────────────────────────────────────────
function fmt(v) {
  if (v >= 1e9) return '$' + (v/1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v/1e3).toFixed(0) + 'K';
  return '$' + v.toFixed(0);
}

function fmtPrice(p) {
  if (!p) return '—';
  if (p >= 1000) return '$' + p.toLocaleString('en', {maximumFractionDigits:2});
  if (p >= 1)    return '$' + p.toFixed(3);
  if (p >= 0.01) return '$' + p.toFixed(5);
  return '$' + p.toFixed(8);
}

function isStable(coin) {
  if (STABLE_IDS.includes(coin.id)) return true;
  const p = coin.current_price || 0;
  return p >= 0.95 && p <= 1.05;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CryptoRadar/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const r = JSON.parse(d);
        if (!r.ok) console.error('Telegram xətası:', r.description);
        resolve(r);
      });
    });
    req.on('error', (e) => { console.error('Telegram bağlantı xətası:', e); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Main Check ───────────────────────────────────────────
async function checkVolumes() {
  checkCount++;
  console.log(`[${new Date().toISOString()}] Yoxlama #${checkCount} başladı...`);

  try {
    const url = 'https://api.coingecko.com/api/v3/coins/markets' +
      '?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false';

    const data = await fetchJSON(url);
    const now = Date.now();
    const newPrev = {};
    const signals = [];

    for (const c of data) {
      const vol = c.total_volume || 0;
      newPrev[c.id] = vol;

      if (isStable(c)) continue;
      if (vol < 500000) continue; // Çox kiçik həcmli coinləri keç

      let ratio = 1;
      if (prevVolumes[c.id] && prevVolumes[c.id] > 0) {
        ratio = vol / prevVolumes[c.id];
        if (ratio > 50) ratio = 50;
      } else {
        continue; // İlk yükləmədə bildiriş göndərmə
      }

      if (ratio >= THRESHOLD) {
        // Eyni coindən 30 dəqiqədə bir bildiriş
        if (sentAlerts[c.id] && (now - sentAlerts[c.id]) < 30 * 60 * 1000) continue;
        signals.push({ ...c, ratio });
      }
    }

    prevVolumes = newPrev;

    // Ən güclü 3 siqnalı göndər
    signals.sort((a,b) => b.ratio - a.ratio);
    const top = signals.slice(0, 3);

    for (const c of top) {
      sentAlerts[c.id] = now;

      const emoji  = c.ratio >= 5 ? '🔥' : c.ratio >= 3 ? '⚡' : '📊';
      const chEmoji = (c.price_change_percentage_24h || 0) >= 0 ? '📈' : '📉';
      const sign   = (c.price_change_percentage_24h || 0) >= 0 ? '+' : '';

      const msg =
        `${emoji} <b>HƏCM SİQNALI: ${(c.symbol||'').toUpperCase()}</b>\n\n` +
        `💰 Qiymət: ${fmtPrice(c.current_price)}\n` +
        `${chEmoji} 24s Dəyişim: ${sign}${(c.price_change_percentage_24h||0).toFixed(2)}%\n` +
        `📦 Həcm: ${fmt(c.total_volume)}\n` +
        `🚀 Artım: <b>${c.ratio.toFixed(1)}x</b>\n\n` +
        `⏰ ${new Date().toLocaleTimeString('az-AZ', {timeZone:'Asia/Baku'})}`;

      await sendTelegram(msg);
      console.log(`  → Göndərildi: ${c.symbol} (${c.ratio.toFixed(1)}x)`);

      await new Promise(r => setTimeout(r, 500));
    }

    if (top.length === 0) {
      console.log(`  → Siqnal yoxdur (threshold: ${THRESHOLD}x)`);
    }

  } catch(err) {
    console.error('Xəta:', err.message);
    if (err.message && err.message.includes('429')) {
      console.log('Rate limit — 3 dəq gözlənilir...');
      await new Promise(r => setTimeout(r, 180000));
    }
  }
}

// ── HTTP Server (Railway üçün lazımdır) ──────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end(`HəcmRadar aktiv\nYoxlama sayı: ${checkCount}\nThreshold: ${THRESHOLD}x`);
}).listen(PORT, () => {
  console.log(`Server ${PORT} portunda işləyir`);
});

// ── Start ────────────────────────────────────────────────
console.log('🚀 HəcmRadar başladı');
console.log(`   Threshold: ${THRESHOLD}x`);
console.log(`   Interval: ${INTERVAL/1000}s`);
console.log(`   Chat ID: ${CHAT_ID}`);

// İlk yükləmə — məlumat topla, bildiriş göndərmə
checkVolumes().then(() => {
  console.log('İlk yükləmə tamamlandı — növbəti yoxlamadan bildiriş göndəriləcək');
  setInterval(checkVolumes, INTERVAL);
});

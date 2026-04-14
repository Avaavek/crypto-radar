const https = require('https');
const http  = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN || '8780430108:AAHysfwi4_XvOzW-HEs7QZWumon4V8xfiPs';
const CHAT_ID   = process.env.CHAT_ID   || '1475632521';
const INTERVAL  = 120000;

const STABLE_IDS = [
  'tether','usd-coin','dai','binance-usd','true-usd','frax','usdd',
  'pax-dollar','neutrino','fei-usd','liquity-usd','vai','usdn',
  'united-stables','tether-eurt','stasis-eurs','celo-dollar','reserve',
  'terrausd','husd','eurs','sbtc','renbtc','steth','wbtc','weth'
];

let prevData      = {};
let sentAlerts    = {};
let checkCount    = 0;
let totalSignals  = 0;
let correctCalls  = 0;
let signalHistory = [];

function fmt(v) {
  if (!v) return '$0';
  if (v >= 1e9) return '$' + (v/1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v/1e3).toFixed(0) + 'K';
  return '$' + v.toFixed(0);
}

function fmtPrice(p) {
  if (!p && p !== 0) return '—';
  if (p >= 1000) return '$' + p.toLocaleString('en', {maximumFractionDigits:2});
  if (p >= 1)    return '$' + p.toFixed(3);
  if (p >= 0.01) return '$' + p.toFixed(5);
  return '$' + p.toFixed(8);
}

function isStable(coin) {
  if (STABLE_IDS.includes(coin.id)) return true;
  const p = coin.current_price || 0;
  return (p >= 0.95 && p <= 1.05);
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CryptoRadar/2.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse xetasi')); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function calculateScore(coin, prev) {
  let score = 0;
  const reasons = [];
  const vol       = coin.total_volume || 0;
  const price     = coin.current_price || 0;
  const change    = coin.price_change_percentage_24h || 0;
  const cap       = coin.market_cap || 0;
  const rank      = coin.market_cap_rank || 999;
  const prevVol   = prev.vol || 0;
  const prevPrice = prev.price || 0;

  const volRatio = prevVol > 0 ? vol / prevVol : 1;
  if      (volRatio >= 8) { score += 4; reasons.push('Hecm ' + volRatio.toFixed(1) + 'x 🔥'); }
  else if (volRatio >= 5) { score += 3; reasons.push('Hecm ' + volRatio.toFixed(1) + 'x ⚡'); }
  else if (volRatio >= 3) { score += 2; reasons.push('Hecm ' + volRatio.toFixed(1) + 'x ↑'); }
  else if (volRatio >= 2) { score += 1; reasons.push('Hecm ' + volRatio.toFixed(1) + 'x'); }
  else return null;

  if      (change >= 15) { score += 3; reasons.push('+' + change.toFixed(1) + '% 🚀'); }
  else if (change >= 8)  { score += 2; reasons.push('+' + change.toFixed(1) + '% ↑'); }
  else if (change >= 3)  { score += 1; reasons.push('+' + change.toFixed(1) + '%'); }
  else if (change < -5)  { score -= 2; reasons.push(change.toFixed(1) + '% ↓'); }

  if (prevPrice > 0) {
    const priceMove = (price - prevPrice) / prevPrice * 100;
    if      (priceMove >= 3)  { score += 2; reasons.push('Son 2deq: +' + priceMove.toFixed(1) + '%'); }
    else if (priceMove >= 1)  { score += 1; reasons.push('Momentum ↑'); }
    else if (priceMove <= -3) { score -= 1; }
  }

  if      (cap < 50e6)  { score += 2; reasons.push('Kicik cap 💎'); }
  else if (cap < 200e6) { score += 1; reasons.push('Mid cap'); }
  else if (cap > 5e9)   { score -= 1; }

  if (cap > 0) {
    const vcr = vol / cap;
    if      (vcr >= 0.5) { score += 2; reasons.push('Hecm/Cap: ' + (vcr*100).toFixed(0) + '% 🔥'); }
    else if (vcr >= 0.2) { score += 1; reasons.push('Hecm/Cap: ' + (vcr*100).toFixed(0) + '%'); }
  }

  if (rank >= 50 && rank <= 200) { score += 1; reasons.push('Rank #' + rank); }

  return { score, reasons, volRatio };
}

async function checkPastSignals(currentCoins) {
  const now = Date.now();
  const toCheck = signalHistory.filter(s =>
    !s.checked &&
    (now - s.timestamp) >= 30*60*1000 &&
    (now - s.timestamp) <= 35*60*1000
  );
  for (const signal of toCheck) {
    const coin = currentCoins.find(c => c.id === signal.id);
    if (!coin) continue;
    signal.checked = true;
    const priceDiff = ((coin.current_price - signal.price) / signal.price) * 100;
    const correct = priceDiff > 0;
    totalSignals++;
    if (correct) correctCalls++;
    signal.result = { priceDiff, correct };
    console.log('  Backtest: ' + signal.symbol + ' -> ' + (correct ? 'DURUST' : 'SEHV') + ' ' + priceDiff.toFixed(2) + '%');
  }
}

function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: '/bot' + BOT_TOKEN + '/sendMessage',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { const r = JSON.parse(d); if (!r.ok) console.error('Telegram xetasi:', r.description); } catch(e) {} resolve(); });
    });
    req.on('error', (e) => { console.error('Telegram xetasi:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

async function checkVolumes() {
  checkCount++;
  console.log('[' + new Date().toISOString() + '] Yoxlama #' + checkCount);
  try {
    const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false';
    const data = await fetchJSON(url);
    const now  = Date.now();
    const newPrev = {};
    const signals = [];

    await checkPastSignals(data);

    for (const c of data) {
      newPrev[c.id] = { vol: c.total_volume || 0, price: c.current_price || 0, ts: now };
      if (isStable(c)) continue;
      if ((c.total_volume || 0) < 300000) continue;
      if (!prevData[c.id]) continue;
      const result = calculateScore(c, prevData[c.id]);
      if (!result) continue;
      const { score, reasons, volRatio } = result;
      if (score < 6) continue;
      if (sentAlerts[c.id] && (now - sentAlerts[c.id]) < 45*60*1000) continue;
      signals.push({ ...c, score, reasons, volRatio });
    }

    prevData = newPrev;
    signals.sort((a, b) => b.score - a.score);
    const top = signals.slice(0, 2);

    for (const c of top) {
      sentAlerts[c.id] = now;
      signalHistory.push({ id: c.id, symbol: c.symbol.toUpperCase(), price: c.current_price, score: c.score, timestamp: now, checked: false, result: null });
      if (signalHistory.length > 200) signalHistory.shift();

      const accuracy = totalSignals > 0 ? ((correctCalls / totalSignals) * 100).toFixed(1) + '%' : 'Hesablanir...';
      const level = c.score >= 10 ? '🔥 GUCLU SIQNAL' : c.score >= 8 ? '⚡ YAXSI SIQNAL' : '📊 SIQNAL';
      const change = c.price_change_percentage_24h || 0;
      const changeEmoji = change >= 0 ? '📈' : '📉';
      const sign = change >= 0 ? '+' : '';

      const msg = level + ': <b>' + c.symbol.toUpperCase() + '</b>\n' +
        '────────────────────────────\n' +
        '💰 Qiymet: <b>' + fmtPrice(c.current_price) + '</b>\n' +
        changeEmoji + ' 24s: ' + sign + change.toFixed(2) + '%\n' +
        '📦 Hecm: ' + fmt(c.total_volume) + '\n' +
        '🚀 Hecm artimi: <b>' + c.volRatio.toFixed(1) + 'x</b>\n' +
        '⭐ Xal: <b>' + c.score + '/13</b>\n' +
        '────────────────────────────\n' +
        '📋 Sebbler:\n' + c.reasons.map(r => '  • ' + r).join('\n') + '\n' +
        '────────────────────────────\n' +
        '🎯 Sistem deqiqliyi: ' + accuracy + '\n' +
        '⏰ ' + new Date().toLocaleTimeString('az-AZ', {timeZone:'Asia/Baku'});

      await sendTelegram(msg);
      console.log('  -> Gonderildi: ' + c.symbol.toUpperCase() + ' (xal: ' + c.score + ')');
      await sleep(600);
    }

    if (top.length === 0) console.log('  -> Yuksek xalli siqnal yoxdur');

    if (checkCount % 20 === 0 && totalSignals > 0) {
      const acc = ((correctCalls / totalSignals) * 100).toFixed(1);
      await sendTelegram('📊 <b>Sistem Statistikasi</b>\n────────────────────────────\n✅ Duzgun siqnal: ' + correctCalls + '/' + totalSignals + '\n🎯 Deqiqlik: <b>' + acc + '%</b>\n🔄 Yoxlama sayi: ' + checkCount + '\n⏰ ' + new Date().toLocaleTimeString('az-AZ', {timeZone:'Asia/Baku'}));
    }

  } catch(err) {
    console.error('Xeta:', err.message);
    if (err.message.includes('429') || err.message.includes('rate')) { await sleep(180000); }
  }
}

function startTelegramPolling() {
  let lastUpdateId = 0;
  async function poll() {
    try {
      const url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/getUpdates?offset=' + (lastUpdateId + 1) + '&timeout=30';
      const data = await fetchJSON(url);
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          lastUpdateId = update.update_id;
          const text = update.message && update.message.text;
          if (!text) continue;
          if (text === '/status' || text === '/start') {
            const acc = totalSignals > 0 ? ((correctCalls / totalSignals) * 100).toFixed(1) + '%' : 'Hele yoxdur';
            await sendTelegram('✅ <b>HecmRadar Aktiv</b>\n\n🔄 Yoxlama sayi: ' + checkCount + '\n📊 Gonderilen siqnal: ' + signalHistory.length + '\n🎯 Deqiqlik: ' + acc + '\n⏱ Interval: 2 deqiqe\n\nSistem avtomatik isleyir.');
          }
        }
      }
    } catch(e) {}
    setTimeout(poll, 3000);
  }
  poll();
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  const acc = totalSignals > 0 ? ((correctCalls / totalSignals) * 100).toFixed(1) + '%' : 'N/A';
  res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
  res.end('HecmRadar v2 — Aktiv\nYoxlama: #' + checkCount + '\nSiqnal: ' + signalHistory.length + '\nDeqiqlik: ' + acc + '\n');
}).listen(PORT, () => console.log('Server port ' + PORT + '-da isleyir'));

async function start() {
  console.log('HecmRadar v2 basladi');
  await sendTelegram('🚀 <b>HecmRadar v2 Aktiv!</b>\n\nSistem basladi. Her 2 deqiqede 250 coin izlenilir.\n\n<b>Xal sistemi:</b>\n• Hecm artimi (maks 4 xal)\n• Qiymet deyisimi (maks 3 xal)\n• Qiymet momentumu (maks 2 xal)\n• Market cap (maks 2 xal)\n• Hecm/Cap nisbeti (maks 2 xal)\n\nYalniz <b>6+ xal</b> olan siqnallar gonderilir.\n\n/status — sistem veziyyeti');
  await checkVolumes();
  console.log('Ilk yukleme tamamlandi');
  startTelegramPolling();
  setInterval(checkVolumes, INTERVAL);
}

start();

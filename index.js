const https = require('https');
const http  = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN || '8780430108:AAHysfwi4_XvOzW-HEs7QZWumon4V8xfiPs';
const CHAT_ID   = process.env.CHAT_ID   || '1475632521';
const REFRESH_SEC = 120;

const STABLE_IDS = [
  'tether','usd-coin','dai','binance-usd','true-usd','frax','usdd',
  'pax-dollar','neutrino','fei-usd','liquity-usd','vai','usdn',
  'united-stables','tether-eurt','stasis-eurs','celo-dollar','reserve',
  'terrausd','husd','eurs','sbtc','renbtc','steth','wbtc','weth',
  'usdp','gusd','lusd','susd','mim','dola','cusd'
];

let prevData      = {};
let priceHistory  = {};
let sentAlerts    = {};
let checkCount    = 0;
let totalSignals  = 0;
let correctCalls  = 0;
let signalHistory = [];
const processedIds = new Set();

function fmt(v) {
  if (!v) return '$0';
  if (v >= 1e9) return '$' + (v/1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v/1e3).toFixed(0) + 'K';
  return '$' + v.toFixed(0);
}

function fmtPrice(p) {
  if (!p && p !== 0) return '--';
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function calculateRSI(prices) {
  if (prices.length < 5) return null;
  const gains = [], losses = [];
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i-1];
    if (diff >= 0) { gains.push(diff); losses.push(0); }
    else           { gains.push(0); losses.push(Math.abs(diff)); }
  }
  const avgGain = gains.reduce((a,b) => a+b, 0) / gains.length;
  const avgLoss = losses.reduce((a,b) => a+b, 0) / losses.length;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round(100 - (100 / (1 + rs)));
}

function detectBreakout(coin, prev) {
  const price   = coin.current_price || 0;
  const high24h = coin.high_24h || 0;
  const low24h  = coin.low_24h  || 0;
  if (!high24h || !low24h) return null;
  const range = high24h - low24h;
  if (range <= 0) return null;
  const position = (price - low24h) / range;
  if (price >= high24h * 0.95) {
    return { type: 'BREAKOUT', position: Math.round(position*100), label: 'Zirve keciyor' };
  }
  if (position < 0.35 && prev.price > 0 && price > prev.price) {
    return { type: 'RECOVERY', position: Math.round(position*100), label: 'Dibden qalxir' };
  }
  return null;
}

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
  if      (volRatio >= 8) { score += 4; reasons.push('Hecm ' + volRatio.toFixed(1) + 'x PARTLAYIS 🔥'); }
  else if (volRatio >= 5) { score += 3; reasons.push('Hecm ' + volRatio.toFixed(1) + 'x guclu ⚡'); }
  else if (volRatio >= 3) { score += 2; reasons.push('Hecm ' + volRatio.toFixed(1) + 'x artti ↑'); }
  else if (volRatio >= 2) { score += 1; reasons.push('Hecm ' + volRatio.toFixed(1) + 'x'); }
  else return null;

  if      (change >= 20) { score += 3; reasons.push('+' + change.toFixed(1) + '% guclu artim 🚀'); }
  else if (change >= 10) { score += 2; reasons.push('+' + change.toFixed(1) + '% artim ↑'); }
  else if (change >= 4)  { score += 1; reasons.push('+' + change.toFixed(1) + '%'); }
  else if (change < -8)  { score -= 2; reasons.push(change.toFixed(1) + '% DUSUR ↓'); }
  else if (change < -3)  { score -= 1; }

  if (prevPrice > 0) {
    const priceMove = (price - prevPrice) / prevPrice * 100;
    if      (priceMove >= 3)  { score += 2; reasons.push('2deqde +' + priceMove.toFixed(2) + '%'); }
    else if (priceMove >= 1)  { score += 1; reasons.push('Momentum artti ↑'); }
    else if (priceMove <= -3) { score -= 1; }
  }

  const prices = priceHistory[coin.id] || [];
  const rsi = calculateRSI(prices);
  if (rsi !== null) {
    if      (rsi < 25) { score += 3; reasons.push('RSI ' + rsi + ' - cox satilmis 💎'); }
    else if (rsi < 35) { score += 2; reasons.push('RSI ' + rsi + ' - satilmis'); }
    else if (rsi < 45) { score += 1; reasons.push('RSI ' + rsi + ' - normal'); }
    else if (rsi > 80) { score -= 2; reasons.push('RSI ' + rsi + ' - cox alinmis ⚠️'); }
    else if (rsi > 70) { score -= 1; reasons.push('RSI ' + rsi + ' - yuksek'); }
  }

  const breakout = detectBreakout(coin, prev);
  if (breakout) {
    if      (breakout.type === 'BREAKOUT') { score += 3; reasons.push('BREAKOUT - ' + breakout.label + ' 🚀'); }
    else if (breakout.type === 'RECOVERY') { score += 2; reasons.push(breakout.label + ' 📈'); }
  }

  if      (cap < 50e6)  { score += 2; reasons.push('Kicik cap - yuksek potensial 💎'); }
  else if (cap < 300e6) { score += 1; reasons.push('Orta cap'); }
  else if (cap > 10e9)  { score -= 1; }

  if (cap > 0) {
    const vcr = vol / cap;
    if      (vcr >= 0.5) { score += 2; reasons.push('Hecm/Cap ' + (vcr*100).toFixed(0) + '% - anormal aktivlik 🔥'); }
    else if (vcr >= 0.2) { score += 1; reasons.push('Hecm/Cap ' + (vcr*100).toFixed(0) + '%'); }
  }

  if (rank >= 51 && rank <= 300) { score += 1; reasons.push('Rank #' + rank); }

  return { score, reasons, volRatio, rsi, breakout };
}

function sendTelegram(text) {
  return new Promise((resolve) => {
    const t = text.length > 4000 ? text.slice(0,4000)+'...' : text;
    const body = JSON.stringify({ chat_id: CHAT_ID, text: t, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: '/bot' + BOT_TOKEN + '/sendMessage',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const r = JSON.parse(d); if (!r.ok) console.error('TG xetasi:', r.description); } catch(e) {}
        resolve();
      });
    });
    req.on('error', (e) => { console.error('TG bag xetasi:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
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
    const correct   = priceDiff > 0;
    totalSignals++;
    if (correct) correctCalls++;
    signal.result = { priceDiff, correct };
    const sign = priceDiff >= 0 ? '+' : '';
    await sendTelegram(
      (correct ? '✅' : '❌') + ' <b>Backtest: ' + signal.symbol + '</b>\n' +
      '30 deq sonraki netice: ' + sign + priceDiff.toFixed(2) + '%\n' +
      'Siqnal xali: ' + signal.score + '/18\n' +
      'Umumi deqiqlik: ' + ((correctCalls/totalSignals)*100).toFixed(1) + '% (' + correctCalls + '/' + totalSignals + ')'
    );
    console.log('Backtest ' + signal.symbol + ': ' + (correct?'DURUST':'SEHV') + ' ' + priceDiff.toFixed(2) + '%');
    await sleep(500);
  }
}

async function fetchData() {
  checkCount++;
  console.log('[' + new Date().toISOString() + '] Yoxlama #' + checkCount);

  try {
    const url = 'https://api.coingecko.com/api/v3/coins/markets' +
      '?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false';

    const data = await fetchJSON(url);
    const now  = Date.now();
    const newPrev = {};
    const signals = [];

    await checkPastSignals(data);

    for (const c of data) {
      const price = c.current_price || 0;
      if (!priceHistory[c.id]) priceHistory[c.id] = [];
      priceHistory[c.id].push(price);
      if (priceHistory[c.id].length > 20) priceHistory[c.id].shift();

      newPrev[c.id] = { vol: c.total_volume||0, price, high24h: c.high_24h||0, low24h: c.low_24h||0, ts: now };

      if (isStable(c)) continue;
      if ((c.total_volume||0) < 200000) continue;
      if (!prevData[c.id]) continue;

      const result = calculateScore(c, prevData[c.id]);
      if (!result) continue;
      const { score, reasons, volRatio, rsi, breakout } = result;
      if (score < 6) continue;
      if (sentAlerts[c.id] && (now - sentAlerts[c.id]) < 45*60*1000) continue;

      signals.push({ ...c, score, reasons, volRatio, rsi, breakout });
    }

    prevData = newPrev;
    signals.sort((a,b) => b.score - a.score);
    const top = signals.slice(0, 3);

    for (const c of top) {
      sentAlerts[c.id] = now;
      signalHistory.push({
        id: c.id, symbol: c.symbol.toUpperCase(),
        price: c.current_price, score: c.score,
        timestamp: now, checked: false, result: null
      });
      if (signalHistory.length > 300) signalHistory.shift();

      const accuracy = totalSignals > 0 ? ((correctCalls/totalSignals)*100).toFixed(1) + '%' : 'Hesablanir';
      const level = c.score >= 13 ? '🔥 GUCLU SIQNAL' : c.score >= 10 ? '⚡ YAXSI SIQNAL' : '📊 SIQNAL';
      const change = c.price_change_percentage_24h || 0;
      const sign   = change >= 0 ? '+' : '';
      const rsiLine = c.rsi !== null && c.rsi !== undefined
        ? 'RSI: ' + c.rsi + (c.rsi<30?' - ALIS FURSETI 💎':c.rsi>70?' - DIKKATLI ⚠️':'') + '\n'
        : '';
      const brkLine = c.breakout ? 'Breakout: ' + c.breakout.label + '\n' : '';

      const msg =
        level + ': <b>' + c.symbol.toUpperCase() + '</b>\n' +
        '════════════════════════════\n' +
        '💰 Qiymet: <b>' + fmtPrice(c.current_price) + '</b>\n' +
        '📊 24s deyisim: ' + sign + change.toFixed(2) + '%\n' +
        '📦 Hecm: ' + fmt(c.total_volume) + '\n' +
        '🚀 Hecm artimi: <b>' + c.volRatio.toFixed(1) + 'x</b>\n' +
        (rsiLine ? '📉 ' + rsiLine : '') +
        (brkLine ? '💥 ' + brkLine : '') +
        '⭐ Xal: <b>' + c.score + '/18</b>\n' +
        '════════════════════════════\n' +
        '📋 Sebbler:\n' + c.reasons.map(r => '• ' + r).join('\n') + '\n' +
        '════════════════════════════\n' +
        '🎯 Deqiqlik: ' + accuracy + (totalSignals > 0 ? ' (' + correctCalls + '/' + totalSignals + ')' : '') + '\n' +
        '⏰ ' + new Date().toLocaleTimeString('az-AZ', {timeZone:'Asia/Baku'});

      await sendTelegram(msg);
      console.log('-> ' + c.symbol.toUpperCase() + ' xal:' + c.score + ' RSI:' + c.rsi);
      await sleep(600);
    }

    if (top.length === 0) console.log('-> Siqnal yoxdur (' + signals.length + ' zeyif var)');

    if (checkCount % 20 === 0 && totalSignals > 0) {
      const acc = ((correctCalls/totalSignals)*100).toFixed(1);
      await sendTelegram(
        '📊 Sistem Statistikasi\n' +
        '════════════════════════════\n' +
        '✅ Durust siqnal: ' + correctCalls + '/' + totalSignals + '\n' +
        '🎯 Deqiqlik: <b>' + acc + '%</b>\n' +
        '🔄 Yoxlama sayi: ' + checkCount + '\n' +
        '📈 Izlenen coin: 250\n' +
        '⏰ ' + new Date().toLocaleTimeString('az-AZ', {timeZone:'Asia/Baku'})
      );
    }

  } catch(err) {
    console.error('Xeta:', err.message);
    if (err.message.includes('429') || err.message.includes('rate')) {
      console.log('Rate limit - 3 deq gozlenilir...');
      await sleep(180000);
    }
  }
}

function startPolling() {
  let lastId = 0;
  let processing = false;

  async function poll() {
    if (processing) { setTimeout(poll, 5000); return; }
    try {
      const data = await fetchJSON(
        'https://api.telegram.org/bot' + BOT_TOKEN +
        '/getUpdates?offset=' + (lastId+1) + '&timeout=10'
      );
      if (data.ok && data.result.length > 0) {
        processing = true;
        for (const upd of data.result) {
          lastId = upd.update_id;
          if (processedIds.has(upd.update_id)) continue;
          processedIds.add(upd.update_id);
          if (processedIds.size > 1000) {
            const first = processedIds.values().next().value;
            processedIds.delete(first);
          }

          const text = upd.message && upd.message.text;
          if (!text) continue;

          const acc = totalSignals > 0 ? ((correctCalls/totalSignals)*100).toFixed(1) + '%' : 'Hele yoxdur';

          if (text === '/status' || text === '/start') {
            await sendTelegram(
              '🤖 <b>HecmRadar v2 Aktiv</b>\n\n' +
              '🔄 Yoxlama sayi: ' + checkCount + '\n' +
              '📊 Gonderilen siqnal: ' + signalHistory.length + '\n' +
              '🎯 Deqiqlik: ' + acc + '\n' +
              '📈 Izlenen coin: 250\n\n' +
              '/status - bu mesaj\n' +
              '/top - son siqnallar'
            );
          } else if (text === '/top') {
            const recent = signalHistory.slice(-5).reverse();
            if (!recent.length) {
              await sendTelegram('📊 Hele siqnal yoxdur.');
            } else {
              let msg = '📋 <b>Son Siqnallar:</b>\n\n';
              for (const s of recent) {
                const t   = new Date(s.timestamp).toLocaleTimeString('az-AZ', {timeZone:'Asia/Baku'});
                const res = s.checked
                  ? (s.result.correct ? '✅ +' + s.result.priceDiff.toFixed(1) + '%' : '❌ ' + s.result.priceDiff.toFixed(1) + '%')
                  : '⏳ gozlenilir';
                msg += '• ' + s.symbol + ' | ' + t + ' | ⭐' + s.score + ' | ' + res + '\n';
              }
              await sendTelegram(msg);
            }
          }
        }
        processing = false;
      }
    } catch(e) { processing = false; }
    setTimeout(poll, 5000);
  }
  poll();
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  const acc = totalSignals > 0 ? ((correctCalls/totalSignals)*100).toFixed(1) + '%' : 'N/A';
  res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
  res.end(
    'HecmRadar v2\n' +
    'Yoxlama:#' + checkCount + '\n' +
    'Siqnal:' + signalHistory.length + '\n' +
    'Deqiqlik:' + acc + '\n' +
    'Coin:250\n'
  );
}).listen(PORT, () => console.log('Server port ' + PORT + '-da isleyir'));

async function start() {
  console.log('HecmRadar v2 basladi');
  await sendTelegram(
    '🚀 <b>HecmRadar v2 Aktiv!</b>\n\n' +
    '📈 250 coin izlenilir\n' +
    '⏱ Her 2 deqiqede yoxlama\n\n' +
    '✅ Analizler:\n' +
    '• Hecm artimi\n' +
    '• Qiymet deyisimi\n' +
    '• RSI gostericisi\n' +
    '• Breakout askarlamasi\n' +
    '• Market cap filteri\n' +
    '• Backtest (30 deq sonra netice)\n\n' +
    'Yalniz 6+ xal olan siqnallar gonderilir.\n\n' +
    '/status - sistem veziyyeti\n' +
    '/top - son siqnallar'
  );

  await fetchData();
  console.log('Ilk yukleme tamamlandi');
  startPolling();
  setInterval(fetchData, REFRESH_SEC * 1000);
}

start();
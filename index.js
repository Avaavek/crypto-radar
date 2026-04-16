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
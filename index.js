const https = require('https');
const http  = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN || '8780430108:AAHysfwi4_XvOzW-HEs7QZWumon4V8xfiPs';
const CHAT_ID   = process.env.CHAT_ID   || '1475632521';
const INTERVAL  = 30 * 60 * 1000; // 30 dəqiqə

const STABLE_SYMBOLS = [
  'USDTUSDT','USDCUSDT','DAIUSDT','BUSDUSDT','TUSDUSDT','FRAXUSDT',
  'USDPUSDT','GUSDUSDT','LUSTUSDT','SUSDT','FDUSDT','PYUSDT'
];

let sentAlerts    = {};
let checkCount    = 0;
let totalSignals  = 0;
let correctCalls  = 0;
let signalHistory = [];
let marketState   = { fearGreed: 50, btcDominance: 50, fundingRates: {} };
let topSymbols    = [];

const TF_LABELS = { '4h':'4 SAAT','1h':'1 SAAT','15m':'15 DEQ','5m':'5 DEQ' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'CryptoRadar/4.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse xetasi')); }
      });
    }).on('error', reject);
  });
}

async function getBinanceCandles(symbol, interval, limit) {
  try {
    const url = 'https://api.binance.com/api/v3/klines?symbol=' + symbol + '&interval=' + interval + '&limit=' + limit;
    const data = await fetchJSON(url);
    return data.map(c => ({
      time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]),
      volume: parseFloat(c[5]), buyVolume: parseFloat(c[9]), trades: parseInt(c[8])
    }));
  } catch(e) { return []; }
}

async function getTopSymbols() {
  try {
    const data = await fetchJSON('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=80&page=1&sparkline=false');
    const stables = ['tether','usd-coin','dai','binance-usd','true-usd','frax','usdd'];
    return data
      .filter(c => !stables.includes(c.id))
      .map(c => c.symbol.toUpperCase() + 'USDT');
  } catch(e) { return []; }
}

async function getFundingRates() {
  try {
    const data = await fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex');
    const rates = {};
    for (const d of data) {
      if (d.symbol.endsWith('USDT')) rates[d.symbol] = parseFloat(d.lastFundingRate) * 100;
    }
    return rates;
  } catch(e) { return {}; }
}

async function getFearGreed() {
  try {
    const data = await fetchJSON('https://api.alternative.me/fng/?limit=1');
    return parseInt(data.data[0].value);
  } catch(e) { return 50; }
}

async function getBTCDominance() {
  try {
    const data = await fetchJSON('https://api.coingecko.com/api/v3/global');
    return data.data.market_cap_percentage.btc || 50;
  } catch(e) { return 50; }
}

function calcRSI(candles, period) {
  period = period || 14;
  if (candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return Math.round(100 - (100 / (1 + avgGain / avgLoss)));
}

function calcStochRSI(candles, period) {
  period = period || 14;
  if (candles.length < period * 2) return null;
  const rsiValues = [];
  for (let i = period; i < candles.length; i++) {
    const r = calcRSI(candles.slice(i - period, i + 1), period);
    if (r !== null) rsiValues.push(r);
  }
  if (rsiValues.length < period) return null;
  const recent = rsiValues.slice(-period);
  const minR = Math.min(...recent);
  const maxR = Math.max(...recent);
  if (maxR === minR) return 50;
  return Math.round(((rsiValues[rsiValues.length-1] - minR) / (maxR - minR)) * 100);
}

function ema(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let val = data.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < data.length; i++) val = data[i] * k + val * (1 - k);
  return val;
}

function calcMACD(candles) {
  if (candles.length < 26) return null;
  const closes = candles.map(c => c.close);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macdLine = e12 - e26;
  const macdVals = [];
  for (let i = 26; i <= closes.length; i++) {
    const m12 = ema(closes.slice(0, i), 12);
    const m26 = ema(closes.slice(0, i), 26);
    macdVals.push(m12 - m26);
  }
  const signal = ema(macdVals, 9);
  const hist   = macdLine - signal;
  const prevM  = macdVals[macdVals.length-2] || 0;
  const prevS  = ema(macdVals.slice(0,-1), 9) || 0;
  return {
    macd: macdLine, signal, histogram: hist,
    crossUp:   macdLine > signal && prevM <= prevS,
    crossDown: macdLine < signal && prevM >= prevS,
    histIncreasing: hist > (macdVals[macdVals.length-2] - (ema(macdVals.slice(0,-1),9)||0))
  };
}

function calcBollinger(candles, period) {
  period = period || 20;
  if (candles.length < period) return null;
  const closes = candles.slice(-period).map(c => c.close);
  const sma = closes.reduce((a,b) => a+b, 0) / period;
  const std = Math.sqrt(closes.reduce((a,b) => a + Math.pow(b-sma,2), 0) / period);
  const upper = sma + 2*std, lower = sma - 2*std;
  const price = candles[candles.length-1].close;
  const bw = (upper - lower) / sma * 100;
  return {
    upper, middle: sma, lower, bandwidth: bw,
    position: (price-lower)/(upper-lower),
    atLower: price <= lower*1.01,
    atUpper: price >= upper*0.99,
    squeezed: bw < 5
  };
}

function calcATR(candles, period) {
  period = period || 14;
  if (candles.length < period+1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low  - candles[i-1].close)
    ));
  }
  return trs.slice(-period).reduce((a,b) => a+b, 0) / period;
}

function calcCRT(candles) {
  if (candles.length < 3) return null;
  const prev = candles[candles.length-2];
  const curr = candles[candles.length-1];
  const range = prev.high - prev.low;
  if (range <= 0) return null;
  const pos = (curr.close - prev.low) / range;
  return {
    breakoutUp:   curr.close > prev.high,
    breakoutDown: curr.close < prev.low,
    position: Math.round(pos*100),
    nearTop: pos > 0.8,
    nearBot: pos < 0.2
  };
}

function calcVolumeDelta(candles) {
  if (candles.length < 5) return null;
  const recent = candles.slice(-10);
  let buy = 0, sell = 0;
  for (const c of recent) {
    buy  += c.buyVolume || 0;
    sell += (c.volume - (c.buyVolume || 0));
  }
  const ratio = sell > 0 ? buy/sell : 1;
  return { delta: buy-sell, ratio, bullish: ratio > 1.1, bearish: ratio < 0.9 };
}

function findOrderBlocks(candles) {
  if (candles.length < 5) return { bullish: null, bearish: null };
  let bullOB = null, bearOB = null;
  for (let i = candles.length-10; i < candles.length-1; i++) {
    if (i < 0) continue;
    const c = candles[i], next = candles[i+1];
    if (c.close < c.open && next.close > c.high) bullOB = { top: c.open, bottom: c.low };
    if (c.close > c.open && next.close < c.low)  bearOB = { top: c.high, bottom: c.close };
  }
  return { bullish: bullOB, bearish: bearOB };
}

function findFVG(candles) {
  if (candles.length < 3) return [];
  const fvgs = [];
  for (let i = 1; i < candles.length-1; i++) {
    const prev = candles[i-1], next = candles[i+1];
    if (next.low > prev.high)  fvgs.push({ type:'bullish', top:next.low, bottom:prev.high });
    if (next.high < prev.low)  fvgs.push({ type:'bearish', top:prev.low, bottom:next.high });
  }
  return fvgs.slice(-5);
}

function findSupplyDemand(candles) {
  if (candles.length < 10) return { supply:[], demand:[] };
  const supply = [], demand = [];
  for (let i = 2; i < candles.length-2; i++) {
    const c = candles[i], n1 = candles[i+1], n2 = candles[i+2];
    if (c.close < c.open && (c.open-c.close) > (c.high-c.low)*0.6 && n1.close < c.close && n2.close < n1.close)
      supply.push({ top:c.high, bottom:c.open, strength:(c.open-c.close)/c.open*100 });
    if (c.close > c.open && (c.close-c.open) > (c.high-c.low)*0.6 && n1.close > c.close && n2.close > n1.close)
      demand.push({ top:c.close, bottom:c.low, strength:(c.close-c.open)/c.open*100 });
  }
  return { supply:supply.slice(-3), demand:demand.slice(-3) };
}

function analyzeMarketStructure(candles) {
  if (candles.length < 10) return { trend:'neutral', breakup:false, breakdown:false };
  const recent = candles.slice(-10);
  let hh=0, hl=0, ll=0, lh=0;
  for (let i=1; i<recent.length; i++) {
    if (recent[i].high > recent[i-1].high) hh++;
    if (recent[i].low  > recent[i-1].low)  hl++;
    if (recent[i].low  < recent[i-1].low)  ll++;
    if (recent[i].high < recent[i-1].high) lh++;
  }
  const last     = candles[candles.length-1];
  const prevHigh = Math.max(...candles.slice(-5,-1).map(c=>c.high));
  const prevLow  = Math.min(...candles.slice(-5,-1).map(c=>c.low));
  return {
    trend:     hh+hl > ll+lh ? 'bullish' : ll+lh > hh+hl ? 'bearish' : 'neutral',
    breakup:   last.close > prevHigh,
    breakdown: last.close < prevLow
  };
}

function detectLiquiditySweep(candles) {
  if (candles.length < 10) return null;
  const prev   = candles.slice(-10,-5);
  const recent = candles.slice(-5);
  const pH = Math.max(...prev.map(c=>c.high));
  const pL = Math.min(...prev.map(c=>c.low));
  const last = recent[recent.length-1];
  const prev1 = recent[recent.length-2];
  if (prev1 && prev1.high > pH && last.close < pH) return { type:'bearish_sweep', level:pH };
  if (prev1 && prev1.low  < pL && last.close > pL) return { type:'bullish_sweep', level:pL };
  return null;
}

function analyzeTimeframe(tfCandles) {
  if (!tfCandles || tfCandles.length < 5) return null;
  let score = 0;
  const signals = [];

  const rsi      = calcRSI(tfCandles);
  const stochRsi = calcStochRSI(tfCandles);
  const macd     = calcMACD(tfCandles);
  const boll     = calcBollinger(tfCandles);
  const crt      = calcCRT(tfCandles);
  const ms       = analyzeMarketStructure(tfCandles);
  const ob       = findOrderBlocks(tfCandles);
  const fvg      = findFVG(tfCandles);
  const sd       = findSupplyDemand(tfCandles);
  const liq      = detectLiquiditySweep(tfCandles);
  const delta    = calcVolumeDelta(tfCandles);
  const e9       = ema(tfCandles.map(c=>c.close), 9);
  const e21      = ema(tfCandles.map(c=>c.close), 21);
  const e50      = ema(tfCandles.map(c=>c.close), 50);
  const e200     = ema(tfCandles.map(c=>c.close), 200);
  const price    = tfCandles[tfCandles.length-1].close;

  if (rsi !== null) {
    if      (rsi < 25) { score += 3; signals.push('RSI ' + rsi + ' - cox satilmis'); }
    else if (rsi < 35) { score += 2; signals.push('RSI ' + rsi + ' - satilmis'); }
    else if (rsi < 45) { score += 1; signals.push('RSI ' + rsi); }
    else if (rsi > 80) { score -= 2; signals.push('RSI ' + rsi + ' - asiri alinmis'); }
    else if (rsi > 70) { score -= 1; signals.push('RSI ' + rsi + ' - yuksek'); }
  }

  if (stochRsi !== null) {
    if      (stochRsi < 20) { score += 2; signals.push('StochRSI ' + stochRsi + ' - dib'); }
    else if (stochRsi < 30) { score += 1; signals.push('StochRSI ' + stochRsi); }
    else if (stochRsi > 80) { score -= 1; signals.push('StochRSI ' + stochRsi + ' - zirve'); }
  }

  if (macd) {
    if      (macd.crossUp)                              { score += 3; signals.push('MACD - yuxari kecdi'); }
    else if (macd.histIncreasing && macd.histogram > 0) { score += 2; signals.push('MACD - guclenme'); }
    else if (macd.crossDown)                            { score -= 2; signals.push('MACD - asagi kecdi'); }
  }

  if (boll) {
    if      (boll.atLower && boll.squeezed) { score += 3; signals.push('Bollinger - alt bant + sixilma'); }
    else if (boll.atLower)                  { score += 2; signals.push('Bollinger - alt bantda'); }
    else if (boll.squeezed)                 { score += 1; signals.push('Bollinger - sixilma'); }
    else if (boll.atUpper)                  { score -= 1; signals.push('Bollinger - ust bantda'); }
  }

  if (e9 && e21) {
    if      (e9 > e21 && price > e9)  { score += 2; signals.push('EMA 9>21 - yukselis trendi'); }
    else if (e9 < e21 && price < e9)  { score -= 1; }
  }
  if (e50  && price > e50)  { score += 1; signals.push('EMA50 ustunde'); }
  if (e200 && price > e200) { score += 1; signals.push('EMA200 ustunde - uzunmuddetli bull'); }

  if (crt) {
    if      (crt.breakoutUp)   { score += 3; signals.push('CRT - yuxari breakout'); }
    else if (crt.nearBot)      { score += 2; signals.push('CRT - alt zonada (' + crt.position + '%)'); }
    else if (crt.breakoutDown) { score -= 2; signals.push('CRT - asagi breakout'); }
  }

  if      (ms.breakup)             { score += 3; signals.push('Market Structure - yeni zirve'); }
  else if (ms.trend === 'bullish') { score += 2; signals.push('Market Structure - yukselis HH/HL'); }
  else if (ms.trend === 'bearish') { score -= 1; }
  else if (ms.breakdown)           { score -= 2; }

  if (ob.bullish) {
    const inOB = price >= ob.bullish.bottom && price <= ob.bullish.top * 1.02;
    if (inOB) { score += 3; signals.push('ICT Order Block - bullish zonada'); }
  }

  const bullFVG = fvg.filter(f => f.type==='bullish' && price>=f.bottom && price<=f.top);
  if (bullFVG.length > 0) { score += 2; signals.push('FVG - boslug dolduruluyor'); }

  const inDemand = sd.demand.find(z => price >= z.bottom && price <= z.top*1.02);
  if (inDemand) { score += 3; signals.push('Demand Zone - taleb zonasinda (' + inDemand.strength.toFixed(1) + '% guclu)'); }

  if (liq && liq.type === 'bullish_sweep') { score += 3; signals.push('Likvidlik sweep - alis gelecek'); }

  if (delta && delta.bullish) { score += 2; signals.push('Order Flow - alis tesyiqi (' + delta.ratio.toFixed(2) + 'x)'); }

  return { score, signals, rsi };
}

function calculateLevels(candles4h, price) {
  const atr = calcATR(candles4h, 14);
  if (!atr) return null;
  const sl  = price - atr * 1.5;
  const tp1 = price + atr * 2;
  const tp2 = price + atr * 4;
  const tp3 = price + atr * 7;
  return {
    entry: price, stopLoss: sl, tp1, tp2, tp3,
    slPct:  ((sl-price)/price*100).toFixed(2),
    tp1Pct: ((tp1-price)/price*100).toFixed(2),
    tp2Pct: ((tp2-price)/price*100).toFixed(2),
    tp3Pct: ((tp3-price)/price*100).toFixed(2),
    rr:     ((tp2-price)/(price-sl)).toFixed(1)
  };
}

function calcLiquidation(entry, leverage) {
  return entry * (1 - 1/leverage * 0.9);
}

function suggestLeverage(score) {
  if (score >= 22) return 10;
  if (score >= 18) return 7;
  if (score >= 15) return 5;
  return 3;
}

function sendTelegram(text) {
  return new Promise((resolve) => {
    const t = text.length > 4000 ? text.slice(0,4000)+'...' : text;
    const body = JSON.stringify({ chat_id: CHAT_ID, text: t, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: '/bot' + BOT_TOKEN + '/sendMessage',
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d+=c);
      res.on('end', () => {
        try { const r=JSON.parse(d); if(!r.ok) console.error('TG:',r.description); } catch(e){}
        resolve();
      });
    });
    req.on('error', e => { console.error('TG xeta:',e.message); resolve(); });
    req.write(body); req.end();
  });
}

async function checkPastSignals(symbol, price) {
  const now = Date.now();
  const toCheck = signalHistory.filter(s =>
    s.symbol === symbol && !s.checked &&
    (now - s.timestamp) >= 4*60*60*1000 &&
    (now - s.timestamp) <= 4.5*60*60*1000
  );
  for (const s of toCheck) {
    s.checked = true;
    const diff   = ((price - s.entry) / s.entry * 100);
    const hitTP1 = price >= s.tp1;
    const hitTP2 = price >= s.tp2;
    const hitSL  = price <= s.stopLoss;
    const correct = diff > 0 && !hitSL;
    totalSignals++;
    if (correct) correctCalls++;
    s.result = { diff, correct, hitTP1, hitTP2, hitSL };
    const res = hitTP2?'🎯 TP2 VURULDU':hitTP1?'🎯 TP1 VURULDU':hitSL?'🛑 SL VURULDU':(correct?'📈 Artdi':'📉 Dusdu');
    const acc = ((correctCalls/totalSignals)*100).toFixed(1);
    await sendTelegram(
      (correct?'✅':'❌') + ' <b>Backtest: ' + s.symbol + '</b>\n' +
      '4 saat sonra: ' + (diff>=0?'+':'') + diff.toFixed(2) + '%\n' +
      'Netice: ' + res + '\n' +
      '⭐ Xal: ' + s.score + '/24\n' +
      '🎯 Deqiqlik: ' + acc + '% (' + correctCalls + '/' + totalSignals + ')'
    );
    await sleep(500);
  }
}

async function analyzeSymbol(symbol) {
  try {
    const tfs = [['4h',100],['1h',100],['15m',100],['5m',100]];
    const tfData = {};
    for (const [tf, limit] of tfs) {
      tfData[tf] = await getBinanceCandles(symbol, tf, limit);
      await sleep(120);
    }

    const price = tfData['1h'].length > 0 ? tfData['1h'][tfData['1h'].length-1].close : 0;
    if (!price) return null;

    await checkPastSignals(symbol, price);

    let totalScore = 0, tfAlignment = 0;
    const tfResults = [];

    for (const [tf] of tfs) {
      if (!tfData[tf] || tfData[tf].length < 5) continue;
      const a = analyzeTimeframe(tfData[tf]);
      if (!a) continue;
      totalScore += a.score;
      if (a.score > 3) tfAlignment++;
      tfResults.push({ tf, score: a.score, signals: a.signals });
    }

    if (totalScore < 12 || tfAlignment < 3) return null;

    const levels = calculateLevels(tfData['4h'], price);
    if (!levels) return null;

    const funding = marketState.fundingRates[symbol] || 0;
    if (funding < -0.05) totalScore += 2;
    else if (funding < 0) totalScore += 1;
    else if (funding > 0.1) totalScore -= 1;

    const fg = marketState.fearGreed;
    if      (fg < 25) totalScore += 3;
    else if (fg < 40) totalScore += 1;
    else if (fg > 75) totalScore -= 1;

    const btcD = marketState.btcDominance;
    if      (btcD < 45) totalScore += 2;
    else if (btcD > 55) totalScore -= 1;

    if (totalScore < 12) return null;

    return { symbol, price, totalScore, tfAlignment, tfResults, levels, funding };
  } catch(e) {
    console.error(symbol + ':', e.message);
    return null;
  }
}

function buildMessage(r) {
  const { symbol, price, totalScore, tfAlignment, tfResults, levels, funding } = r;
  const pct = Math.round(totalScore/24*100);
  const lvl = pct>=90?'🔥 MAKSIMUM LONG':pct>=75?'⚡ GUCLU LONG':pct>=60?'💪 LONG SIQNAL':'📊 LONG';
  const acc = totalSignals>0 ? ((correctCalls/totalSignals)*100).toFixed(1)+'%' : 'Hesablanir';
  const fg  = marketState.fearGreed;
  const fgL = fg<25?'😱 ASIRI QORXU':fg<45?'😰 QORXU':fg<55?'😐 NEYTRAL':fg<75?'😏 TAMAH':'🤑 ASIRI TAMAH';

  const leverage = suggestLeverage(totalScore);
  const liqPrice = calcLiquidation(price, leverage);

  const fundingNote = funding < -0.05
    ? '✅ Funding menfi - long ucun elverisli'
    : funding > 0.1
    ? '⚠️ Funding yuksek - long ucun elave xerc'
    : '➖ Funding normal';

  const tfLine = tfResults.map(t => {
    const e = t.score>=5?'✅':t.score>=2?'⚠️':'❌';
    return e+' '+TF_LABELS[t.tf]+': '+(t.score>=5?'OK':t.score>=2?'--':'XX')+' ('+t.score+')';
  }).join('\n');

  let tech = '';
  for (const t of tfResults) {
    if (t.signals.length > 0) {
      tech += '\n📅 ['+TF_LABELS[t.tf]+']\n';
      tech += t.signals.slice(0,2).map(s=>'• '+s).join('\n')+'\n';
    }
  }

  return lvl+': <b>'+symbol+'</b>\n'+
    '════════════════════════════\n'+
    '💰 Qiymet: <b>'+fmtPrice(price)+'</b>\n'+
    '🎯 Uygunluq: <b>'+tfAlignment+'/4 timeframe</b>\n'+
    '⭐ Xal: <b>'+totalScore+'/24</b>\n'+
    '════════════════════════════\n'+
    '📊 TIMEFRAME:\n'+tfLine+'\n'+
    '════════════════════════════\n'+
    '📈 FYUCERS GİRİS/CIXIS:\n'+
    '🟢 Giris: <b>'+fmtPrice(levels.entry)+'</b>\n'+
    '🎯 TP1: '+fmtPrice(levels.tp1)+' ('+levels.tp1Pct+'%)\n'+
    '🎯 TP2: '+fmtPrice(levels.tp2)+' ('+levels.tp2Pct+'%)\n'+
    '🎯 TP3: '+fmtPrice(levels.tp3)+' ('+levels.tp3Pct+'%)\n'+
    '🛑 Stop Loss: '+fmtPrice(levels.stopLoss)+' ('+levels.slPct+'%)\n'+
    '⚖️ Risk/Reward: 1:'+levels.rr+'\n'+
    '════════════════════════════\n'+
    '⚡ LEVERAGE:\n'+
    '📊 Tovsiye: <b>'+leverage+'x</b>\n'+
    '💥 Likvid qiymeti ('+leverage+'x): <b>'+fmtPrice(liqPrice)+'</b>\n'+
    '⚠️ Kapitalin 2%-ni iske at\n'+
    '════════════════════════════\n'+
    '🔍 TEXNIKI:'+tech+
    '════════════════════════════\n'+
    '🌍 BAZAR:\n'+
    fgL+' Fear & Greed: '+fg+'\n'+
    '₿ BTC Dominans: '+marketState.btcDominance.toFixed(1)+'%\n'+
    fundingNote+'\n'+
    (funding!==0?'💸 Funding: '+funding.toFixed(4)+'%\n':'')+
    '════════════════════════════\n'+
    '🎯 Deqiqlik: '+acc+(totalSignals>0?' ('+correctCalls+'/'+totalSignals+')':'')+'\n'+
    '⏰ '+new Date().toLocaleTimeString('az-AZ',{timeZone:'Asia/Baku'});
}

async function mainLoop() {
  checkCount++;
  const timeStr = new Date().toLocaleTimeString('az-AZ',{timeZone:'Asia/Baku'});
  console.log('\n['+new Date().toISOString()+'] Yoxlama #'+checkCount);

  try {
    [marketState.fearGreed, marketState.btcDominance, marketState.fundingRates] =
      await Promise.all([getFearGreed(), getBTCDominance(), getFundingRates()]);

    console.log('F&G:'+marketState.fearGreed+' BTC:'+marketState.btcDominance.toFixed(1)+'%');

    if (checkCount % 5 === 1) {
      topSymbols = await getTopSymbols();
      console.log('Coinler: '+topSymbols.length);
    }

    const signals = [];
    let analyzed  = 0;

    for (const symbol of topSymbols) {
      await sleep(200);
      const result = await analyzeSymbol(symbol);
      analyzed++;
      if (result) {
        signals.push(result);
        console.log('✅ SIQNAL: '+symbol+' xal:'+result.totalScore+' uygunluq:'+result.tfAlignment+'/4');
      }
      if (analyzed % 10 === 0) {
        console.log('📊 '+analyzed+'/'+topSymbols.length+' analiz edildi...');
      }
    }

    signals.sort((a,b) => b.totalScore - a.totalScore);
    const now = Date.now();
    let sent  = 0;

    for (const r of signals) {
      if (sent >= 3) break;
      if (sentAlerts[r.symbol] && (now-sentAlerts[r.symbol]) < 2*60*60*1000) continue;
      sentAlerts[r.symbol] = now;
      signalHistory.push({
        symbol: r.symbol, entry: r.levels.entry,
        tp1: r.levels.tp1, tp2: r.levels.tp2,
        stopLoss: r.levels.stopLoss, score: r.totalScore,
        timestamp: now, checked: false, result: null
      });
      if (signalHistory.length > 200) signalHistory.shift();
      await sendTelegram(buildMessage(r));
      sent++;
      await sleep(1000);
    }

    // Hər analizdən sonra nəticə bildirişi
    const fg  = marketState.fearGreed;
    const fgL = fg<25?'😱 ASIRI QORXU':fg<45?'😰 QORXU':fg<55?'😐 NEYTRAL':fg<75?'😏 TAMAH':'🤑 ASIRI TAMAH';
    const acc = totalSignals>0?((correctCalls/totalSignals)*100).toFixed(1)+'%':'N/A';

    if (sent === 0) {
      await sendTelegram(
        '🔍 Axtaris tamamlandi — Siqnal yoxdur\n\n'+
        '📊 Analiz edilen: '+topSymbols.length+' coin\n'+
        '⏱ Yoxlama: #'+checkCount+'\n'+
        fgL+' Fear & Greed: '+fg+'\n'+
        '₿ BTC Dominans: '+marketState.btcDominance.toFixed(1)+'%\n'+
        '🎯 Deqiqlik: '+acc+'\n'+
        '⏰ Novbeti axtaris: 30 deq sonra\n'+
        '⏰ '+timeStr
      );
    } else {
      await sendTelegram(
        '✅ Axtaris tamamlandi — '+sent+' siqnal gonderildi\n\n'+
        '📊 Analiz edilen: '+topSymbols.length+' coin\n'+
        '⏱ Yoxlama: #'+checkCount+'\n'+
        fgL+' Fear & Greed: '+fg+'\n'+
        '₿ BTC Dominans: '+marketState.btcDominance.toFixed(1)+'%\n'+
        '🎯 Deqiqlik: '+acc+'\n'+
        '⏰ Novbeti axtaris: 30 deq sonra\n'+
        '⏰ '+timeStr
      );
    }

  } catch(e) {
    console.error('Loop xeta:',e.message);
  }
}

function startPolling() {
  let lastId = 0;
  async function poll() {
    try {
      const data = await fetchJSON('https://api.telegram.org/bot'+BOT_TOKEN+'/getUpdates?offset='+(lastId+1)+'&timeout=30');
      if (data.ok && data.result.length > 0) {
        for (const upd of data.result) {
          lastId = upd.update_id;
          const text = upd.message && upd.message.text;
          if (!text) continue;
          const acc = totalSignals>0?((correctCalls/totalSignals)*100).toFixed(1)+'%':'Hele yoxdur';
          const fg  = marketState.fearGreed;
          const fgL = fg<25?'😱 ASIRI QORXU':fg<45?'😰 QORXU':fg<55?'😐 NEYTRAL':fg<75?'😏 TAMAH':'🤑 ASIRI TAMAH';

          if (text==='/status'||text==='/start') {
            await sendTelegram(
              '🤖 HecmRadar v4 - Aktiv\n\n'+
              '⏱ Yoxlama sayi: '+checkCount+'\n'+
              '📈 Analiz edilen coin: '+topSymbols.length+'\n'+
              '📊 Gonderilen siqnal: '+signalHistory.length+'\n'+
              '🎯 Deqiqlik: '+acc+'\n'+
              fgL+' Fear & Greed: '+fg+'\n'+
              '₿ BTC Dominans: '+marketState.btcDominance.toFixed(1)+'%\n\n'+
              '/status - bu mesaj\n'+
              '/top - son siqnallar\n'+
              '/market - bazar veziyyeti'
            );
          }

          if (text==='/top') {
            const recent = signalHistory.slice(-5).reverse();
            if (!recent.length) {
              await sendTelegram('📊 Hele siqnal yoxdur.');
            } else {
              let msg = '📋 Son Siqnallar:\n\n';
              for (const s of recent) {
                const t   = new Date(s.timestamp).toLocaleTimeString('az-AZ',{timeZone:'Asia/Baku'});
                const res = s.checked
                  ? (s.result.correct?'✅ +'+s.result.diff.toFixed(1)+'%':'❌ '+s.result.diff.toFixed(1)+'%')
                  : '⏳ gozlenilir';
                msg += '• '+s.symbol+' | '+t+' | ⭐'+s.score+' | '+res+'\n';
              }
              await sendTelegram(msg);
            }
          }

          if (text==='/market') {
            await sendTelegram(
              '🌍 Bazar Veziyyeti\n\n'+
              fgL+' Fear & Greed: '+fg+'\n'+
              '₿ BTC Dominans: '+marketState.btcDominance.toFixed(1)+'%\n'+
              '📊 Analiz edilen: '+topSymbols.length+' coin\n'+
              '⏰ '+new Date().toLocaleTimeString('az-AZ',{timeZone:'Asia/Baku'})
            );
          }
        }
      }
    } catch(e) {}
    setTimeout(poll, 3000);
  }
  poll();
}

const PORT = process.env.PORT || 3000;
http.createServer((req,res) => {
  const acc = totalSignals>0?((correctCalls/totalSignals)*100).toFixed(1)+'%':'N/A';
  res.writeHead(200,{'Content-Type':'text/plain;charset=utf-8'});
  res.end('HecmRadar v4\nYoxlama:#'+checkCount+'\nCoin:'+topSymbols.length+'\nSiqnal:'+signalHistory.length+'\nDeqiqlik:'+acc+'\n');
}).listen(PORT,()=>console.log('Server port '+PORT+'-da isleyir'));

async function start() {
  console.log('HecmRadar v4 basladi');
  await sendTelegram(
    '🚀 HecmRadar v4 Aktiv!\n\n'+
    '📊 4 Timeframe: 4H → 1H → 15dəq → 5dəq\n'+
    '⏱ Hər 30 dəqiqədə analiz\n'+
    '📈 77 coin izlənilir\n\n'+
    '✅ Analizlər:\n'+
    '• RSI + StochRSI\n'+
    '• MACD + Bollinger\n'+
    '• EMA 9/21/50/200\n'+
    '• CRT + ATR\n'+
    '• ICT Order Block + FVG\n'+
    '• Supply & Demand\n'+
    '• Market Structure\n'+
    '• Liquidity Sweep\n'+
    '• Order Flow\n'+
    '• Fear & Greed\n'+
    '• BTC Dominans\n'+
    '• Funding Rate\n'+
    '• Leverage + Likvidləşmə qiyməti\n\n'+
    '🔍 Hər analizdən sonra nəticə bildirilir\n\n'+
    '/status /top /market'
  );

  topSymbols = await getTopSymbols();
  console.log('Coinler: '+topSymbols.length);
  startPolling();
  await mainLoop();
  setInterval(mainLoop, INTERVAL);
}

start();
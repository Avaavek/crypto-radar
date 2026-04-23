const https = require('https');
const http  = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN || '8780430108:AAHysfwi4_XvOzW-HEs7QZWumon4V8xfiPs';
const CHAT_ID   = process.env.CHAT_ID   || '1475632521';
const INTERVAL  = 60 * 1000; // 1 dəqiqə

let checkCount  = 0;
let sentAlerts  = {}; // { symbol_type_time: true }
let topSymbols  = [];
const processedIds = new Set();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtPrice(p) {
  if (!p && p !== 0) return '--';
  if (p >= 1000) return '$' + p.toLocaleString('en', {maximumFractionDigits:2});
  if (p >= 1)    return '$' + p.toFixed(3);
  if (p >= 0.01) return '$' + p.toFixed(5);
  return '$' + p.toFixed(8);
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'FVGRadar/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse xetasi')); }
      });
    }).on('error', reject);
  });
}

// Bybit-dən 15 dəqiqəlik şamlar
async function getCandles(symbol) {
  try {
    const url = 'https://api.bybit.com/v5/market/kline?category=linear&symbol=' + symbol + '&interval=15&limit=100';
    const data = await fetchJSON(url);
    if (!data.result || !data.result.list || data.result.list.length === 0) return [];
    // Bybit şamları tərsinə gəlir — düzəlt
    return data.result.list.reverse().map(c => ({
      time:  parseInt(c[0]),
      open:  parseFloat(c[1]),
      high:  parseFloat(c[2]),
      low:   parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol:   parseFloat(c[5])
    }));
  } catch(e) { return []; }
}

// Top coinləri CoinGecko-dan al
async function getTopSymbols() {
  try {
    const stables = ['tether','usd-coin','dai','binance-usd','true-usd','frax',
      'usdd','pax-dollar','stasis-eurs','wbtc','weth','steth','usdp','gusd','lusd'];
    const data = await fetchJSON(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1&sparkline=false'
    );
    return data
      .filter(c => !stables.includes(c.id))
      .map(c => c.symbol.toUpperCase() + 'USDT');
  } catch(e) { return []; }
}

// ── FVG Aşkarlaması ──────────────────────────────────────
// Bullish FVG: şam[i-1].high < şam[i+1].low → boşluq var
// Bearish FVG: şam[i-1].low > şam[i+1].high → boşluq var
function findFVGs(candles) {
  const bullishFVGs = [];
  const bearishFVGs = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i-1];
    const curr = candles[i];
    const next = candles[i+1];

    // Bullish FVG — aşağı boşluq
    if (prev.high < next.low) {
      bullishFVGs.push({
        top:    next.low,
        bottom: prev.high,
        index:  i,
        time:   curr.time,
        midpoint: (next.low + prev.high) / 2
      });
    }

    // Bearish FVG — yuxarı boşluq
    if (prev.low > next.high) {
      bearishFVGs.push({
        top:    prev.low,
        bottom: next.high,
        index:  i,
        time:   curr.time,
        midpoint: (prev.low + next.high) / 2
      });
    }
  }

  return { bullishFVGs, bearishFVGs };
}

// ── FVG Kəsilməsi Yoxla ──────────────────────────────────
// Şamın GÖVDƏSİ FVG-ni tam keçirmi?
// Bullish FVG kəsilməsi: bearish şam gövdəsi FVG-nin altından keçir
// Bearish FVG kəsilməsi: bullish şam gövdəsi FVG-nin yuxarısından keçir
function checkFVGBreak(candles, fvgs, type) {
  const results = [];
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  // Yalnız son 2 şama bax — yeni kəsilmə
  for (const fvg of fvgs) {
    // FVG köhnədirsə keç (son 50 şam içindəki FVG-lərə bax)
    if (fvg.index < candles.length - 50) continue;

    if (type === 'bullish') {
      // Bullish FVG kəsilməsi — bearish şam (qırmızı) gövdəsi ilə aşağı keçir
      // Şamın AÇILIŞI FVG-nin yuxarısında, BAĞLANIŞI FVG-nin aşağısında
      const candleBodyTop    = Math.max(lastCandle.open, lastCandle.close);
      const candleBodyBottom = Math.min(lastCandle.open, lastCandle.close);
      const isBearish = lastCandle.close < lastCandle.open;

      if (isBearish &&
          candleBodyTop >= fvg.top &&
          candleBodyBottom <= fvg.bottom) {
        results.push({
          fvg,
          breakCandle: lastCandle,
          direction: 'SHORT', // Bullish FVG kəsildi → SHORT siqnal
          entryZone: { top: fvg.top, bottom: fvg.bottom }
        });
      }
    } else if (type === 'bearish') {
      // Bearish FVG kəsilməsi — bullish şam (yaşıl) gövdəsi ilə yuxarı keçir
      const candleBodyTop    = Math.max(lastCandle.open, lastCandle.close);
      const candleBodyBottom = Math.min(lastCandle.open, lastCandle.close);
      const isBullish = lastCandle.close > lastCandle.open;

      if (isBullish &&
          candleBodyBottom <= fvg.bottom &&
          candleBodyTop >= fvg.top) {
        results.push({
          fvg,
          breakCandle: lastCandle,
          direction: 'LONG', // Bearish FVG kəsildi → LONG siqnal
          entryZone: { top: fvg.top, bottom: fvg.bottom }
        });
      }
    }
  }

  return results;
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

async function analyzeSymbol(symbol) {
  try {
    const candles = await getCandles(symbol);
    if (candles.length < 10) return;

    const { bullishFVGs, bearishFVGs } = findFVGs(candles);

    // Bullish FVG kəsilməsini yoxla → SHORT siqnal
    const bullishBreaks = checkFVGBreak(candles, bullishFVGs, 'bullish');
    // Bearish FVG kəsilməsini yoxla → LONG siqnal
    const bearishBreaks = checkFVGBreak(candles, bearishFVGs, 'bearish');

    const allBreaks = [...bullishBreaks, ...bearishBreaks];

    for (const b of allBreaks) {
      const lastCandle = candles[candles.length-1];
      const price      = lastCandle.close;

      // Eyni coin + eyni FVG + eyni istiqamət üçün 4 saatda bir bildiriş
      const alertKey = symbol + '_' + b.direction + '_' + b.fvg.index;
      const now = Date.now();
      if (sentAlerts[alertKey] && (now - sentAlerts[alertKey]) < 4*60*60*1000) continue;
      sentAlerts[alertKey] = now;

      // SL və TP hesabla
      const fvgSize = b.fvg.top - b.fvg.bottom;

      let sl, tp, slPct, tpPct;

      if (b.direction === 'LONG') {
        // LONG: SL = iFVG-nin altı (FVG-nin bottom-undan biraz aşağı)
        sl    = b.fvg.bottom - (fvgSize * 0.1);
        tp    = price + (price - sl) * 3; // 1:3
        slPct = ((sl - price) / price * 100).toFixed(2);
        tpPct = ((tp - price) / price * 100).toFixed(2);
      } else {
        // SHORT: SL = iFVG-nin üstü (FVG-nin top-undan biraz yuxarı)
        sl    = b.fvg.top + (fvgSize * 0.1);
        tp    = price - (sl - price) * 3; // 1:3
        slPct = ((sl - price) / price * 100).toFixed(2);
        tpPct = ((tp - price) / price * 100).toFixed(2);
      }

      const dirEmoji = b.direction === 'LONG' ? '📈' : '📉';
      const dirColor = b.direction === 'LONG' ? '🟢' : '🔴';
      const timeStr  = new Date(lastCandle.time).toLocaleTimeString('az-AZ', {timeZone:'Asia/Baku'});
      const fvgType  = b.direction === 'LONG' ? 'Bearish FVG kəsildi' : 'Bullish FVG kəsildi';

      const msg =
        '🎯 <b>FVG SİQNALI: ' + symbol + '</b>\n' +
        '════════════════════════════\n' +
        dirEmoji + ' İstiqamət: <b>' + b.direction + '</b>\n' +
        '💰 Cari Qiymət: <b>' + fmtPrice(price) + '</b>\n' +
        '════════════════════════════\n' +
        '📊 FVG Məlumatı:\n' +
        '• ' + fvgType + '\n' +
        '• FVG yuxarı: ' + fmtPrice(b.fvg.top) + '\n' +
        '• FVG aşağı: ' + fmtPrice(b.fvg.bottom) + '\n' +
        '════════════════════════════\n' +
        '📈 GİRİŞ/ÇIXIŞ:\n' +
        dirColor + ' Giriş: <b>' + fmtPrice(price) + '</b>\n' +
        '🛑 Stop Loss: ' + fmtPrice(sl) + ' (' + slPct + '%)\n' +
        '🎯 Take Profit: ' + fmtPrice(tp) + ' (' + tpPct + '%)\n' +
        '⚖️ Risk/Reward: 1:3\n' +
        '════════════════════════════\n' +
        '💡 Növbəti addım:\n' +
        '• FVG içində iFVG ax\n' +
        '• iFVG-yə qiymət qayıdanda gir\n' +
        '• SL iFVG-nin altına/üstünə qoy\n' +
        '════════════════════════════\n' +
        '⏰ 15 dəq timeframe\n' +
        '🕐 ' + timeStr;

      await sendTelegram(msg);
      console.log('FVG SIQNAL: ' + symbol + ' ' + b.direction + ' qiymet:' + fmtPrice(price));
      await sleep(500);
    }
  } catch(e) {
    console.error(symbol + ':', e.message);
  }
}

async function mainLoop() {
  checkCount++;
  console.log('[' + new Date().toISOString() + '] Yoxlama #' + checkCount);

  try {
    // Hər 10 dövrdə coinləri yenilə
    if (checkCount % 10 === 1) {
      topSymbols = await getTopSymbols();
      console.log('Coinler: ' + topSymbols.length);
    }

    let analyzed = 0;
    for (const symbol of topSymbols) {
      await analyzeSymbol(symbol);
      analyzed++;
      await sleep(150); // rate limit
      if (analyzed % 20 === 0) {
        console.log(analyzed + '/' + topSymbols.length + ' analiz edildi');
      }
    }

    console.log('Yoxlama tamamlandi. Siqnal axtarilir...');

  } catch(e) {
    console.error('Loop xeta:', e.message);
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

          if (text === '/status' || text === '/start') {
            await sendTelegram(
              '🎯 <b>FVG Radar Aktiv</b>\n\n' +
              '⏱ Yoxlama sayı: ' + checkCount + '\n' +
              '📈 İzlənən coin: ' + topSymbols.length + '\n' +
              '⏰ Interval: 1 dəqiqə\n\n' +
              '📋 Strategiya:\n' +
              '• FVG yaranır\n' +
              '• Şam FVG-ni gövdə ilə tam keçir\n' +
              '• Anında bildiriş gəlir\n' +
              '• Sən iFVG tapıb girərsən\n' +
              '• SL: FVG-nin altı/üstü\n' +
              '• TP: 1:3\n\n' +
              '/status - bu mesaj'
            );
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
  res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
  res.end(
    'FVG Radar\n' +
    'Yoxlama:#' + checkCount + '\n' +
    'Coin:' + topSymbols.length + '\n'
  );
}).listen(PORT, () => console.log('Server port ' + PORT + '-da isleyir'));

async function start() {
  console.log('FVG Radar basladi');
  await sendTelegram(
    '🎯 <b>FVG Radar Aktiv!</b>\n\n' +
    '📊 15 dəqiqəlik timeframe\n' +
    '⏱ Hər 1 dəqiqədə 100 coin yoxlanır\n\n' +
    '📋 Strategiya:\n' +
    '1️⃣ FVG yaranır (bullish/bearish)\n' +
    '2️⃣ Şam FVG-ni gövdəsi ilə tam keçir\n' +
    '3️⃣ Anında Telegram bildirişi gəlir\n' +
    '4️⃣ Sən FVG içindəki iFVG-ni tapırsan\n' +
    '5️⃣ iFVG-yə qiymət qayıdanda girərsən\n\n' +
    '📈 LONG: Bearish FVG kəsilir\n' +
    '📉 SHORT: Bullish FVG kəsilir\n\n' +
    '⚖️ Risk/Reward: 1:3\n' +
    '⏰ 15 dəq timeframe\n\n' +
    '/status - sistem vəziyyəti'
  );

  topSymbols = await getTopSymbols();
  console.log('Coinler: ' + topSymbols.length);
  startPolling();
  await mainLoop();
  setInterval(mainLoop, INTERVAL);
}

start();

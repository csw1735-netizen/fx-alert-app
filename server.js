const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const SUB_FILE = path.join(DATA_DIR, 'subscribers.json');

const DEFAULT_SETTINGS = {
  unit: 'percent',
  threshold: 0.5,
  hourly: false,
  fiveMin: false
};

// ---- 저장소: Upstash Redis(클라우드)가 설정되어 있으면 그걸 쓰고, 없으면 로컬 파일로 fallback ----
// Render 무료 플랜은 재배포/재시작마다 로컬 파일이 초기화되기 때문에, 등록 정보를 재배포와
// 무관하게 유지하려면 Upstash 같은 외부 저장소가 필요하다.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useCloudStore = !!(UPSTASH_URL && UPSTASH_TOKEN);
const SUBS_KEY = 'fx_alert_subscribers';

let Redis, redis;
if (useCloudStore) {
  Redis = require('@upstash/redis').Redis;
  redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
  console.log('[저장소] Upstash Redis(클라우드)에 구독 정보를 저장합니다.');
} else {
  console.warn('[경고] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 이 없어 로컬 파일에 저장합니다. ' +
    'Render 무료 플랜은 재배포 시 이 파일이 초기화되니, 영구 저장하려면 Upstash를 연결하세요.');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SUB_FILE)) fs.writeFileSync(SUB_FILE, '[]');
}

function readLocalJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function writeLocalJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// 구독자 목록: [{ chatId, settings: {...}, createdAt }]
async function readSubs() {
  if (useCloudStore) {
    try {
      const data = await redis.get(SUBS_KEY);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('Upstash 읽기 실패:', err.message);
      return [];
    }
  }
  return readLocalJSON(SUB_FILE) || [];
}

async function writeSubs(subs) {
  if (useCloudStore) {
    try {
      await redis.set(SUBS_KEY, subs);
    } catch (err) {
      console.error('Upstash 쓰기 실패:', err.message);
    }
    return;
  }
  writeLocalJSON(SUB_FILE, subs);
}

function findSub(subs, chatId) {
  return subs.find(s => String(s.chatId) === String(chatId));
}

// ---- Telegram Bot setup ----
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const telegramReady = !!TELEGRAM_BOT_TOKEN;
if (!telegramReady) {
  console.warn('[경고] TELEGRAM_BOT_TOKEN 환경변수가 없습니다. ' +
    '@BotFather 에서 봇을 만들고 토큰을 환경변수로 설정하세요. 토큰이 없으면 알림이 전송되지 않습니다.');
}

async function sendTelegramMessage(chatId, text) {
  if (!telegramReady) {
    console.warn('TELEGRAM_BOT_TOKEN 미설정으로 메시지 전송 생략');
    return true; // 키 없으면 조용히 skip, 구독은 유지
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn('텔레그램 전송 실패:', data.description);
      // 403 = 사용자가 봇을 차단함 / 잘못된 chat_id -> 제거 대상
      if (data.error_code === 403 || data.error_code === 400) return false;
    }
    return true;
  } catch (err) {
    console.warn('텔레그램 전송 오류:', err.message);
    return true; // 네트워크 일시 오류는 구독 유지
  }
}

// ---- API: 텔레그램 chatId 등록/설정 저장 ----
app.post('/api/register', async (req, res) => {
  const { chatId, settings } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const subs = await readSubs();
  const existing = findSub(subs, chatId);
  if (existing) {
    existing.settings = { ...existing.settings, ...(settings || {}) };
  } else {
    subs.push({
      chatId: String(chatId),
      settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
      createdAt: Date.now()
    });
  }
  await writeSubs(subs);
  res.status(201).json({ ok: true });
});

// ---- API: 등록 해제 ----
app.post('/api/unregister', async (req, res) => {
  const { chatId } = req.body || {};
  let subs = await readSubs();
  subs = subs.filter(s => String(s.chatId) !== String(chatId));
  await writeSubs(subs);
  res.json({ ok: true });
});

// ---- API: 개인 설정 조회/저장 (chatId 기준) ----
app.get('/api/settings', async (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.json({ ...DEFAULT_SETTINGS, registered: false });
  const subs = await readSubs();
  const sub = findSub(subs, chatId);
  res.json(sub ? { ...sub.settings, registered: true } : { ...DEFAULT_SETTINGS, registered: false });
});

app.post('/api/settings', async (req, res) => {
  const { chatId, ...newSettings } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const subs = await readSubs();
  const sub = findSub(subs, chatId);
  if (!sub) return res.status(404).json({ error: 'not registered. 먼저 텔레그램 연동을 완료하세요.' });
  sub.settings = { ...sub.settings, ...newSettings };
  await writeSubs(subs);
  res.json(sub.settings);
});

// ---- 환율 조회 ----
let baselineUsd = null;
let baselineJpy = null;

// 네이버 검색 "환율" 계산기 위젯이 쓰는 API. 비공식이지만 오래되고 안정적으로 쓰여온 엔드포인트라
// 무료 환율 API(하루 1회 갱신)보다 훨씬 자주 갱신된 값을 준다. 실패하면 fallback으로 전환.
function naverRateUrl(code, amount) {
  return `https://m.search.naver.com/p/csearch/content/qapirender.nhn?key=calculator&pkid=141` +
    `&q=${encodeURIComponent('환율')}&where=m&u1=keb&u6=standardUnit&u7=0&u3=${code}&u4=KRW&u8=down&u2=${amount}`;
}

function parseNaverValue(json) {
  const raw = json && json.country && json.country[1] && json.country[1].value;
  if (raw === undefined || raw === null) throw new Error('unexpected naver response shape');
  const num = parseFloat(String(raw).replace(/,/g, ''));
  if (!isFinite(num)) throw new Error('naver value parse failed');
  return num;
}

const NAVER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Referer': 'https://m.search.naver.com/'
};

async function fetchFromNaver() {
  const [usdRes, jpyRes] = await Promise.all([
    fetch(naverRateUrl('USD', 1), { headers: NAVER_HEADERS }),
    fetch(naverRateUrl('JPY', 100), { headers: NAVER_HEADERS })
  ]);
  const [usdJson, jpyJson] = await Promise.all([usdRes.json(), jpyRes.json()]);
  return {
    usdToKrw: parseNaverValue(usdJson),
    jpyToKrw: parseNaverValue(jpyJson),
    source: 'naver'
  };
}

async function fetchFromFallback() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  const data = await res.json();
  if (data.result !== 'success') throw new Error('rate api error');
  const krw = data.rates.KRW;
  const jpy = data.rates.JPY;
  return {
    usdToKrw: krw,
    jpyToKrw: (krw / jpy) * 100,
    lastUpdateUtc: data.time_last_update_utc || null,
    nextUpdateUtc: data.time_next_update_utc || null,
    source: 'fallback'
  };
}

async function fetchRates() {
  try {
    return await fetchFromNaver();
  } catch (err) {
    console.warn('네이버 환율 조회 실패, 대체 API로 전환:', err.message);
    return await fetchFromFallback();
  }
}

// ---- 변동 알림 체크 (구독자별 임계값 적용) ----
async function checkThresholdAndAlert() {
  try {
    const { usdToKrw, jpyToKrw } = await fetchRates();

    if (baselineUsd !== null && baselineJpy !== null) {
      const usdDiff = usdToKrw - baselineUsd;
      const usdPct = (usdDiff / baselineUsd) * 100;
      const jpyDiff = jpyToKrw - baselineJpy;
      const jpyPct = (jpyDiff / baselineJpy) * 100;

      const subs = await readSubs();
      const survivors = [];
      for (const s of subs) {
        const { unit, threshold } = s.settings || DEFAULT_SETTINGS;
        const th = parseFloat(threshold) || 0;
        let keep = true;

        if (th > 0) {
          const usdExceeded = unit === 'percent' ? Math.abs(usdPct) >= th : Math.abs(usdDiff) >= th;
          if (usdExceeded) {
            keep = await sendTelegramMessage(s.chatId,
              `💱 원/달러 환율 변동 알림\n${usdDiff > 0 ? '상승' : '하락'} ${Math.abs(usdDiff).toFixed(2)}원 (${usdPct.toFixed(2)}%) → 현재 ${usdToKrw.toFixed(2)}원`
            );
          }
          if (keep) {
            const jpyExceeded = unit === 'percent' ? Math.abs(jpyPct) >= th : Math.abs(jpyDiff) >= th;
            if (jpyExceeded) {
              keep = await sendTelegramMessage(s.chatId,
                `💱 원/100엔 환율 변동 알림\n${jpyDiff > 0 ? '상승' : '하락'} ${Math.abs(jpyDiff).toFixed(2)}원 (${jpyPct.toFixed(2)}%) → 현재 ${jpyToKrw.toFixed(2)}원`
              );
            }
          }
        }
        if (keep) survivors.push(s);
      }
      await writeSubs(survivors);
    }

    baselineUsd = usdToKrw;
    baselineJpy = jpyToKrw;
  } catch (err) {
    console.error('환율 체크 실패:', err.message);
  }
}

// 5분마다 환율 조회 + 변동 알림 체크
cron.schedule('*/5 * * * *', checkThresholdAndAlert);
checkThresholdAndAlert(); // 서버 시작 시 1회 baseline 설정

// 매분 스케줄 알림 체크 (정각 / 5분 단위, 구독자별 on/off)
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const minutes = now.getMinutes();
  const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

  const isHourMark = minutes === 0;
  const isFiveMark = minutes % 5 === 0;
  if (!isFiveMark) return;

  let usdText = '--';
  let jpyText = '--';
  try {
    const { usdToKrw, jpyToKrw } = await fetchRates();
    usdText = usdToKrw.toFixed(2) + '원';
    jpyText = jpyToKrw.toFixed(2) + '원';
  } catch (e) { /* ignore */ }

  const subs = await readSubs();
  const survivors = [];
  for (const s of subs) {
    const { hourly, fiveMin } = s.settings || DEFAULT_SETTINGS;
    let keep = true;
    if (isHourMark && hourly) {
      keep = await sendTelegramMessage(s.chatId, `⏰ 정시 환율 알림\n${timeStr} · USD/KRW ${usdText} · JPY100/KRW ${jpyText}`);
    } else if (fiveMin) {
      keep = await sendTelegramMessage(s.chatId, `⏰ 5분 환율 알림\n${timeStr} · USD/KRW ${usdText} · JPY100/KRW ${jpyText}`);
    }
    if (keep) survivors.push(s);
  }
  await writeSubs(survivors);
});

// ---- 현재 환율 조회 API (프론트 표시용) ----
app.get('/api/rates', async (req, res) => {
  try {
    const rates = await fetchRates();
    res.json(rates);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 저장소 상태 확인 (디버그용) ----
app.get('/api/storage-status', (req, res) => {
  res.json({ cloud: useCloudStore });
});

// ---- 테스트 메시지 ----
app.post('/api/test-notify', async (req, res) => {
  const { chatId } = req.body || {};
  const subs = await readSubs();
  const sub = chatId ? findSub(subs, chatId) : null;
  if (!sub) return res.status(404).json({ error: 'not registered' });
  await sendTelegramMessage(sub.chatId, '✅ 테스트 메시지 - 텔레그램 알림이 정상 동작합니다.');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));

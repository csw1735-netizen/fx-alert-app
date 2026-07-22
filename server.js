const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const webpush = require('web-push');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const SUB_FILE = path.join(DATA_DIR, 'subscriptions.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SUB_FILE)) fs.writeFileSync(SUB_FILE, '[]');
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    unit: 'percent',
    threshold: 0.5,
    hourly: false,
    fiveMin: false
  }, null, 2));
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- VAPID setup ----
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

let vapidReady = false;
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn('[경고] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 환경변수가 없습니다. ' +
    '"npm run generate-keys" 로 키를 생성한 뒤 환경변수로 설정하세요. ' +
    '키가 없으면 푸시 알림이 동작하지 않습니다.');
} else {
  try {
    webpush.setVapidDetails(
      'mailto:example@example.com',
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
    vapidReady = true;
  } catch (err) {
    console.error('[오류] VAPID 키가 올바르지 않습니다. generate-vapid-keys.js 로 새로 생성하세요:', err.message);
  }
}

// ---- API: 공개 키 조회 ----
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidReady ? VAPID_PUBLIC_KEY : null });
});

// ---- API: 구독 등록 ----
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'invalid subscription' });
  }
  const subs = readJSON(SUB_FILE) || [];
  const exists = subs.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subs.push(subscription);
    writeJSON(SUB_FILE, subs);
  }
  res.status(201).json({ ok: true });
});

// ---- API: 구독 해제 ----
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  let subs = readJSON(SUB_FILE) || [];
  subs = subs.filter(s => s.endpoint !== endpoint);
  writeJSON(SUB_FILE, subs);
  res.json({ ok: true });
});

// ---- API: 설정 조회/저장 ----
app.get('/api/settings', (req, res) => {
  res.json(readJSON(SETTINGS_FILE) || {});
});
app.post('/api/settings', (req, res) => {
  const current = readJSON(SETTINGS_FILE) || {};
  const updated = { ...current, ...req.body };
  writeJSON(SETTINGS_FILE, updated);
  res.json(updated);
});

// ---- 푸시 전송 유틸 ----
async function sendPushToAll(payload) {
  if (!vapidReady) {
    console.warn('VAPID 키 미설정으로 푸시 전송 생략');
    return;
  }
  const subs = readJSON(SUB_FILE) || [];
  const payloadStr = JSON.stringify(payload);
  const stillValid = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payloadStr);
      stillValid.push(sub);
    } catch (err) {
      // 410/404 등이면 만료된 구독이므로 제거
      if (err.statusCode !== 410 && err.statusCode !== 404) {
        stillValid.push(sub);
      }
      console.warn('push 실패:', err.statusCode || err.message);
    }
  }
  writeJSON(SUB_FILE, stillValid);
}

// ---- 환율 조회 & 변동 체크 ----
let baselineUsd = null;
let baselineJpy = null;

async function fetchRates() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  const data = await res.json();
  if (data.result !== 'success') throw new Error('rate api error');
  const krw = data.rates.KRW;
  const jpy = data.rates.JPY;
  const usdToKrw = krw;
  const jpyToKrw = (krw / jpy) * 100;
  return { usdToKrw, jpyToKrw };
}

async function checkThresholdAndAlert() {
  try {
    const { usdToKrw, jpyToKrw } = await fetchRates();
    const settings = readJSON(SETTINGS_FILE) || {};
    const unit = settings.unit || 'percent';
    const threshold = parseFloat(settings.threshold) || 0;

    if (threshold > 0) {
      if (baselineUsd !== null) {
        const diff = usdToKrw - baselineUsd;
        const pct = (diff / baselineUsd) * 100;
        const exceeded = unit === 'percent' ? Math.abs(pct) >= threshold : Math.abs(diff) >= threshold;
        if (exceeded) {
          await sendPushToAll({
            title: '💱 원/달러 환율 변동 알림',
            body: `${diff > 0 ? '상승' : '하락'} ${Math.abs(diff).toFixed(2)}원 (${pct.toFixed(2)}%) → 현재 ${usdToKrw.toFixed(2)}원`
          });
        }
      }
      if (baselineJpy !== null) {
        const diff = jpyToKrw - baselineJpy;
        const pct = (diff / baselineJpy) * 100;
        const exceeded = unit === 'percent' ? Math.abs(pct) >= threshold : Math.abs(diff) >= threshold;
        if (exceeded) {
          await sendPushToAll({
            title: '💱 원/100엔 환율 변동 알림',
            body: `${diff > 0 ? '상승' : '하락'} ${Math.abs(diff).toFixed(2)}원 (${pct.toFixed(2)}%) → 현재 ${jpyToKrw.toFixed(2)}원`
          });
        }
      }
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

// 매분 스케줄 알림 체크 (정각 / 5분 단위)
cron.schedule('* * * * *', async () => {
  const settings = readJSON(SETTINGS_FILE) || {};
  const now = new Date();
  const minutes = now.getMinutes();
  const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

  let usdText = '--';
  let jpyText = '--';
  try {
    const { usdToKrw, jpyToKrw } = await fetchRates();
    usdText = usdToKrw.toFixed(2) + '원';
    jpyText = jpyToKrw.toFixed(2) + '원';
  } catch (e) { /* ignore, 알림은 시간 정보만이라도 보냄 */ }

  if (minutes === 0 && settings.hourly) {
    await sendPushToAll({
      title: '⏰ 정시 환율 알림',
      body: `${timeStr} · USD/KRW ${usdText} · JPY100/KRW ${jpyText}`
    });
  } else if (minutes % 5 === 0 && settings.fiveMin) {
    await sendPushToAll({
      title: '⏰ 5분 환율 알림',
      body: `${timeStr} · USD/KRW ${usdText} · JPY100/KRW ${jpyText}`
    });
  }
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

// ---- 테스트 알림 ----
app.post('/api/test-notify', async (req, res) => {
  await sendPushToAll({ title: '테스트 알림', body: '푸시 알림이 정상 동작합니다.' });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));

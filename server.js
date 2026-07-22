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

const DEFAULT_SETTINGS = {
  unit: 'percent',
  threshold: 0.5,
  hourly: false,
  fiveMin: false
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SUB_FILE)) fs.writeFileSync(SUB_FILE, '[]');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// 구독자 목록: [{ subscription: {endpoint, keys}, settings: {...}, createdAt }]
function readSubs() {
  return readJSON(SUB_FILE) || [];
}
function writeSubs(subs) {
  writeJSON(SUB_FILE, subs);
}
function findSub(subs, endpoint) {
  return subs.find(s => s.subscription.endpoint === endpoint);
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

// ---- API: 구독 등록 (구독 시점의 개인 설정도 함께 저장) ----
app.post('/api/subscribe', (req, res) => {
  const { subscription, settings } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'invalid subscription' });
  }
  const subs = readSubs();
  const existing = findSub(subs, subscription.endpoint);
  if (existing) {
    existing.subscription = subscription;
    if (settings) existing.settings = { ...existing.settings, ...settings };
  } else {
    subs.push({
      subscription,
      settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
      createdAt: Date.now()
    });
  }
  writeSubs(subs);
  res.status(201).json({ ok: true });
});

// ---- API: 구독 해제 ----
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  let subs = readSubs();
  subs = subs.filter(s => s.subscription.endpoint !== endpoint);
  writeSubs(subs);
  res.json({ ok: true });
});

// ---- API: 개인 설정 조회/저장 (endpoint 기준) ----
app.get('/api/settings', (req, res) => {
  const { endpoint } = req.query;
  if (!endpoint) return res.json(DEFAULT_SETTINGS);
  const subs = readSubs();
  const sub = findSub(subs, endpoint);
  res.json(sub ? sub.settings : DEFAULT_SETTINGS);
});

app.post('/api/settings', (req, res) => {
  const { endpoint, ...newSettings } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  const subs = readSubs();
  const sub = findSub(subs, endpoint);
  if (!sub) return res.status(404).json({ error: 'subscription not found. 먼저 알림을 켜주세요.' });
  sub.settings = { ...sub.settings, ...newSettings };
  writeSubs(subs);
  res.json(sub.settings);
});

// ---- 푸시 전송 유틸 (특정 구독자 1명에게) ----
async function sendPushTo(subEntry, payload) {
  if (!vapidReady) return true; // 키 없으면 조용히 skip, 구독은 유지
  const payloadStr = JSON.stringify(payload);
  try {
    await webpush.sendNotification(subEntry.subscription, payloadStr);
    return true;
  } catch (err) {
    console.warn('push 실패:', err.statusCode || err.message);
    // 410/404 = 만료된 구독 -> 제거 대상
    if (err.statusCode === 410 || err.statusCode === 404) return false;
    return true;
  }
}

async function sendPushToAllRaw(payload) {
  if (!vapidReady) {
    console.warn('VAPID 키 미설정으로 푸시 전송 생략');
    return;
  }
  const subs = readSubs();
  const survivors = [];
  for (const s of subs) {
    const keep = await sendPushTo(s, payload);
    if (keep) survivors.push(s);
  }
  writeSubs(survivors);
}

// ---- 환율 조회 ----
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

// ---- 변동 알림 체크 (구독자별 임계값 적용, 최신 알림만 남도록 tag 지정) ----
async function checkThresholdAndAlert() {
  try {
    const { usdToKrw, jpyToKrw } = await fetchRates();

    if (baselineUsd !== null && baselineJpy !== null) {
      const usdDiff = usdToKrw - baselineUsd;
      const usdPct = (usdDiff / baselineUsd) * 100;
      const jpyDiff = jpyToKrw - baselineJpy;
      const jpyPct = (jpyDiff / baselineJpy) * 100;

      const subs = readSubs();
      const survivors = [];
      for (const s of subs) {
        const { unit, threshold } = s.settings || DEFAULT_SETTINGS;
        const th = parseFloat(threshold) || 0;
        let keep = true;

        if (th > 0) {
          const usdExceeded = unit === 'percent' ? Math.abs(usdPct) >= th : Math.abs(usdDiff) >= th;
          if (usdExceeded) {
            keep = await sendPushTo(s, {
              title: '💱 원/달러 환율 변동 알림',
              body: `${usdDiff > 0 ? '상승' : '하락'} ${Math.abs(usdDiff).toFixed(2)}원 (${usdPct.toFixed(2)}%) → 현재 ${usdToKrw.toFixed(2)}원`,
              tag: 'fx-usd-threshold'
            });
          }
          if (keep) {
            const jpyExceeded = unit === 'percent' ? Math.abs(jpyPct) >= th : Math.abs(jpyDiff) >= th;
            if (jpyExceeded) {
              keep = await sendPushTo(s, {
                title: '💱 원/100엔 환율 변동 알림',
                body: `${jpyDiff > 0 ? '상승' : '하락'} ${Math.abs(jpyDiff).toFixed(2)}원 (${jpyPct.toFixed(2)}%) → 현재 ${jpyToKrw.toFixed(2)}원`,
                tag: 'fx-jpy-threshold'
              });
            }
          }
        }
        if (keep) survivors.push(s);
      }
      writeSubs(survivors);
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

// 매분 스케줄 알림 체크 (정각 / 5분 단위, 구독자별 on/off, 같은 tag로 최신만 유지)
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const minutes = now.getMinutes();
  const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

  let usdText = '--';
  let jpyText = '--';
  try {
    const { usdToKrw, jpyToKrw } = await fetchRates();
    usdText = usdToKrw.toFixed(2) + '원';
    jpyText = jpyToKrw.toFixed(2) + '원';
  } catch (e) { /* ignore */ }

  const isHourMark = minutes === 0;
  const isFiveMark = minutes % 5 === 0;
  if (!isFiveMark) return; // 정각도 5분의 배수이므로 5분 단위가 아니면 아무도 대상 없음

  const subs = readSubs();
  const survivors = [];
  for (const s of subs) {
    const { hourly, fiveMin } = s.settings || DEFAULT_SETTINGS;
    let keep = true;
    if (isHourMark && hourly) {
      keep = await sendPushTo(s, {
        title: '⏰ 정시 환율 알림',
        body: `${timeStr} · USD/KRW ${usdText} · JPY100/KRW ${jpyText}`,
        tag: 'fx-schedule'
      });
    } else if (fiveMin) {
      keep = await sendPushTo(s, {
        title: '⏰ 5분 환율 알림',
        body: `${timeStr} · USD/KRW ${usdText} · JPY100/KRW ${jpyText}`,
        tag: 'fx-schedule'
      });
    }
    if (keep) survivors.push(s);
  }
  writeSubs(survivors);
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

// ---- 테스트 알림 (요청한 사람에게만) ----
app.post('/api/test-notify', async (req, res) => {
  const { endpoint } = req.body || {};
  const subs = readSubs();
  const sub = endpoint ? findSub(subs, endpoint) : null;
  if (!sub) return res.status(404).json({ error: 'subscription not found' });
  await sendPushTo(sub, { title: '테스트 알림', body: '푸시 알림이 정상 동작합니다.', tag: 'fx-test' });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));

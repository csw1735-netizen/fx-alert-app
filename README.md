# 환율 알림 (Telegram Bot)

원/달러, 원/엔 환율을 서버가 5분마다 체크해서, 지정한 기준 이상 변동하면 텔레그램으로 메시지를 보냅니다.
매시 정각 / 5분 단위 정기 알림도 켤 수 있습니다.

**왜 Web Push 대신 텔레그램인가?** 브라우저 Web Push는 삼성/샤오미/화웨이 등 일부 안드로이드 제조사의
배터리 최적화 때문에 화면을 끄고 몇 분 지나면 알림이 끊기는 경우가 흔합니다. 텔레그램은 자체 푸시 채널을
쓰기 때문에 이 문제에서 자유롭고, 훨씬 안정적으로 옵니다.

## 1단계. 텔레그램 봇 만들기

1. 텔레그램 앱에서 `@BotFather` 검색해서 대화 시작
2. `/newbot` 입력 → 봇 이름 입력 → 봇 아이디(예: `my_fx_alert_bot`) 입력
3. 완료되면 아래처럼 토큰이 나옵니다:
   ```
   Use this token to access the HTTP API:
   123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   이 토큰을 메모해두세요. (배포 시 환경변수로 넣습니다.)

## 2단계. GitHub에 올리기 / 업데이트

```bash
cd fx-alert-app
git add .
git commit -m "switch to telegram"
git push
```

(이미 GitHub 저장소가 연결되어 있다면 push만 하면 됩니다.)

## 3단계. Render 환경변수 설정

Render 대시보드 → 서비스 선택 → Environment 탭:
- `TELEGRAM_BOT_TOKEN` = 1단계에서 받은 토큰 값
- 기존에 있던 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`는 더 이상 필요 없으니 삭제해도 됩니다.

저장하면 자동으로 재배포됩니다.

## 4단계. 내 Chat ID 확인하기

1. 텔레그램에서 1단계에서 만든 내 봇을 검색해서 대화 시작
2. 봇에게 아무 메시지나 하나 보내기 (예: "안녕")
3. 브라우저에서 아래 주소 접속 (토큰 부분만 본인 것으로 교체):
   ```
   https://api.telegram.org/bot<내토큰>/getUpdates
   ```
4. 결과 JSON에서 `"chat":{"id":123456789, ...}` 부분의 숫자를 찾으면 그게 내 Chat ID

## 5단계. 웹앱에서 연동

1. 배포된 URL 접속
2. "내 Chat ID" 칸에 4단계에서 찾은 숫자 입력 → "연동/저장" 클릭
3. 변동 기준(%나 원), 정기 알림(정각/5분) 설정
4. "테스트 메시지 보내기"로 정상 수신 확인

이후로는 텔레그램 앱만 설치되어 있으면 폰이 잠자기 상태여도 알림이 옵니다.

## 참고: Render 무료 플랜 슬립 방지

Render 무료 플랜은 15분간 요청이 없으면 서버가 잠들어서 cron 알림도 멈춥니다. UptimeRobot(무료)으로
5분마다 배포 URL을 핑(ping)해서 계속 깨어있게 유지하세요:

1. https://uptimerobot.com 가입
2. New Monitor → HTTP(s) → URL: `https://<배포주소>/api/settings` → Interval: 5 minutes

## 로컬에서 테스트하기

```bash
npm install
TELEGRAM_BOT_TOKEN=... npm start
```

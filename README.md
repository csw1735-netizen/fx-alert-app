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

## 3단계. Upstash Redis 만들기 (구독 정보를 클라우드에 영구 저장)

Render 무료 플랜은 재배포할 때마다 서버의 로컬 파일이 초기화됩니다. 즉 이 단계를 건너뛰면
코드를 업데이트해서 재배포할 때마다 등록했던 Chat ID와 설정이 사라집니다. Upstash(무료)를
연결하면 재배포와 무관하게 계속 유지됩니다.

1. https://upstash.com 접속 → 무료 계정 가입 (GitHub 계정으로 바로 가입 가능)
2. 대시보드에서 "Create Database" 클릭
3. 이름 아무거나 입력, Type은 "Regional", Region은 가까운 곳(도쿄 등) 선택 → 생성
4. 생성된 데이터베이스 페이지에서 "REST API" 섹션 찾기 → 여기 두 값을 메모:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

## 4단계. 봇 도메인 등록 (Telegram Login Widget 필수 조건)

로그인 위젯이 동작하려면 봇에 "이 도메인에서 로그인 위젯을 써도 된다"고 등록해줘야 합니다.

1. `@BotFather` 대화에서 `/setdomain` 입력
2. 내 봇 선택
3. 배포된 도메인 입력 (https:// 빼고, 예: `fx-alert-app-4xfw.onrender.com`)

## 5단계. Render 환경변수 설정

Render 대시보드 → 서비스 선택 → Environment 탭에 아래 항목 추가:
- `TELEGRAM_BOT_TOKEN` = 1단계에서 받은 토큰 값
- `TELEGRAM_BOT_USERNAME` = 봇 사용자명 (`@` 빼고, 예: `my_fx_alert_bot`)
- `SESSION_SECRET` = 아무 임의의 긴 문자열 (예: 32자 이상 랜덤 문자열. 로그인 세션 서명에 사용, 없으면
  서버 재시작마다 로그인이 풀림)
- `UPSTASH_REDIS_REST_URL` = 3단계에서 받은 URL
- `UPSTASH_REDIS_REST_TOKEN` = 3단계에서 받은 토큰
- 기존에 있던 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`는 더 이상 필요 없으니 삭제해도 됩니다.

저장하면 자동으로 재배포됩니다. 배포 후 `https://<배포주소>/api/storage-status` 접속했을 때
`{"cloud":true}`가 나오면 클라우드 저장이 정상적으로 연결된 것입니다. (Upstash를 설정하지 않아도
앱은 동작하지만, 그 경우 재배포할 때마다 등록 정보가 초기화됩니다.)

## 6단계. 로그인해서 사용하기

1. 배포된 URL 접속
2. "Log in with Telegram" 버튼 클릭 → 텔레그램 로그인 승인
3. 로그인되면 자동으로 내 계정에 연결됨 (Chat ID를 직접 찾을 필요 없음)
4. 변동 기준(%나 원), 정기 알림(정각/5분) 설정 — 저장은 자동으로 됨
5. "테스트 메시지 보내기"로 정상 수신 확인

로그인은 텔레그램이 서명으로 본인 확인을 해주기 때문에, 다른 사람이 내 Chat ID를 안다고 해도 내 설정을
바꿀 수 없습니다. 어느 기기에서 로그인하든 항상 내 계정 설정 그대로 불러와집니다.

봇과 아직 대화를 시작한 적이 없다면 "테스트 메시지 보내기"가 실패할 수 있습니다 — 텔레그램에서 내 봇을
검색해 아무 메시지나 한 번 보낸 뒤 다시 시도하세요.

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

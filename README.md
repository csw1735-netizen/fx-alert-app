# 환율 알림 (Web Push)

원/달러, 원/엔 환율을 서버가 5분마다 체크해서, 지정한 기준 이상 변동하면 폰으로 푸시 알림을 보냅니다.
매시 정각 / 5분 단위 정기 알림도 켤 수 있습니다. **서버가 알림을 보내주기 때문에, 폰에서 앱(브라우저 탭)을
완전히 꺼두어도 알림이 옵니다.** (단, 폰 알림 권한은 허용해야 하고, 인터넷에 연결되어 있어야 합니다.)

## 배포 전 준비물

- GitHub 계정 (코드를 올릴 저장소)
- Render.com 계정 (무료 플랜으로 충분합니다) — https://render.com
- Node.js가 설치된 컴퓨터 (VAPID 키 생성용, 최초 1회만 필요)

## 1단계. VAPID 키 생성 (로컬 컴퓨터에서 1회)

터미널에서 이 폴더로 이동한 뒤:

```bash
npm install
npm run generate-keys
```

다음과 같은 출력이 나옵니다:

```
VAPID_PUBLIC_KEY=BN...
VAPID_PRIVATE_KEY=abc...
```

이 두 값을 메모해두세요. (배포 시 환경변수로 넣습니다.)

## 2단계. GitHub에 올리기

이 폴더(`fx-alert-app`) 전체를 새 GitHub 저장소에 push 합니다.

```bash
cd fx-alert-app
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin <본인의 GitHub 저장소 URL>
git push -u origin main
```

## 3단계. Render.com 배포

1. https://render.com 가입/로그인
2. "New +" → "Web Service" 선택
3. 방금 만든 GitHub 저장소 연결
4. 설정값:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. "Environment" 탭에서 환경변수 추가:
   - `VAPID_PUBLIC_KEY` = 1단계에서 얻은 값
   - `VAPID_PRIVATE_KEY` = 1단계에서 얻은 값
6. "Create Web Service" 클릭 → 배포 완료되면 `https://xxxx.onrender.com` 같은 URL이 생성됩니다.

> 무료 플랜은 일정 시간 요청이 없으면 슬립 상태가 될 수 있습니다. 슬립 중에는 정각/변동 체크 cron이 잠시
> 멈출 수 있어요. 완전히 끊김 없는 24시간 동작을 원하면 유료 플랜(가장 저렴한 단계)으로 올리는 걸 권장합니다.

## 4단계. 폰에서 설치

1. 폰 브라우저(크롬/사파리)로 배포된 URL 접속
2. "폰 알림 켜기" 버튼 눌러서 알림 권한 허용
3. 브라우저 메뉴에서 "홈 화면에 추가" / "앱 설치" 선택 → 홈 화면에 아이콘 생김
4. 원하는 변동 기준(%, 원)과 정기 알림(정각/5분)을 설정

이후로는 앱을 실행해두지 않아도 서버가 조건을 만족할 때마다 폰으로 알림을 보냅니다.

## iOS 참고사항

iOS는 16.4 버전 이상이어야 웹 푸시를 지원하며, 반드시 "홈 화면에 추가"로 설치한 후에만 알림 권한 요청과
푸시 수신이 가능합니다(사파리 탭 상태로는 동작하지 않음).

## 로컬에서 테스트하기

```bash
npm install
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... npm start
```

브라우저에서 `http://localhost:3000` 접속 (단, 로컬 http 환경에서는 iOS 실기기 테스트가 안 되니
실제 폰 테스트는 배포 후 진행하세요.)

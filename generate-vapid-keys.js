// VAPID 키 생성 스크립트. 한 번만 실행해서 나온 값을 .env / 환경변수에 저장하세요.
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);

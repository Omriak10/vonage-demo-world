// Take Me - RCS demo video host (VCR). Two public player pages:
//   /order-taxi      - order a taxi + live map + opt-out
//   /discount-offer  - 20% off next ride rich card + opt-out
// Raw files under /media/*. No auth - meant to be shared with anyone.
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.NERU_APP_PORT || process.env.PORT || 3000;

app.use('/media', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/_/health', (req, res) => res.status(200).send('OK'));

function player(title, sub, file) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - Take Me</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;background:linear-gradient(150deg,#0b2431 0%,#123d52 55%,#0e7fb0 130%);font-family:'Segoe UI',Roboto,Arial,sans-serif;color:#fff;display:flex;flex-direction:column;align-items:center;padding:34px 16px 50px}
.brand{display:flex;align-items:center;gap:13px;margin-bottom:8px}
.brand img{width:52px;height:52px;border-radius:13px}
.brand b{font-size:24px;letter-spacing:.3px}
.sub{color:#a9cfe3;font-size:15px;margin-bottom:26px;text-align:center;max-width:520px}
video{width:min(92vw,380px);border-radius:26px;box-shadow:0 40px 90px -30px rgba(0,0,0,.65);display:block;background:#000}
.foot{margin-top:26px;color:#7fa9c0;font-size:12.5px}
</style></head><body>
<div class="brand"><img src="/media/takeme_logo.png" alt="Take Me"><b>Take Me</b></div>
<div class="sub">${sub}</div>
<video src="/media/${file}" controls autoplay muted playsinline loop></video>
<div class="foot">RCS Business Messaging demo &middot; powered by Vonage</div>
</body></html>`;
}

app.get('/order-taxi', (req, res) => res.type('html').send(player(
  'Order a taxi on RCS',
  'Order a ride in the chat, watch your taxi arrive on the live map - with a one-tap opt-out.',
  'TakeMe-RCS-Order-Taxi.mp4')));

app.get('/discount-offer', (req, res) => res.type('html').send(player(
  '20% off your next ride',
  'A rich discount card with promo code and booking button - with a one-tap opt-out.',
  'TakeMe-RCS-Discount-Offer.mp4')));

app.get('/', (req, res) => res.type('html').send(
  '<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>Take Me - RCS demo videos</h2><ul><li><a href="/order-taxi">Order a taxi (map + opt-out)</a></li><li><a href="/discount-offer">Discount offer (rich card + opt-out)</a></li></ul></body>'));

app.listen(PORT, () => console.log('TakeMe video host on :' + PORT));

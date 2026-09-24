// Wayfair Hot Deals - RCS deals bot + mini storefront with demo checkout
// (Google Pay / Apple Pay / card - simulated). Mounted at /wf on the avon-skin
// VCR instance (account VCR project quota - shares the host, nothing else).
// Trigger word WAYFAIR arrives via the Demo-World fan-out (POST /wf/trigger).
// Includes abandoned-cart win-back: leave checkout unpaid -> 5s later a rich
// card offers an extra 10% (COMEBACK10), applied when reopening the webview.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const BP = '/wf'; // mount path - every internal link must carry it
const HOST = process.env.BASE_URL || 'https://<your-vcr-avon-skin-instance>';
const BASE = HOST + BP;
const RCS_APP_ID = process.env.RCS_APP_ID || '';
const RCS_SENDER = process.env.RCS_SENDER || '';
const PRIVATE_KEY = fs.readFileSync(path.join(__dirname, process.env.VONAGE_PRIVATE_KEY_FILE || 'private.key'), 'utf8');

router.use('/img', (req, res) => res.redirect(302, (process.env.ASSET_BASE || '') + '/wf-img' + req.path));

// ---------------------------------------------------------------------------
const DEALS = {
  sofa: { name: 'Andover Mills™ Amia 3-Seater Velvet Sofa', was: 899, now: 499, tag: 'Best seller' },
  armchair: { name: 'Mercury Row® Kaine Armchair & Lamp Set', was: 349, now: 199, tag: 'Bundle deal' },
  lamp: { name: 'Kelly Clarkson Home Beatrice Accent Chair', was: 279, now: 149, tag: 'Clearance' },
  bed: { name: 'Wayfair Sleep™ Odette Upholstered King Bed', was: 559, now: 299, tag: 'Flash deal' },
  rug: { name: '17 Stories Nordic Diamond Rug 160x230', was: 189, now: 79, tag: 'Lowest ever' },
  desk: { name: 'Ebern Designs Halvar Home Office Desk', was: 259, now: 139, tag: 'WFH pick' },
  dining: { name: 'Three Posts™ Solene 6-Seat Dining Set', was: 899, now: 549, tag: 'Big save' },
  shelf: { name: 'Zipcode Design™ Ada Wide Bookcase', was: 219, now: 119, tag: 'Clearance' },
};
const pct = (d) => Math.round((1 - d.now / d.was) * 100);
const DID = (id) => DEALS[id] ? id : null;

// ---- RCS helpers (same proven pattern as the Avon bot) ----------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ application_id: RCS_APP_ID, iat: now, exp: now + 900, jti: crypto.randomUUID() }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(header + '.' + payload), PRIVATE_KEY);
  return header + '.' + payload + '.' + b64url(sig);
}
async function sendRcs(to, body) {
  const payload = Object.assign({ channel: 'rcs', to, from: RCS_SENDER }, body);
  const res = await fetch('https://api.nexmo.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + makeJwt() },
    body: JSON.stringify(payload)
  });
  console.log('[WF RCS]', res.status, (await res.text() || '').slice(0, 160));
  return res.status;
}
const webviewBtn = (text, url, mode) => ({
  action: { text: text.slice(0, 25), postbackData: 'wf_open_' + text.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 18),
    openUrlAction: { url, application: 'WEBVIEW', webviewViewMode: mode || 'TALL', description: 'Wayfair' } }
});
const replyBtn = (text, data) => ({ reply: { text: text.slice(0, 25), postbackData: data } });

function dealCard(id, msisdn) {
  const d = DEALS[id];
  const u = msisdn ? `&u=${encodeURIComponent(msisdn)}` : '';
  return {
    title: d.name.slice(0, 80),
    description: `Was £${d.was} - NOW £${d.now} (save ${pct(d)}%) · ${d.tag}`.slice(0, 120),
    media: { height: 'MEDIUM', contentInfo: { fileUrl: `${BASE}/img/${id}.jpg`, forceRefresh: false } },
    suggestions: [
      webviewBtn('Buy now', `${BASE}/checkout?p=${id}${u}`, 'TALL'),
      webviewBtn('Details', `${BASE}/p/${id}${u}`, 'HALF')
    ]
  };
}
async function sendDealsCarousel(to, ids, followUp) {
  await sendRcs(to, { message_type: 'custom', custom: { contentMessage: {
    richCard: { carouselCard: { cardWidth: 'MEDIUM', cardContents: ids.map((id) => dealCard(id, to)) } } } } });
  if (followUp) {
    await sendRcs(to, { message_type: 'custom', custom: { contentMessage: {
      text: 'Checkout takes seconds - pay with Google Pay, Apple Pay or card 💳',
      suggestions: [replyBtn('More deals', 'WF_MORE'), webviewBtn('Browse everything', BASE + '/', 'TALL')]
    } } });
  }
}
async function sendWelcome(to) {
  await sendRcs(to, { message_type: 'custom', custom: { contentMessage: {
    richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
      title: 'Wayfair Hot Deals 🔥',
      description: 'Up to 60% off furniture today only. See the hottest deals and check out in seconds with Google Pay, Apple Pay or card.',
      media: { height: 'MEDIUM', contentInfo: { fileUrl: BASE + '/img/hero.jpg', forceRefresh: false } },
      suggestions: [replyBtn('Show hot deals 🔥', 'WF_DEALS'), webviewBtn('Browse the sale', BASE + '/', 'TALL')]
    } } } } } });
}

// ---- Abandoned cart ---------------------------------------------------------
const PROMO = { code: 'COMEBACK10', off: 0.10 };
const promoPrice = (d) => Math.round(d.now * (1 - PROMO.off));
const paid = new Set();
const offered = new Map();
const abandonTimers = new Map();

async function sendAbandonedCard(u, id) {
  const d = DEALS[id];
  await sendRcs(u, { message_type: 'custom', custom: { contentMessage: {
    richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
      title: 'You left this in your basket 🛒',
      description: `${d.name} is still waiting - and it just got better: an EXTRA 10% off with code ${PROMO.code}. £${d.now} → £${promoPrice(d)} for the next hour.`,
      media: { height: 'MEDIUM', contentInfo: { fileUrl: `${BASE}/img/${id}.jpg`, forceRefresh: false } },
      suggestions: [
        webviewBtn(`Checkout -10% · £${promoPrice(d)}`, `${BASE}/checkout?p=${id}&u=${encodeURIComponent(u)}&promo=${PROMO.code}`, 'TALL'),
        replyBtn('Show more deals', 'WF_DEALS')
      ]
    } } } } } });
}
router.post('/abandon', (req, res) => {
  const { u, p } = req.body || {};
  const id = DID(p);
  res.json({ ok: true });
  if (!u || !id) return;
  const key = `${u}|${id}`;
  if (paid.has(key)) return;
  if (offered.has(key) && Date.now() - offered.get(key) < 3600e3) return;
  if (abandonTimers.has(key)) clearTimeout(abandonTimers.get(key));
  abandonTimers.set(key, setTimeout(async () => {
    abandonTimers.delete(key);
    if (paid.has(key)) return;
    offered.set(key, Date.now());
    console.log('[WF ABANDON] win-back ->', u, id);
    try { await sendAbandonedCard(u, id); } catch (e) { console.error('[WF ABANDON]', e.message); }
  }, 5000));
});
router.post('/paid', (req, res) => {
  const { u, p } = req.body || {};
  const id = DID(p);
  if (u && id) {
    const key = `${u}|${id}`;
    paid.add(key);
    if (abandonTimers.has(key)) { clearTimeout(abandonTimers.get(key)); abandonTimers.delete(key); }
    console.log('[WF PAID]', u, id);
  }
  res.json({ ok: true });
});

// ---- POST /wf/trigger - from the Demo-World fan-out { msisdn, text } ------------
router.post('/trigger', async (req, res) => {
  const { msisdn, text } = req.body || {};
  if (!msisdn) return res.status(400).json({ error: 'msisdn required' });
  res.json({ ok: true });
  try {
    const t = String(text || '').trim().toUpperCase();
    if (t === 'WF_DEALS') await sendDealsCarousel(msisdn, ['sofa', 'bed', 'rug', 'dining'], true);
    else if (t === 'WF_MORE') await sendDealsCarousel(msisdn, ['armchair', 'lamp', 'desk', 'shelf'], true);
    else await sendWelcome(msisdn);
  } catch (e) { console.error('[WF TRIGGER]', e.message); }
});

// ---------------------------------------------------------------------------
// Mini Wayfair storefront + demo checkout
// ---------------------------------------------------------------------------
const B = { purple: '#7F187F', sale: '#C6002B', ink: '#252626', bg: '#F7F5F2' };
function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:${B.ink};background:#fff}
.top{display:flex;align-items:center;justify-content:space-between;padding:13px 18px;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff;z-index:5}
.wm{font-weight:800;font-size:23px;color:${B.purple};letter-spacing:-.5px;font-style:italic}
.wm span{color:${B.sale}}
.banner{background:${B.purple};color:#fff;text-align:center;padding:9px;font-size:13px;font-weight:700}
.hero{position:relative}
.hero img{width:100%;max-height:230px;object-fit:cover;display:block}
.hero .ov{position:absolute;inset:0;background:linear-gradient(180deg,transparent 30%,rgba(0,0,0,.55));display:flex;align-items:flex-end;padding:18px}
.hero .ov h1{color:#fff;font-size:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:14px;padding:16px}
.card{border:1px solid #eee;border-radius:12px;overflow:hidden;text-decoration:none;color:inherit;background:#fff;position:relative;display:block}
.card img{width:100%;aspect-ratio:1;object-fit:cover}
.off{position:absolute;top:10px;left:10px;background:${B.sale};color:#fff;font-size:12px;font-weight:800;border-radius:6px;padding:3px 8px}
.card .in{padding:10px}.card .n{font-size:13px;font-weight:600;line-height:1.3;min-height:34px}
.pr{margin-top:6px}.pr .now{color:${B.sale};font-weight:800;font-size:17px}.pr .was{color:#9aa;text-decoration:line-through;font-size:13px;margin-left:6px}
.pd img{width:100%;max-height:330px;object-fit:cover}
.pd .in{padding:20px}.pd h1{font-size:21px}
.btn{display:block;text-align:center;background:${B.purple};color:#fff;font-weight:800;border:none;border-radius:10px;padding:15px;font-size:16px;width:100%;margin-top:12px;text-decoration:none;cursor:pointer;font-family:inherit}
.btn.sale{background:${B.sale}}
.btn.ghost{background:#fff;color:${B.purple};border:2px solid ${B.purple}}
.paybtn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;border-radius:10px;padding:14px;font-size:16px;font-weight:700;border:none;cursor:pointer;margin-top:10px;font-family:inherit}
.apple{background:#000;color:#fff}.gpay{background:#fff;color:#3c4043;border:1.5px solid #dadce0}
.sum{background:${B.bg};border-radius:14px;padding:16px;margin:14px 0;display:flex;gap:14px;align-items:center}
.sum img{width:84px;height:84px;object-fit:cover;border-radius:10px;flex:none}
.row{display:flex;justify-content:space-between;padding:7px 0;font-size:14.5px}
.row.total{font-weight:800;font-size:17px;border-top:1px solid #e5e0da;margin-top:6px;padding-top:12px}
.cardform{border:1.5px solid #dadce0;border-radius:12px;padding:14px;margin-top:10px;display:none}
.cardform input{width:100%;border:1px solid #ddd;border-radius:8px;padding:11px;font:inherit;margin-top:8px}
.cardrow{display:flex;gap:8px}
.done{display:none;text-align:center;padding:34px 20px}
.done .tick{width:74px;height:74px;border-radius:50%;background:#0aa06e;color:#fff;font-size:38px;display:grid;place-items:center;margin:0 auto 16px}
.spin{display:none;text-align:center;padding:40px}
.spin .l{width:44px;height:44px;border:4px solid #eee;border-top-color:${B.purple};border-radius:50%;margin:0 auto;animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
.foot{padding:20px;text-align:center;color:#a7a7a7;font-size:12px}
</style></head><body>
<div class="banner">🔥 HOT DEALS - up to 60% off, today only</div>
<div class="top"><div class="wm">Wayfair<span>.</span></div><div style="font-size:13px;color:#888">Hot Deals demo</div></div>
${body}
<div class="foot">Wayfair Hot Deals demo · powered by Vonage RCS · payments simulated</div>
</body></html>`;
}
const dealTile = (id) => {
  const d = DEALS[id];
  return `<a class="card" href="${BP}/p/${id}"><span class="off">-${pct(d)}%</span><img src="${BP}/img/${id}.jpg" alt="">
  <div class="in"><div class="n">${d.name}</div><div class="pr"><span class="now">£${d.now}</span><span class="was">£${d.was}</span></div></div></a>`;
};

router.get('/', (req, res) => {
  res.send(page('Wayfair Hot Deals', `
    <div class="hero"><img src="${BP}/img/hero.jpg" alt=""><div class="ov"><h1>The Hot Deals event 🔥</h1></div></div>
    <div class="grid">${Object.keys(DEALS).map(dealTile).join('')}</div>`));
});

router.get('/p/:id', (req, res) => {
  const id = DID(req.params.id);
  if (!id) return res.status(404).send(page('Not found', '<div style="padding:30px">Deal not found</div>'));
  const d = DEALS[id];
  const u = String(req.query.u || '').replace(/[^\d]/g, '');
  const uq = u ? `&u=${u}` : '';
  const others = Object.keys(DEALS).filter((x) => x !== id).slice(0, 4).map(dealTile).join('');
  res.send(page(d.name, `
    <div class="pd"><img src="${BP}/img/${id}.jpg" alt="">
    <div class="in"><span class="off" style="position:static">-${pct(d)}% · ${d.tag}</span>
    <h1 style="margin-top:10px">${d.name}</h1>
    <div class="pr" style="margin-top:8px"><span class="now" style="font-size:26px">£${d.now}</span><span class="was" style="font-size:16px">£${d.was}</span></div>
    <p style="color:#666;font-size:14px;margin-top:10px">Free delivery · 30-day returns · in stock and ships within 2 days.</p>
    <a class="btn sale" href="${BP}/checkout?p=${id}${uq}">Buy now - £${d.now}</a>
    <a class="btn ghost" href="${BP}/">Keep browsing</a></div></div>
    <div style="padding:0 16px;font-weight:800;color:${B.purple}">MORE HOT DEALS</div>
    <div class="grid">${others}</div>`));
});

router.get('/checkout', (req, res) => {
  const id = DID(req.query.p) || 'sofa';
  const d = DEALS[id];
  const u = String(req.query.u || '').replace(/[^\d]/g, '');
  const hasPromo = String(req.query.promo || '').toUpperCase() === PROMO.code;
  const total = hasPromo ? promoPrice(d) : d.now;
  const orderNo = 'WF-' + String(Math.abs(id.length * 7919 + total)).padStart(4, '0') + '-DEMO';
  const promoRows = hasPromo
    ? `<div class="row"><span>Subtotal</span><span>£${d.now}.00</span></div>
       <div class="row" style="color:${B.sale};font-weight:800"><span>Promo ${PROMO.code} (-10%)</span><span>-£${d.now - total}.00</span></div>`
    : `<div class="row"><span>Subtotal</span><span>£${d.now}.00</span></div>`;
  const promoBanner = hasPromo
    ? `<div style="background:#0aa06e;color:#fff;border-radius:10px;padding:11px 14px;font-weight:800;font-size:14px;margin-bottom:12px">🎉 Welcome back! Code ${PROMO.code} applied - an extra 10% off your basket.</div>`
    : '';
  res.send(page('Checkout - Wayfair', `
    <div style="padding:18px" id="chk">
      <h1 style="font-size:21px">Checkout</h1>
      <div style="height:8px"></div>${promoBanner}
      <div class="sum"><img src="${BP}/img/${id}.jpg" alt="">
        <div><div style="font-weight:700;font-size:14px">${d.name}</div>
        <div class="pr"><span class="now">£${total}</span><span class="was">£${d.was}</span></div>
        <div style="font-size:12px;color:#0aa06e;font-weight:700">You save £${d.was - total} (${Math.round((1 - total / d.was) * 100)}%)</div></div></div>
      ${promoRows}
      <div class="row"><span>Delivery</span><span style="color:#0aa06e;font-weight:700">FREE</span></div>
      <div class="row total"><span>Total</span><span>£${total}.00</span></div>
      <button class="paybtn apple" onclick="pay('Apple Pay')"> Pay with Apple Pay</button>
      <button class="paybtn gpay" onclick="pay('Google Pay')"><b style="color:#4285F4">G</b><b style="color:#EA4335">o</b><b style="color:#FBBC05">o</b><b style="color:#4285F4">g</b><b style="color:#34A853">l</b><b style="color:#EA4335">e</b>&nbsp;Pay</button>
      <button class="paybtn gpay" onclick="toggleCard()">💳 Pay with card</button>
      <div class="cardform" id="cardform">
        <input placeholder="Card number" inputmode="numeric" maxlength="19">
        <div class="cardrow"><input placeholder="MM/YY" maxlength="5"><input placeholder="CVC" maxlength="4"></div>
        <input placeholder="Name on card">
        <button class="btn sale" onclick="pay('card')">Pay £${total}.00</button>
      </div>
    </div>
    <div class="spin" id="spin"><div class="l"></div><p style="margin-top:14px;color:#888" id="spintxt">Contacting your bank...</p></div>
    <div class="done" id="done"><div class="tick">✓</div>
      <h1 style="font-size:22px">Order confirmed!</h1>
      <p style="color:#666;margin-top:8px">Order <b>${orderNo}</b><br>${d.name}<br>Paid <b>£${total}.00</b>${hasPromo ? ' (extra 10% off applied)' : ''} · arriving in 2-3 days 🚚</p>
      <a class="btn" href="${BP}/" style="max-width:280px;margin:22px auto 0">Back to Hot Deals</a></div>
    <script>
      var U=${JSON.stringify(u)},P=${JSON.stringify(id)},BP=${JSON.stringify(BP)},didPay=false;
      function toggleCard(){var f=document.getElementById('cardform');f.style.display=f.style.display==='block'?'none':'block';}
      function pay(method){
        didPay=true;
        try{fetch(BP+'/paid',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:U,p:P}),keepalive:true});}catch(e){}
        document.getElementById('chk').style.display='none';
        document.getElementById('spin').style.display='block';
        document.getElementById('spintxt').textContent='Authorising with '+method+'...';
        setTimeout(function(){
          document.getElementById('spin').style.display='none';
          document.getElementById('done').style.display='block';
        },1600);
      }
      // Abandoned cart: leaving this page unpaid tells the server - 5s later it
      // sends the win-back rich card with an extra 10% off.
      function abandon(){
        if(didPay||!U)return;
        try{navigator.sendBeacon(BP+'/abandon',new Blob([JSON.stringify({u:U,p:P})],{type:'application/json'}));}
        catch(e){try{fetch(BP+'/abandon',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:U,p:P}),keepalive:true});}catch(_){}}
      }
      document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')abandon();});
      window.addEventListener('pagehide',abandon);
    </script>`));
});

module.exports = router;

// Wayfair Hot Deals - RCS deals bot + mini storefront with a real multi-item
// basket and demo checkout (Google Pay / Apple Pay / card - simulated, using
// the official payment marks self-hosted in /wf/img). Baskets are server-side,
// keyed by the shopper's msisdn (the `u` param carried on every webview link),
// so "Add to basket" works from the RCS cards AND the store, across webviews.
// Abandoned-basket win-back: leave the basket/checkout unpaid -> 5s later a
// rich card offers an extra 10% (COMEBACK10) on the WHOLE basket - reopening
// shows the discount applied.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const router = express.Router();
router.use(express.json({ limit: '2mb' }));
const BP = '/wf';
const HOST = process.env.PUBLIC_BASE || '';
const BASE = HOST + BP;
const RCS_APP_ID = process.env.VONAGE_APP_ID || '';
const RCS_SENDER = process.env.RCS_SENDER || '';
const PRIVATE_KEY = (() => { try { return fs.readFileSync(path.join(__dirname, process.env.VONAGE_PRIVATE_KEY_FILE || 'private.key'), 'utf8'); } catch (e) { return process.env.VONAGE_PRIVATE_KEY || ''; } })();

router.use('/img', express.static(path.join(__dirname, 'public', 'wf-img'), { maxAge: '1d' }));

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

// ---------------------------------------------------------------------------
// Baskets: { [msisdn]: { items: {id: qty}, promo: bool, updatedAt } }
// ---------------------------------------------------------------------------
const PROMO = { code: 'COMEBACK10', off: 0.10 };
const carts = new Map();
const paidOrders = new Map();   // u -> last completed order (for /done back-compat)
const offered = new Map();      // u -> ts of last win-back
const abandonTimers = new Map();// u -> timer

const uid = (v) => String(v || '').replace(/[^\d]/g, '');
// Basket keys allow anonymous shoppers too ("anon..." ids minted client-side
// when a page is opened without ?u=). RCS win-backs only fire for real msisdns.
const ckey = (v) => String(v || '').replace(/[^\dA-Za-z]/g, '').slice(0, 28);
const isMsisdn = (v) => /^\d{8,15}$/.test(String(v || ''));
function cartOf(u) {
  if (!carts.has(u)) carts.set(u, { items: {}, promo: false, updatedAt: Date.now() });
  return carts.get(u);
}
function cartCount(c) { return Object.values(c.items).reduce((s, q) => s + q, 0); }
function cartSubtotal(c) { return Object.entries(c.items).reduce((s, [id, q]) => s + (DEALS[id] ? DEALS[id].now * q : 0), 0); }
function cartTotal(c) { const sub = cartSubtotal(c); return c.promo ? Math.round(sub * (1 - PROMO.off)) : sub; }
function cartSummary(c) {
  const names = Object.keys(c.items).filter(DID).map((id) => DEALS[id].name.split('™')[0].split('®')[0].trim());
  return names.length <= 2 ? names.join(' + ') : `${names[0]} + ${names.length - 1} more`;
}

// ---- RCS helpers ------------------------------------------------------------
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
const basketUrl = (u, promo) => `${BASE}/cart?u=${encodeURIComponent(u)}${promo ? '&promo=' + PROMO.code : ''}`;

function dealCard(id, msisdn) {
  const d = DEALS[id];
  const u = encodeURIComponent(msisdn || '');
  return {
    title: d.name.slice(0, 80),
    description: `Was £${d.was} - NOW £${d.now} (save ${pct(d)}%) · ${d.tag}`.slice(0, 120),
    media: { height: 'MEDIUM', contentInfo: { fileUrl: `${BASE}/img/${id}.jpg`, forceRefresh: false } },
    suggestions: [
      replyBtn('Add to basket 🛒', 'WF_ADD_' + id),
      webviewBtn('Details', `${BASE}/p/${id}?u=${u}`, 'HALF')
    ]
  };
}
async function sendDealsCarousel(to, ids, followUp) {
  await sendRcs(to, { message_type: 'custom', custom: { contentMessage: {
    richCard: { carouselCard: { cardWidth: 'MEDIUM', cardContents: ids.map((id) => dealCard(id, to)) } } } } });
  if (followUp) {
    const c = cartOf(ckey(to));
    const n = cartCount(c);
    await sendRcs(to, { message_type: 'custom', custom: { contentMessage: {
      text: n ? `Your basket has ${n} item${n > 1 ? 's' : ''} (£${cartTotal(c)}). Checkout in seconds with Google Pay, Apple Pay or card 💳`
             : 'Tap "Add to basket" on anything you like - then check out in seconds with Google Pay, Apple Pay or card 💳',
      suggestions: [replyBtn('More deals', 'WF_MORE'), webviewBtn(n ? `Basket (${n}) · £${cartTotal(c)}` : 'Open my basket', basketUrl(ckey(to)), 'TALL'),
                    webviewBtn('Browse everything', `${BASE}/?u=${uid(to)}`, 'TALL')]
    } } });
  }
}
async function sendWelcome(to) {
  await sendRcs(to, { message_type: 'custom', custom: { contentMessage: {
    richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
      title: 'Wayfair Hot Deals 🔥',
      description: 'Up to 60% off furniture today only. Add deals to your basket right from this chat, then check out in seconds with Google Pay, Apple Pay or card.',
      media: { height: 'MEDIUM', contentInfo: { fileUrl: BASE + '/img/hero.jpg', forceRefresh: false } },
      suggestions: [replyBtn('Show hot deals 🔥', 'WF_DEALS'), webviewBtn('Browse the sale', `${BASE}/?u=${encodeURIComponent(to)}`, 'TALL')]
    } } } } } });
}
async function sendAddedConfirmation(to, id) {
  const u = ckey(to);
  const c = cartOf(u);
  const d = DEALS[id];
  const n = cartCount(c);
  await sendRcs(to, { message_type: 'custom', custom: { contentMessage: {
    text: `Added ✓ ${d.name} (£${d.now})\n\n🛒 Basket: ${n} item${n > 1 ? 's' : ''} · £${cartTotal(c)}`,
    suggestions: [
      webviewBtn(`Checkout · £${cartTotal(c)}`, basketUrl(to), 'TALL'),
      replyBtn('More deals', 'WF_MORE'),
      replyBtn('Show hot deals', 'WF_DEALS')
    ]
  } } });
}

// ---- Abandoned basket -------------------------------------------------------
const promoTotal = (c) => Math.round(cartSubtotal(c) * (1 - PROMO.off));
async function sendAbandonedCard(u) {
  const c = carts.get(u);
  if (!c || cartCount(c) === 0) return;
  const n = cartCount(c);
  const firstId = Object.keys(c.items).find(DID) || 'sofa';
  c.promo = true; // the offer itself unlocks the promo for this basket
  await sendRcs(u, { message_type: 'custom', custom: { contentMessage: {
    richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
      title: `Your basket misses you 🛒 (${n} item${n > 1 ? 's' : ''})`,
      description: `${cartSummary(c)} - still yours, and now even better: an EXTRA 10% off the whole basket with code ${PROMO.code}. £${cartSubtotal(c)} → £${promoTotal(c)} for the next hour.`,
      media: { height: 'MEDIUM', contentInfo: { fileUrl: `${BASE}/img/${firstId}.jpg`, forceRefresh: false } },
      suggestions: [
        webviewBtn(`Basket -10% · £${promoTotal(c)}`, basketUrl(u, true), 'TALL'),
        replyBtn('Show more deals', 'WF_DEALS')
      ]
    } } } } } });
}
function fireWinback(u, delayMs) {
  // Win-backs go out on RCS, so only real phone numbers qualify - anonymous
  // baskets (opened outside the RCS thread) just skip the follow-up.
  if (!u || !isMsisdn(u)) return;
  const c = carts.get(u);
  if (!c || cartCount(c) === 0) return;
  if (offered.has(u) && Date.now() - offered.get(u) < 3600e3) return;
  if (abandonTimers.has(u)) clearTimeout(abandonTimers.get(u));
  abandonTimers.set(u, setTimeout(async () => {
    abandonTimers.delete(u);
    const cc = carts.get(u);
    if (!cc || cartCount(cc) === 0) return; // emptied or paid meanwhile
    if (lastSeen.has(u) && Date.now() - lastSeen.get(u) < 4000) return; // came back
    if (offered.has(u) && Date.now() - offered.get(u) < 3600e3) return;
    offered.set(u, Date.now());
    console.log('[WF ABANDON] win-back ->', u, cartCount(cc), 'items');
    try { await sendAbandonedCard(u); } catch (e) { console.error('[WF ABANDON]', e.message); }
  }, delayMs));
}
router.post('/abandon', (req, res) => {
  const u = ckey((req.body || {}).u);
  res.json({ ok: true });
  fireWinback(u, 5000);
});
// Heartbeat: the cart/checkout pages ping every 2s while open. Webviews often
// get torn down WITHOUT firing pagehide/visibilitychange (which is why the
// beacon alone missed real closes on the phone) - so a sweeper treats "pings
// went silent with an unpaid basket" as the abandon signal.
const lastSeen = new Map(); // u -> ts of last ping
router.post('/ping', (req, res) => {
  const u = ckey((req.body || {}).u);
  if (u) lastSeen.set(u, Date.now());
  res.json({ ok: true });
});
setInterval(() => {
  const now = Date.now();
  for (const [u, ts] of lastSeen) {
    if (now - ts > 6000) {
      lastSeen.delete(u);
      console.log('[WF PING] gone quiet:', u);
      fireWinback(u, 500); // pings already stopped ~6s ago - send promptly
    }
  }
}, 2000);
router.post('/paid', (req, res) => {
  const u = ckey((req.body || {}).u);
  if (u) {
    const c = carts.get(u);
    if (c) paidOrders.set(u, { items: { ...c.items }, total: cartTotal(c), promo: c.promo, at: Date.now() });
    carts.delete(u);
    lastSeen.delete(u);
    offered.delete(u); // a completed order resets the win-back allowance (clean demo retakes)
    if (abandonTimers.has(u)) { clearTimeout(abandonTimers.get(u)); abandonTimers.delete(u); }
    console.log('[WF PAID]', u);
  }
  res.json({ ok: true });
});

// ---- Basket API (used by the store pages) ------------------------------------
router.post('/cart/add', (req, res) => {
  const u = ckey((req.body || {}).u);
  const id = DID((req.body || {}).p);
  if (!u || !id) return res.status(400).json({ error: 'u and valid p required' });
  const c = cartOf(u);
  c.items[id] = (c.items[id] || 0) + 1;
  c.updatedAt = Date.now();
  res.json({ ok: true, count: cartCount(c), total: cartTotal(c) });
});
router.post('/cart/set', (req, res) => {
  const u = ckey((req.body || {}).u);
  const id = DID((req.body || {}).p);
  const qty = Math.max(0, Math.min(9, parseInt((req.body || {}).qty, 10) || 0));
  if (!u || !id) return res.status(400).json({ error: 'u and valid p required' });
  const c = cartOf(u);
  if (qty === 0) delete c.items[id]; else c.items[id] = qty;
  c.updatedAt = Date.now();
  res.json({ ok: true, count: cartCount(c), total: cartTotal(c) });
});

// ---- POST /wf/trigger - from the inbound webhook fan-out { msisdn, text } -------------
router.post('/trigger', async (req, res) => {
  const { msisdn, text } = req.body || {};
  if (!msisdn) return res.status(400).json({ error: 'msisdn required' });
  res.json({ ok: true });
  try {
    const t = String(text || '').trim().toUpperCase();
    if (t === 'WF_DEALS') await sendDealsCarousel(msisdn, ['sofa', 'bed', 'rug', 'dining'], true);
    else if (t === 'WF_MORE') await sendDealsCarousel(msisdn, ['armchair', 'lamp', 'desk', 'shelf'], true);
    else if (t.startsWith('WF_ADD_')) {
      const id = DID(t.slice(7).toLowerCase().replace(/_/g, '-'));
      if (id) {
        const c = cartOf(ckey(msisdn));
        c.items[id] = (c.items[id] || 0) + 1;
        c.updatedAt = Date.now();
        await sendAddedConfirmation(msisdn, id);
      } else await sendWelcome(msisdn);
    }
    else {
      // Fresh WAYFAIR trigger = a fresh demo session: reset the win-back
      // allowance so repeated run-throughs (e.g. filming takes) all work.
      offered.delete(ckey(msisdn));
      await sendWelcome(msisdn);
    }
  } catch (e) { console.error('[WF TRIGGER]', e.message); }
});

// ---------------------------------------------------------------------------
// Storefront + basket + checkout pages
// ---------------------------------------------------------------------------
const B = { purple: '#7F187F', sale: '#C6002B', ink: '#252626', bg: '#F7F5F2' };
function page(title, body, u) {
  const c = u ? cartOf(u) : null;
  const n = c ? cartCount(c) : 0;
  const cartLink = u ? `${BP}/cart?u=${u}` : `${BP}/cart`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:${B.ink};background:#fff}
.top{display:flex;align-items:center;justify-content:space-between;padding:13px 18px;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff;z-index:5}
.wm{font-weight:800;font-size:23px;color:${B.purple};letter-spacing:-.5px;font-style:italic;text-decoration:none}
.wm span{color:${B.sale}}
.cartbtn{position:relative;text-decoration:none;font-size:22px}
.cartbtn .badge{position:absolute;top:-7px;right:-10px;background:${B.sale};color:#fff;font-size:11px;font-weight:800;border-radius:20px;padding:1px 6px;min-width:18px;text-align:center}
.banner{background:${B.purple};color:#fff;text-align:center;padding:9px;font-size:13px;font-weight:700}
.hero{position:relative}
.hero img{width:100%;max-height:230px;object-fit:cover;display:block}
.hero .ov{position:absolute;inset:0;background:linear-gradient(180deg,transparent 30%,rgba(0,0,0,.55));display:flex;align-items:flex-end;padding:18px}
.hero .ov h1{color:#fff;font-size:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:14px;padding:16px}
.card{border:1px solid #eee;border-radius:12px;overflow:hidden;color:inherit;background:#fff;position:relative}
.card a.imglink{text-decoration:none;color:inherit;display:block}
.card img{width:100%;aspect-ratio:1;object-fit:cover}
.off{position:absolute;top:10px;left:10px;background:${B.sale};color:#fff;font-size:12px;font-weight:800;border-radius:6px;padding:3px 8px;z-index:2}
.card .in{padding:10px}.card .n{font-size:13px;font-weight:600;line-height:1.3;min-height:34px}
.pr{margin-top:6px}.pr .now{color:${B.sale};font-weight:800;font-size:17px}.pr .was{color:#9aa;text-decoration:line-through;font-size:13px;margin-left:6px}
.addbtn{display:block;width:calc(100% - 20px);margin:0 10px 10px;background:${B.purple};color:#fff;border:none;border-radius:8px;padding:10px;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit}
.addbtn.added{background:#0aa06e}
.pd img{width:100%;max-height:330px;object-fit:cover}
.pd .in{padding:20px}.pd h1{font-size:21px}
.btn{display:block;text-align:center;background:${B.purple};color:#fff;font-weight:800;border:none;border-radius:10px;padding:15px;font-size:16px;width:100%;margin-top:12px;text-decoration:none;cursor:pointer;font-family:inherit}
.btn.sale{background:${B.sale}}
.btn.ghost{background:#fff;color:${B.purple};border:2px solid ${B.purple}}
.paybtn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;border-radius:10px;padding:13px;border:none;cursor:pointer;margin-top:10px;min-height:52px}
.apple{background:#000}.apple img{height:24px;filter:invert(1)}
.gpay{background:#fff;border:1.5px solid #dadce0}.gpay img{height:26px}
.cardpay{background:#fff;border:1.5px solid #dadce0;color:#3c4043;font-size:16px;font-weight:700;font-family:inherit}
.sum{background:${B.bg};border-radius:14px;padding:14px;margin:10px 0;display:flex;gap:14px;align-items:center}
.sum img{width:74px;height:74px;object-fit:cover;border-radius:10px;flex:none}
.qty{display:flex;align-items:center;gap:10px;margin-top:6px}
.qty button{width:30px;height:30px;border-radius:8px;border:1.5px solid #ddd;background:#fff;font-size:16px;font-weight:800;cursor:pointer}
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
.empty{text-align:center;padding:44px 20px;color:#888}
.foot{padding:20px;text-align:center;color:#a7a7a7;font-size:12px}
</style>
<script>
// Shopper id self-heal: pages opened without ?u= (e.g. from a link that lost
// it) recover the id from localStorage - or mint an anonymous one - and
// reload with it, so "Add to basket" ALWAYS has a basket to add to.
(function(){
  var q=new URLSearchParams(location.search),u=q.get('u');
  if(u){try{localStorage.setItem('wf_u',u)}catch(e){}return;}
  var s=null;try{s=localStorage.getItem('wf_u')}catch(e){}
  if(!s){s='anon'+Math.random().toString(36).slice(2,10)+Date.now().toString(36);try{localStorage.setItem('wf_u',s)}catch(e){}}
  q.set('u',s);location.replace(location.pathname+'?'+q.toString());
})();
</script>
</head><body>
<div class="banner">🔥 HOT DEALS - up to 60% off, today only</div>
<div class="top"><a class="wm" href="${BP}/${u ? '?u=' + u : ''}">Wayfair<span>.</span></a>
<a class="cartbtn" href="${cartLink}">🛒${n ? `<span class="badge" id="cartBadge">${n}</span>` : '<span class="badge" id="cartBadge" style="display:none"></span>'}</a></div>
${body}
<div class="foot">Wayfair Hot Deals demo · powered by Vonage RCS · payments simulated</div>
</body></html>`;
}
const cartJs = (u) => `
<script>
var U=${JSON.stringify(u || '')},BP=${JSON.stringify(BP)};
if(!U){try{U=localStorage.getItem('wf_u')||''}catch(e){}}
function addToCart(id,btn){
  if(!U){return Promise.resolve();} // self-heal reload is already in flight
  return fetch(BP+'/cart/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:U,p:id})})
    .then(function(r){return r.json();}).then(function(d){
      if(btn){btn.textContent='Added ✓';btn.classList.add('added');setTimeout(function(){btn.textContent='Add to basket';btn.classList.remove('added');},1400);}
      var b=document.getElementById('cartBadge');if(b){b.style.display='inline-block';b.textContent=d.count;}
      return d;
    }).catch(function(){});
}
</script>`;

const dealTile = (id, u) => {
  const d = DEALS[id];
  const uq = u ? `?u=${u}` : '';
  return `<div class="card"><span class="off">-${pct(d)}%</span>
  <a class="imglink" href="${BP}/p/${id}${uq}"><img src="${BP}/img/${id}.jpg" alt="">
  <div class="in"><div class="n">${d.name}</div><div class="pr"><span class="now">£${d.now}</span><span class="was">£${d.was}</span></div></div></a>
  <button class="addbtn" onclick="addToCart('${id}',this)">Add to basket</button></div>`;
};

router.get('/', (req, res) => {
  const u = ckey(req.query.u);
  res.send(page('Wayfair Hot Deals', `
    <div class="hero"><img src="${BP}/img/hero.jpg" alt=""><div class="ov"><h1>The Hot Deals event 🔥</h1></div></div>
    <div class="grid">${Object.keys(DEALS).map((id) => dealTile(id, u)).join('')}</div>${cartJs(u)}`, u));
});

router.get('/p/:id', (req, res) => {
  const id = DID(req.params.id);
  const u = ckey(req.query.u);
  if (!id) return res.status(404).send(page('Not found', '<div style="padding:30px">Deal not found</div>', u));
  const d = DEALS[id];
  const others = Object.keys(DEALS).filter((x) => x !== id).slice(0, 4).map((x) => dealTile(x, u)).join('');
  res.send(page(d.name, `
    <div class="pd"><img src="${BP}/img/${id}.jpg" alt="">
    <div class="in"><span class="off" style="position:static">-${pct(d)}% · ${d.tag}</span>
    <h1 style="margin-top:10px">${d.name}</h1>
    <div class="pr" style="margin-top:8px"><span class="now" style="font-size:26px">£${d.now}</span><span class="was" style="font-size:16px">£${d.was}</span></div>
    <p style="color:#666;font-size:14px;margin-top:10px">Free delivery · 30-day returns · in stock and ships within 2 days.</p>
    <button class="btn" onclick="addToCart('${id}',this)">Add to basket</button>
    <a class="btn sale" href="#" onclick="addToCart('${id}').then(function(){location.href=BP+'/cart?u='+U});return false">Buy now - £${d.now}</a>
    <a class="btn ghost" href="${BP}/${u ? '?u=' + u : ''}">Keep browsing</a></div></div>
    <div style="padding:0 16px;font-weight:800;color:${B.purple}">MORE HOT DEALS</div>
    <div class="grid">${others}</div>${cartJs(u)}`, u));
});

// ---- Basket page --------------------------------------------------------------
router.get('/cart', (req, res) => {
  const u = ckey(req.query.u);
  const c = u ? cartOf(u) : { items: {}, promo: false };
  if (String(req.query.promo || '').toUpperCase() === PROMO.code && cartCount(c) > 0) c.promo = true;
  const ids = Object.keys(c.items).filter(DID);
  const n = cartCount(c);
  if (!n) {
    return res.send(page('Your basket', `
      <div class="empty"><div style="font-size:44px">🛒</div><h1 style="font-size:20px;margin:10px 0 6px">Your basket is empty</h1>
      <p>Add some hot deals - they will not stay this cheap for long!</p>
      <a class="btn" href="${BP}/${u ? '?u=' + u : ''}" style="max-width:280px;margin:20px auto 0">Browse hot deals</a></div>`, u));
  }
  const sub = cartSubtotal(c);
  const total = cartTotal(c);
  const rows = ids.map((id) => {
    const d = DEALS[id]; const q = c.items[id];
    return `<div class="sum"><img src="${BP}/img/${id}.jpg" alt="">
      <div style="flex:1"><div style="font-weight:700;font-size:14px">${d.name}</div>
      <div class="pr"><span class="now">£${d.now}</span><span class="was">£${d.was}</span></div>
      <div class="qty"><button onclick="setQty('${id}',${q - 1})">−</button><b id="q_${id}">${q}</b><button onclick="setQty('${id}',${q + 1})">+</button>
      <a href="#" onclick="setQty('${id}',0);return false" style="color:#999;font-size:12px;margin-left:8px">Remove</a></div></div></div>`;
  }).join('');
  const promoRow = c.promo ? `<div class="row" style="color:${B.sale};font-weight:800"><span>Promo ${PROMO.code} (-10%)</span><span>-£${sub - total}.00</span></div>` : '';
  const promoBanner = c.promo ? `<div style="background:#0aa06e;color:#fff;border-radius:10px;padding:11px 14px;font-weight:800;font-size:14px;margin-bottom:12px">🎉 Welcome back! Code ${PROMO.code} applied - an extra 10% off your whole basket.</div>` : '';
  res.send(page('Your basket', `
    <div style="padding:18px">
      <h1 style="font-size:21px">Your basket (${n})</h1>
      <div style="height:8px"></div>${promoBanner}${rows}
      <div class="row"><span>Subtotal</span><span>£${sub}.00</span></div>${promoRow}
      <div class="row"><span>Delivery</span><span style="color:#0aa06e;font-weight:700">FREE</span></div>
      <div class="row total"><span>Total</span><span>£${total}.00</span></div>
      <a class="btn sale" href="${BP}/checkout?u=${u}">Checkout · £${total}.00</a>
      <a class="btn ghost" href="${BP}/?u=${u}">Add more deals</a>
    </div>
    <script>
      var U=${JSON.stringify(u)},BP=${JSON.stringify(BP)},didPay=false;
      function setQty(id,q){
        fetch(BP+'/cart/set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:U,p:id,qty:q})})
          .then(function(){location.reload();}).catch(function(){});
      }
      function abandon(){
        if(didPay||!U)return;
        try{navigator.sendBeacon(BP+'/abandon',new Blob([JSON.stringify({u:U})],{type:'application/json'}));}
        catch(e){try{fetch(BP+'/abandon',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:U}),keepalive:true});}catch(_){}}
      }
      document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')abandon();});
      window.addEventListener('pagehide',abandon);
      // Heartbeat: webviews often close without firing the events above, so
      // the server also watches for these pings going quiet.
      setInterval(function(){
        if(didPay||!U||document.visibilityState==='hidden')return;
        try{fetch(BP+'/ping',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:U})});}catch(e){}
      },2000);
    </script>`, u));
});

// ---- Checkout (whole basket; legacy ?p= adds that item first) ------------------
router.get('/checkout', (req, res) => {
  const u = ckey(req.query.u);
  const c = u ? cartOf(u) : { items: {}, promo: false };
  const legacy = DID(req.query.p);
  if (legacy && u) { c.items[legacy] = c.items[legacy] || 1; }
  if (String(req.query.promo || '').toUpperCase() === PROMO.code && cartCount(c) > 0) c.promo = true;
  const ids = Object.keys(c.items).filter(DID);
  if (!ids.length) return res.redirect(`${BP}/cart${u ? '?u=' + u : ''}`);
  const n = cartCount(c);
  const sub = cartSubtotal(c);
  const total = cartTotal(c);
  const orderNo = 'WF-' + String(1000 + ((sub * 7 + n * 131) % 9000)) + '-DEMO';
  const items = ids.map((id) => {
    const d = DEALS[id]; const q = c.items[id];
    return `<div class="sum"><img src="${BP}/img/${id}.jpg" alt="">
      <div><div style="font-weight:700;font-size:14px">${d.name}${q > 1 ? ' × ' + q : ''}</div>
      <div class="pr"><span class="now">£${d.now * q}</span><span class="was">£${d.was * q}</span></div></div></div>`;
  }).join('');
  const promoRow = c.promo ? `<div class="row" style="color:${B.sale};font-weight:800"><span>Promo ${PROMO.code} (-10%)</span><span>-£${sub - total}.00</span></div>` : '';
  const promoBanner = c.promo ? `<div style="background:#0aa06e;color:#fff;border-radius:10px;padding:11px 14px;font-weight:800;font-size:14px;margin-bottom:12px">🎉 Code ${PROMO.code} applied - an extra 10% off your whole basket.</div>` : '';
  res.send(page('Checkout - Wayfair', `
    <div style="padding:18px" id="chk">
      <h1 style="font-size:21px">Checkout (${n} item${n > 1 ? 's' : ''})</h1>
      <div style="height:8px"></div>${promoBanner}${items}
      <div class="row"><span>Subtotal</span><span>£${sub}.00</span></div>${promoRow}
      <div class="row"><span>Delivery</span><span style="color:#0aa06e;font-weight:700">FREE</span></div>
      <div class="row total"><span>Total</span><span>£${total}.00</span></div>
      <button class="paybtn apple" onclick="pay('Apple Pay')"><img src="${BP}/img/applepay.svg" alt="Apple Pay"></button>
      <button class="paybtn gpay" onclick="pay('Google Pay')"><img src="${BP}/img/gpay.svg" alt="Google Pay"></button>
      <button class="paybtn cardpay" onclick="toggleCard()">💳 Pay with card</button>
      <div class="cardform" id="cardform">
        <input placeholder="Card number" inputmode="numeric" maxlength="19">
        <div class="cardrow"><input placeholder="MM/YY" maxlength="5"><input placeholder="CVC" maxlength="4"></div>
        <input placeholder="Name on card">
        <button class="btn sale" onclick="pay('card')">Pay £${total}.00</button>
      </div>
      <a class="btn ghost" href="${BP}/cart?u=${u}">Back to basket</a>
    </div>
    <div class="spin" id="spin"><div class="l"></div><p style="margin-top:14px;color:#888" id="spintxt">Contacting your bank...</p></div>
    <div class="done" id="done"><div class="tick">✓</div>
      <h1 style="font-size:22px">Order confirmed!</h1>
      <p style="color:#666;margin-top:8px">Order <b>${orderNo}</b> · ${n} item${n > 1 ? 's' : ''}<br>Paid <b>£${total}.00</b>${c.promo ? ' (extra 10% off applied)' : ''} · arriving in 2-3 days 🚚</p>
      <a class="btn" href="${BP}/?u=${u}" style="max-width:280px;margin:22px auto 0">Back to Hot Deals</a></div>
    <script>
      var U=${JSON.stringify(u)},BP=${JSON.stringify(BP)},didPay=false;
      function toggleCard(){var f=document.getElementById('cardform');f.style.display=f.style.display==='block'?'none':'block';}
      function pay(method){
        didPay=true;
        try{fetch(BP+'/paid',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:U}),keepalive:true});}catch(e){}
        document.getElementById('chk').style.display='none';
        document.getElementById('spin').style.display='block';
        document.getElementById('spintxt').textContent='Authorising with '+method+'...';
        setTimeout(function(){
          document.getElementById('spin').style.display='none';
          document.getElementById('done').style.display='block';
        },1600);
      }
      function abandon(){
        if(didPay||!U)return;
        try{navigator.sendBeacon(BP+'/abandon',new Blob([JSON.stringify({u:U})],{type:'application/json'}));}
        catch(e){try{fetch(BP+'/abandon',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:U}),keepalive:true});}catch(_){}}
      }
      document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')abandon();});
      window.addEventListener('pagehide',abandon);
      // Heartbeat: webviews often close without firing the events above, so
      // the server also watches for these pings going quiet.
      setInterval(function(){
        if(didPay||!U||document.visibilityState==='hidden')return;
        try{fetch(BP+'/ping',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:U})});}catch(e){}
      },2000);
    </script>`, u));
});

module.exports = router;

// Avon Skin Coach - AI skin-analysis RCS bot + mini Avon storefront
// Runs on Vonage Cloud Runtime (VCR). Flow:
//   user sends a selfie to the VonageTestUK live RCS agent -> Demo-World fan-out forwards the
//   image here (POST /analyze) -> Gemini vision scores the skin -> we reply on
//   RCS with a skin report + a carousel of matching Avon products, each opening
//   this mini-site in a webview.
// Dedicated instance: does NOT share state or webhooks with any other project.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/img', (req, res) => res.redirect(302, (process.env.ASSET_BASE || '') + '/skin-img' + req.path)); // product/brand images live on ASSET_BASE, not in the repo

const PORT = process.env.NERU_APP_PORT || process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://<your-vcr-avon-skin-instance>';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const RCS_APP_ID = process.env.RCS_APP_ID || '';
const RCS_SENDER = process.env.RCS_SENDER || '';  // launched RCS agent id from the environment
const PRIVATE_KEY = fs.readFileSync(path.join(__dirname, process.env.VONAGE_PRIVATE_KEY_FILE || 'private.key'), 'utf8');

// ---------------------------------------------------------------------------
// Catalog: real Avon UK skincare products (title/price/images pulled from
// avon.uk.com). Each product lists the skin concerns it addresses - the
// analysis maps Gemini's findings onto these tags.
// ---------------------------------------------------------------------------
const PRODUCTS = {
  'clay-mask': {
    name: 'Clearskin Pink Clay 4-Minute Mask', size: '75ml', price: 4.00,
    concerns: ['acne', 'blemishes', 'oiliness', 'pores'],
    blurb: 'Pink kaolin clay draws out impurities and helps clear blemishes in just 4 minutes.',
    how: 'Apply a thin layer to clean skin 2-3 times a week. Leave for 4 minutes, rinse with warm water.'
  },
  'renewal-serum': {
    name: 'Anew Skin Renewal Power Serum', size: '30ml', price: 17.50,
    concerns: ['fine_lines', 'texture', 'dullness', 'wrinkles'],
    blurb: 'Our most powerful renewal serum - visibly smooths fine lines and refines skin texture.',
    how: 'Apply 3-4 drops morning and evening before moisturiser.'
  },
  'ha-serum': {
    name: 'Anew HA Hydrate & Plump Serum', size: '30ml', price: 23.00,
    concerns: ['dehydration', 'dryness', 'fine_lines'],
    blurb: 'Hyaluronic acid surge that plumps skin with lasting hydration and softens dehydration lines.',
    how: 'Smooth over face and neck twice daily; follow with your day or night cream.'
  },
  'platinum-day': {
    name: 'Anew Platinum Lift & Tighten Day Cream', size: '50ml', price: 13.00,
    concerns: ['wrinkles', 'sagging', 'mature', 'firmness'],
    blurb: 'Lifts and tightens the look of skin, targeting deep wrinkles and loss of firmness.',
    how: 'Massage upwards over face and neck every morning.'
  },
  'reversalist-night': {
    name: 'Anew Reversalist Plump & Smooth Night Cream', size: '50ml', price: 13.00,
    concerns: ['fine_lines', 'night_repair', 'texture'],
    blurb: 'Overnight repair cream that plumps and smooths the look of fine lines while you sleep.',
    how: 'Apply every evening as the last step of your routine.'
  },
  'vitc-tonic': {
    name: 'Anew Radiance Maximising Vitamin C Tonic', size: '200ml', price: 7.00,
    concerns: ['dullness', 'uneven_tone', 'radiance'],
    blurb: 'A vitamin C boost that wakes up dull skin and maximises natural radiance.',
    how: 'Sweep over the face with a cotton pad after cleansing, morning and evening.'
  },
  'darkspot-serum': {
    name: 'Anew Anti-Dark Spot Serum', size: '30ml', price: 19.00,
    concerns: ['dark_spots', 'uneven_tone', 'pigmentation'],
    blurb: 'Visibly reduces the look of dark spots and evens skin tone in 4 weeks.',
    how: 'Apply to clean skin twice a day, focusing on areas with visible spots.'
  },
  'mattify-toner': {
    name: 'SK!N Mattify Micellar Water + Toner', size: '400ml', price: 5.00,
    concerns: ['oiliness', 'acne', 'shine', 'pores'],
    blurb: 'Removes excess oil and mattifies shine while gently toning the skin.',
    how: 'Use with a cotton pad morning and evening - no rinsing needed.'
  },
  'sensitive-cleanser': {
    name: 'Anew Sensitive+ Cream Cleanser', size: '150ml', price: 7.00,
    concerns: ['sensitivity', 'redness', 'dryness'],
    blurb: 'Ultra-gentle cream cleanser that calms sensitive, redness-prone skin.',
    how: 'Massage onto damp skin and rinse, morning and evening.'
  },
  'water-cream': {
    name: 'Anew HA Hydrate & Plump Water Cream', size: '50ml', price: 13.00,
    concerns: ['dehydration', 'dryness'],
    blurb: 'Featherlight water cream that drenches skin in hyaluronic hydration.',
    how: 'Apply morning and evening after serum.'
  },
  'vitc-spf': {
    name: 'Anew Vitamin C Lightweight Cream SPF 50', size: '50ml', price: 9.00,
    concerns: ['sun_protection', 'dullness', 'uneven_tone', 'dark_spots'],
    blurb: 'Daily SPF 50 with vitamin C - protects against the UV damage behind dark spots and ageing.',
    how: 'Apply generously every morning as your final skincare step.'
  },
  'glow-cleanser': {
    name: 'SK!N Glow Gel Cleanser + Make-Up Remover', size: '195ml', price: 5.00,
    concerns: ['dullness', 'cleansing', 'texture'],
    blurb: 'Gel cleanser that melts make-up away and leaves skin glowing.',
    how: 'Massage onto damp skin, rinse thoroughly. Use daily.'
  }
};
const PID = (id) => PRODUCTS[id] ? id : null;

// ---------------------------------------------------------------------------
// Vonage Messages API helpers (JWT signed with the Omriak app key - the same
// hand-rolled RS256 pattern as the proven send_avon.js demo script)
// ---------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    application_id: RCS_APP_ID, iat: now, exp: now + 900, jti: crypto.randomUUID()
  }));
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
  const text = await res.text();
  console.log('[RCS]', res.status, (text || '').slice(0, 200));
  return res.status;
}

const sendText = (to, text) => sendRcs(to, { message_type: 'text', text });

// suggestion builders - text+postbackData INSIDE action (wrong shape = silent #1040)
const webviewBtn = (text, url, mode) => ({
  action: {
    text: text.slice(0, 25), postbackData: 'open_' + text.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20),
    openUrlAction: { url, application: 'WEBVIEW', webviewViewMode: mode || 'HALF', description: 'Avon' }
  }
});
const replyBtn = (text, data) => ({ reply: { text: text.slice(0, 25), postbackData: data } });

// ---------------------------------------------------------------------------
// Gemini vision skin analysis
// ---------------------------------------------------------------------------
const ANALYSIS_PROMPT = `You are a friendly cosmetic skincare consultant for a beauty brand.
Look at this selfie and give a COSMETIC (non-medical) skin assessment. Be kind, positive and specific.
Reply ONLY with strict JSON in exactly this shape:
{
 "is_face": true,
 "skin_type": "normal|dry|oily|combination",
 "glow_score": 78,
 "hydration": "low|good|great",
 "acne": "none|mild|moderate",
 "fine_lines": "none|subtle|visible",
 "dark_spots": "none|few|noticeable",
 "redness": "none|mild|noticeable",
 "top_concerns": ["dehydration","fine_lines"],
 "compliment": "one short specific compliment about their skin",
 "tip": "one short practical skincare tip personalised to what you see"
}
Rules: glow_score is 1-100 (be generous, 60-95 range unless skin is clearly struggling).
top_concerns: 1-3 items from: acne, oiliness, pores, dehydration, dryness, fine_lines, wrinkles, dark_spots, uneven_tone, dullness, redness, sensitivity, sagging.
If the image does not contain a human face, set is_face=false and all other fields null.`;

async function analyzeFace(imageB64, mime) {
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: mime || 'image/jpeg', data: imageB64 } },
      { text: ANALYSIS_PROMPT }
    ]}],
    generationConfig: { temperature: 0.4, responseMimeType: 'application/json' }
  };
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error('Gemini ' + res.status + ': ' + JSON.stringify(data).slice(0, 200));
  const text = data.candidates && data.candidates[0] && data.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

// Download the inbound RCS image (Vonage-hosted media needs the app JWT)
async function fetchImage(url) {
  let res = await fetch(url, { headers: { Authorization: 'Bearer ' + makeJwt() } });
  if (!res.ok) res = await fetch(url); // public URLs don't want the bearer
  if (!res.ok) throw new Error('image fetch ' + res.status);
  const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const buf = Buffer.from(await res.arrayBuffer());
  return { b64: buf.toString('base64'), mime };
}

// Map Gemini concerns -> best products (max 5, most-specific first)
function recommend(result) {
  const concerns = (result.top_concerns || []).map(c => String(c).toLowerCase());
  if (result.skin_type === 'dry' && !concerns.includes('dryness')) concerns.push('dryness');
  if (result.skin_type === 'oily' && !concerns.includes('oiliness')) concerns.push('oiliness');
  if (result.hydration === 'low' && !concerns.includes('dehydration')) concerns.push('dehydration');
  const scored = Object.entries(PRODUCTS).map(([id, p]) => {
    const hits = p.concerns.filter(c => concerns.includes(c)).length;
    return { id, hits };
  }).filter(x => x.hits > 0).sort((a, b) => b.hits - a.hits);
  const picks = scored.slice(0, 4).map(x => x.id);
  if (!picks.includes('vitc-spf') && picks.length < 4) picks.push('vitc-spf'); // always protect
  if (picks.length === 0) picks.push('renewal-serum', 'vitc-tonic', 'vitc-spf');
  return picks.slice(0, 5);
}

function reportText(r) {
  const bar = (score) => {
    const filled = Math.round(score / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };
  const nice = (v) => (v || '-').replace(/_/g, ' ');
  return 'Your Avon Skin Report ✨\n\n' +
    'Glow score: ' + r.glow_score + '/100\n' + bar(r.glow_score) + '\n\n' +
    '• Skin type: ' + nice(r.skin_type) + '\n' +
    '• Hydration: ' + nice(r.hydration) + '\n' +
    '• Blemishes: ' + nice(r.acne) + '\n' +
    '• Fine lines: ' + nice(r.fine_lines) + '\n' +
    '• Dark spots: ' + nice(r.dark_spots) + '\n' +
    '• Redness: ' + nice(r.redness) + '\n\n' +
    '💖 ' + r.compliment + '\n💡 ' + r.tip;
}

async function sendProductCarousel(to, ids, routineUrl) {
  const cards = ids.map(id => {
    const p = PRODUCTS[id];
    return {
      title: p.name.slice(0, 80),
      description: ('£' + p.price.toFixed(2) + ' · ' + p.blurb).slice(0, 120),
      media: { height: 'MEDIUM', contentInfo: { fileUrl: BASE_URL + '/img/' + id + '.jpg', forceRefresh: false } },
      suggestions: [
        webviewBtn('View product', BASE_URL + '/p/' + id, 'TALL'),
        replyBtn('More like this', 'more_' + id)
      ]
    };
  });
  await sendRcs(to, {
    message_type: 'custom',
    custom: { contentMessage: { richCard: { carouselCard: { cardWidth: 'MEDIUM', cardContents: cards } } } }
  });
  await sendRcs(to, {
    message_type: 'custom',
    custom: { contentMessage: {
      text: 'I put your full personalised routine together here 👇',
      suggestions: [webviewBtn('My skin routine', routineUrl, 'TALL'),
                    replyBtn('New analysis', 'send_new_selfie')]
    } }
  });
}

async function sendWelcome(to) {
  await sendRcs(to, {
    message_type: 'custom',
    custom: { contentMessage: {
      richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
        title: 'Avon Skin Coach ✨',
        description: 'Send me a selfie 🤳 and I’ll analyse your skin - type, hydration, blemishes, fine lines - then match you with the perfect Avon products.',
        media: { height: 'MEDIUM', contentInfo: { fileUrl: BASE_URL + '/img/hero.jpg', forceRefresh: false } },
        suggestions: [
          replyBtn('How does it work?', 'how_it_works'),
          webviewBtn('Browse products', BASE_URL + '/', 'TALL')
        ]
      } } }
    } }
  });
}

// ---------------------------------------------------------------------------
// POST /analyze - called by the Demo-World inbound fan-out
//   { msisdn, imageUrl?, text? }
// ---------------------------------------------------------------------------
const recent = new Map(); // msisdn -> last analysis (for the routine page)

app.post('/analyze', async (req, res) => {
  const { msisdn, imageUrl, text } = req.body || {};
  if (!msisdn) return res.status(400).json({ error: 'msisdn required' });
  res.json({ ok: true }); // ack fast; work async

  try {
    if (!imageUrl) {
      const t = (text || '').trim().toUpperCase();
      if (t === 'HOW_IT_WORKS' || t === 'HOW DOES IT WORK?') {
        await sendText(msisdn, 'It’s easy! 📸 Take a well-lit selfie (no filters), send it here, and within seconds I’ll send back your personal skin report and the Avon products that match it. Nothing is stored - it’s just between us 💜');
      } else if (t === 'SEND_NEW_SELFIE') {
        await sendText(msisdn, 'Ready when you are! 🤳 Send a fresh selfie and I’ll take a look.');
      } else if (t.startsWith('MORE_')) {
        // "More like this" tap on a product card -> send similar products
        const baseId = PID(t.slice(5).toLowerCase().replace(/_/g, '-'));
        if (baseId) {
          const p = PRODUCTS[baseId];
          const similar = Object.keys(PRODUCTS).filter(x => x !== baseId)
            .sort((a, b) => PRODUCTS[b].concerns.filter(c => p.concerns.includes(c)).length -
                            PRODUCTS[a].concerns.filter(c => p.concerns.includes(c)).length)
            .slice(0, 3);
          await sendProductCarousel(msisdn, similar, BASE_URL + '/');
        } else {
          await sendWelcome(msisdn);
        }
      } else {
        await sendWelcome(msisdn);
      }
      return;
    }

    await sendText(msisdn, 'Beautiful! 🔍 Give me a few seconds to study your skin...');
    const img = await fetchImage(imageUrl);
    const result = await analyzeFace(img.b64, img.mime);

    if (!result.is_face) {
      await sendText(msisdn, 'Hmm, I couldn’t spot a face in that photo 🙈 Try a clear, well-lit selfie facing the camera!');
      return;
    }

    const picks = recommend(result);
    recent.set(msisdn, { result, picks, at: Date.now() });
    const routineUrl = BASE_URL + '/routine?c=' + encodeURIComponent((result.top_concerns || []).join(',')) +
      '&s=' + result.glow_score + '&t=' + encodeURIComponent(result.skin_type || '') + '&p=' + picks.join(',');

    await sendText(msisdn, reportText(result));
    await sendProductCarousel(msisdn, picks, routineUrl);
  } catch (e) {
    console.error('[ANALYZE] error:', e.message);
    try { await sendText(msisdn, 'Oops, my magnifying glass fogged up 😅 Please try sending your selfie again.'); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// Mini Avon storefront (webview-friendly, mobile-first)
// ---------------------------------------------------------------------------
const BRAND = { magenta: '#E01D8B', ink: '#1A1A1A', blush: '#FCEFF6' };

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;color:${BRAND.ink};background:#fff}
.top{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #f3d9e8;position:sticky;top:0;background:#fff;z-index:5}
.top img{height:30px}.top .wm{font-weight:800;letter-spacing:6px;font-size:20px;color:${BRAND.magenta}}
.hero{background:${BRAND.blush};padding:26px 20px;text-align:center}
.hero h1{font-size:24px;color:${BRAND.magenta}}.hero p{margin-top:6px;color:#5a4652;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;padding:18px}
.card{border:1px solid #f3d9e8;border-radius:14px;overflow:hidden;text-decoration:none;color:inherit;background:#fff;display:block}
.card img{width:100%;aspect-ratio:1;object-fit:cover;background:${BRAND.blush}}
.card .in{padding:10px}.card .n{font-size:13px;font-weight:600;line-height:1.3;min-height:34px}
.card .pr{color:${BRAND.magenta};font-weight:800;margin-top:6px}
.tag{display:inline-block;background:${BRAND.blush};color:${BRAND.magenta};border-radius:20px;padding:3px 10px;font-size:11px;font-weight:600;margin:2px}
.pd img{width:100%;max-height:340px;object-fit:cover;background:${BRAND.blush}}
.pd .in{padding:20px}.pd h1{font-size:22px}.pd .pr{color:${BRAND.magenta};font-size:26px;font-weight:800;margin:8px 0}
.pd p{color:#5a4652;font-size:14px;line-height:1.55;margin:10px 0}
.btn{display:block;text-align:center;background:${BRAND.magenta};color:#fff;font-weight:700;border:none;border-radius:30px;padding:14px;font-size:16px;width:100%;margin-top:14px;text-decoration:none}
.btn.sec{background:#fff;color:${BRAND.magenta};border:2px solid ${BRAND.magenta}}
.score{background:${BRAND.blush};border-radius:16px;padding:18px;margin:16px 18px;text-align:center}
.score .big{font-size:40px;font-weight:800;color:${BRAND.magenta}}
.meter{height:10px;background:#fff;border-radius:6px;margin-top:10px;overflow:hidden}
.meter i{display:block;height:100%;background:${BRAND.magenta};border-radius:6px}
.sect{padding:6px 18px;font-size:15px;font-weight:700;color:${BRAND.magenta};letter-spacing:1px;text-transform:uppercase}
.foot{padding:22px;text-align:center;color:#a08794;font-size:12px}
</style></head><body>
<div class="top"><img src="/img/logo-a.svg" alt="A"><span class="wm">AVON</span></div>
${body}
<div class="foot">Avon Skin Coach demo · powered by Vonage RCS + AI</div>
</body></html>`;
}

function productCard(id) {
  const p = PRODUCTS[id];
  return `<a class="card" href="/p/${id}"><img src="/img/${id}.jpg" alt="">
  <div class="in"><div class="n">${p.name}</div><div class="pr">£${p.price.toFixed(2)}</div></div></a>`;
}

app.get('/', (req, res) => {
  const grid = Object.keys(PRODUCTS).map(productCard).join('');
  res.send(page('Avon Skincare', `
    <div class="hero"><h1>Skincare that listens to your skin</h1>
    <p>Send a selfie to our RCS Skin Coach and get matched in seconds ✨</p></div>
    <div class="sect">All products</div><div class="grid">${grid}</div>`));
});

app.get('/p/:id', (req, res) => {
  const id = PID(req.params.id);
  if (!id) return res.status(404).send(page('Not found', '<div class="hero"><h1>Product not found</h1></div>'));
  const p = PRODUCTS[id];
  const tags = p.concerns.map(c => `<span class="tag">${c.replace(/_/g, ' ')}</span>`).join('');
  const others = Object.keys(PRODUCTS).filter(x => x !== id)
    .sort((a, b) => PRODUCTS[b].concerns.filter(c => p.concerns.includes(c)).length -
                    PRODUCTS[a].concerns.filter(c => p.concerns.includes(c)).length)
    .slice(0, 4).map(productCard).join('');
  res.send(page(p.name, `
    <div class="pd"><img src="/img/${id}.jpg" alt="">
    <div class="in"><h1>${p.name}</h1><div>${p.size}</div><div class="pr">£${p.price.toFixed(2)}</div>
    <div>${tags}</div>
    <p>${p.blurb}</p><p><b>How to use:</b> ${p.how}</p>
    <a class="btn" href="#" onclick="this.textContent='Added to basket ✓';return false">Add to basket</a>
    <a class="btn sec" href="/">Keep browsing</a>
    </div></div>
    <div class="sect">Goes well with</div><div class="grid">${others}</div>`));
});

app.get('/routine', (req, res) => {
  const score = Math.max(1, Math.min(100, parseInt(req.query.s, 10) || 75));
  const skinType = (req.query.t || 'your').replace(/[^a-z]/gi, '');
  const concerns = String(req.query.c || '').split(',').filter(Boolean).slice(0, 4);
  const ids = String(req.query.p || '').split(',').map(PID).filter(Boolean);
  const list = (ids.length ? ids : ['renewal-serum', 'vitc-tonic', 'vitc-spf']);
  const tags = concerns.map(c => `<span class="tag">${c.replace(/_/g, ' ')}</span>`).join('') || '<span class="tag">healthy glow</span>';
  const steps = list.map((id, i) => {
    const p = PRODUCTS[id];
    return `<a class="card" href="/p/${id}" style="display:flex;align-items:center;gap:12px;margin:0 18px 12px;padding:10px">
      <img src="/img/${id}.jpg" style="width:74px;height:74px;border-radius:10px;flex:none">
      <div><div style="font-weight:800;color:${BRAND.magenta};font-size:12px">STEP ${i + 1}</div>
      <div class="n" style="min-height:0">${p.name}</div><div class="pr" style="font-size:14px">£${p.price.toFixed(2)}</div></div></a>`;
  }).join('');
  res.send(page('Your Avon routine', `
    <div class="hero"><h1>Your personalised routine</h1><p>Built from your AI skin analysis 🧖</p></div>
    <div class="score"><div>Glow score</div><div class="big">${score}<span style="font-size:18px">/100</span></div>
    <div class="meter"><i style="width:${score}%"></i></div>
    <div style="margin-top:10px">Skin type: <b>${skinType}</b></div><div style="margin-top:6px">${tags}</div></div>
    <div class="sect">Your routine</div>${steps}
    <div style="padding:0 18px"><a class="btn" href="/">Shop all Avon skincare</a></div>`));
});

// Wayfair Hot Deals (/wf) is TEMPORARILY hosted on the Demo-World EB because VCR
// package uploads are 403-blocked account-wide (2026-07-13). When uploads work
// again: uncomment this mount, update wayfair.js HOST to this instance, move
// the Demo-World /wf routes out, and redeploy both.
// app.use('/wf', require('./wayfair'));

app.get('/_/health', (req, res) => res.status(200).send('OK'));
app.get('/_/metrics', (req, res) => res.status(200).send('OK'));

app.listen(PORT, () => console.log('Avon Skin Coach listening on', PORT, 'base', BASE_URL));

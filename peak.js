'use strict';
// ---- Peak Season Promotions: the Vonage x Telefonica event demo (RCS + WhatsApp) ----
// Self-contained module. server.js calls mount() once (after its constants exist) and
// inbound() from the messages webhook. Nothing here runs unless the trigger word or one
// of this flow's own PK_* postbacks arrives, so every other demo keeps working as before.
// Design rules from Omri: rich cards and carousels over text, a Back-to-menu button on
// every stop, medium (TALL) webviews, no prices, black & white vector webviews.
let D = null;                       // deps injected by mount()
const S = {};                       // sessions by phone digits
const IMG = (n) => (process.env.ASSET_BASE || '') + '/peak/' + n + '.jpg';
const SOL_BASE = (process.env.ASSET_BASE || '') + '/peak/sol/';
const PDF_URL = (process.env.ASSET_BASE || '') + '/peak/Peak-Season-Promotions-Agenda.pdf';
const EVENT_DATE = process.env.PEAK_DATE || '2026-10-15';          // YYYY-MM-DD, London
const VENUE = { name: 'Vonage London', address: '15 Bonhill Street, London EC2A 4DN', lat: 51.5236, lng: -0.0846 };
const TRIGGERS = ['PEAK', 'PEAKSEASON', 'PEAK SEASON', 'PROMOTIONS', 'TELEFONICA', 'PEAK SEASON PROMOTIONS'];
const digits = (s) => String(s || '').replace(/\D/g, '');
const sess = (n) => { n = digits(n); if (!S[n]) S[n] = { at: Date.now() }; S[n].at = Date.now(); return S[n]; };
const log = (...a) => console.log('[PEAK]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AGENDA = [
  { t: '09:00', end: '09:30', title: 'Registration & Breakfast', desc: 'Grab a coffee, collect your badge and meet the Vonage and Telefonica teams.', img: 'agenda-breakfast' },
  { t: '09:30', end: '09:40', title: 'Welcome address', desc: 'Why peak season is the moment for rich, verified messaging.', img: 'agenda-welcome' },
  { t: '09:40', end: '10:30', title: 'Google Ignite Lab: RCS Masterclass', desc: 'Hands-on with rich cards, carousels, suggested actions and agent verification.', img: 'agenda-masterclass' },
  { t: '10:30', end: '11:00', title: 'RCS Innovation Showcase', desc: 'Live demos: commerce, notifications, AI agents and authentication over RCS.', img: 'agenda-showcase' },
  { t: '11:00', end: '11:30', title: 'O2 and Telefonica: Customer Engagement & Authentication Story', desc: 'How a mobile operator engages and verifies millions of customers in one thread.', img: 'agenda-telefonica' },
  { t: '11:30', end: '12:15', title: 'Ask the Experts: RCS Panel + Q&A', desc: 'Bring your questions on compliance, carrier onboarding, pricing and design.', img: 'agenda-panel' },
];
// Replace with the real headshots and bios from marketing (img = full public URL or a peak/ image name).
const TEAM = [
  { name: 'Vonage team member', role: 'Headshot and bio coming soon', img: 'team-avatar' },
  { name: 'Vonage team member', role: 'Headshot and bio coming soon', img: 'team-avatar' },
  { name: 'Vonage team member', role: 'Headshot and bio coming soon', img: 'team-avatar' },
  { name: 'Vonage team member', role: 'Headshot and bio coming soon', img: 'team-avatar' },
];
// Every Vonage solution: card image + explainer video rendered to S3 peak/sol/<id>, real marketing + docs pages.
const SOL = [
  ['messages', 'Messages API', 'One API for RCS, WhatsApp, SMS, MMS and Viber', 'https://www.vonage.com/communications-apis/messages/', 'https://developer.vonage.com/en/messages/overview'],
  ['rcs', 'RCS Business Messaging', 'Branded, verified, rich messaging in the default SMS app', 'https://www.vonage.com/communications-apis/messages/features/rcs/', 'https://developer.vonage.com/en/messages/concepts/rcs'],
  ['whatsapp', 'WhatsApp Business', 'Conversations, templates and payments on WhatsApp', 'https://www.vonage.com/communications-apis/messages/features/whatsapp/', 'https://developer.vonage.com/en/messages/concepts/whatsapp'],
  ['sms', 'SMS API', 'Global SMS with the reach of 1,600 networks', 'https://www.vonage.com/communications-apis/sms/', 'https://developer.vonage.com/en/messaging/sms/overview'],
  ['viber', 'Viber Business Messages', 'Rich messages on Viber, popular across Europe', 'https://www.vonage.com/communications-apis/messages/features/viber/', 'https://developer.vonage.com/en/messages/concepts/viber'],
  ['verify', 'Verify API', 'One-time codes on SMS, WhatsApp, voice and email', 'https://www.vonage.com/communications-apis/verify/', 'https://developer.vonage.com/en/verify/overview'],
  ['silent-auth', 'Silent Authentication', 'Verify a phone with no code at all', 'https://www.vonage.com/communications-apis/verify/', 'https://developer.vonage.com/en/verify/concepts/silent-authentication'],
  ['voice', 'Voice API', 'Programmable calls, IVR, recording and AI voice', 'https://www.vonage.com/communications-apis/voice/', 'https://developer.vonage.com/en/voice/voice-api/overview'],
  ['video', 'Video API', 'Live video in your app or site', 'https://www.vonage.com/communications-apis/video/', 'https://developer.vonage.com/en/video/overview'],
  ['number-insight', 'Number Insight', 'Know the number before you message or call it', 'https://www.vonage.com/communications-apis/number-insight/', 'https://developer.vonage.com/en/number-insight/overview'],
  ['network', 'Network APIs & Identity Insights', 'Real-time signals from the mobile network', 'https://www.vonage.com/communications-apis/', 'https://developer.vonage.com/en/identity-insights/overview'],
  ['conversation', 'Conversation API', 'One conversation, every channel, full history', 'https://www.vonage.com/communications-apis/conversation/', 'https://developer.vonage.com/en/conversation/overview'],
  ['ai-studio', 'AI Studio', 'Low-code conversational AI on voice and messaging', 'https://www.vonage.com/communications-apis/ai-studio/', 'https://developer.vonage.com/en/ai-studio/overview'],
  ['fraud-defender', 'Fraud Defender', 'Stop SMS pumping and toll fraud before it bills you', 'https://www.vonage.com/communications-apis/fraud-defender/', 'https://developer.vonage.com/en/fraud-defender/overview'],
  ['numbers', 'Phone Numbers', 'Virtual numbers in 100+ countries, provisioned by API', 'https://www.vonage.com/communications-apis/phone-numbers/', 'https://developer.vonage.com/en/numbers/overview'],
  ['sip', 'SIP Trunking', 'Connect your PBX or contact centre to the world', 'https://www.vonage.com/communications-apis/sip-trunking/', 'https://developer.vonage.com/en/sip/overview'],
  ['contact-center', 'Vonage Contact Center', 'An omnichannel contact centre inside your CRM', 'https://www.vonage.com/contact-centers/', 'https://developer.vonage.com/en/documentation'],
  ['vbc', 'Vonage Business Communications', 'Calling, meetings and messaging for every team', 'https://www.vonage.com/unified-communications/', 'https://developer.vonage.com/en/vonage-business-cloud/overview'],
];
const QUIZ = [
  { q: 'Quick one to start: what does RCS stand for?', a: ['Rich Communication Services', 'Real Chat System', 'Rapid Content Sending'], ok: 0, img: 'game-1' },
  { q: 'How many cards can a single RCS carousel hold?', a: ['Up to 4', 'Up to 10', 'Unlimited'], ok: 1, img: 'game-2' },
  { q: 'Which Vonage API sends RCS, WhatsApp, SMS and Viber from one integration?', a: ['Messages API', 'Voice API', 'Number Insight'], ok: 0, img: 'menu-rcs' },
  { q: 'Bonus: what happens when a phone has no RCS?', a: ['The message is lost', 'Vonage falls back to SMS', 'It waits forever'], ok: 1, img: 'rcs-verified' },
];
const EMOJI = [
  { q: '🔐 📲 6️⃣', a: ['Verify API', 'Video API', 'SMS API'], ok: 0, img: 'showcase-verify' },
  { q: '🗣️ ☎️ 🤖', a: ['Number Insight', 'Voice API', 'Viber'], ok: 1, img: 'showcase-voice' },
  { q: '🎥 👥 💬', a: ['Video API', 'Fraud Defender', 'SIP Trunking'], ok: 0, img: 'showcase-video' },
  { q: '🃏 🃏 🃏 ➡️', a: ['Silent Auth', 'RCS carousel', 'Phone Numbers'], ok: 1, img: 'rcs-cards' },
];
const TF = [
  { q: 'An RCS message can show a verified badge next to your brand name.', ok: true, img: 'rcs-verified' },
  { q: 'RCS needs the customer to install an app first.', ok: false, img: 'menu-rcs' },
  { q: 'Silent Authentication can verify a phone with no code at all.', ok: true, img: 'showcase-verify' },
  { q: 'If a handset has no RCS, the message simply disappears.', ok: false, img: 'rcs-analytics' },
  { q: 'One Messages API call can reach RCS, WhatsApp, SMS and Viber.', ok: true, img: 'menu-showcase' },
];
const HL = [
  { q: 'Maximum cards in one RCS carousel. More or fewer than 6?', ok: 'HIGHER', fact: 'It is 10.', img: 'rcs-cards' },
  { q: 'Suggested chips under one RCS text message. More or fewer than 15?', ok: 'LOWER', fact: 'It is 11.', img: 'rcs-actions' },
  { q: 'Countries Vonage SMS can reach. More or fewer than 100?', ok: 'HIGHER', fact: 'Over 200.', img: 'agenda-showcase' },
];
const POLL = { q: 'What will you build first after today?', opts: ['Promotions on RCS', 'Verification', 'Customer care', 'An AI agent'] };

// ------------------------------------------------------------------ senders
function rcsChip(c) {
  const text = String(c.t).slice(0, 25), pb = String(c.pb || c.t).slice(0, 200);
  if (c.url) return { action: { text, postbackData: pb, openUrlAction: c.ext ? { url: c.url } : { url: c.url, application: 'WEBVIEW', webviewViewMode: c.mode || 'TALL', description: c.desc || text } } };
  if (c.dial) return { action: { text, postbackData: pb, dialAction: { phoneNumber: c.dial } } };
  if (c.cal) return { action: { text, postbackData: pb, createCalendarEventAction: { startTime: c.cal.start, endTime: c.cal.end, title: c.cal.title, description: c.cal.desc || '' } } };
  if (c.map) return { action: { text, postbackData: pb, viewLocationAction: { label: c.map.label, latLong: { latitude: c.map.lat, longitude: c.map.lng } } } };
  return { reply: { text, postbackData: pb } };
}
const imgUrl = (i) => (i && i.startsWith('http')) ? i : IMG(i);
function rcsCard(card) {
  return { title: String(card.title || '').slice(0, 200), description: String(card.desc || '').slice(0, 2000),
    media: card.img ? { height: 'MEDIUM', contentInfo: { fileUrl: imgUrl(card.img), forceRefresh: false } } : undefined,
    suggestions: (card.chips || []).slice(0, 4).map(rcsChip) };
}
async function rcs(to, content) {
  const r = await D.vonageMessages({ from: D.RCS_SENDER, to: digits(to), channel: 'rcs', message_type: 'custom', custom: { contentMessage: content } });
  if (!r.ok) log('rcs send failed', r.error);
  return r;
}
async function wa(to, payload) {
  const r = await D.vonageMessages(Object.assign({ from: D.WA_NUMBER, to: digits(to), channel: 'whatsapp' }, payload));
  if (!r.ok) log('wa send failed', r.error);
  return r;
}
async function waCard(to, card) {
  const caption = [card.title, card.desc].filter(Boolean).join('\n\n');
  const replies = (card.chips || []).filter((c) => !c.url && !c.dial && !c.cal && !c.map);
  const others = (card.chips || []).filter((c) => c.url || c.dial || c.cal || c.map);
  if (card.img && !replies.length) await wa(to, { message_type: 'image', image: { url: imgUrl(card.img), caption } });
  else if (replies.length) {
    const inter = { type: 'button', body: { text: caption.slice(0, 1024) }, action: { buttons: replies.slice(0, 3).map((c) => ({ type: 'reply', reply: { id: String(c.pb || c.t).toUpperCase().slice(0, 256), title: String(c.t).slice(0, 20) } })) } };
    if (card.img) inter.header = { type: 'image', image: { link: imgUrl(card.img) } };
    if (replies.length > 3) { inter.action = { button: 'Choose', sections: [{ title: 'Options', rows: replies.slice(0, 10).map((c) => ({ id: String(c.pb || c.t).toUpperCase().slice(0, 200), title: String(c.t).slice(0, 24) })) }] }; inter.type = 'list'; delete inter.header; if (card.img) await wa(to, { message_type: 'image', image: { url: imgUrl(card.img) } }); }
    await wa(to, { message_type: 'custom', custom: { type: 'interactive', interactive: inter } });
  } else await wa(to, { message_type: 'text', text: caption });
  for (const c of others) {
    if (c.url) await wa(to, { message_type: 'custom', custom: { type: 'interactive', interactive: { type: 'cta_url', body: { text: c.desc || c.t }, action: { name: 'cta_url', parameters: { display_text: String(c.t).slice(0, 20), url: c.url } } } } });
    else if (c.dial) await wa(to, { message_type: 'text', text: c.t + ': ' + c.dial });
    else if (c.map) await wa(to, { message_type: 'custom', custom: { type: 'location', location: { latitude: String(c.map.lat), longitude: String(c.map.lng), name: c.map.label, address: VENUE.address } } });
    else if (c.cal) await wa(to, { message_type: 'text', text: c.t + ': ' + c.cal.title + ' at ' + c.cal.start.slice(11, 16) + ' on ' + c.cal.start.slice(0, 10) });
  }
}
async function card(to, ch, c) { return ch === 'whatsapp' ? waCard(to, c) : rcs(to, { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: rcsCard(c) } } }); }
async function carousel(to, ch, cards, opts) {
  if (ch === 'whatsapp') return waCarousel(to, cards, opts || {});
  return rcs(to, { richCard: { carouselCard: { cardWidth: 'MEDIUM', cardContents: cards.slice(0, 10).map(rcsCard) } } });
}
// WhatsApp has no carousel outside templates: up to 3 cards go out as image+button cards, longer sets become
// one image plus a list menu (max 10 rows). A row whose card has a single reply chip jumps straight to that
// section; any other row (PK_WAC_<set>_<i>) sends that card back as an image with its buttons/links.
const isReply = (c) => !c.url && !c.dial && !c.cal && !c.map;
async function waCarousel(to, cards, opts) {
  cards = cards.slice(0, 10);
  if (cards.length <= 3) { for (const c of cards) { await waCard(to, c); await sleep(350); } return; }
  const s = sess(to); s.waSets = s.waSets || {}; const setId = (Date.now() % 100000).toString(36);
  s.waSets[setId] = cards; const keys = Object.keys(s.waSets); if (keys.length > 6) delete s.waSets[keys[0]];
  const head = opts.img || cards[0].img; const title = opts.title || cards[0].title;
  if (head) await wa(to, { message_type: 'image', image: { url: imgUrl(head), caption: title } });
  const seen = new Set();
  const rows = cards.map((c, i) => {
    const single = (c.chips || []).filter((x) => x.pb !== 'PK_MENU');
    let id = (single.length === 1 && isReply(single[0])) ? String(single[0].pb).toUpperCase() : 'PK_WAC_' + setId.toUpperCase() + '_' + i;
    if (seen.has(id)) id = 'PK_WAC_' + setId.toUpperCase() + '_' + i; seen.add(id);
    return { id: id.slice(0, 200), title: String(c.title || '').slice(0, 24), description: String(c.desc || '').slice(0, 72) };
  });
  return wa(to, { message_type: 'custom', custom: { type: 'interactive', interactive: { type: 'list', body: { text: opts.body || 'Pick one to open it. Reply MENU at any time to come back here.' }, action: { button: opts.button || 'Choose', sections: [{ title: String(opts.section || title || 'Options').slice(0, 24), rows }] } } } });
}
async function text(to, ch, t, chips) {
  if (ch === 'whatsapp') return waCard(to, { desc: t, chips: chips || [] });
  return rcs(to, Object.assign({ text: t }, chips && chips.length ? { suggestions: chips.slice(0, 11).map(rcsChip) } : {}));
}
async function file(to, ch, url, name) {
  if (ch === 'whatsapp') return wa(to, { message_type: 'file', file: { url, name, caption: 'Peak Season Promotions - agenda' } });
  const a = await D.vonageMessages({ from: D.RCS_SENDER, to: digits(to), channel: 'rcs', message_type: 'file', file: { url, name } });
  if (a.ok) return a;
  return rcs(to, { fileName: name, contentInfo: { fileUrl: url, forceRefresh: false } });
}
const calAt = (hhmm) => new Date(EVENT_DATE + 'T' + hhmm + ':00+01:00').toISOString();
const MENU = { t: 'Back to menu', pb: 'PK_MENU' };
const webChip = (t, page, extra) => ({ t, pb: 'PK_WEB_' + page.replace(/\W/g, '').toUpperCase(), url: D.DW_CF + '/' + page + (extra || ''), mode: 'TALL' });
const who = (to, ch) => '?to=' + digits(to) + '&ch=' + ch;
// a closing card: image + short line + Back to menu (+ one contextual chip)
const back = (to, ch, title, desc, img, extra) => card(to, ch, { title, desc, img, chips: [...(extra || []), MENU] });

// ------------------------------------------------------------------ sections
async function welcome(to, ch) {
  const s = sess(to); s.ch = ch; s.mode = null;
  USERS[digits(to)] = Date.now(); Promise.resolve().then(() => D.dset('peak_users', USERS)).catch(() => {});
  await card(to, ch, { title: 'Welcome to Peak Season Promotions', desc: 'Swipe the carousel to view the agenda, learn more about RCS and more!', img: 'hero', chips: [] });
  await sleep(5000);
  return menu(to, ch);
}
async function menu(to, ch) {
  return carousel(to, ch, [
    { title: 'Agenda', desc: 'Six sessions from 9:00. Add any of them to your calendar.', img: 'menu-agenda', chips: [{ t: 'View agenda', pb: 'PK_AGENDA' }] },
    { title: 'All Vonage solutions', desc: 'Every API and product, each with a 60-second video, the product page and the developer docs.', img: 'menu-showcase', chips: [{ t: 'Browse solutions', pb: 'PK_SOL' }] },
    { title: 'What is rich messaging', desc: 'Verified senders, rich cards, carousels and actions, explained in 60 seconds.', img: 'menu-rcs', chips: [{ t: 'Show me', pb: 'PK_RCS' }] },
    { title: 'Games', desc: 'Seven games: quiz, emoji decoder, true or false, higher or lower, memory match, tap the V, and a poll.', img: 'menu-game', chips: [{ t: 'Play', pb: 'PK_GAME' }] },
    { title: 'A branded demo, built for you', desc: 'Send a photo of your logo or product and our AI builds your RCS demo.', img: 'menu-branded', chips: [{ t: 'Build my demo', pb: 'PK_BRAND' }] },
    { title: 'Live demo showcase', desc: 'Shopping, a real voice call, video, documents and verification, all from this thread.', img: 'agenda-showcase', chips: [{ t: 'Open showcase', pb: 'PK_SHOW' }] },
    { title: 'Customer stories', desc: 'Aramex, Vinted, Revolut, Grab, Zalora and more: what they built on Vonage, with the full story on vonage.com.', img: 'agenda-telefonica', chips: [{ t: 'See the stories', pb: 'PK_STORIES' }] },
    { title: 'Find out more', desc: 'Tell us what you would like to build and we will follow up.', img: 'menu-form', chips: [webChip('Quick enquiry', 'peak-enquiry.html', who(to, ch))] },
    { title: 'Try it on WhatsApp', desc: 'The same experience runs on WhatsApp through the Vonage Messages API.', img: 'menu-whatsapp', chips: [{ t: 'Open WhatsApp', pb: 'PK_WA', url: 'https://wa.me/' + D.WA_NUMBER + '?text=PEAK', ext: true }] },
  ]);
}
async function agenda(to, ch) {
  // one carousel: the six sessions plus a closing "whole day" card (full agenda webview + PDF), no separate follow-up message
  return carousel(to, ch, [
    ...AGENDA.map((a) => ({ title: a.t + '  ' + a.title, desc: a.desc, img: a.img,
      chips: [{ t: 'Add to calendar', pb: 'PK_CAL', cal: { start: calAt(a.t), end: calAt(a.end), title: 'Peak Season Promotions: ' + a.title, desc: a.desc + ' (' + VENUE.name + ')' } }, MENU] })),
    { title: 'The whole day in one place', desc: 'The full agenda as a page, or as a PDF sent into this chat.', img: 'menu-agenda',
      chips: [webChip('Full agenda', 'peak-agenda.html'), { t: 'Send me the PDF', pb: 'PK_PDF' }, MENU] },
  ], { title: 'Agenda', img: 'menu-agenda' });
}
async function team(to, ch) {
  await carousel(to, ch, TEAM.map((m) => ({ title: m.name, desc: m.role, img: m.img, chips: [{ t: 'Say hello', pb: 'PK_HELLO' }, { t: 'Ask a question', pb: 'PK_ASK' }, MENU] })));
  return back(to, ch, 'Find us at the Vonage stand', 'We are there all morning. Wave at anyone in a Vonage T-shirt.', 'menu-team', [{ t: 'Venue map', pb: 'PK_MAP', map: { label: VENUE.name, lat: VENUE.lat, lng: VENUE.lng } }]);
}
function solCard(s, extraChip) {
  return { title: s[1], desc: s[2], img: SOL_BASE + s[0] + '-card.jpg',
    chips: [{ t: 'Watch the video', pb: 'PK_VID_' + s[0] }, { t: 'Product page', pb: 'PK_MKT_' + s[0], url: s[3], mode: 'TALL' }, { t: 'Developer docs', pb: 'PK_DOC_' + s[0], url: s[4], mode: 'TALL' }, ...(extraChip ? [extraChip] : [])] };
}
async function solutions(to, ch) {
  // two carousels only (9 + 9 solutions, the closing "build one for you" card rides in the second one)
  const a = SOL.slice(0, 9), b = SOL.slice(9);
  await carousel(to, ch, a.map((s, i) => solCard(s, i === a.length - 1 ? { t: 'More solutions', pb: 'PK_SOL_2' } : null)), { title: 'All Vonage solutions (1 of 2)', img: 'menu-showcase' });
  await sleep(1200);
  return carousel(to, ch, b.map((s) => solCard(s, MENU)), { title: 'All Vonage solutions (2 of 2)', img: 'menu-showcase' });
}
async function rcsExplainer(to, ch) {
  await carousel(to, ch, [
    { title: 'A verified sender', desc: 'Your brand name, logo and a verified badge on every message. No more "who is this?"', img: 'rcs-verified', chips: [webChip('The 60-second explainer', 'peak-rcs.html'), MENU] },
    { title: 'Rich cards and carousels', desc: 'Photos, titles, descriptions and buttons. Up to 10 cards in a swipeable carousel, like this one.', img: 'rcs-cards', chips: [{ t: 'See a shop carousel', pb: 'PK_SHOP' }, MENU] },
    { title: 'Suggested actions', desc: 'One tap to call, open a map, add to calendar, or open a webview without leaving the chat. Try them:', img: 'rcs-actions', chips: [{ t: 'Call Vonage', pb: 'PK_DIALX', dial: process.env.PEAK_DIAL_NUMBER || '' }, { t: 'Venue on the map', pb: 'PK_MAP', map: { label: VENUE.name, lat: VENUE.lat, lng: VENUE.lng } }, { t: 'Save the date', pb: 'PK_CAL', cal: { start: calAt('09:00'), end: calAt('12:15'), title: 'Peak Season Promotions', desc: 'Vonage x Telefonica, ' + VENUE.name } }, MENU] },
    { title: 'Delivered, read, replied', desc: 'Read receipts, typing indicators and analytics through the Vonage Messages API, with SMS fallback built in.', img: 'rcs-analytics', chips: [{ t: 'Watch the RCS video', pb: 'PK_VID_rcs' }, { t: 'Developer docs', pb: 'PK_DOC_rcs', url: SOL[1][4], mode: 'TALL' }, MENU] },
  ]);
}
// ---- games ----
async function games(to, ch) {
  const s = sess(to); s.quiz = null; s.emoji = null; s.tf = null; s.hl = null;
  return carousel(to, ch, [
    { title: 'The RCS quiz', desc: 'Four questions, right here in the chat.', img: 'game-1', chips: [{ t: 'Start', pb: 'PK_Q_0' }, MENU] },
    { title: 'Emoji decoder', desc: 'Guess the Vonage API from three emojis.', img: 'game-2', chips: [{ t: 'Decode', pb: 'PK_E_0' }, MENU] },
    { title: 'True or false', desc: 'Five statements about rich messaging. Trust your gut.', img: 'rcs-verified', chips: [{ t: 'Go', pb: 'PK_T_0' }, MENU] },
    { title: 'Higher or lower', desc: 'Three numbers from the world of RCS.', img: 'rcs-cards', chips: [{ t: 'Play', pb: 'PK_H_0' }, MENU] },
    { title: 'Memory match', desc: 'Find the six Vonage API pairs. Fewest moves wins.', img: 'menu-game', chips: [webChip('Open the game', 'peak-game.html', who(to, ch)), MENU] },
    { title: 'Tap the V', desc: 'Reaction test. Ten rounds, fastest average wins.', img: 'menu-rcs', chips: [webChip('Open the game', 'peak-reaction.html', who(to, ch)), MENU] },
    { title: 'The room poll', desc: POLL.q, img: 'agenda-panel', chips: [{ t: 'Vote', pb: 'PK_POLL' }, MENU] },
  ]);
}
async function quiz(to, ch, i) {
  const s = sess(to); if (i === 0 || !s.quiz) s.quiz = { i, score: 0 };
  const q = QUIZ[i]; if (!q) return quizEnd(to, ch); s.quiz.i = i;
  return card(to, ch, { title: 'Question ' + (i + 1) + ' of ' + QUIZ.length, desc: q.q, img: q.img, chips: q.a.map((a, k) => ({ t: a, pb: 'PK_A_' + i + '_' + k })) });
}
async function answer(to, ch, i, k) {
  const s = sess(to); if (!s.quiz) s.quiz = { i, score: 0 };
  const q = QUIZ[i]; if (!q) return quizEnd(to, ch);
  const right = q.ok === k; if (right) s.quiz.score += 1;
  if (i + 1 < QUIZ.length) { const n = QUIZ[i + 1]; s.quiz.i = i + 1; return card(to, ch, { title: (right ? 'Correct. ' : 'Not quite, it was ' + q.a[q.ok] + '. ') + 'Question ' + (i + 2) + ' of ' + QUIZ.length, desc: n.q, img: n.img, chips: n.a.map((a, kk) => ({ t: a, pb: 'PK_A_' + (i + 1) + '_' + kk })) }); }
  return quizEnd(to, ch, right ? 'Correct.' : 'Not quite, it was ' + q.a[q.ok] + '.');
}
async function quizEnd(to, ch, pre) {
  const s = sess(to); const sc = (s.quiz && s.quiz.score) || 0;
  const line = sc === QUIZ.length ? 'Perfect score. You clearly belong on the panel.' : sc >= 2 ? 'Nice. A couple more sessions and you will be unbeatable.' : 'Every expert started somewhere. The masterclass is at 9:40.';
  return card(to, ch, { title: (pre ? pre + ' ' : '') + 'You scored ' + sc + ' of ' + QUIZ.length, desc: line, img: 'game-win', chips: [{ t: 'Play again', pb: 'PK_Q_0' }, { t: 'More games', pb: 'PK_GAME' }, MENU] });
}
async function emoji(to, ch, i, pre) {
  const s = sess(to); if (i === 0 || !s.emoji) s.emoji = { score: 0 };
  const e = EMOJI[i]; if (!e) return card(to, ch, { title: (pre ? pre + ' ' : '') + 'Decoded ' + s.emoji.score + ' of ' + EMOJI.length, desc: s.emoji.score >= 3 ? 'Fluent in emoji and in Vonage.' : 'Good effort. The showcase at 10:30 has the answers.', img: 'game-win', chips: [{ t: 'Play again', pb: 'PK_E_0' }, { t: 'More games', pb: 'PK_GAME' }, MENU] });
  return card(to, ch, { title: (pre ? pre + ' ' : '') + 'Emoji ' + (i + 1) + ' of ' + EMOJI.length + ': which Vonage API?', desc: e.q, img: e.img, chips: e.a.map((a, k) => ({ t: a, pb: 'PK_EA_' + i + '_' + k })) });
}
async function emojiAnswer(to, ch, i, k) { const s = sess(to); if (!s.emoji) s.emoji = { score: 0 }; const e = EMOJI[i]; if (!e) return emoji(to, ch, 99); const ok = e.ok === k; if (ok) s.emoji.score += 1; return emoji(to, ch, i + 1, ok ? 'Yes!' : 'It was ' + e.a[e.ok] + '.'); }
async function tf(to, ch, i, pre) {
  const s = sess(to); if (i === 0 || !s.tf) s.tf = { score: 0 };
  const q = TF[i]; if (!q) return card(to, ch, { title: (pre ? pre + ' ' : '') + s.tf.score + ' of ' + TF.length + ' right', desc: s.tf.score === TF.length ? 'Flawless. Ask the panel something hard.' : 'Solid instincts. The explainer fills the gaps.', img: 'game-win', chips: [{ t: 'Play again', pb: 'PK_T_0' }, { t: 'More games', pb: 'PK_GAME' }, MENU] });
  return card(to, ch, { title: (pre ? pre + ' ' : '') + 'True or false, ' + (i + 1) + ' of ' + TF.length, desc: q.q, img: q.img, chips: [{ t: 'True', pb: 'PK_TA_' + i + '_1' }, { t: 'False', pb: 'PK_TA_' + i + '_0' }] });
}
async function tfAnswer(to, ch, i, v) { const s = sess(to); if (!s.tf) s.tf = { score: 0 }; const q = TF[i]; if (!q) return tf(to, ch, 99); const ok = q.ok === (v === 1); if (ok) s.tf.score += 1; return tf(to, ch, i + 1, ok ? 'Correct.' : (q.ok ? 'It was true.' : 'It was false.')); }
async function hl(to, ch, i, pre) {
  const s = sess(to); if (i === 0 || !s.hl) s.hl = { score: 0 };
  const q = HL[i]; if (!q) return card(to, ch, { title: (pre ? pre + ' ' : '') + s.hl.score + ' of ' + HL.length, desc: s.hl.score === HL.length ? 'You know your limits. Literally.' : 'Numbers are in the docs, one tap away.', img: 'game-win', chips: [{ t: 'Play again', pb: 'PK_H_0' }, { t: 'More games', pb: 'PK_GAME' }, MENU] });
  return card(to, ch, { title: (pre ? pre + ' ' : '') + 'Higher or lower, ' + (i + 1) + ' of ' + HL.length, desc: q.q, img: q.img, chips: [{ t: 'Higher', pb: 'PK_HA_' + i + '_HIGHER' }, { t: 'Lower', pb: 'PK_HA_' + i + '_LOWER' }] });
}
async function hlAnswer(to, ch, i, v) { const s = sess(to); if (!s.hl) s.hl = { score: 0 }; const q = HL[i]; if (!q) return hl(to, ch, 99); const ok = q.ok === v; if (ok) s.hl.score += 1; return hl(to, ch, i + 1, (ok ? 'Right. ' : 'No. ') + q.fact); }
async function poll(to, ch) { return card(to, ch, { title: 'The room poll', desc: POLL.q, img: 'agenda-panel', chips: POLL.opts.map((o, k) => ({ t: o, pb: 'PK_PV_' + k })) }); }
async function pollVote(to, ch, k) {
  const counts = await D.dget('peak_poll', {}); const key = digits(to);
  counts.votes = counts.votes || {}; counts.votes[key] = k; const tally = [0, 0, 0, 0]; Object.values(counts.votes).forEach((v) => { if (tally[v] != null) tally[v] += 1; });
  await D.dset('peak_poll', counts); const total = tally.reduce((a, b) => a + b, 0) || 1;
  const lines = POLL.opts.map((o, i) => o + ': ' + Math.round(100 * tally[i] / total) + '%').join('\n');
  return card(to, ch, { title: 'You voted: ' + POLL.opts[k], desc: 'The room so far (' + total + ' votes):\n' + lines, img: 'agenda-panel', chips: [{ t: 'Change my vote', pb: 'PK_POLL' }, { t: 'More games', pb: 'PK_GAME' }, MENU] });
}
// ---- AI branded demo ----
async function brand(to, ch) {
  const s = sess(to); s.mode = 'brand'; s.modeAt = Date.now();
  return card(to, ch, { title: 'A branded demo, built for you', desc: 'Send one photo in this chat: your logo, a product, your shop front, or your website on a screen. Our AI reads it and replies with an RCS demo for your brand.', img: 'menu-branded',
    chips: [{ t: 'How it works', pb: 'PK_BRAND_HOW' }, { t: 'Customer stories', pb: 'PK_STORIES' }, MENU] });
}
async function brandHow(to, ch) {
  return card(to, ch, { title: 'How it works', desc: '1. Attach a photo. 2. Vision AI identifies the brand, colours and industry. 3. It drafts three customer messages and generates the images. 4. You get a branded RCS carousel back in this chat. About 30 seconds.', img: 'rcs-cards', chips: [{ t: 'Customer stories', pb: 'PK_STORIES' }, MENU] });
}
async function brandFromImage(to, ch, imageUrl) {
  const s = sess(to); s.mode = null;
  await card(to, ch, { title: 'Got it, building your demo', desc: 'Reading the photo, drafting the messages and generating the images. About 30 seconds.', img: 'menu-branded', chips: [] });
  let bytes, mime = 'image/jpeg';
  try { let r = await D.f(imageUrl, { headers: { Authorization: 'Bearer ' + D.vjwt() } }); if (!r.ok) r = await D.f(imageUrl); mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0]; bytes = Buffer.from(await r.arrayBuffer()); } catch (e) { log('image fetch failed', e.message); }
  if (!bytes) return back(to, ch, 'I could not download that photo', 'Please send it again.', 'menu-branded', [{ t: 'Try again', pb: 'PK_BRAND' }]);
  const prompt = 'You are a Vonage solutions architect at a retail and telecom event. Look at this photo and identify the brand or business (logo, product, shop, website). Reply with ONLY JSON: {"brand":"name","industry":"...","colour":"#hex primary brand colour","tone":"3 words","summary":"one sentence on what the business does","cards":[{"title":"short customer-facing title","desc":"one short line as a message from the brand to its customer, no prices","cta":"button label under 20 chars","imagePrompt":"a vivid real-world photo scene for this card, no text or logos"}]} with exactly 3 cards (welcome or offer, a carousel-worthy product or service, a service or reminder moment), written as RCS rich-card messages. If the photo is not a brand, pick the most plausible business and say so in summary.';
  let info = null;
  try {
    const r = await D.f('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + D.DW_GEMINI_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: bytes.toString('base64') } }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } }) });
    const d = await r.json(); const t = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts.map((p) => p.text || '').join('');
    const m = String(t || '').match(/\{[\s\S]*\}/); if (m) info = JSON.parse(m[0]);
  } catch (e) { log('vision failed', e.message); }
  if (!info || !Array.isArray(info.cards) || !info.cards.length) return back(to, ch, 'No brand found in that photo', 'Try a clearer shot of a logo, a product or a storefront.', 'menu-branded', [{ t: 'Try again', pb: 'PK_BRAND' }]);
  const id = Date.now().toString(36);
  const imgs = await Promise.all(info.cards.slice(0, 3).map((c, i) => genImage((c.imagePrompt || c.title) + '. Brand colour ' + (info.colour || 'neutral') + ', ' + (info.tone || 'modern') + '.', 'brand/' + id + '-' + i)));
  s.brand = info;
  // RCS only: one branded carousel (intro, three customer messages, closing card), no API suggestions
  return carousel(to, ch, [
    { title: (info.brand || 'Your brand') + ' on RCS', desc: (info.summary || '') + ' Swipe for three messages your customers could receive.', img: imgs[0] || 'menu-branded', chips: [MENU] },
    ...info.cards.slice(0, 3).map((c, i) => ({ title: String(c.title || info.brand).slice(0, 80), desc: String(c.desc || '').slice(0, 300), img: imgs[i] || 'menu-branded', chips: [{ t: String(c.cta || 'Learn more').slice(0, 20), pb: 'PK_BRAND_TAP' }, MENU] })),
    { title: 'Your brand, verified, in the messages app', desc: 'Every card here is one Messages API call on the Vonage RCS channel: verified sender, rich cards, tracked taps, SMS fallback.', img: imgs[1] || 'menu-branded',
      chips: [webChip('Talk to us', 'peak-enquiry.html', who(to, ch) + '&brand=' + encodeURIComponent(info.brand || '')), { t: 'Build another', pb: 'PK_BRAND' }, MENU] },
  ], { title: (info.brand || 'Your brand') + ' on RCS', img: imgs[0] || 'menu-branded' });
}
async function genImage(prompt, key) {
  try {
    const r = await D.f('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + D.DW_GEMINI_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Professional marketing photograph for a mobile rich card, landscape 16:9, vivid, realistic, no text, no words, no logos, no watermark: ' + prompt }] }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }) });
    const d = await r.json(); const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    const p = parts.find((x) => x.inlineData || x.inline_data); if (!p) return null;
    const inl = p.inlineData || p.inline_data; const buf = Buffer.from(inl.data, 'base64');
    const Key = 'demoworld/peak/' + key + '.png';
    await D.s3.send(new D.PutObjectCommand({ Bucket: D.S3_BUCKET, Key, Body: buf, ContentType: inl.mimeType || 'image/png', ACL: 'public-read' }));
    return 'https://' + D.S3_BUCKET + '.s3.eu-north-1.amazonaws.com/' + Key;
  } catch (e) { log('genImage failed', e.message); return null; }
}
// ---- customer stories (real vonage.com pages) ----
const STORY_BASE = (process.env.ASSET_BASE || '') + '/peak/story/';
const STORIES = [
  ['aramex', 'Aramex', 'Delivery updates and two-way support on WhatsApp across the Middle East, on the Messages API.', 'https://www.vonage.com/resources/customers/aramex/'],
  ['vinted', 'Vinted', 'The second-hand fashion marketplace protects buyers and sellers from fraud with the Verify API.', 'https://www.vonage.com/resources/customers/vinted/'],
  ['revolut', 'Revolut', 'Two-factor authentication over SMS so users can send money globally with confidence.', 'https://www.vonage.com/resources/customers/disruptive-fintech-startup-revolut-verifies-genuine-users-with-n/'],
  ['remitly', 'Remitly', 'The largest independent digital remittance company in the US safeguards transfers with SMS 2FA.', 'https://www.vonage.com/resources/customers/remitly/'],
  ['blablacar', 'BlaBlaCar', 'Passenger and driver confidence with SMS and two-factor authentication.', 'https://www.vonage.com/resources/customers/blablacar/'],
  ['kiwicom', 'Kiwi.com', 'Keeps travellers informed on the fly: itinerary changes and alerts on the SMS API.', 'https://www.vonage.com/resources/customers/kiwicom/'],
  ['grab', 'Grab', 'Adaptive routing across SMS and Voice so every message and call lands, wherever the user is.', 'https://www.vonage.com/resources/customers/grab/'],
  ['zalora', 'Zalora', 'Operational and marketing messages at scale for the online fashion marketplace across Asia.', 'https://www.vonage.com/resources/customers/zalora/'],
  ['carousell', 'Carousell', 'A safe, reliable way to connect, buy and sell online, powered by Vonage APIs.', 'https://www.vonage.com/resources/customers/carousell/'],
  ['dunelm', 'Dunelm', 'The UK homewares retailer runs its contact centre and business communications on Vonage.', 'https://www.vonage.com/resources/customers/dunelm-customer/'],
];
async function stories(to, ch) {
  // one carousel: nine stories plus the "all stories" card (RCS max is 10 cards)
  return carousel(to, ch, [
    ...STORIES.slice(0, 9).map((s) => ({ title: s[1], desc: s[2], img: STORY_BASE + s[0] + '.png',
      chips: [{ t: 'Read the story', pb: 'PK_STORY_' + s[0], url: s[3], mode: 'TALL' }, MENU] })),
    { title: 'All customer stories', desc: 'Hundreds more on vonage.com: retail, travel, fintech, healthcare and telecoms.', img: 'agenda-showcase', chips: [{ t: 'Browse all stories', pb: 'PK_STORY_ALL', url: 'https://www.vonage.com/resources/customers/', mode: 'TALL' }, { t: 'Build my demo', pb: 'PK_BRAND' }, MENU] },
  ], { title: 'Customer stories', img: 'agenda-telefonica' });
}
// ---- Verify (real one-time code, checked in the thread) ----
async function verifyStart(to, ch, next) {
  const s = sess(to); next = next || 'PK_SHOW';
  try {
    const wf = ch === 'whatsapp' ? [{ channel: 'whatsapp', to: digits(to), from: D.WA_NUMBER }, { channel: 'sms', to: digits(to) }] : [{ channel: 'sms', to: digits(to) }];
    const r = await D.f(D.API_BASE + '/v2/verify', { method: 'POST', headers: { Authorization: D.DW_VBASIC(), 'Content-Type': 'application/json' }, body: JSON.stringify({ brand: 'Vonage', workflow: wf, code_length: 6 }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.request_id) { s.verify = { id: d.request_id, at: Date.now(), next }; return card(to, ch, { title: 'Code sent', desc: 'A 6-digit code is on its way by ' + (ch === 'whatsapp' ? 'WhatsApp' : 'SMS') + ' from the Vonage Verify API. Type it here to continue.', img: 'showcase-verify', chips: [{ t: 'Skip', pb: next }] }); }
    if (r.status === 409) { s.verify = { id: null, at: Date.now(), next }; return card(to, ch, { title: 'A code was already sent', desc: 'Type the code you received a moment ago, or wait two minutes and try again.', img: 'showcase-verify', chips: [{ t: 'Skip', pb: next }] }); }
    log('verify start failed', JSON.stringify(d).slice(0, 200));
  } catch (e) { log('verify error', e.message); }
  return card(to, ch, { title: 'Verification unavailable right now', desc: 'We will skip it for the demo.', img: 'showcase-verify', chips: [{ t: 'Continue', pb: next }, MENU] });
}
async function checkCode(to, ch, code) {
  const s = sess(to); const v = s.verify; s.verify = null;
  if (!v || !v.id) return card(to, ch, { title: 'Nothing to check that code against', desc: 'Start a verification first.', img: 'showcase-verify', chips: [{ t: 'Verify again', pb: 'PK_VERIFY' }, { t: 'Continue', pb: v ? v.next : 'PK_MENU' }] });
  const r = await D.f(D.API_BASE + '/v2/verify/' + encodeURIComponent(v.id), { method: 'POST', headers: { Authorization: D.DW_VBASIC(), 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  if (r.status === 200) { await card(to, ch, { title: 'Verified', desc: 'That was the Vonage Verify API. With Silent Authentication on a UK mobile it can happen with no code at all.', img: 'rcs-verified', chips: [{ t: 'Verify API video', pb: 'PK_VID_verify' }, MENU] }); await sleep(400); return dispatch(to, ch, v.next); }
  s.verify = v; return card(to, ch, { title: 'That code did not match', desc: 'Try again, or skip.', img: 'showcase-verify', chips: [{ t: 'Skip', pb: v.next }] });
}
// ---- showcase ----
async function showcase(to, ch) {
  return carousel(to, ch, [
    { title: 'Shopping', desc: 'A product carousel with a checkout webview that supports Apple Pay and Google Pay.', img: 'showcase-shop', chips: [{ t: 'Shop the edit', pb: 'PK_SHOP' }, MENU] },
    { title: 'A live voice call', desc: 'Tap and the Vonage Voice API calls this phone with a spoken message.', img: 'showcase-voice', chips: [{ t: 'Call me now', pb: 'PK_CALL' }, MENU] },
    { title: 'Video', desc: 'Open a Vonage Video room in the thread. Invite a colleague with the same link.', img: 'showcase-video', chips: [{ t: 'Open video room', pb: 'PK_VIDEO', url: (process.env.PUBLIC_BASE || '') + '/demoworld-video.html?room=peak', ext: true }, MENU] },
    { title: 'Documents', desc: 'Send a PDF straight into the conversation, no link, no download page.', img: 'showcase-docs', chips: [{ t: 'Send the agenda PDF', pb: 'PK_PDF' }, MENU] },
    { title: 'Verification', desc: 'A real one-time code from the Verify API, checked right here.', img: 'showcase-verify', chips: [{ t: 'Send me a code', pb: 'PK_VERIFY' }, MENU] },
    { title: 'Every product, explained', desc: 'A 60-second video for each Vonage API, plus product page and docs.', img: 'menu-showcase', chips: [{ t: 'Browse solutions', pb: 'PK_SOL' }, MENU] },
    { title: 'WhatsApp', desc: 'The same demo, same code, on WhatsApp.', img: 'menu-whatsapp', chips: [{ t: 'Open WhatsApp', pb: 'PK_WA', url: 'https://wa.me/' + D.WA_NUMBER + '?text=PEAK', ext: true }, MENU] },
  ]);
}
const noPrice = (s) => String(s || '').replace(/\s*[-·]\s*[£€$]\s?[\d.,]+.*$/, '').replace(/[£€$]\s?[\d.,]+/g, '').trim();
async function shop(to, ch) {
  await carousel(to, ch, [
    ...D.DW_PRODUCTS.map((p) => ({ title: p.name, desc: noPrice(p.desc), img: p.img, chips: [{ t: 'Shop', pb: 'PK_SHOP_TAP', url: p.url, mode: 'TALL' }, MENU] })),
    { title: 'Every tap is tracked', desc: 'Each button comes back as a postback, so you know which card sold.', img: 'showcase-shop', chips: [{ t: 'Back to showcase', pb: 'PK_SHOW' }, MENU] },
  ]);
}
async function callMe(to, ch) {
  const msg = 'Hello from Peak Season Promotions. This call was placed by the Vonage Voice A P I the moment you tapped the card. Alerts, reminders, I V R menus and callbacks work exactly like this. Enjoy the rest of the event.';
  try {
    const r = await D.f(D.API_BASE + '/v1/calls', { method: 'POST', headers: { Authorization: 'Bearer ' + D.vjwt(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: [{ type: 'phone', number: digits(to) }], from: { type: 'phone', number: D.VOICE_NUMBER }, answer_url: [D.DW_CF + '/dw/voice/answer?m=' + encodeURIComponent(msg)], answer_method: 'GET' }) });
    if (r.ok) return card(to, ch, { title: 'Calling you now', desc: 'From +' + D.VOICE_NUMBER + '. Pick up to hear the Voice API.', img: 'showcase-voice', chips: [{ t: 'Voice API video', pb: 'PK_VID_voice' }, { t: 'Back to showcase', pb: 'PK_SHOW' }, MENU] });
    log('call failed', r.status, (await r.text()).slice(0, 200));
  } catch (e) { log('call error', e.message); }
  return back(to, ch, 'The call could not be placed', 'Try again in a moment.', 'showcase-voice', [{ t: 'Try again', pb: 'PK_CALL' }]);
}
async function sendPdf(to, ch) {
  const r = await file(to, ch, PDF_URL, 'Peak-Season-Promotions-Agenda.pdf');
  if (!r || !r.ok) return back(to, ch, 'Agenda', 'Open the full agenda:', 'showcase-docs', [webChip('Open the agenda', 'peak-agenda.html')]);
  await sleep(800);
  return back(to, ch, 'The agenda PDF is above', 'One tap to open, no link, no download page.', 'showcase-docs', [webChip('Or view as a page', 'peak-agenda.html')]);
}
async function enquiryThanks(to, ch, e) {
  return card(to, ch, { title: 'Thanks, ' + (e.name || 'we have your details'), desc: 'We will follow up about ' + (e.interest || 'your project') + (e.company ? ' at ' + e.company : '') + ' within one working day. Meanwhile, keep exploring.', img: 'form-thanks', chips: [{ t: 'Build a branded demo', pb: 'PK_BRAND' }, { t: 'Play a game', pb: 'PK_GAME' }, MENU] });
}

// ---- free-text Q&A about Vonage (Gemini, event + product context, no prices) ----
let USERS = {};                                  // numbers that have opened the demo (persisted so questions survive a redeploy)
const OTHER_TRIGGERS = /^(GLOW|WAYFAIR|WF_|PARKING|PARK|EPARK|CC |STOP|START|UNSUBSCRIBE)/;
const KB = () => 'EVENT: Peak Season Promotions, Vonage x Telefonica, ' + EVENT_DATE + ' at ' + VENUE.name + ', ' + VENUE.address + '. AGENDA: ' + AGENDA.map((a) => a.t + '-' + a.end + ' ' + a.title + ' (' + a.desc + ')').join('; ') +
  '. VONAGE SOLUTIONS: ' + SOL.map((s) => s[1] + ': ' + s[2] + ' [product ' + s[3] + ', docs ' + s[4] + ']').join('; ') +
  '. CUSTOMER STORIES: ' + STORIES.map((s) => s[1] + ' (' + s[2] + ') ' + s[3]).join('; ') +
  '. RCS FACTS: verified sender with logo; rich cards; carousels up to 10 cards; up to 4 suggestions per card and 11 per text; suggested actions dial, open URL or webview (HALF/TALL/FULL), calendar, location; read receipts; SMS fallback when the handset has no RCS; sent through the Vonage Messages API; agents are registered per brand and approved by carriers; Apple added RCS to iPhone in iOS 18 (2024) and RCS Business Messaging on iPhone is rolling out carrier by carrier, with SMS fallback everywhere else; Android has RCS in Google Messages by default.';
async function ask(to, ch, question) {
  const prompt = 'You are the Vonage assistant chatting with a guest at the Peak Season Promotions event, over ' + (ch === 'whatsapp' ? 'WhatsApp' : 'RCS') + '. Answer the question using the facts below plus your general knowledge of Vonage (a global cloud communications company, part of Ericsson: Communications APIs, Contact Center, Business Communications, Network APIs). Rules: plain text only, no markdown, no bullet symbols, at most 90 words, friendly and concrete, never quote prices or pricing (say the team at the stand can talk pricing), include one relevant vonage.com or developer.vonage.com link when it helps, and if the question is not about Vonage, communications or the event, answer briefly and steer back to Vonage.\n\nFACTS: ' + KB() + '\n\nQUESTION: ' + question;
  let answer = null;
  try {
    const r = await D.f('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + D.DW_GEMINI_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } } }) });
    const d = await r.json(); answer = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts.map((p) => p.text || '').join('').trim();
    if (d.candidates && d.candidates[0] && d.candidates[0].finishReason && d.candidates[0].finishReason !== 'STOP') log('ask finish', d.candidates[0].finishReason);
  } catch (e) { log('ask failed', e.message); }
  if (!answer) answer = 'I could not reach the assistant just now. The Vonage team at the stand can answer anything, or browse the solutions carousel.';
  return text(to, ch, answer.replace(/[*_#`]/g, '').slice(0, 1900), [MENU]);
}
// ---- native video message (RCS media message with suggestions / WhatsApp button message with a video header) ----
async function sendVideo(to, ch, id) {
  const s = SOL.find((x) => x[0] === id); if (!s) return menu(to, ch);
  const url = SOL_BASE + 'v2/' + id + '.mp4', thumb = SOL_BASE + 'v2/' + id + '-poster.jpg';   // v2 = Baseline-profile encode under fresh URLs (no platform cache)
  const chips = [{ t: 'Product page', pb: 'PK_MKT_' + id, url: s[3], mode: 'TALL' }, { t: 'Developer docs', pb: 'PK_DOC_' + id, url: s[4], mode: 'TALL' }, MENU];
  if (ch === 'whatsapp') {
    return wa(to, { message_type: 'custom', custom: { type: 'interactive', interactive: { type: 'button', header: { type: 'video', video: { link: url } }, body: { text: s[1] + ': ' + s[2] }, action: { buttons: [{ type: 'reply', reply: { id: 'PK_MENU', title: 'Back to menu' } }] } } } });
  }
  // forceRefresh: the RBM platform caches media by URL, and the first uploads were an unplayable yuv444p encode
  const r = await rcs(to, { contentInfo: { fileUrl: url, thumbnailUrl: thumb, forceRefresh: true }, suggestions: chips.map(rcsChip) });
  if (r.ok) return r;
  // fallback: plain video message, then a card with the buttons
  await D.vonageMessages({ from: D.RCS_SENDER, to: digits(to), channel: 'rcs', message_type: 'video', video: { url } });
  return card(to, ch, { title: s[1], desc: s[2], img: thumb, chips });
}
// ------------------------------------------------------------------ dispatch
async function dispatch(to, ch, pb) {
  const u = String(pb || '').toUpperCase();
  if (u === 'PK_MENU') return menu(to, ch);
  if (u === 'PK_AGENDA') return agenda(to, ch);
  if (u.startsWith('PK_WAC_')) { const m = u.match(/^PK_WAC_(\w+)_(\d+)$/); const set = m && sess(to).waSets && sess(to).waSets[m[1].toLowerCase()]; const c = set && set[+m[2]]; if (c) return waCard(to, Object.assign({}, c, { chips: [...(c.chips || []).filter((x) => x.pb !== 'PK_MENU'), MENU] })); return menu(to, ch); }
  if (u === 'PK_SOL') return solutions(to, ch);
  if (u === 'PK_SOL_2') return carousel(to, ch, SOL.slice(9).map((s, i, arr) => solCard(s, i === arr.length - 1 ? MENU : null)));
  if (u === 'PK_HELLO') return back(to, ch, 'Hello back!', 'Wave at anyone in a Vonage T-shirt, or find us at the stand by the entrance.', 'menu-team');
  if (u === 'PK_ASK') return back(to, ch, 'Ask away', 'Type your question here and one of the team will answer it in this thread during the panel.', 'agenda-panel');
  if (u === 'PK_RCS') return rcsExplainer(to, ch);
  if (u === 'PK_GAME') return games(to, ch);
  if (u.startsWith('PK_Q_')) return quiz(to, ch, parseInt(u.slice(5), 10) || 0);
  if (u.startsWith('PK_A_')) { const m = u.match(/^PK_A_(\d+)_(\d+)$/); if (m) return answer(to, ch, +m[1], +m[2]); }
  if (u.startsWith('PK_E_')) return emoji(to, ch, parseInt(u.slice(5), 10) || 0);
  if (u.startsWith('PK_EA_')) { const m = u.match(/^PK_EA_(\d+)_(\d+)$/); if (m) return emojiAnswer(to, ch, +m[1], +m[2]); }
  if (u.startsWith('PK_T_')) return tf(to, ch, parseInt(u.slice(5), 10) || 0);
  if (u.startsWith('PK_TA_')) { const m = u.match(/^PK_TA_(\d+)_(\d)$/); if (m) return tfAnswer(to, ch, +m[1], +m[2]); }
  if (u.startsWith('PK_H_')) return hl(to, ch, parseInt(u.slice(5), 10) || 0);
  if (u.startsWith('PK_HA_')) { const m = u.match(/^PK_HA_(\d+)_(HIGHER|LOWER)$/); if (m) return hlAnswer(to, ch, +m[1], m[2]); }
  if (u === 'PK_POLL') return poll(to, ch);
  if (u.startsWith('PK_PV_')) return pollVote(to, ch, parseInt(u.slice(6), 10) || 0);
  if (u === 'PK_BRAND') return brand(to, ch);
  if (u === 'PK_BRAND_HOW') return brandHow(to, ch);
  if (u === 'PK_BRAND_TAP') return back(to, ch, 'In a live deployment', 'That tap would open your webview, call you, or continue the flow. Every tap is tracked.', 'menu-branded', [{ t: 'Build another', pb: 'PK_BRAND' }]);
  if (u === 'PK_STORIES') return stories(to, ch);
  if (u.startsWith('PK_VID_')) return sendVideo(to, ch, pb.slice(7).toLowerCase());
  if (u === 'PK_SHOW') return showcase(to, ch);
  if (u === 'PK_SHOP') return shop(to, ch);
  if (u === 'PK_CALL') return callMe(to, ch);
  if (u === 'PK_PDF') return sendPdf(to, ch);
  if (u === 'PK_VERIFY') return verifyStart(to, ch, 'PK_SHOW');
  if (u === 'PK_CAL' || u === 'PK_MAP' || u === 'PK_DIALX' || u === 'PK_WA' || u === 'PK_VIDEO' || u === 'PK_SHOP_TAP' || u.startsWith('PK_WEB_') || u.startsWith('PK_MKT_') || u.startsWith('PK_DOC_') || u.startsWith('PK_STORY_')) return null; // native actions: nothing to send
  return menu(to, ch);
}
function isTrigger(upper) { const u = String(upper || '').replace(/[^A-Z0-9 ]/g, '').trim(); return TRIGGERS.includes(u); }
// Called from the messages webhook. Returns true when this module handled the message.
async function inbound(m) {
  if (!D) return false;
  const ch = m.channel === 'whatsapp' ? 'whatsapp' : m.channel === 'rcs' ? 'rcs' : null; if (!ch) return false;
  const from = digits(m.from); const upper = String(m.upper || '').toUpperCase(); const s = S[from];
  const mt = String(m.message_type || '').toLowerCase();
  const imageUrl = (mt === 'image' && m.body && m.body.image && m.body.image.url) ? m.body.image.url : null;
  if (imageUrl && s && s.mode === 'brand' && Date.now() - (s.modeAt || 0) < 30 * 60000) { sess(from).ch = ch; brandFromImage(from, ch, imageUrl).catch((e) => log('brand flow', e.message)); return true; }
  if (upper.startsWith('PK_')) { sess(from).ch = ch; dispatch(from, ch, upper).catch((e) => log('dispatch', e.message)); return true; }
  // RCS url/dial/calendar/map actions arrive as message_type 'button' with the postback in button.payload; swallow ours so no other bot fires.
  const bp = String((m.body && m.body.button && m.body.button.payload) || '').toUpperCase();
  if (bp.startsWith('PK_')) { sess(from).ch = ch; dispatch(from, ch, bp).catch((e) => log('dispatch', e.message)); return true; }
  if (isTrigger(upper)) { welcome(from, ch).catch((e) => log('welcome', e.message)); return true; }
  if (upper === 'MENU' && (s || USERS[from])) { sess(from).ch = ch; menu(from, ch).catch((e) => log('menu', e.message)); return true; }
  if (s && s.verify && /^\d{4,8}$/.test(String(m.text || '').trim()) && Date.now() - s.verify.at < 10 * 60000) { checkCode(from, ch, String(m.text).trim()).catch((e) => log('check', e.message)); return true; }
  // Any other typed text from someone who has opened this demo: answer it as the Vonage assistant.
  const q = String(m.text || '').trim();
  if (mt === 'text' && q.length > 1 && (s || USERS[from]) && !OTHER_TRIGGERS.test(upper)) { sess(from).ch = ch; ask(from, ch, q).catch((e) => log('ask', e.message)); return true; }
  return false;
}

function mount(app, deps) {
  D = deps;
  const express = deps.express;
  app.post('/dw/peak/enquiry', express.json(), async (req, res) => {
    const b = req.body || {}; const to = digits(b.to); const ch = b.ch === 'whatsapp' ? 'whatsapp' : 'rcs';
    const e = { at: new Date().toISOString(), to, ch, name: String(b.name || '').slice(0, 80), company: String(b.company || '').slice(0, 80), email: String(b.email || '').slice(0, 120), interest: String(b.interest || '').slice(0, 80), message: String(b.message || '').slice(0, 1000), brand: String(b.brand || '').slice(0, 80) };
    try { const list = await D.dget('peak_enquiries', []); list.unshift(e); await D.dset('peak_enquiries', list.slice(0, 500)); } catch (err) { log('enquiry save', err.message); }
    res.json({ ok: true });
    if (to.length >= 9) enquiryThanks(to, ch, e).catch((err) => log('thanks', err.message));
    try { if (D.sendEmail) await D.sendEmail(process.env.DW_ADMIN_EMAIL, { subject: 'Peak Season enquiry: ' + (e.name || to), body: 'Name: ' + e.name + '\nCompany: ' + e.company + '\nEmail: ' + e.email + '\nPhone: +' + to + '\nInterest: ' + e.interest + '\nBrand demo: ' + e.brand + '\n\n' + e.message }); } catch (err) {}
  });
  app.get('/dw/peak/enquiries', async (req, res) => { if (!process.env.DW_ADMIN_KEY || req.query.k !== process.env.DW_ADMIN_KEY) return res.status(403).send('no'); res.json(await D.dget('peak_enquiries', [])); });
  app.post('/dw/peak/score', express.json(), async (req, res) => {
    const b = req.body || {}; const to = digits(b.to); const ch = b.ch === 'whatsapp' ? 'whatsapp' : 'rcs'; const moves = parseInt(b.moves, 10) || 0; const secs = parseInt(b.secs, 10) || 0;
    res.json({ ok: true });
    if (to.length >= 9) card(to, ch, { title: 'Memory match: ' + moves + ' moves in ' + secs + 's', desc: moves <= 10 ? 'Elite. Show that to the panel.' : moves <= 16 ? 'Solid. The masterclass will sharpen you further.' : 'Warmed up. Play again for a better time.', img: 'game-win', chips: [webChip('Play again', 'peak-game.html', who(to, ch)), { t: 'More games', pb: 'PK_GAME' }, MENU] }).catch((e) => log('score', e.message));
  });
  app.post('/dw/peak/prize', express.json(), async (req, res) => {
    const b = req.body || {}; const to = digits(b.to); const ch = b.ch === 'whatsapp' ? 'whatsapp' : 'rcs';
    res.json({ ok: true });
    if (to.length >= 9) card(to, ch, { title: 'You won: ' + String(b.prize || 'a prize').slice(0, 80), desc: String(b.note || 'Show this card to the Vonage team.').slice(0, 200) + ' Show this card to claim it.', img: 'game-win', chips: [webChip('Scratch another', 'peak-scratch.html', who(to, ch)), { t: 'More games', pb: 'PK_GAME' }, MENU] }).catch((e) => log('prize', e.message));
  });
  app.post('/dw/peak/reaction', express.json(), async (req, res) => {
    const b = req.body || {}; const to = digits(b.to); const ch = b.ch === 'whatsapp' ? 'whatsapp' : 'rcs'; const avg = parseInt(b.avg, 10) || 0, best = parseInt(b.best, 10) || 0;
    res.json({ ok: true });
    if (to.length >= 9) card(to, ch, { title: 'Tap the V: ' + avg + 'ms average', desc: 'Best tap ' + best + 'ms. ' + (avg < 300 ? 'Lightning. Are you sure you are human?' : avg < 450 ? 'Quick. Coffee is working.' : 'Warmed up. Another go after the breakfast?'), img: 'game-win', chips: [webChip('Play again', 'peak-reaction.html', who(to, ch)), { t: 'More games', pb: 'PK_GAME' }, MENU] }).catch((e) => log('reaction', e.message));
  });
  app.get('/dw/peak/team', (req, res) => res.json({ team: TEAM, agenda: AGENDA, date: EVENT_DATE, venue: VENUE }));
  Promise.resolve().then(() => D.dget('peak_users', {})).then((u) => { if (u && typeof u === 'object') USERS = Object.assign(u, USERS); log('users loaded', Object.keys(USERS).length); }).catch(() => {});
  log('mounted; event date', EVENT_DATE);
}
module.exports = { mount, inbound, welcome, TEAM, AGENDA, SOL };

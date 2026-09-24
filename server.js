'use strict';
// Vonage Demo-World - internal API demo platform (Express on Node.js).
// Routes: /demoworld (SPA), /dw/api/* (demo actions), /dw/admin, /webhooks/* (Vonage callbacks), /dw/voice/* (NCCO).
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const multer = require('multer');
const peak = require('./peak'); // Peak Season event demo module (mounted after the config below)
const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 8081;

// ============================================================
// Configuration - everything account-specific comes from the environment (see .env.example).
// Nothing in this repository identifies a Vonage account, a phone number or an application.
// ============================================================
const env = (k, d = '') => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);
const VONAGE_API_KEY = env('VONAGE_API_KEY');
const VONAGE_API_SECRET = env('VONAGE_API_SECRET');
const VONAGE_APP_ID = env('VONAGE_APP_ID');                       // messaging + voice application
const VONAGE_KEY = (() => { try { return fs.readFileSync(path.join(__dirname, env('VONAGE_PRIVATE_KEY_FILE', 'private.key')), 'utf8'); } catch (e) { return env('VONAGE_PRIVATE_KEY'); } })();
const WA_NUMBER = env('WA_NUMBER');                               // WhatsApp Business number (digits)
const WA_WABA_ID = env('WA_WABA_ID');                             // WhatsApp Business Account id (templates)
const RCS_SENDER = env('RCS_SENDER');                             // RCS agent id (launched agent)
const RBM_AGENT = env('RBM_AGENT');                               // RBM deep-link agent handle, e.g. <agent>_<id>_agent
const VIBER_FROM = env('VIBER_FROM');                             // Viber Business service id
const SMS_FROM = env('SMS_FROM', WA_NUMBER);                      // numeric SMS sender
const VOICE_NUMBER = env('VOICE_NUMBER', WA_NUMBER);              // outbound caller id
const DW_WEB_LVN = env('DW_WEB_LVN');                             // the number that rings the browser dialer
const API_BASE = env('VONAGE_API_BASE', 'https://api.nexmo.com');
const SMS_API_BASE = env('VONAGE_SMS_API_BASE', 'https://rest.nexmo.com');
const VIDEO_APP_ID = env('VIDEO_APP_ID');                         // Vonage Video application
const VIDEO_KEY = (() => { try { return fs.readFileSync(path.join(__dirname, env('VIDEO_PRIVATE_KEY_FILE', 'video.key')), 'utf8'); } catch (e) { return env('VIDEO_PRIVATE_KEY'); } })();
const DWVOICE_APP_ID = env('DWVOICE_APP_ID');                     // Client SDK (browser calling) application
const DWVOICE_KEY = (() => { try { return fs.readFileSync(path.join(__dirname, env('DWVOICE_PRIVATE_KEY_FILE', 'dwvoice.key')), 'utf8'); } catch (e) { return env('DWVOICE_PRIVATE_KEY'); } })();
// Storage: one S3 bucket, a private prefix for JSON state and a public prefix for assets. Credentials come from
// the AWS default chain (instance role, profile or AWS_* env vars) - never from source.
const S3_BUCKET = env('S3_BUCKET');
const S3_REGION = env('S3_REGION', 'eu-north-1');
const DATA_PREFIX = env('DATA_PREFIX', 'demoworld/data/');
const ASSET_BASE = env('ASSET_BASE');                             // https://<bucket>.s3.<region>.amazonaws.com/demoworld
const s3 = new S3Client({ region: S3_REGION });
const bedrock = new BedrockRuntimeClient({ region: env('BEDROCK_REGION', 'us-east-1') });
const BEDROCK_MODELS = env('BEDROCK_MODELS', 'us.anthropic.claude-sonnet-4-20250514-v1:0').split(',').map(s => s.trim()).filter(Boolean);
const DW_GEMINI_KEY = env('GEMINI_API_KEY');
// Where this app is reachable (HTTPS front). Used for webhook URLs, webview links and QR codes.
const DW_SITE = env('PUBLIC_BASE');
const DW_CF = DW_SITE;
// Demo-World accounts
const DW_ADMIN_EMAIL = env('DW_ADMIN_EMAIL');                     // the only account allowed into /dw/admin
const DW_ALLOWED_DOMAIN = env('DW_ALLOWED_DOMAIN', 'vonage.com'); // registration is limited to this email domain
const DW_AUTH_SECRET = env('DW_AUTH_SECRET', crypto.randomBytes(24).toString('hex'));
const DW_ADMIN_KEY = env('DW_ADMIN_KEY');                         // key for owner-only JSON endpoints (enquiries)
const DW_SEED_PASSWORD = env('DW_SEED_PASSWORD');                 // optional: seeds DW_ADMIN_EMAIL as a verified owner on first boot
// Transactional email (verification, password reset): Gmail SMTP app password, or the Gmail API (OAuth) fallback
const GMAIL_USER = env('GMAIL_USER');
const GMAIL_APP_PASS = env('GMAIL_APP_PASS');
const GMAIL_ENV = { user: GMAIL_USER, clientId: env('GMAIL_CLIENT_ID'), clientSecret: env('GMAIL_CLIENT_SECRET'), refreshToken: env('GMAIL_REFRESH_TOKEN'), fromName: 'Vonage Demo-World' };
// Satellite services (Vonage Cloud Runtime instances in ./vcr) and optional CRM forwards - blank = disabled
const AVON_SKIN_URL = env('AVON_SKIN_URL');
const OPTOUT_URL = env('OPTOUT_URL');
const HUBSPOT_INBOUND = env('HUBSPOT_INBOUND_URL');
const SALESHUB_INBOUND = env('SALESHUB_INBOUND_URL');
const DW_VIBER_VIDEO = env('DW_VIBER_VIDEO', ASSET_BASE + '/media/order-taxi.mp4');
const DW_VIBER_THUMB = env('DW_VIBER_THUMB', ASSET_BASE + '/toon/viber-marketing.jpg');
const DW_VIBER_PDF = env('DW_VIBER_PDF', ASSET_BASE + '/AURELIA-Occasion-Edit.pdf');

const P = DATA_PREFIX;
let fetchFn = null;
async function f(...a) { if (!fetchFn) fetchFn = (await import('node-fetch')).default; return fetchFn(...a); }

// ============ Data layer (S3, DATA_PREFIX  prefix, memory cache) ============
const cache = {};
async function dget(key, def) {
  if (cache[key] !== undefined) return cache[key];
  try { const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: `${DATA_PREFIX}${key}.json` })); cache[key] = JSON.parse(await r.Body.transformToString()); }
  catch (e) { cache[key] = def; }
  return cache[key];
}
async function dset(key, val) { cache[key] = val; try { await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `${DATA_PREFIX}${key}.json`, Body: JSON.stringify(val, null, 2), ContentType: 'application/json' })); } catch (e) { console.error('[S3] save', key, e.message); } }
// Cross-brand store access (used by the owner /admin dashboard to read a tenant's data)
async function dgetFor(prefix, key, def) { try { const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: `${prefix}${key}.json` })); return JSON.parse(await r.Body.transformToString()); } catch (e) { return def; } }
async function dsetFor(prefix, key, val) { try { await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `${prefix}${key}.json`, Body: JSON.stringify(val, null, 2), ContentType: 'application/json' })); } catch (e) { console.error('[S3] save', key, e.message); } }

// Unified inbox: log every inbound/outbound message to a per-contact conversation.
// Contact identity = digits(phone), so a user is merged across WhatsApp/RCS/SMS.
async function logMessage(to, channel, dir, text, meta) {
  const id = String(to || '').replace(/\D/g, ''); if (!id) return; // email/non-phone skipped
  const convos = await dget('conversations', {});
  const c = convos[id] || { id, contact: id, channels: [], messages: [], takenOver: false, lastAt: 0 };
  if (channel && c.channels.indexOf(channel) < 0) c.channels.push(channel);
  c.messages.push({ id: crypto.randomUUID(), channel, dir, text: String(text == null ? '' : text).slice(0, 2000), at: Date.now(), ...(meta || {}) });
  if (c.messages.length > 300) c.messages = c.messages.slice(-300);
  c.lastAt = Date.now(); convos[id] = c;
  await dset('conversations', convos);
}
// Analytics event log (kind: campaign | agent | bot | ad)
async function logEvent(ev) {
  const logs = await dget('logs', []);
  logs.unshift({ id: ev.id || crypto.randomUUID(), kind: ev.kind || 'campaign', channel: ev.channel || '', vendor: ev.vendor || 'vonage', to: ev.to || '', campaignName: ev.campaignName || '', status: ev.status || 'sent', error: ev.error || null, at: Date.now() });
  if (logs.length > 5000) logs.length = 5000;
  await dset('logs', logs);
}
// ============ Vonage JWT + senders ============
function vjwt() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ application_id: VONAGE_APP_ID, iat: now, exp: now + 3600, jti: crypto.randomUUID() }, VONAGE_KEY, { algorithm: 'RS256' });
}
async function vonageMessages(payload) {
  const r = await f(`${API_BASE}/v1/messages`, { method: 'POST', headers: { Authorization: `Bearer ${vjwt()}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, id: d.message_uuid || null, status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (d.detail || d.title || `HTTP ${r.status}`), raw: d };
}
// SMS: Messages API first (as requested); fall back to SMS API which delivers on this account
async function vonageSms(to, text, base, from) {
  const sender = from || SMS_FROM;
  const mp = { from: sender, to: String(to).replace(/\D/g, ''), channel: 'sms', message_type: 'text', text };
  if (base) mp.webhook_url = `${base}/2s/webhooks/status`;
  const m = await vonageMessages(mp);
  if (m.ok) return { ...m, via: 'messages-api' };
  // fallback to the SMS API (api_key + api_secret) — configurable in Settings for accounts whose default SMS setting is the SMS API
  const sset = await dget('settings', {}); const vc = sset.vonage || {};
  const params = new URLSearchParams({ api_key: vc.apiKey || VONAGE_API_KEY, api_secret: vc.apiSecret || VONAGE_API_SECRET, from: sender, to: String(to).replace(/\D/g, ''), text });
  const r = await f(`${SMS_API_BASE}/sms/json`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  const d = await r.json().catch(() => ({}));
  const msg = (d.messages && d.messages[0]) || {};
  const ok = msg.status === '0';
  return { ok, id: msg['message-id'] || null, status: ok ? 'sent' : 'failed', error: ok ? null : (msg['error-text'] || `status ${msg.status}`), via: 'sms-api' };
}

// Build channel payloads from a campaign content object
function waPayload(to, c, base, from) {
  const p = { from: from || WA_NUMBER, to: String(to).replace(/\D/g, ''), channel: 'whatsapp' };
  if (base) p.webhook_url = `${base}/2s/webhooks/status`;
  if (c.buttons && c.buttons.length) return { ...p, message_type: 'custom', custom: { type: 'interactive', interactive: { type: 'button', body: { text: c.body || ' ' }, action: { buttons: c.buttons.slice(0, 3).map((b, i) => ({ type: 'reply', reply: { id: String(i), title: String(b.text || b).substring(0, 20) } })) } } } };
  return { ...p, message_type: 'text', text: c.body || ' ' };
}
// RCS suggestion: url -> openUrlAction in a WEBVIEW (never an external browser),
// phone -> dialAction, else a reply (postbackData may be overridden via b.postback).
function rcsSuggestion(b) {
  const text = String(b.text || b).substring(0, 25);
  const pb = String(b.postback || b.text || 'tap').substring(0, 200);
  if (b && b.url) return { action: { text, postbackData: pb, openUrlAction: { url: b.url, application: 'WEBVIEW', webviewViewMode: 'TALL' } } };
  if (b && (b.phone || b.dial)) return { action: { text, postbackData: pb, dialAction: { phoneNumber: b.phone || b.dial } } };
  return { reply: { text, postbackData: pb } };
}
function rcsCardContent(cd) {
  return { title: cd.title || '', description: cd.body || '', media: cd.mediaUrl ? { height: 'MEDIUM', contentInfo: { fileUrl: cd.mediaUrl, forceRefresh: false } } : undefined, suggestions: (cd.buttons || []).slice(0, 4).map(rcsSuggestion) };
}
function rcsPayload(to, c, base, from) {
  const p = { from: from || RCS_SENDER, to: String(to).replace(/\D/g, ''), channel: 'rcs' };
  if (base) p.webhook_url = `${base}/2s/webhooks/status`;
  if (c.cards && c.cards.length === 1) {
    // single rich card (carousel needs 2+, so use a standalone card)
    return { ...p, message_type: 'custom', custom: { contentMessage: { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: rcsCardContent(c.cards[0]) } } } } };
  }
  if (c.cards && c.cards.length) {
    return { ...p, message_type: 'custom', custom: { contentMessage: { richCard: { carouselCard: { cardWidth: 'MEDIUM', cardContents: c.cards.slice(0, 10).map(rcsCardContent) } } } } };
  }
  if (c.buttons && c.buttons.length) {
    return { ...p, message_type: 'custom', custom: { contentMessage: { text: c.body || ' ', suggestions: c.buttons.slice(0, 11).map(rcsSuggestion) } } };
  }
  return { ...p, message_type: 'text', text: c.body || ' ' };
}

// Unified vendor send. `from` optionally overrides the sender (number / RCS agent).
async function sendOne(vendor, channel, to, content, base, from) {
  if (vendor && vendor !== 'vonage') {
    return { ok: false, status: 'skipped', error: `${vendor} isn't connected yet — add its API key in Settings to send through it.` };
  }
  let out;
  try {
    if (channel === 'whatsapp') out = await vonageMessages(waPayload(to, content, base, from));
    else if (channel === 'rcs') out = await vonageMessages(rcsPayload(to, content, base, from));
    else if (channel === 'sms') out = await vonageSms(to, content.body || ' ', base, from);
    else if (channel === 'email') out = await sendEmail(to, content);
    else if (channel === 'messenger' || channel === 'instagram') out = { ok: false, status: 'skipped', error: channel + ' not connected — link a Facebook/Instagram page in Settings' };
    else out = { ok: false, status: 'failed', error: 'unknown channel ' + channel };
  } catch (e) { out = { ok: false, status: 'failed', error: e.message }; }
  if (channel !== 'email') { try { await logMessage(to, channel, 'out', content.body || content.text || (content.cards ? '[carousel]' : '[message]'), { agentName: content._agentName }); } catch (e) {} }
  return out;
}

// ---- Rich WhatsApp sending for AI agents (text + media + link/CTA + reply
//      buttons + card sequences). RCS/SMS fall back to the standard sender. ----
function waBase(to, base, from) {
  const p = { from: from || WA_NUMBER, to: String(to).replace(/\D/g, ''), channel: 'whatsapp' };
  if (base) p.webhook_url = `${base}/2s/webhooks/status`;
  return p;
}
function waImgHeader(url) { return url ? { type: 'image', image: { link: url } } : undefined; }
function waIxn(p, interactive) { return { ...p, message_type: 'custom', custom: { type: 'interactive', interactive } }; }
function waReplyBtns(p, header, body, replies) { const ix = { type: 'button', body: { text: body || ' ' }, action: { buttons: replies.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: String(b.text || b).slice(0, 200), title: String(b.text || b).slice(0, 20) } })) } }; if (header) ix.header = header; return waIxn(p, ix); }
function waCta(p, header, body, link) { const ix = { type: 'cta_url', body: { text: body || ' ' }, action: { name: 'cta_url', parameters: { display_text: String(link.text || 'Open').slice(0, 20), url: link.url } } }; if (header) ix.header = header; return waIxn(p, ix); }
function waList(p, body, rows, btnLabel) { return waIxn(p, { type: 'list', body: { text: body || ' ' }, action: { button: String(btnLabel || 'Choose').slice(0, 20), sections: [{ title: 'Topics', rows: rows.slice(0, 10).map((b) => ({ id: String(b.text || b).slice(0, 200), title: String(b.text || b).slice(0, 24), description: String(b.desc || b.description || '').slice(0, 72) })) }] } }); }
async function sendAgentReply(channel, to, c, base, from) {
  if (channel !== 'whatsapp') {
    // RCS: generate an AI image for any carousel card that has none, so the bot's
    // own rich answers look as good as the built demos (cards already render link
    // buttons as webview via rcsSuggestion).
    if (channel === 'rcs' && c.cards && c.cards.length) {
      await Promise.all(c.cards.slice(0, 6).map(async (cd) => {
        if (!cd.mediaUrl || !/^https?:/i.test(cd.mediaUrl)) {
          try { cd.mediaUrl = (await aiImage(`${cd.title || cd.body || c.body || 'product'}. Premium professional photography, vibrant, realistic, no text, no words, no logos, no watermark.`)) || cd.mediaUrl; } catch (e) {}
        }
      }));
    }
    return sendOne('vonage', channel, to, c, base, from);
  }
  const p = waBase(to, base, from);
  let last = { ok: true, status: 'sent' };
  const log = (t) => { try { logMessage(to, channel, 'out', t || ' ', {}); } catch (e) {} };

  // Carousel of rich cards -> native interactive cards (image header + 1 link or reply buttons each)
  const uniqLinks = (arr) => { const s = new Set(), o = []; for (const b of (arr || [])) if (b && b.url && !s.has(b.url)) { s.add(b.url); o.push(b); } return o; };
  const cards = c.cards || [];

  // ONE card -> a single rich message (image header + link button or text).
  if (cards.length === 1) {
    const cd = cards[0], head = waImgHeader(cd.mediaUrl);
    const body = [c.body || '', cd.title ? ('*' + cd.title + '*') : '', cd.body || ''].filter(Boolean).join('\n\n') || ' ';
    const link = (cd.buttons || []).find(b => b.url);
    if (link) last = await vonageMessages(waCta(p, head, body, link));
    else if (cd.mediaUrl) last = await vonageMessages({ ...p, message_type: 'image', image: { url: cd.mediaUrl, caption: body } });
    else last = await vonageMessages({ ...p, message_type: 'text', text: body });
    log('[card] ' + (cd.title || c.body || '')); return last;
  }
  // MANY cards: if every card has an image, send them as individual rich cards
  // (image + text + link button) so PICTURES and LINKS are always preserved — a
  // product recommender needs the photo and the shop link on every item. Only fall
  // back to a native interactive list (text rows) when the cards carry no images.
  if (cards.length > 1) {
    if (cards.every(cd => cd.mediaUrl && /^https?:/i.test(cd.mediaUrl))) {
      if (c.body) await vonageMessages({ ...p, message_type: 'text', text: c.body });
      for (const cd of cards.slice(0, 10)) {
        const link = (cd.buttons || []).find(b => b.url);
        const body = [cd.title ? ('*' + cd.title + '*') : '', cd.body || ''].filter(Boolean).join('\n') || ' ';
        if (link) last = await vonageMessages(waCta(p, waImgHeader(cd.mediaUrl), body, link));
        else last = await vonageMessages({ ...p, message_type: 'image', image: { url: cd.mediaUrl, caption: body } });
      }
      log('[cards] ' + cards.length); return last;
    }
    const rows = cards.slice(0, 10).map(cd => ({ text: (cd.title || 'Пункт').slice(0, 24), desc: (cd.body || '').slice(0, 72) }));
    last = await vonageMessages(waList(p, c.body || 'Оберіть пункт, щоб дізнатися більше:', rows, 'Детальніше'));
    log('[list] ' + (c.body || '')); return last;
  }

  const links = uniqLinks(c.buttons);
  const replies = (c.buttons || []).filter(b => !b.url);
  const head = waImgHeader(c.mediaUrl);
  const body = c.body || ' ';

  // Many tap options with no links -> (image card +) WhatsApp interactive list
  if (replies.length > 3 && links.length === 0) {
    if (c.mediaUrl) await vonageMessages({ ...p, message_type: 'image', image: { url: c.mediaUrl, caption: body } });
    last = await vonageMessages(waList(p, c.mediaUrl ? 'Оберіть тему:' : body, replies, 'Теми'));
    log(body); return last;
  }

  // Single link, nothing else -> one native CTA-URL button (with optional image header)
  if (links.length === 1 && replies.length === 0) { last = await vonageMessages(waCta(p, head, body, links[0])); log(body); return last; }

  // Lead message: reply buttons (image header) | image | text
  if (replies.length) last = await vonageMessages(waReplyBtns(p, head, body, replies));
  else if (c.mediaUrl) last = await vonageMessages({ ...p, message_type: 'image', image: { url: c.mediaUrl, caption: body } });
  else last = await vonageMessages({ ...p, message_type: 'text', text: body });

  // One CTA per UNIQUE link, capped at 2 (never repeat the same link)
  for (const l of links.slice(0, 2)) last = await vonageMessages(waCta(p, undefined, String(l.text || 'Офіційна сторінка'), l));
  log(body);
  return last;
}
// Parse an AI reply that may be a rich JSON envelope into a content object.
// Any prose written around the JSON block is preserved and merged into the body.
function parseAgentReply(raw) {
  if (!raw) return { body: '' };
  const s = String(raw);
  let jsonText = null, before = '', after = '';
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { jsonText = fence[1]; before = s.slice(0, fence.index); after = s.slice(fence.index + fence[0].length); }
  else { const m = s.match(/\{[\s\S]*\}/); if (m && /"(text|buttons|cards|image)"\s*:/.test(m[0])) { jsonText = m[0]; before = s.slice(0, m.index); after = s.slice(m.index + m[0].length); } }
  if (jsonText) {
    try {
      const o = JSON.parse(jsonText);
      if (o && (o.text || o.body || o.buttons || o.cards || o.image)) {
        const prose = (before + '\n' + after).replace(/[ \t]+\n/g, '\n').trim();
        const c = { body: [prose, (o.text || o.body || '')].filter(Boolean).join('\n\n').trim() };
        if (o.image || o.mediaUrl) c.mediaUrl = o.image || o.mediaUrl;
        if (Array.isArray(o.buttons)) c.buttons = o.buttons.map(b => ({ text: b.title || b.text || b.label, url: b.url || b.link })).filter(b => b.text);
        if (Array.isArray(o.cards)) c.cards = o.cards.map(cd => { const bts = (cd.buttons || []).map(b => ({ text: b.title || b.text, url: b.url || b.link })).filter(b => b.text); if (!bts.length && (cd.url || cd.link)) bts.push({ text: cd.cta || 'Learn more', url: cd.url || cd.link }); return { title: cd.title, body: cd.body || cd.description, mediaUrl: cd.image || cd.mediaUrl, buttons: bts }; });
        return c;
      }
    } catch (e) {}
  }
  return { body: s };
}
// When Demo-World handled nothing for an inbound, hand it to the RCS Designer app
// (which owns this number's other flows) so existing behaviour is preserved.

// ---- Optional forwards of every inbound to CRM bridges (blank URL = off) ----
async function forwardToDesigner(body) { /* no external flow designer in this deployment */ }
async function forwardToHubspot(body) {
  if (!HUBSPOT_INBOUND) return;
  try { await f(HUBSPOT_INBOUND, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); console.log('[FWD] -> hubspot'); }
  catch (e) { console.error('[FWD] hubspot failed', e.message); }
}
async function forwardToSalesHub(body) {
  if (!SALESHUB_INBOUND) return;
  try { await f(SALESHUB_INBOUND, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); console.log('[FWD] -> saleshub'); }
  catch (e) { console.error('[FWD] saleshub failed', e.message); }
}
async function designerWaTriggers() { return new Set(); }

// ============ RCS DEMO BUILDER (LLM-generated multi-stage flow, 24h TTL) ============
async function crawlSite(url) {
  try {
    const u = /^https?:\/\//i.test(url) ? url : ('https://' + url);
    const r = await f(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VonageDemoBot/1.0)' } });
    let html = await r.text();
    const title = ((html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '').trim();
    const ogImage = (html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || [])[1] || '';
    const desc = (html.match(/name=["']description["'][^>]*content=["']([^"']+)["']/i) || [])[1] || '';
    html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    return { url: u, title, ogImage, desc, text: html.slice(0, 5000) };
  } catch (e) { return { url, title: '', text: '', error: e.message }; }
}
function parseDemoDirective(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/); if (!m) return null;
  try { const o = JSON.parse(m[0]); if (o && o.action === 'build_demo') return o; } catch (e) {}
  return null;
}
async function generateDemoFlow(brief, base) {
  const site = brief.site ? await crawlSite(brief.site) : null;
  const n = Math.min(5, Math.max(4, Number(brief.stages) || 5));
  const sys = `You design a short, polished interactive RCS Business Messaging demo that shows what the COMPANY below could do with RCS for their OWN customers - a branded example experience (NOT a Vonage pitch). Output ONLY one JSON object, no prose:
{"name":"Demo name","stages":[ {"text":"short on-brand message (1-2 sentences) as if sent BY the company to its customer","cards":[{"title":"short title","body":"one short line","imagePrompt":"a vivid, specific real-world scene to PHOTOGRAPH for this card (no text/words in the image)","cta":"button label under 18 chars","link":"https real url for this card's action, or omit"}],"next":"label of the button to advance to the NEXT stage (omit on the LAST stage)"} ]}
Rules: EXACTLY ${n} stages with a clear arc: welcome/hook -> showcase offerings as a CAROUSEL of 2-4 cards -> an interactive choice (also a carousel of options) -> a personalised offer -> final call-to-action. EVERY card MUST have "title", "cta" (its button label) and "imagePrompt". Most stages should use a carousel of cards. Add a real "link" only when a genuine URL fits. Keep all labels short and specific to the company.`;
  const who = `Subject: ${brief.name || 'the company'}.` + (site ? ` Website: ${site.url} - "${site.title}". ${site.desc} Page content: ${site.text.slice(0, 2500)}` : '') + (brief.brief ? ` Extra brief: ${brief.brief}` : '');
  let raw = ''; try { raw = await aiText(sys, [{ role: 'user', content: who + '\n\nGenerate the demo flow JSON now.' }], 3500); } catch (e) { return null; }
  let spec = null; const m = raw.match(/\{[\s\S]*\}/); if (m) { try { spec = JSON.parse(m[0]); } catch (e) {} }
  if (!spec || !Array.isArray(spec.stages) || spec.stages.length < 3) return null;
  const stages = spec.stages.slice(0, 5);
  const brand = brief.name || (site && site.title) || 'the brand';
  const homeLink = brief.site || (site && site.url) || '';
  const trigger = ('DEMO' + Math.random().toString(36).slice(2, 6)).toUpperCase();
  const nodes = [{ id: 'start', type: 'start', data: { triggerWords: [trigger] } }];
  const conns = []; const entry = []; const exit = [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const isLast = i === stages.length - 1;
    const advance = isLast ? null : String(s.next || 'Continue').slice(0, 18);
    const seq = [];
    if (s.text && String(s.text).trim()) { const tid = 's' + i + 't'; nodes.push({ id: tid, type: 'message', data: { text: s.text } }); seq.push(tid); }
    const raw2 = (s.cards || []).slice(0, 4);
    if (raw2.length) {
      const cards = await Promise.all(raw2.map(async (c) => {
        let img = '';
        try { img = await aiImage(`${c.imagePrompt || c.title || s.text}. For ${brand}. Premium professional photography, vibrant, realistic, no text, no words, no logos, no watermark.`); } catch (e) {}
        const link = (c.link && /^https?:/i.test(c.link)) ? c.link : (isLast ? homeLink : '');
        const btns = [];
        if (link) btns.push({ text: String(c.cta || 'View').slice(0, 18), url: link });
        if (advance) btns.push({ text: String(c.link ? 'Select' : (c.cta || 'Select')).slice(0, 18), postback: advance });
        if (!btns.length) btns.push({ text: String(c.cta || 'View').slice(0, 18), url: homeLink || undefined, postback: 'tap' });
        return { title: c.title || '', body: c.body || c.description || '', mediaUrl: img || undefined, buttons: btns };
      }));
      const cid = 's' + i + 'c'; nodes.push({ id: cid, type: 'message', data: { cards } }); seq.push(cid);
    } else {
      const links = (s.links || []).filter(l => l && l.url).map(l => ({ text: String(l.label || 'Open').slice(0, 18), url: l.url }));
      const buttons = [...links]; if (advance) buttons.push({ text: advance });
      if (seq.length) { const tn = nodes.find(x => x.id === seq[0]); tn.data.buttons = buttons; }
      else { const tid = 's' + i + 't'; nodes.push({ id: tid, type: 'message', data: { text: s.text || '', buttons } }); seq.push(tid); }
    }
    entry[i] = seq[0]; exit[i] = seq[seq.length - 1];
    for (let k = 0; k < seq.length - 1; k++) conns.push({ from: seq[k], to: seq[k + 1] });
    if (i === 0) conns.push({ from: 'start', to: seq[0] });
  }
  for (let i = 0; i < stages.length - 1; i++) conns.push({ from: exit[i], to: entry[i + 1], fromOutput: 'button', btnIdx: 0 });
  const bot = { id: 'demo_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: spec.name || ('Demo: ' + (brief.name || 'company')), active: true, channel: 'rcs', sender: RCS_SENDER, trigger, demo: true, expiresAt: Date.now() + 24 * 3600 * 1000, nodes, connections: conns };
  const bots = await dget('rcs_chatbots', []); bots.unshift(bot); await dset('rcs_chatbots', bots);
  console.log('[DEMO] built', bot.name, 'trigger', trigger, stages.length, 'stages');
  return { trigger, name: bot.name, stages: stages.length };
}
async function purgeExpiredDemos() {
  try { const bots = await dget('rcs_chatbots', []); const now = Date.now(); const keep = bots.filter(b => !(b.demo && b.expiresAt && b.expiresAt < now)); if (keep.length !== bots.length) { await dset('rcs_chatbots', keep); console.log('[DEMO] purged', bots.length - keep.length, 'expired demos'); } } catch (e) {}
}
setInterval(() => { purgeExpiredDemos(); }, 30 * 60 * 1000);

// ---- Email (Google app) — connect via Settings (settings.email) or env vars ----
async function gmailCfg() { const s = await dget('settings', {}); const e = s.email || {}; return { user: e.user || GMAIL_ENV.user, clientId: e.clientId || GMAIL_ENV.clientId, clientSecret: e.clientSecret || GMAIL_ENV.clientSecret, refreshToken: e.refreshToken || GMAIL_ENV.refreshToken, fromName: e.fromName || '' }; }
function cfgReady(g) { return !!(g && g.user && g.clientId && g.clientSecret && g.refreshToken); }
const emailReady = () => cfgReady(GMAIL_ENV); // sync env-only (health); real send uses gmailCfg()
async function emailConnected() { return cfgReady(await gmailCfg()); }
async function gmailToken(g) {
  const r = await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: 'refresh_token' }) });
  const j = await r.json(); if (!r.ok) throw new Error('oauth: ' + (j.error_description || j.error)); return j.access_token;
}
async function sendEmail(to, content) {
  const g = await gmailCfg();
  if (!cfgReady(g)) return { ok: false, status: 'skipped', error: 'Email not connected — add your Google app in Settings.' };
  const token = await gmailToken(g);
  const isHtml = /<[a-z][\s\S]*>/i.test(content.body || '');
  const mime = [`From: =?UTF-8?B?${Buffer.from(content.fromName || g.fromName || 'Vonage Demo-World').toString('base64')}?= <${g.user}>`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(content.subject || 'Vonage Demo-World').toString('base64')}?=`, 'MIME-Version: 1.0', `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset="UTF-8"`, '', content.body || ''].join('\r\n');
  const raw = Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await f('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) });
  const j = await r.json(); if (!r.ok) throw new Error('gmail: ' + (j.error && j.error.message)); return { ok: true, id: j.id, status: 'sent' };
}

// ============ AI (Bedrock) ============
async function aiJSON(prompt, maxTokens = 1500) {
  for (const modelId of BEDROCK_MODELS) {
    try {
      const r = await bedrock.send(new InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }) }));
      const t = JSON.parse(new TextDecoder().decode(r.body)).content?.[0]?.text || '';
      const m = t.match(/\{[\s\S]*\}|\[[\s\S]*\]/); if (m) return JSON.parse(m[0]);
    } catch (e) { console.log('[AI] model failed', modelId, e.message); }
  }
  return null;
}
async function aiImage(prompt) {
  try {
    const r = await bedrock.send(new InvokeModelCommand({ modelId: 'amazon.nova-canvas-v1:0', contentType: 'application/json', accept: 'application/json', body: JSON.stringify({ taskType: 'TEXT_IMAGE', textToImageParams: { text: prompt }, imageGenerationConfig: { numberOfImages: 1, height: 512, width: 512, cfgScale: 8 } }) }));
    const b64 = JSON.parse(new TextDecoder().decode(r.body)).images[0];
    const fn = `img-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: `${P}images/${fn}`, Body: Buffer.from(b64, 'base64'), ContentType: 'image/png', ACL: 'public-read' }));
    return `https://${S3_BUCKET}.s3.eu-north-1.amazonaws.com/${P}images/${fn}`;
  } catch (e) { console.error('[AI image]', e.message); return null; }
}
const baseUrl = (req) => `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`;
app.all('/webhooks/status', express.json(), async (req, res) => {
  res.status(200).send('OK');
  try {
    const p = req.method === 'GET' ? req.query : req.body; const uuid = p.message_uuid; const st = (p.status || '').toLowerCase();
    if (!uuid || !st) return;
    if (st === 'rejected' || st === 'undeliverable' || p.error) console.log('[STATUS]', p.channel || '', uuid, st, p.error ? JSON.stringify(p.error).slice(0, 300) : '');
    const logs = await dget('logs', []); const rec = logs.find(l => l.id === uuid);
    if (rec) { rec.status = st; rec.statusAt = Date.now(); await dset('logs', logs); }
  } catch (e) {}
});

// ============ BOT BUILDER endpoints (the real canvas builder calls these) ============
// Bots stored in the separate DATA_PREFIX  namespace. Reuses Demo-World Vonage/Bedrock/S3.
// Bring-your-own-key providers (used by AI Agents to cut costs). Falls back to Bedrock.
async function byoAI(ag, systemPrompt, messages, maxTokens) {
  const p = ag.provider, key = ag.apiKey;
  if (p === 'openai') {
    const r = await f('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify({ model: ag.model || 'gpt-4o-mini', max_tokens: Math.min(maxTokens, 4096), messages: [{ role: 'system', content: systemPrompt }, ...messages] }) });
    const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status)); return j.choices?.[0]?.message?.content || '';
  }
  if (p === 'claude' || p === 'anthropic') {
    const r = await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: ag.model || 'claude-sonnet-4-6', max_tokens: Math.min(maxTokens, 4096), system: systemPrompt, messages }) });
    const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status)); return j.content?.[0]?.text || '';
  }
  if (p === 'gemini') {
    const r = await f('https://generativelanguage.googleapis.com/v1beta/models/' + (ag.model || 'gemini-2.0-flash') + ':generateContent?key=' + encodeURIComponent(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) }) });
    const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status)); return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  throw new Error('unknown provider ' + p);
}
async function aiText(systemPrompt, messages, maxTokens = 8192, ag) {
  if (ag && ag.provider && ag.provider !== 'bedrock' && ag.apiKey) {
    try { return await byoAI(ag, systemPrompt, messages, maxTokens); } catch (e) { console.log('[BYO]', ag.provider, e.message); }
  }
  for (const modelId of BEDROCK_MODELS) {
    try {
      const r = await bedrock.send(new InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: maxTokens, system: systemPrompt || 'You are a helpful assistant.', messages }) }));
      return JSON.parse(new TextDecoder().decode(r.body)).content?.[0]?.text || '';
    } catch (e) { console.log('[aiText]', modelId, e.message); }
  }
  throw new Error('Bedrock request failed');
}
// Map a builder node to a channel content object
function nodeToContent(n) {
  const d = (n && n.data) || {};
  const c = { body: d.text || d.bodyText || d.message || '' };
  const sugg = d.suggestions || d.buttons || [];
  if (sugg.length) c.buttons = sugg.map(s => ({ text: s.text || s, url: s.url }));
  if (d.cards && d.cards.length) c.cards = d.cards.map(cd => ({ title: cd.title, body: cd.description || cd.text || cd.bodyText, mediaUrl: cd.mediaUrl || cd.imageUrl, buttons: (cd.suggestions || cd.buttons || []).map(s => ({ text: s.text || s, url: s.url })) }));
  if (d.mediaUrl || d.imageUrl) c.mediaUrl = d.mediaUrl || d.imageUrl;
  return c;
}

// Auto-connect (no setup screen) — the builder uses the configured RCS sender and application
// ============ WhatsApp TEMPLATES (create + submit for Meta approval) ============
async function waUploadHandle(mediaUrl) {
  const mr = await f(mediaUrl); if (!mr.ok) throw new Error('could not fetch image (' + mr.status + ')');
  const buf = Buffer.from(await mr.arrayBuffer());
  let ft = (mr.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!/^(image|video|application)\//.test(ft)) ft = 'image/jpeg';
  const boundary = '----FB' + crypto.randomBytes(8).toString('hex');
  const fn = 'media.' + (ft.split('/')[1] || 'jpg');
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="mediafile"; filename="${fn}"\r\nContent-Type: ${ft}\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head), buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await f(`${API_BASE}/v2/whatsapp-manager/media/uploads?file_type=${encodeURIComponent(ft)}`, { method: 'POST', headers: { Authorization: `Bearer ${vjwt()}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body });
  const j = await r.json().catch(() => ({})); if (!j.h) throw new Error('media upload failed: ' + JSON.stringify(j).slice(0, 140));
  return j.h;
}
const RICH_PROTOCOL = `RICH WHATSAPP MESSAGES: you can send native WhatsApp interactive elements. To do so, reply with ONLY a single JSON object (no text before or after it), shaped like:
{"text":"message","image":"https://...","buttons":[{"title":"Apply online","url":"https://..."},{"title":"Housing"}],"cards":[{"title":"Program","body":"short text","image":"https://...","buttons":[{"title":"Open","url":"https://..."}]}]}
How each part renders natively on WhatsApp:
- a button WITH "url" becomes a real tappable LINK button (call-to-action). Use this every time you share an official page — never paste a raw URL in the text.
- a button WITHOUT "url" becomes a quick-reply button (for navigation). 1-3 show as buttons; 4 or more become a tappable list menu automatically.
- "image" adds a picture/header to the message (a rich card). Use a real image URL only.
- "cards" render as a carousel of rich cards; each card may carry ONE link button.
Rules: use ONLY real URLs from the official source — never invent a link. Keep every title under 20 characters. Prefer link buttons and quick replies over plain text whenever you offer options or links. For a simple answer with no options, just reply in plain text (no JSON).`;

function buildAgentSystem(ag) {
  let sys = ag.systemPrompt || 'You are a helpful AI assistant for this brand. Be concise and friendly. Do not use emojis.';
  if (ag.links && ag.links.length) sys += '\n\nReference links you can share when relevant:\n' + ag.links.map(l => '- ' + (l.url || l)).join('\n');
  if (ag.templateMode === 'strict') sys += '\n\nOnly respond using approved brand templates/wording.';
  if (ag.rich) sys += '\n\n' + RICH_PROTOCOL;
  return sys;
}

// ============ CONVERSATIONAL EXECUTION (inbound webhook runs builder bots) ============
const botStates = {}; // key = channel:digits(from) -> { botId, channel, nodeId, vars, awaitVar }
const agentSessions = {}; // key = channel:digits(from) -> { agentId, history:[] }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function renderVars(str, vars) { return String(str == null ? '' : str).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars && vars[k] != null ? vars[k] : '')); }
function nodeButtons(node) { const d = (node && node.data) || {}; return d.suggestions || d.buttons || []; }
function nextNodeId(bot, nodeId, output) { const c = (bot.connections || []).find(x => x.from === nodeId && (x.fromOutput === (output || 'node') || (!x.fromOutput && !output))); return c ? c.to : null; }
function storageKeyFor(channel) { return (channel === 'whatsapp' ? 'whatsapp_chatbots' : channel === 'sms' ? 'sms_chatbots' : 'rcs_chatbots'); }

async function loadActiveBots(channel) {
  // prefer the channel-specific store, fall back to rcs_chatbots (where the builder saves today)
  let bots = await dget(storageKeyFor(channel), []);
  if (!bots || !bots.length) bots = await dget('rcs_chatbots', []);
  return (bots || []).filter(b => b.active !== false);
}
// Does this incoming (uppercased) text match an active builder-bot / demo start trigger?
async function matchesBotTrigger(channel, upper) {
  if (!upper) return false;
  try {
    const bots = await loadActiveBots(channel);
    return bots.some(b => { const s = (b.nodes || []).find(n => n.type === 'start'); const tw = (s && (s.data?.triggerWords || s.data?.triggerKeywords)) || []; return tw.some(t => String(t).trim().toUpperCase() === upper); });
  } catch (e) { return false; }
}

async function sendNode(channel, to, node, vars, base, sender) {
  const c = nodeToContent(node);
  c.body = renderVars(c.body || node.data?.message || node.data?.prompt || '', vars);
  if (c.buttons) c.buttons = c.buttons.map(b => ({ ...b, text: renderVars(b.text, vars) }));
  if (c.cards) c.cards = c.cards.map(cd => ({ ...cd, title: renderVars(cd.title, vars), body: renderVars(cd.body, vars) }));
  // RCS rich-card carousels can't carry top-level text or node buttons, so when a
  // node has cards AND text/buttons, send the carousel then a follow-up text+buttons
  // message - otherwise the navigation/CTA buttons vanish and the flow can't advance.
  if (channel === 'rcs' && c.cards && c.cards.length && ((c.buttons && c.buttons.length) || (c.body && c.body.trim()))) {
    await sendOne('vonage', channel, to, { cards: c.cards }, base, sender);
    await sleep(350);
    const navText = (c.body && c.body.trim()) ? c.body : 'Tap to continue:';
    const out = await sendOne('vonage', channel, to, { body: navText, buttons: c.buttons }, base, sender);
    console.log(`[BOT] sent ${channel} carousel+nav ${node.type} -> ${to} : ${out.ok ? 'OK ' + out.id : 'FAIL ' + out.error}`);
    return out;
  }
  const out = await sendOne('vonage', channel, to, c, base, sender);
  console.log(`[BOT] sent ${channel} node ${node.type} -> ${to} : ${out.ok ? 'OK ' + out.id : 'FAIL ' + out.error}`);
  return out;
}

// Run the flow from a node until it needs user input (buttons or an input node) or ends.
async function runBot(bot, channel, from, startNodeId, vars, base, sender) {
  const key = channel + ':' + String(from).replace(/\D/g, '');
  const reply_from = sender || bot.sender || undefined; // who the bot replies AS
  let nodeId = startNodeId; const visited = new Set();
  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = (bot.nodes || []).find(n => n.id === nodeId);
    if (!node) break;
    if (node.type === 'end') { if (node.data?.message) await sendOne('vonage', channel, from, { body: renderVars(node.data.message, vars) }, base, reply_from); break; }
    if (node.type === 'delay') { await sleep(Math.min((node.data?.duration || 2) * 1000, 60000)); nodeId = nextNodeId(bot, nodeId); continue; }
    if (node.type === 'set_variable') { (node.data?.variables || []).forEach(v => { if (v.name) vars[v.name] = renderVars(v.value, vars); }); nodeId = nextNodeId(bot, nodeId); continue; }
    if (node.type === 'input') { // ask, then capture the next inbound into a variable
      await sendOne('vonage', channel, from, { body: renderVars(node.data?.prompt || 'Please reply:', vars) }, base, reply_from);
      botStates[key] = { botId: bot.id, channel, nodeId, vars, sender: reply_from, awaitVar: node.data?.variable || node.data?.saveAs || ('input_' + nodeId.slice(-4)) };
      return;
    }
    if (node.type === 'ai' || node.type === 'ai_agent') {
      const sys = node.data?.systemPrompt || node.data?.instructions || node.data?.prompt || 'You are a helpful assistant for this brand.';
      let reply = ''; try { reply = await aiText(sys, [{ role: 'user', content: vars.lastInput || 'Hello' }], 600); } catch (e) { reply = ''; }
      if (reply) await sendOne('vonage', channel, from, { body: reply }, base, reply_from);
      botStates[key] = { botId: bot.id, channel, nodeId, vars, sender: reply_from }; // stay in AI node for follow-ups
      return;
    }
    // message node (text/image/buttons/cards/picture/video)
    await sendNode(channel, from, node, vars, base, reply_from);
    await sleep(400);
    const btnConns = (bot.connections || []).filter(c => c.from === nodeId && c.fromOutput === 'button');
    if (btnConns.length) { botStates[key] = { botId: bot.id, channel, nodeId, vars, sender: reply_from }; return; }
    nodeId = nextNodeId(bot, nodeId);
  }
  delete botStates[key];
}

// Resolve which button branch the user pressed → next node id
function resolveButton(bot, node, ctx) {
  const conns = (bot.connections || []).filter(c => c.from === node.id && c.fromOutput === 'button');
  if (!conns.length) return null;
  const rawId = ctx.reply ? (ctx.reply.id != null ? ctx.reply.id : ctx.reply.title) : (ctx.button ? (ctx.button.payload || ctx.button.text) : null);
  const pressed = String(rawId || ctx.text || '').trim();
  // carousel "cardIdx:btnIdx"
  if (/^\d+:\d+$/.test(pressed)) { const [ci, bi] = pressed.split(':').map(Number); const c = conns.find(x => Number(x.cardIdx) === ci && Number(x.btnIdx) === bi); return c ? c.to : null; }
  // numeric index (WhatsApp reply.id)
  if (/^\d+$/.test(pressed)) { const c = conns.find(x => Number(x.btnIdx) === Number(pressed)); if (c) return c.to; }
  // match by button text (RCS postback)
  const btns = nodeButtons(node).map(b => String(b.text || b).trim().toUpperCase());
  const i = btns.findIndex(t => t === pressed.toUpperCase());
  if (i >= 0) { const c = conns.find(x => Number(x.btnIdx) === i); if (c) return c.to; }
  return conns[0].to; // fallback
}

async function handleInbound(body, base) {
  // Debug monitor: record every raw inbound webhook hit with a precise
  // server-received timestamp (before dedupe, so retries are visible too).
  // Best-effort and non-blocking — never affects downstream handling.
  // De-duplicate webhook retries: Vonage may resend the same inbound (same
  // message_uuid) more than once. Ignore a repeat seen within 20s.
  try {
    if (body && body.message_uuid) {
      const now = Date.now(); const seen = (handleInbound._seen = handleInbound._seen || {});
      for (const k in seen) if (now - seen[k] > 20000) delete seen[k];
      if (seen[body.message_uuid] && now - seen[body.message_uuid] < 20000) { console.log('[DEDUP] skip', body.message_uuid); return; }
      seen[body.message_uuid] = now;
    }
  } catch (e) {}
  // Claude Code bridge: a whitelisted number sending "cc <text>" is captured for
  // the running Claude Code session and stops here (no bot/demo also fires).
  // WhatsApp Opt-Out Manager: an exact keyword match for a configured sender is
  // fully handled there (suppress/unsuppress + confirmation) and stops here, so
  // no bot or forward also fires on the keyword. Anything else passes through.
  // Opt-out manager now lives on VCR (moved 2026-07-23) - forward the inbound
  // there and honour {handled:true} so bots never fire on STOP/START keywords.
  try {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 4000);
    if (!OPTOUT_URL) throw new Error('optout manager not configured');
    const r = await fetch(OPTOUT_URL + '/webhooks/inbound', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    clearTimeout(tm);
    const j = await r.json().catch(() => ({}));
    if (j && j.handled) { console.log('[OPTOUT] keyword handled (VCR) for', body.from); return; }
  } catch (e) { console.error('[OPTOUT] VCR hook error:', e.message); }
  const channel = (body.channel || 'rcs').toLowerCase();
  const from = body.from; const to = body.to;
  const message_type = body.message_type; const reply = body.reply; const button = body.button;
  const text = (body.text || '').trim();
  const incomingUpper = (reply ? (reply.id || reply.title || '') : text).trim().toUpperCase();
  // Human-readable text of a tapped button / list row (so the AI sees "Housing", not an id)
  const tap = (reply && (reply.title || reply.id)) || (button && (button.text || button.title || button.payload)) || '';
  // A tapped suggestion / quick-reply (RCS `reply`, WhatsApp `button`) must NEVER
  // cold-start a bot or AI agent — its postbackData/label can collide with a trigger
  // word. Only text the customer actually typed may start a trigger flow. Taps still
  // drive an already-running bot (section 1 below runs before any start-trigger check).
  const isButtonTap = !!(reply || button) || ['reply', 'button', 'postback'].includes(String(message_type || '').toLowerCase());
  const key = channel + ':' + String(from).replace(/\D/g, '');

  // Log the inbound to the unified inbox (every message for this number)
  try { await logMessage(from, channel, 'in', text || incomingUpper, {}); } catch (e) {}
  // Track button / quick-reply clicks (WhatsApp & RCS) for analytics
  const _clickLabel = (reply && (reply.title || reply.id)) || (button && (button.text || button.payload || button.title)) || '';
  if (_clickLabel) { try { await logEvent({ kind: 'click', channel, to: from, campaignName: 'Tapped: ' + String(_clickLabel).slice(0, 50), status: 'click' }); } catch (e) {} }
  // Human takeover: if an agent has taken this conversation, the bot/agent stays silent
  try { const cv = (await dget('conversations', {}))[String(from).replace(/\D/g, '')]; if (cv && cv.takenOver) { console.log('[INBOX] human-controlled, automation paused for', from); return; } } catch (e) {}

  // PEAK SEASON PROMOTIONS (Vonage x Telefonica event demo, peak.js): trigger PEAK,
  // its own PK_* postbacks, a photo while its "branded demo" mode is armed, or an OTP
  // code while its Verify step is pending. Handles RCS and WhatsApp; otherwise no-op.
  try { if (await peak.inbound({ channel, from, body, upper: incomingUpper, text, message_type })) { console.log('[PEAK] handled', incomingUpper || message_type); return; } } catch (e) { console.error('[PEAK] inbound error', e.message); }

  // AVON SKIN COACH (dedicated VCR app): RCS selfies -> AI skin analysis.
  // Scope is deliberately narrow so nothing else changes: RCS channel only, and
  // only (a) image messages - which never matched any trigger/flow before and
  // were silently dropped by the Designer, (b) the text trigger GLOW - unused
  // by any Designer bot (AVON itself is taken by an existing bot), and (c) the
  // Avon bot's own reply postbacks (HOW_IT_WORKS / SEND_NEW_SELFIE / MORE_*).
  if (channel === 'rcs') {
    const avonImg = (String(message_type).toLowerCase() === 'image' && body.image && body.image.url) ? body.image.url : null;
    const avonTap = ['GLOW', 'HOW_IT_WORKS', 'SEND_NEW_SELFIE'].includes(incomingUpper) || incomingUpper.startsWith('MORE_');
    if (avonImg || avonTap) {
      console.log('[AVON] forwarding to skin coach:', avonImg ? 'image' : incomingUpper);
      if (!AVON_SKIN_URL) return;
      f(AVON_SKIN_URL + '/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msisdn: from, imageUrl: avonImg, text: incomingUpper })
      }).catch(e => console.error('[AVON] forward failed', e.message));
      return;
    }
    // WAYFAIR HOT DEALS (the /wf router on this instance): trigger word WAYFAIR
    // (unused by any Designer bot; DEALS is taken) + the bot's own WF_* postbacks.
    if (incomingUpper === 'WAYFAIR' || incomingUpper.startsWith('WF_')) {
      console.log('[WAYFAIR] trigger:', incomingUpper);
      f(DW_CF + '/wf/trigger', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msisdn: from, text: incomingUpper })
      }).catch(e => console.error('[WAYFAIR] trigger failed', e.message));
      return;
    }
    // ePARK (Nordic parking) conversational demo: triggers PARKING / PARK / EPARK + the bot's own EPARK_* postbacks.
    if (incomingUpper === 'PARKING' || incomingUpper === 'PARK' || incomingUpper === 'EPARK' || incomingUpper.startsWith('EPARK_')) {
      console.log('[EPARK] inbound:', incomingUpper);
      eparkInbound(from, incomingUpper).catch(e => console.error('[EPARK] inbound failed', e.message));
      return;
    }
  }

  // 0) AI AGENTS (standalone, trigger-word + knowledge base)
  const aKey = 'agent:' + key;
  const agents = await dget('agents', []);
  if (agentSessions[aKey]) {
    const ag = agents.find(a => a.id === agentSessions[aKey].agentId);
    // A tapped suggestion is never conversational input for a plain text agent — a
    // stray card button (e.g. an Avon demo card) must not make an active agent reply.
    // (A `rich` agent that sends its own buttons still receives taps.) The session is
    // kept intact so the next thing the customer TYPES is handled normally.
    if (isButtonTap && !(ag && ag.rich)) return;
    // A builder-bot / demo trigger word always wins over an active agent chat:
    // leave the agent session and let the flow engine start the bot.
    const botTrig = isButtonTap ? false : await matchesBotTrigger(channel, incomingUpper);
    if (ag && ag.active && !botTrig && !/^(stop|exit|menu|reset)$/i.test((text || '').trim())) {
      const hist = agentSessions[aKey].history || []; hist.push({ role: 'user', content: text || tap || incomingUpper });
      let reply = ''; try { reply = await aiText(buildAgentSystem(ag), hist.slice(-10), 700, ag); } catch (e) {}
      const demoDir = (reply && ag.demoBuilder) ? parseDemoDirective(reply) : null;
      if (demoDir) {
        await sendAgentReply(channel, from, { body: 'Building your demo now — this can take a minute…' }, base, ag.sender || to);
        const built = await generateDemoFlow(demoDir, base);
        const msg = built ? `Your demo "${built.name}" is ready — ${built.stages} stages.\n\nTo preview it on RCS, just send:  ${built.trigger}\n\n(It auto-deletes in 24 hours.)` : 'Sorry, I hit a snag building that demo. Tell me the company name or website again and I will retry.';
        hist.push({ role: 'assistant', content: msg }); agentSessions[aKey].history = hist;
        await sendAgentReply(channel, from, { body: msg }, base, ag.sender || to);
        await logEvent({ kind: 'agent', channel, to: from, campaignName: ag.name + ' (demo)', status: built ? 'sent' : 'failed' });
        return;
      }
      if (reply) { hist.push({ role: 'assistant', content: reply }); agentSessions[aKey].history = hist; await sendAgentReply(channel, from, ag.rich ? parseAgentReply(reply) : { body: reply }, base, ag.sender || to); console.log('[AGENT] replied to', from); }
      await logEvent({ kind: 'agent', channel, to: from, campaignName: ag.name, status: reply ? 'sent' : 'failed' });
      return;
    }
    delete agentSessions[aKey];
  }
  if (!isButtonTap) for (const ag of agents.filter(a => a.active && (a.channels || []).includes(channel))) {
    if ((ag.triggers || []).some(t => String(t).trim().toUpperCase() === incomingUpper)) {
      let reply = ''; try { reply = await aiText(buildAgentSystem(ag), [{ role: 'user', content: 'A user started a chat by sending the trigger word. Greet them and offer help.' }], 500, ag); } catch (e) {}
      agentSessions[aKey] = { agentId: ag.id, history: reply ? [{ role: 'assistant', content: reply }] : [] };
      if (reply) await sendAgentReply(channel, from, ag.rich ? parseAgentReply(reply) : { body: reply }, base, ag.sender || to);
      await logEvent({ kind: 'agent', channel, to: from, campaignName: ag.name, status: reply ? 'sent' : 'failed' });
      console.log('[AGENT] started', ag.name, 'for', from);
      return;
    }
  }

  // 1) mid-conversation?
  const st = botStates[key];
  if (st) {
    const bots = await dget(storageKeyFor(st.channel), []); let bot = (bots || []).find(b => b.id === st.botId) || (await dget('rcs_chatbots', [])).find(b => b.id === st.botId);
    if (bot) {
      const node = (bot.nodes || []).find(n => n.id === st.nodeId);
      if (st.awaitVar) { st.vars[st.awaitVar] = text; st.vars.lastInput = text; delete botStates[key]; const nxt = nextNodeId(bot, st.nodeId); if (nxt) { await runBot(bot, channel, from, nxt, st.vars, base, st.sender); return; } }
      if (node && (node.type === 'ai' || node.type === 'ai_agent')) { st.vars.lastInput = text; const nxt = resolveButton(bot, node, { reply, button, text }) || nextNodeId(bot, st.nodeId); if (nxt && nxt !== st.nodeId) { delete botStates[key]; await runBot(bot, channel, from, nxt, st.vars, base, st.sender); } else { await runBot(bot, channel, from, st.nodeId, st.vars, base, st.sender); } return; }
      const nxt = node ? resolveButton(bot, node, { reply, button, text }) : null;
      if (nxt) { delete botStates[key]; await runBot(bot, channel, from, nxt, st.vars, base, st.sender); return; }
    }
    delete botStates[key];
  }
  // 2) start trigger? (only from typed text — a tapped suggestion never starts a bot)
  const active = isButtonTap ? [] : await loadActiveBots(channel);
  for (const bot of active) {
    const start = (bot.nodes || []).find(n => n.type === 'start');
    const triggers = (start && (start.data?.triggerWords || start.data?.triggerKeywords)) || [];
    if (triggers.some(t => String(t).trim().toUpperCase() === incomingUpper)) {
      // inbound bot replies AS the number/agent the customer messaged (the inbound `to`), falling back to the bot's saved sender
      const first = nextNodeId(bot, start.id); if (first) { await runBot(bot, channel, from, first, {}, base, to || bot.sender); return; }
    }
  }
  // A tapped suggestion that advanced no in-progress flow has already performed its
  // client-side action (open URL, dial, map, add-to-calendar). It must NOT wake the
  // WhatsApp fallback agent or get forwarded to the Designer's RCS bots (Sainsbury's).
  // EXCEPTION: WhatsApp taps are forwarded to the Designer, because a user mid-way
  // through a /hub waFlow answers with QUICK_REPLY buttons and the Designer holds
  // that flow's state - the Designer only acts when such a flow is actually open.
  if (isButtonTap) {
    if (channel === 'whatsapp') forwardToDesigner(body);
    return;
  }
  // Nothing matched here. On WhatsApp: the Designer /hub flows get first claim on
  // their trigger words (so they actually start); anything else engages the fallback
  // agent if configured, else stays silent. Other channels (RCS/SMS) are handed to
  // the Designer as before.
  if (channel === 'whatsapp') {
    try {
      const kws = await designerWaTriggers();
      if (kws.has(incomingUpper)) { console.log('[WAF] hub flow trigger', incomingUpper, '-> designer'); await forwardToDesigner(body); return; }
    } catch (e) { console.error('[WAF] trigger check failed', e.message); }
    const fb = agents.find(a => a.active && a.fallback && (a.channels || []).includes('whatsapp'));
    if (fb) {
      let reply = ''; try { reply = await aiText(buildAgentSystem(fb), [{ role: 'user', content: text || tap || incomingUpper }], 700, fb); } catch (e) {}
      agentSessions[aKey] = { agentId: fb.id, history: reply ? [{ role: 'user', content: text || tap || incomingUpper }, { role: 'assistant', content: reply }] : [] };
      if (reply) await sendAgentReply(channel, from, fb.rich ? parseAgentReply(reply) : { body: reply }, base, fb.sender || to);
      await logEvent({ kind: 'agent', channel, to: from, campaignName: fb.name, status: reply ? 'sent' : 'failed' });
      return;
    }
    return; // whatsapp with no fallback configured and no hub trigger: stay silent
  }
  await forwardToDesigner(body);
}
// Wayfair Hot Deals mini-store + RCS bot (temporary home - see wayfair.js)
app.use('/wf', require('./wayfair'));

app.all(['/webhooks/inbound'], express.json(), async (req, res) => {
  res.status(200).send('OK');
  forwardToHubspot(req.body || {}); // fire-and-forget copy to the HubSpot inbox
  forwardToSalesHub(req.body || {}); // fire-and-forget copy to Salesforce + Android live-agents
  try { console.log('[INBOUND]', JSON.stringify(req.body).slice(0, 300)); await handleInbound(req.body || {}, baseUrl(req)); }
  catch (e) { console.error('[INBOUND] error', e.message); }
});
// ============================================================
// Vonage Demo-World — internal API demo showcase (public routes)
// ============================================================
// ============ DEMO-WORLD REGISTRATION / LOGIN (users in S3 via dget/dset: dw_users) ============
const dwHash = (pass, salt) => crypto.createHash('sha256').update(salt + '|' + pass).digest('hex');

// Minimal SMTP-over-TLS sender (smtp.gmail.com:465) - no extra npm dependency.
// Demo-World transactional mail. Gmail SMTP with the app password (primary); the Demo-World Gmail API sender
// (OAuth, Settings -> Email) is used as the fallback when it is connected. Every failure is logged with the
// SMTP transcript so the next "nobody got the email" has a reason next to it in the EB logs.
function dwSmtpSend(to, subject, html, text) {
  return new Promise((resolve, reject) => {
    if (!GMAIL_APP_PASS) return reject(new Error('mail not configured (GMAIL_APP_PASS missing)'));
    const tlsMod = require('tls');
    const boundary = 'dw' + crypto.randomBytes(8).toString('hex');
    const msgId = '<' + crypto.randomBytes(12).toString('hex') + '@demoworld.vonage>';
    const body = [
      `From: Vonage Demo-World <${GMAIL_USER}>`, `Reply-To: ${DW_ADMIN_EMAIL}`, `To: <${to}>`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${msgId}`,
      'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), '',
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', html, '', `--${boundary}--`, '.',
    ].join('\r\n').replace(/\r\n\.\r\n(?!$)/g, '\r\n..\r\n');
    const steps = [null, 'EHLO demoworld.local', 'AUTH LOGIN', Buffer.from(GMAIL_USER).toString('base64'), Buffer.from(GMAIL_APP_PASS).toString('base64'),
      `MAIL FROM:<${GMAIL_USER}>`, `RCPT TO:<${to}>`, 'DATA', body, 'QUIT'];
    const sock = tlsMod.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' });
    let i = 0, buf = '', done = false; const log = [];
    const finish = (err) => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} err ? reject(new Error(err + ' | ' + log.slice(-3).join(' / '))) : resolve(true); };
    sock.setTimeout(25000, () => finish('smtp timeout at step ' + i));
    sock.on('error', (e) => finish('smtp ' + e.message));
    sock.on('data', (d) => {
      buf += d.toString();
      // a reply is complete when its last line is "NNN<space>" (multi-line replies use "NNN-")
      const lines = buf.split('\r\n').filter(Boolean); const lastLine = lines[lines.length - 1] || '';
      if (!/\r\n$/.test(buf) || !/^\d{3} /.test(lastLine)) return;
      const code = parseInt(lastLine.slice(0, 3), 10); log.push(lastLine.slice(0, 80)); buf = '';
      if (code >= 400) return finish('SMTP ' + lastLine.trim().slice(0, 140));
      i++;
      if (i < steps.length) sock.write(steps[i] + '\r\n'); else finish(null);
    });
  });
}
async function dwSendMail(to, subject, html, text) {
  try { await dwSmtpSend(to, subject, html, text); console.log('[DW-AUTH] mail sent (smtp) to', to, '|', subject); return true; }
  catch (e) {
    console.error('[DW-AUTH] mail smtp failed to', to, ':', e.message);
    if (await emailConnected()) {
      const r = await sendEmail(to, { subject, body: html, fromName: 'Vonage Demo-World' });
      if (r.ok) { console.log('[DW-AUTH] mail sent (gmail api) to', to); return true; }
      throw new Error('smtp: ' + e.message + '; gmail api: ' + r.error);
    }
    throw e;
  }
}
// One template for every Demo-World mail: verification, resend, password reset.
function dwMailHtml({ first, badge, heading, intro, action, link, cta, footnote }) {
  return `<body style="margin:0;padding:0;background:#f4f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:28px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
<tr><td style="background:#ffffff;border-radius:20px 20px 0 0;border:1px solid #ececf0;border-bottom:none;padding:20px 30px;font-family:Helvetica,Arial,sans-serif">
  <span style="font-size:17px;font-weight:800;letter-spacing:.06em;color:#0a0a0a">VONAGE</span><span style="color:#c9c9d1;padding:0 8px">|</span><span style="font-size:14px;font-weight:700;color:#0a0a0a">Demo-World</span>
</td></tr>
<tr><td style="background:#ffffff;border-left:1px solid #ececf0;border-right:1px solid #ececf0;padding:12px 30px 0;font-family:Helvetica,Arial,sans-serif">
  <span style="display:inline-block;background:#e8f7ee;color:#116b3d;font-size:11px;font-weight:800;letter-spacing:.05em;padding:6px 13px;border-radius:100px">&#9679; ${badge}</span>
  <h1 style="margin:16px 0 8px;font-size:27px;letter-spacing:-.5px;color:#0a0a0a;font-family:Helvetica,Arial,sans-serif">${heading.replace('{first}', first)}</h1>
  <p style="margin:0 0 6px;font-size:14.5px;line-height:1.6;color:#55555e">${intro}</p>
  <p style="margin:0;font-size:14.5px;line-height:1.6;color:#55555e">${action}</p>
</td></tr>
<tr><td align="center" style="background:#ffffff;border-left:1px solid #ececf0;border-right:1px solid #ececf0;padding:26px 30px">
  <a href="${link}" style="display:inline-block;background:#0a0a0a;color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;padding:15px 40px;border-radius:100px;text-decoration:none">${cta} &#8594;</a>
</td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 20px 20px;border:1px solid #ececf0;border-top:none;padding:0 30px 24px;font-family:Helvetica,Arial,sans-serif">
  <p style="margin:0 0 4px;font-size:12px;color:#8b8698">Button not working? Paste this link into your browser:</p>
  <p style="margin:0;font-size:12px;word-break:break-all"><a href="${link}" style="color:#0a0a0a">${link}</a></p>
</td></tr>
<tr><td align="center" style="padding:16px 30px;font-family:Helvetica,Arial,sans-serif">
  <p style="margin:0;font-size:11.5px;color:#8b8698">Vonage <b style="color:#55555e">Demo-World</b> &middot; built for the field team &middot; ${footnote}</p>
</td></tr>
</table></td></tr></table></body>`;
}
async function dwSendVerification(u) {
  const link = DW_SITE + '/dw/verify-email?t=' + u.vtoken;
  const html = dwMailHtml({ first: (u.name || '').split(' ')[0] || 'there', badge: 'INTERNAL DEMO PLAYGROUND', heading: 'Welcome, {first}.',
    intro: "You're one tap away from running live Vonage API demos - messaging, voice, video, verify and more.", action: 'Verify your email to activate your account:', link, cta: 'Verify my email', footnote: "if you didn't register, ignore this email." });
  return dwSendMail(u.email, 'Verify your email - Vonage Demo-World', html, `Welcome to Vonage Demo-World. Verify your email to activate your account: ${link}`);
}
async function dwSendReset(u) {
  const link = DW_SITE + '/demoworld?reset=' + u.rtoken;
  const html = dwMailHtml({ first: (u.name || '').split(' ')[0] || 'there', badge: 'PASSWORD RESET', heading: 'Reset your password, {first}.',
    intro: 'Someone asked to reset the password for this Demo-World account. The link works once and expires in 60 minutes.', action: 'Choose a new password:', link, cta: 'Set a new password', footnote: "if you didn't ask for this, ignore this email - your password stays the same." });
  return dwSendMail(u.email, 'Reset your password - Vonage Demo-World', html, `Reset your Vonage Demo-World password (valid 60 minutes): ${link}`);
}

async function dwUsers() { return await dget('dw_users', []); }
async function dwSaveUsers(u) { await dset('dw_users', u); }
// Seed the first account (verified, exact password per owner request).
async function dwSeed() {
  if (!DW_ADMIN_EMAIL || !DW_SEED_PASSWORD) return;
  const users = await dwUsers();
  if (!users.find(u => u.email === DW_ADMIN_EMAIL)) {
    const salt = crypto.randomBytes(8).toString('hex');
    users.push({ name: 'Owner', role: 'Owner', email: DW_ADMIN_EMAIL, salt, pass: dwHash(DW_SEED_PASSWORD, salt), verified: true, created: new Date().toISOString() });
    await dwSaveUsers(users); console.log('[DW-AUTH] seeded owner account');
  }
}
dwSeed().catch(e => console.error('[DW-AUTH] seed', e.message));

function dwCookie(req) {
  const m = /(?:^|;\s*)dwauth=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  try { return jwt.verify(decodeURIComponent(m[1]), DW_AUTH_SECRET); } catch (e) { return null; }
}
app.post('/dw/api/register', express.json(), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    const role = String(req.body.role || '').trim().slice(0, 80);
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!name || !role) return res.json({ error: 'Add your full name and role' });
    if (!new RegExp('^[a-z0-9._%+-]+@' + DW_ALLOWED_DOMAIN.replace(/\./g, '\\.') + '$').test(email)) return res.json({ error: 'Registration is open to @' + DW_ALLOWED_DOMAIN + ' email addresses only' });
    if (password.length < 6) return res.json({ error: 'Password needs at least 6 characters' });
    const users = await dwUsers();
    const ex = users.find(u => u.email === email);
    if (ex && ex.verified) return res.json({ error: 'This email is already registered - sign in instead' });
    const salt = crypto.randomBytes(8).toString('hex');
    const vtoken = crypto.randomBytes(18).toString('hex');
    const rec = { name, role, email, salt, pass: dwHash(password, salt), verified: false, vtoken, created: new Date().toISOString() };
    if (ex) Object.assign(ex, rec); else users.push(rec);
    await dwSaveUsers(users);
    let mailSent = false;
    try { await dwSendVerification(rec);      mailSent = true;
    } catch (e) { console.error('[DW-AUTH] mail', e.message); }
    res.json({ ok: true, mailSent, error: mailSent ? null : 'Account created, but the verification email could not be sent yet - use "Resend verification email" in a minute, or ask the admin to activate you.' });
  } catch (e) { res.json({ error: e.message }); }
});
app.get('/dw/verify-email', async (req, res) => {
  const t = String(req.query.t || '');
  const users = await dwUsers();
  const u = users.find(x => x.vtoken === t && !x.verified);
  if (!u) return res.status(400).send('<meta charset="utf-8"><body style="font-family:Arial;padding:60px;text-align:center"><h2>Link expired or already used</h2><p><a href="/demoworld">Go to Demo-World</a></p>');
  u.verified = true; delete u.vtoken;
  await dwSaveUsers(users);
  res.redirect('/demoworld?verified=1');
});
app.post('/dw/api/login', express.json(), async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const users = await dwUsers();
    const u = users.find(x => x.email === email);
    if (!u || dwHash(password, u.salt) !== u.pass) return res.json({ error: 'Wrong email or password' });
    if (!u.verified) return res.json({ error: 'Please verify your email first - check your inbox' });
    u.lastLogin = new Date().toISOString(); await dwSaveUsers(users);
    const tok = jwt.sign({ email: u.email, name: u.name, role: u.role }, DW_AUTH_SECRET, { expiresIn: '14d' });
    res.setHeader('Set-Cookie', `dwauth=${encodeURIComponent(tok)}; Path=/; Max-Age=1209600; HttpOnly; SameSite=Lax`);
    res.json({ ok: true, name: u.name });
  } catch (e) { res.json({ error: e.message }); }
});
// Resend the verification mail (unverified accounts only; always answers the same so addresses cannot be probed)
app.post('/dw/api/resend-verification', express.json(), async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase(); const users = await dwUsers(); const u = users.find(x => x.email === email);
    if (u && !u.verified) { if (!u.vtoken) { u.vtoken = crypto.randomBytes(18).toString('hex'); await dwSaveUsers(users); } await dwSendVerification(u); }
    res.json({ ok: true, message: 'If that address has an unverified account, a new verification email is on its way.' });
  } catch (e) { console.error('[DW-AUTH] resend', e.message); res.json({ error: 'Could not send the email right now - try again in a minute or ask the admin.' }); }
});
// Forgot password: emails a one-hour, single-use reset link. Same reply whether or not the address exists.
app.post('/dw/api/forgot', express.json(), async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase(); const users = await dwUsers(); const u = users.find(x => x.email === email);
    if (u) { u.rtoken = crypto.randomBytes(18).toString('hex'); u.rtokenExp = Date.now() + 60 * 60000; await dwSaveUsers(users); await dwSendReset(u); }
    res.json({ ok: true, message: 'If that address is registered, a reset link is on its way. It is valid for 60 minutes.' });
  } catch (e) { console.error('[DW-AUTH] forgot', e.message); res.json({ error: 'Could not send the email right now - try again in a minute or ask the admin.' }); }
});
app.post('/dw/api/reset', express.json(), async (req, res) => {
  try {
    const token = String(req.body.token || ''); const password = String(req.body.password || '');
    if (password.length < 6) return res.json({ error: 'Password needs at least 6 characters' });
    const users = await dwUsers(); const u = token && users.find(x => x.rtoken === token);
    if (!u || !u.rtokenExp || u.rtokenExp < Date.now()) return res.json({ error: 'This reset link has expired or was already used - request a new one.' });
    u.salt = crypto.randomBytes(8).toString('hex'); u.pass = dwHash(password, u.salt); delete u.rtoken; delete u.rtokenExp;
    u.verified = true; delete u.vtoken; // owning the inbox proves the address
    await dwSaveUsers(users); console.log('[DW-AUTH] password reset for', u.email);
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});
app.post('/dw/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'dwauth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'); res.json({ ok: true }); });
app.get('/dw/api/me', (req, res) => { const u = dwCookie(req); res.json(u ? { ok: true, name: u.name, role: u.role, email: u.email } : { ok: false }); });

app.get(['/demoworld', '/demo-world', '/demoworld.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); // per-user page - never CDN/browser cache
  if (!dwCookie(req)) return res.sendFile(path.join(__dirname, 'public', 'demoworld-login.html'));
  const html = fs.readFileSync(path.join(__dirname, 'public', 'demoworld.html'), 'utf8')
    .replace(/__WA_NUMBER__/g, WA_NUMBER).replace(/__RBM_AGENT__/g, RBM_AGENT).replace(/__OPTOUT_URL__/g, OPTOUT_URL || '#').replace(/__HUBSPOT_GUIDE_URL__/g, env('HUBSPOT_GUIDE_URL', '#')).replace(/__HUB_URL__/g, env('HUB_URL', '#')).replace(/__ADMIN_EMAIL__/g, DW_ADMIN_EMAIL);
  res.type('html').send(html);
});
app.get('/demoworld-admin.html', (req, res) => res.redirect('/dw/admin'));
app.get('/demoworld-login.html', (req, res) => res.redirect('/demoworld'));

// Demo-World user admin - ONLY the owner account. (/admin belongs to the older Demo-World app.)
const dwIsAdmin = (req) => { const u = dwCookie(req); return u && u.email === DW_ADMIN_EMAIL ? u : null; };
app.get('/dw/admin', (req, res) => {
  if (!dwIsAdmin(req)) return res.redirect('/demoworld');
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'public', 'demoworld-admin.html'), 'utf8').replace(/__ADMIN_EMAIL__/g, DW_ADMIN_EMAIL));
});
app.get('/dw/api/users', async (req, res) => {
  if (!dwIsAdmin(req)) return res.status(403).json({ error: 'forbidden' });
  const users = await dwUsers();
  res.json({ users: users.map(u => ({ name: u.name, role: u.role, email: u.email, verified: !!u.verified, created: u.created, lastLogin: u.lastLogin || null })) });
});
app.post('/dw/api/users/delete', express.json(), async (req, res) => {
  if (!dwIsAdmin(req)) return res.status(403).json({ error: 'forbidden' });
  const email = String(req.body.email || '').trim().toLowerCase();
  if (email === DW_ADMIN_EMAIL) return res.json({ error: 'You cannot delete your own account' });
  const users = await dwUsers();
  const n = users.length;
  const left = users.filter(u => u.email !== email);
  if (left.length === n) return res.json({ error: 'User not found' });
  await dwSaveUsers(left);
  res.json({ ok: true });
});
// Customer-story replica pages (branded landing pages the RCS card buttons open)
for (const st of ['telljo', 'freenow', 'mydealz', 'instyler', 'maxfactory', 'livestorm']) {
  app.get('/' + st, (req, res) => res.sendFile(path.join(__dirname, 'public', 'story-' + st + '.html')));
}
// ePARK (Nordic parking) demo webview - real map + pay-for-parking checkout (Apple Pay / Google Pay / card)
app.get('/epark', (req, res) => res.sendFile(path.join(__dirname, 'public', 'epark.html')));

const DW_BASE = ASSET_BASE + '/shop/';
const DW_SHOP = DW_BASE + 'catalog.html';
const DW_STORES = DW_BASE + 'stores.html';
const DW_IMG = i => `https://images.unsplash.com/photo-${i}?w=800&q=70&auto=format&fit=crop`;
const DW_RETAIL_IMG = DW_IMG('1595777457583-95e059d581b8');
const DW_PRODUCTS = [
  { name: 'The Celeste Gown', desc: 'Sculptural black-tie gown · £320', img: DW_IMG('1595777457583-95e059d581b8'), url: DW_BASE + 'checkout.html?item=celeste' },
  { name: 'Odette Slip Dress', desc: 'Bias-cut silk, effortless · £180', img: DW_IMG('1566174053879-31528523f8ae'), url: DW_BASE + 'checkout.html?item=odette' },
  { name: 'Noor Wrap Dress', desc: 'Fluid crepe, wedding-guest · £195', img: DW_IMG('1509631179647-0177331693ae'), url: DW_BASE + 'checkout.html?item=noor' },
];
// Vonage Video API (dedicated app; app-based auth, no dashboard project key needed)
const dwRooms = {}; // room name -> sessionId (in-memory, so both participants share a session)
function videoJwt(extra) { const now = Math.floor(Date.now() / 1000); return jwt.sign(Object.assign({ application_id: VIDEO_APP_ID, iat: now, exp: now + 3600, jti: crypto.randomUUID() }, extra || {}), VIDEO_KEY, { algorithm: 'RS256' }); }

// Vonage Client SDK voice (browser softphone - dedicated app so the core app's webhooks are untouched)
// App JWT for the voice app (used to provision the Client SDK user).
function dwAppJwt() { const now = Math.floor(Date.now() / 1000); return jwt.sign({ application_id: DWVOICE_APP_ID, iat: now, exp: now + 3600, jti: crypto.randomUUID() }, DWVOICE_KEY, { algorithm: 'RS256' }); }
// Client-SDK token: authenticates a browser as a demo user with the voice ACL.
function dwClientJwt(username) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iat: now, exp: now + 6 * 3600, jti: crypto.randomUUID(), sub: username, application_id: DWVOICE_APP_ID,
    acl: { paths: {
      '/*/users/**': {}, '/*/conversations/**': {}, '/*/sessions/**': {}, '/*/devices/**': {},
      '/*/image/**': {}, '/*/media/**': {}, '/*/applications/**': {}, '/*/push/**': {}, '/*/knocking/**': {}, '/*/legs/**': {},
    } },
  }, DWVOICE_KEY, { algorithm: 'RS256' });
}

// Story-intake scratch channel: the browser (on vonage.com) POSTs scraped story extracts here
// (text/plain avoids CORS preflight); the build pipeline GETs them back. Ephemeral, build-time only.
const dwIntake = {};
app.post('/dw/api/story-intake', express.text({ type: '*/*', limit: '6mb' }), (req, res) => {
  const part = String(req.query.part || '0').replace(/\D/g, '') || '0';
  dwIntake[part] = String(req.body || '');
  res.json({ ok: true, part, bytes: dwIntake[part].length });
});
app.get('/dw/api/story-intake', (req, res) => {
  const parts = Object.keys(dwIntake).sort((a, b) => a - b).map(k => dwIntake[k]);
  res.type('application/json').send('[' + parts.filter(Boolean).join(',') + ']');
});

// Customer-story replica cards (RCS) - each mirrors the flow the real customer runs in production.
// Buttons open OUR replica landing pages (served from this instance via CloudFront) so the whole flow stays live.
const DW_STORY_IMG = id => `${ASSET_BASE}/story/${id}.jpg`;

// ---- ePARK (Nordic parking) conversational RCS demo: PARK -> welcome -> book on map -> pay -> thanks + location ----
const EPARK_HERO = '${ASSET_BASE}/toon/epark-parking.jpg';
function eparkSend(to, content) { return vonageMessages({ from: RCS_SENDER, to: String(to).replace(/\D/g, ''), channel: 'rcs', message_type: 'custom', custom: { contentMessage: content } }); }
function eparkWelcome(to) {
  return eparkSend(to, { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
    title: 'Welcome to ePARK 👋',
    description: 'Park and pay in seconds across the Nordics. What would you like to do?',
    media: { height: 'MEDIUM', contentInfo: { fileUrl: EPARK_HERO, forceRefresh: false } },
    suggestions: [
      { reply: { text: 'Book a parking', postbackData: 'epark_book' } },
      { reply: { text: 'Extend parking', postbackData: 'epark_extend' } },
      { reply: { text: 'Help', postbackData: 'epark_help' } },
    ],
  } } } });
}
function eparkBook(to) {
  return eparkSend(to, { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
    title: 'Book a parking 🅿️',
    description: 'Open the live map, choose your zone and time, and pay with Apple Pay, Google Pay or card. Active in seconds.',
    media: { height: 'MEDIUM', contentInfo: { fileUrl: EPARK_HERO, forceRefresh: false } },
    suggestions: [
      { action: { text: 'Open map & pay', postbackData: 'epark_open', openUrlAction: { url: DW_CF + '/epark?to=' + encodeURIComponent(String(to).replace(/\D/g, '')), application: 'WEBVIEW', webviewViewMode: 'FULL', description: 'ePARK - Park & Pay' } } },
      { reply: { text: 'Back', postbackData: 'epark_menu' } },
    ],
  } } } });
}
function eparkHelp(to) {
  return eparkSend(to, { text: 'ePARK lets you pay for parking from your phone across the Nordics. Tap Book a parking to choose a zone on the map and pay with Apple Pay, Google Pay or card. Support: epark.se/en',
    suggestions: [ { reply: { text: 'Book a parking', postbackData: 'epark_book' } } ] });
}
function eparkPaid(to, o) {
  o = o || {};
  const q = 'zone=' + encodeURIComponent(o.zone || '') + '&name=' + encodeURIComponent(o.name || '') + '&lat=' + encodeURIComponent(o.lat || '59.3326') + '&lng=' + encodeURIComponent(o.lng || '18.0649') + '&plate=' + encodeURIComponent(o.plate || '') + '&until=' + encodeURIComponent(o.until || '') + '&code=' + encodeURIComponent(o.code || '');
  return eparkSend(to, { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
    title: 'Thanks for paying ✅',
    description: 'Your parking is active in Zone ' + (o.zone || '') + (o.name ? (' - ' + o.name) : '') + ' for ' + (o.plate || 'your vehicle') + ', valid until ' + (o.until || '') + '. Receipt ' + (o.code || '') + '. Tap below to see exactly where you parked.',
    media: { height: 'MEDIUM', contentInfo: { fileUrl: EPARK_HERO, forceRefresh: false } },
    suggestions: [
      { action: { text: 'View parking location', postbackData: 'epark_spot', openUrlAction: { url: DW_CF + '/epark-spot?' + q, application: 'WEBVIEW', webviewViewMode: 'TALL', description: 'Your parking location' } } },
      { reply: { text: 'Extend parking', postbackData: 'epark_extend' } },
    ],
  } } } });
}
function eparkInbound(from, upper) {
  if (upper === 'EPARK_BOOK' || upper === 'EPARK_OPEN') return eparkBook(from);
  if (upper === 'EPARK_HELP') return eparkHelp(from);
  if (upper === 'EPARK_MENU') return eparkWelcome(from);
  if (upper === 'EPARK_EXTEND') return eparkBook(from);
  return eparkWelcome(from); // PARK / EPARK -> start the flow
}
app.get('/epark-spot', (req, res) => res.sendFile(path.join(__dirname, 'public', 'epark-spot.html')));
app.post('/epark/paid', express.json(), (req, res) => {
  const b = req.body || {}; const to = String(b.to || '').replace(/\D/g, '');
  res.json({ ok: true });
  if (to.length >= 9) eparkPaid(to, b).catch(e => console.error('[EPARK] paid send failed', e.message));
});
const DW_STORY_CARDS = {
  'story-telljo': { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
    title: 'A check-in from your energy supplier 💙',
    description: 'We noticed things might be tough right now. TellJO offers a free, confidential wellbeing check - no payment demands, just support. Choose what works for you.',
    media: { height: 'MEDIUM', contentInfo: { fileUrl: DW_STORY_IMG('telljo-solution'), forceRefresh: false } },
    suggestions: [
      { action: { text: 'Start wellbeing check', postbackData: 'telljo_check', openUrlAction: { url: DW_CF + '/telljo', application: 'WEBVIEW', webviewViewMode: 'HALF' } } },
      { action: { text: 'Affordability options', postbackData: 'telljo_options', openUrlAction: { url: DW_CF + '/telljo?view=support', application: 'WEBVIEW', webviewViewMode: 'HALF' } } },
      { reply: { text: 'Request a callback', postbackData: 'telljo_callback' } },
    ],
  } } } },
  'story-freenow': { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
    title: 'Your FREENOW ride is confirmed 🚕',
    description: 'Marco is arriving in 4 minutes - black VW ID.4, plate B-FN 2210. Fare estimate £11.40, paid in-app.',
    media: { height: 'MEDIUM', contentInfo: { fileUrl: DW_STORY_IMG('freenow-solution'), forceRefresh: false } },
    suggestions: [
      { action: { text: 'Track your driver', postbackData: 'fn_track', openUrlAction: { url: DW_CF + '/freenow', application: 'WEBVIEW', webviewViewMode: 'HALF' } } },
      { action: { text: 'Trip details & receipt', postbackData: 'fn_trip', openUrlAction: { url: DW_CF + '/freenow#trip', application: 'WEBVIEW', webviewViewMode: 'HALF' } } },
      { reply: { text: 'Book a return ride', postbackData: 'fn_return' } },
    ],
  } } } },
  'story-mydealz': { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
    title: 'Deal alert: Nintendo Switch OLED -40% 🔥',
    description: '189€ instead of 319€ - community verified, 2,400° hot. Ends tonight at midnight.',
    media: { height: 'MEDIUM', contentInfo: { fileUrl: DW_STORY_IMG('mydealz-solution'), forceRefresh: false } },
    suggestions: [
      { action: { text: 'View deal', postbackData: 'md_view', openUrlAction: { url: DW_CF + '/mydealz', application: 'WEBVIEW', webviewViewMode: 'HALF' } } },
      { action: { text: 'More hot deals', postbackData: 'md_more', openUrlAction: { url: DW_CF + '/mydealz#more', application: 'WEBVIEW', webviewViewMode: 'HALF' } } },
      { reply: { text: 'Save for later', postbackData: 'md_save' } },
    ],
  } } } },
  'story-instyler': { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
    title: 'Appointment reminder - Salon Luisa ✂️',
    description: 'Hi! Your colour & cut is tomorrow at 14:30 with Nadja, Friedrichstraße 12. We look forward to seeing you.',
    media: { height: 'MEDIUM', contentInfo: { fileUrl: DW_STORY_IMG('instyler-solution'), forceRefresh: false } },
    suggestions: [
      { reply: { text: 'Confirm ✓', postbackData: 'is_confirm' } },
      { reply: { text: 'Reschedule', postbackData: 'is_resched' } },
      { action: { text: 'Directions', postbackData: 'is_map', openUrlAction: { url: 'https://maps.google.com/?q=Friedrichstrasse+12+Berlin' } } },
    ],
  } } } },
  'story-maxfactory': { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
    title: 'Max Factory - solo per te: -30% Casa 🏠',
    description: 'Weekend offer at your Bologna store: 30% off household & kitchen, picked from what you love. Show this message at the till.',
    media: { height: 'MEDIUM', contentInfo: { fileUrl: DW_STORY_IMG('maxfactory-solution'), forceRefresh: false } },
    suggestions: [
      { action: { text: 'Find your store', postbackData: 'mf_store', openUrlAction: { url: DW_CF + '/maxfactory#store', application: 'WEBVIEW', webviewViewMode: 'HALF' } } },
      { reply: { text: 'Show my code', postbackData: 'mf_code' } },
    ],
  } } } },
  'epark-parking': { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
    title: 'Your parking in Stockholm 🅿️',
    description: 'Pay for parking with ePARK - pick your zone on the live map, choose how long, and pay with Apple Pay, Google Pay or card. Active in seconds.',
    media: { height: 'MEDIUM', contentInfo: { fileUrl: '${ASSET_BASE}/toon/epark-parking.jpg', forceRefresh: false } },
    suggestions: [
      { action: { text: 'Pay for parking', postbackData: 'epark_pay', openUrlAction: { url: DW_CF + '/epark', application: 'WEBVIEW', webviewViewMode: 'FULL', description: 'ePARK - Park & Pay' } } },
      { action: { text: 'Find a zone', postbackData: 'epark_zone', openUrlAction: { url: DW_CF + '/epark', application: 'WEBVIEW', webviewViewMode: 'FULL', description: 'ePARK parking map' } } },
      { reply: { text: 'Extend my parking', postbackData: 'epark_extend' } },
    ],
  } } } },
};

// Live message demos (RCS rich card / SMS). WhatsApp demos are conversational (trigger + QR).
app.post('/dw/api/send', async (req, res) => {
  try {
    const to = String(req.body.to || '').replace(/\D/g, '');
    const channel = req.body.channel; const demo = req.body.demo;
    if (to.length < 8) return res.json({ error: 'Enter a valid number' });
    if (channel === 'rcs') {
      // Avon AI Skin Coach: the dedicated VCR app sends its own welcome card
      // (the user then replies with a selfie which the inbound hook forwards).
      if (demo === 'rcs-skincoach') {
        if (!AVON_SKIN_URL) return res.json({ error: 'Skin Coach service not configured' });
        const r = await f(AVON_SKIN_URL + '/analyze', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msisdn: to, text: 'GLOW' })
        });
        return res.json({ ok: r.ok, error: r.ok ? undefined : 'Skin Coach unavailable' });
      }
      // Wayfair Hot Deals: the /wf router sends its own welcome card with the
      // deals carousel + demo checkout (and the abandoned-cart win-back flow).
      if (demo === 'rcs-wayfair') {
        const r = await f(DW_CF + '/wf/trigger', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msisdn: to, text: 'WAYFAIR' })
        });
        return res.json({ ok: r.ok, error: r.ok ? undefined : 'Wayfair bot unavailable' });
      }
      // Peak Season Promotions: the event demo (welcome card + menu carousel, then conversational)
      if (demo === 'peak-season') {
        await peak.welcome(to, 'rcs');
        return res.json({ ok: true });
      }
      // ePARK: start the conversational flow (welcome -> book -> map+pay -> thanks+location)
      if (demo === 'epark-parking') {
        const s = await eparkWelcome(to);
        return res.json({ ok: s.ok, id: s.id, error: s.error });
      }
      let content;
      if (DW_STORY_CARDS[demo]) {
        content = DW_STORY_CARDS[demo];
      } else if (demo === 'rcs-carousel') {
        content = { richCard: { carouselCard: { cardWidth: 'MEDIUM', cardContents: DW_PRODUCTS.map(p => ({
          title: p.name, description: p.desc,
          media: { height: 'MEDIUM', contentInfo: { fileUrl: p.img, forceRefresh: false } },
          suggestions: [{ action: { text: 'Shop', postbackData: 'shop', openUrlAction: { url: p.url, application: 'WEBVIEW', webviewViewMode: 'HALF' } } }]
        })) } } };
      } else {
        content = { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent: {
          title: 'AURELIA - New this season ✨', description: 'Sculptural gowns, fluid silk and sharp tailoring. Shop the occasion edit or find your nearest boutique.',
          media: { height: 'MEDIUM', contentInfo: { fileUrl: DW_RETAIL_IMG, forceRefresh: false } },
          suggestions: [ { action: { text: 'Shop the edit', postbackData: 'shop', openUrlAction: { url: DW_SHOP, application: 'WEBVIEW', webviewViewMode: 'HALF' } } }, { action: { text: 'Find a store', postbackData: 'stores', openUrlAction: { url: DW_STORES, application: 'WEBVIEW', webviewViewMode: 'HALF' } } } ]
        } } } };
      }
      const out = await vonageMessages({ from: RCS_SENDER, to, channel: 'rcs', message_type: 'custom', custom: { contentMessage: content } });
      return res.json({ ok: out.ok, id: out.id, error: out.error });
    }
    if (channel === 'sms') {
      const text = demo === 'sms-marketing'
        ? 'AURELIA: The Occasion Edit is live - up to 30% off gowns & tailoring this weekend. Shop: ' + DW_SHOP + ' Reply STOP to opt out.'
        : 'Reminder: your appointment is tomorrow at 2:30pm with Dr. Lee. Reply Y to confirm, or call 0808 123 4567 to reschedule. - Vonage Health demo';
      const out = await vonageSms(to, text, baseUrl(req));
      return res.json({ ok: out.ok, id: out.id, error: out.error });
    }
    if (channel === 'viber') {
      // Viber Business Messages via the account's service ID (two-way, linked to the configured application).
      // Capability tour: every message type Vonage supports on Viber, in sequence.
      if (demo === 'viber-capabilities') {
        const V = (extra) => ({ from: VIBER_FROM, to, channel: 'viber_service', ...extra });
        const shop = { url: DW_SHOP, text: 'Shop the edit' };
        await vonageMessages(V({ message_type: 'text', text: '1/4 TEXT with an action button - the workhorse of Viber Business Messages. Two-way: reply and it reaches the team.', viber_service: { category: 'transaction', ttl: 600, action: shop } }));
        await vonageMessages(V({ message_type: 'image', image: { url: DW_RETAIL_IMG, caption: '2/4 IMAGE with caption and button' }, viber_service: { category: 'promotion', ttl: 600, action: shop } }));
        await vonageMessages(V({ message_type: 'video', video: { url: DW_VIBER_VIDEO, thumb_url: DW_VIBER_THUMB }, viber_service: { category: 'promotion', ttl: 600, duration: 23, file_size: 1 } }));
        const out = await vonageMessages(V({ message_type: 'file', file: { url: DW_VIBER_PDF, name: 'AURELIA-Occasion-Edit.pdf' }, viber_service: { category: 'transaction', ttl: 600 } }));
        return res.json({ ok: out.ok, id: out.id, error: out.error });
      }
      if (demo === 'viber-media') {
        await vonageMessages({ from: VIBER_FROM, to, channel: 'viber_service', message_type: 'video',
          video: { url: DW_VIBER_VIDEO, thumb_url: DW_VIBER_THUMB }, viber_service: { category: 'promotion', ttl: 600, duration: 23, file_size: 1 } });
        const out = await vonageMessages({ from: VIBER_FROM, to, channel: 'viber_service', message_type: 'file',
          file: { url: DW_VIBER_PDF, name: 'AURELIA-Occasion-Edit.pdf' }, viber_service: { category: 'transaction', ttl: 600 } });
        return res.json({ ok: out.ok, id: out.id, error: out.error });
      }
      if (demo === 'viber-marketing') {
        // promotion: hero image, then offer text with a tappable action button
        await vonageMessages({ from: VIBER_FROM, to, channel: 'viber_service', message_type: 'image',
          image: { url: DW_RETAIL_IMG }, viber_service: { category: 'promotion', ttl: 600 } });
        const out = await vonageMessages({ from: VIBER_FROM, to, channel: 'viber_service', message_type: 'text',
          text: 'AURELIA on Viber - The Occasion Edit is live. Up to 30% off sculptural gowns, fluid silk and sharp tailoring, this weekend only.',
          viber_service: { category: 'promotion', ttl: 600, action: { url: DW_SHOP, text: 'Shop the edit' } } });
        return res.json({ ok: out.ok, id: out.id, error: out.error });
      }
      // transactional order update with a tracking button
      const out = await vonageMessages({ from: VIBER_FROM, to, channel: 'viber_service', message_type: 'text',
        text: 'AURELIA: order AUR-2417 is confirmed and being prepared. Estimated delivery Thursday. We will message you when it ships.',
        viber_service: { category: 'transaction', ttl: 600, action: { url: DW_SHOP, text: 'View my order' } } });
      return res.json({ ok: out.ok, id: out.id, error: out.error });
    }
    return res.json({ error: 'Unsupported channel' });
  } catch (e) { res.json({ error: e.message }); }
});

// ============ RCS DEMO VIDEO MAKER (Demo World tool) ============
// AI turns a seller's brief into a conversation spec; the browser renders and
// records the video client-side (canvas + MediaRecorder) - nothing server-side.
app.post('/dw/api/videospec', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { brand, brief } = req.body || {};
    if (!brand || !brief) return res.status(400).json({ error: 'brand and brief required' });
    const system = `You write RCS Business Messaging demo conversation scripts. Reply with STRICT JSON ONLY - no prose, no markdown fences.
Schema:
{"agentName":"<brand>","messages":[
 {"k":"in","t":"<agent text message>","chips":["<suggested reply>", ...]?} |
 {"k":"card","ct":"<card title, max 40 chars>","t":"<card description>","btns":["<button, max 22 chars>", ...],"imgPrompt":"<photographic image description for this card, 8-16 words, no text/logos in the image>"} |
 {"k":"out","t":"<message the customer sends>"}
]}
Rules:
- 6 to 11 messages total. Message text must be realistic and compliant.
- Unless the brief says otherwise: START with a welcome message that includes "Msg&Data rates may apply. Msg freq varies. Reply STOP to end, HELP for help." and chips ["HELP","STOP"].
- Unless the brief says otherwise: END with {"k":"out","t":"STOP"} followed by a compliant opt-out confirmation: brand name + confirmation of unsubscribe + "no further messages" + "reply START to opt back in", with chips ["START"].
- Marketing/product content the brief asks for should be rich cards (k:"card") with 1-2 buttons. Every card gets an imgPrompt describing an appetising, professional marketing photo for that card (photography style, no text, no logos, no people's faces close-up).
- Promotional messages should include "Reply STOP to opt-out." in the text.
- OTP/verification messages must be k:"in" plain text (never a card), with a 6-digit example code and an expiry note.
- Use the brand name naturally in messages. Follow any specific wording the brief dictates verbatim.`;
    const raw = await aiText(system, [{ role: 'user', content: `Brand: ${brand}\nBrief: ${brief}` }], 3000);
    const js = raw.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
    const spec = JSON.parse(js.slice(js.indexOf('{'), js.lastIndexOf('}') + 1));
    if (!Array.isArray(spec.messages) || !spec.messages.length) throw new Error('empty spec');
    spec.agentName = spec.agentName || brand;
    res.json({ ok: true, spec });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Card image generation for the video maker - Gemini image model (Bedrock's
// image generators are Legacy/blocked on this AWS account).
app.post('/dw/api/genimage', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const body = {
      contents: [{ parts: [{ text: 'Professional marketing photograph for a mobile rich card, landscape 16:9, vivid and appetising, no text, no watermarks, no logos: ' + prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
    };
    const r = await f('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + DW_GEMINI_KEY,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: (d.error && d.error.message) || ('gemini ' + r.status) });
    const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    const img = parts.find((p) => p.inlineData || p.inline_data);
    if (!img) return res.status(502).json({ error: 'no image in response' });
    const inl = img.inlineData || img.inline_data;
    res.json({ ok: true, dataUrl: `data:${inl.mimeType || inl.mime_type || 'image/png'};base64,${inl.data}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const DW_VBASIC = () => 'Basic ' + Buffer.from(VONAGE_API_KEY + ':' + VONAGE_API_SECRET).toString('base64');
// Peak Season Promotions demo: give the module the senders, AI, S3 and voice/verify plumbing it needs.
try {
  peak.mount(app, { express, vonageMessages, RCS_SENDER, WA_NUMBER, DW_CF, f, vjwt, API_BASE, VOICE_NUMBER, DW_VBASIC, DW_GEMINI_KEY, DW_PRODUCTS, s3, S3_BUCKET, PutObjectCommand, dget, dset, sendEmail });
} catch (e) { console.error('[PEAK] mount failed', e.message); }
app.post('/dw/api/verify/start', async (req, res) => {
  try {
    const to = String(req.body.to || '').replace(/\D/g, '');
    if (to.length < 8) return res.json({ error: 'Enter a valid number' });
    const channel = ['whatsapp', 'voice'].includes(req.body.channel) ? req.body.channel : 'sms';
    const wf = [{ channel, to }]; if (channel !== 'sms') wf.push({ channel: 'sms', to });
    if (channel === 'whatsapp') wf[0].from = WA_NUMBER; // Verify v2 WhatsApp needs the registered WABA sender
    const r = await f(`${API_BASE}/v2/verify`, { method: 'POST', headers: { Authorization: DW_VBASIC(), 'Content-Type': 'application/json' }, body: JSON.stringify({ brand: 'Vonage Demo', workflow: wf }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.request_id) return res.json({ request_id: d.request_id });
    if (r.status === 409) return res.json({ error: 'A code was already sent to this number - use that one, or wait 2-3 minutes before requesting a new code' });
    return res.json({ error: d.title || d.detail || (d.errors && d.errors[0] && d.errors[0].detail) || `HTTP ${r.status}` });
  } catch (e) { res.json({ error: e.message }); }
});
app.post('/dw/api/verify/check', async (req, res) => {
  try {
    const rid = req.body.request_id, code = String(req.body.code || '').trim();
    if (!rid) return res.json({ error: 'Start a verification first' });
    if (!code) return res.json({ error: 'Enter the code' });
    const r = await f(`${API_BASE}/v2/verify/${encodeURIComponent(rid)}`, { method: 'POST', headers: { Authorization: DW_VBASIC(), 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (r.status === 200) return res.json({ verified: true });
    const d = await r.json().catch(() => ({}));
    return res.json({ verified: false, error: r.status === 409 ? 'Incorrect code — try again' : (d.title || d.detail || 'Verification failed') });
  } catch (e) { res.json({ error: e.message }); }
});

// Voice API — live outbound call with text-to-speech
app.all('/dw/voice/answer', (req, res) => res.json([{ action: 'talk', text: String(req.query.m || 'Hello from Vonage.'), voiceName: 'Amy', language: 'en-GB' }]));
app.post('/dw/api/call', async (req, res) => {
  try {
    const to = String(req.body.to || '').replace(/\D/g, '');
    if (to.length < 8) return res.json({ error: 'Enter a valid number' });
    const msg = req.body.demo === 'voice-alert'
      ? 'This is a Vonage critical alert. A high priority incident has been detected on your service. Press 1 to acknowledge, or stay on the line to be connected to the on call engineer. This is a demonstration of the Vonage Voice A P I.'
      : 'Hello, and welcome to Vonage Demo World. This live call was placed by the Vonage Voice A P I using programmable text to speech. You can build call backs, I V R menus and alerts, all from a few lines of code. Thanks for listening.';
    const base = baseUrl(req);
    const answerUrl = `${base}/dw/voice/answer?m=${encodeURIComponent(msg)}`;
    const payload = { to: [{ type: 'phone', number: to }], from: { type: 'phone', number: VOICE_NUMBER }, answer_url: [answerUrl], answer_method: 'GET' };
    const r = await f(`${API_BASE}/v1/calls`, { method: 'POST', headers: { Authorization: `Bearer ${vjwt()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    res.json({ ok: r.ok, uuid: d.uuid, error: r.ok ? null : (d.title || d.detail || `HTTP ${r.status}`) });
  } catch (e) { res.json({ error: e.message }); }
});

// Number Insight API — live carrier / line-type lookup
app.post('/dw/api/insight', async (req, res) => {
  try {
    const num = String(req.body.number || '').replace(/\D/g, '');
    if (num.length < 8) return res.json({ error: 'Enter a valid number' });
    const r = await f(`${API_BASE}/ni/standard/json?api_key=${VONAGE_API_KEY}&api_secret=${encodeURIComponent(VONAGE_API_SECRET)}&number=${num}`);
    const d = await r.json().catch(() => ({}));
    if (String(d.status) !== '0') return res.json({ error: d.status_message || 'Lookup failed' });
    const cc = d.current_carrier || {}, oc = d.original_carrier || {};
    res.json({ data: {
      number: d.international_format_number || ('+' + num),
      country: d.country_name || d.country_code,
      current_carrier: cc.name || 'unknown',
      line_type: cc.network_type || 'unknown',
      original_network: oc.name || cc.name || 'unknown',
      ported: d.ported || 'unknown',
      roaming: (d.roaming && d.roaming.status) || (typeof d.roaming === 'string' ? d.roaming : 'unknown'),
      valid: 'valid'
    } });
  } catch (e) { res.json({ error: e.message }); }
});

// Video API — create/join a shared room session and return a client token
app.all('/dw/api/video/session', express.json(), async (req, res) => {
  try {
    if (!VIDEO_KEY) return res.json({ error: 'Video not configured' });
    const room = String((req.query.room || (req.body && req.body.room) || 'lobby')).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'lobby';
    let sessionId = dwRooms[room];
    if (!sessionId) {
      const form = 'archiveMode=manual&p2p.preference=enabled&location=';
      const r = await f('https://video.api.vonage.com/session/create', { method: 'POST', headers: { Authorization: 'Bearer ' + videoJwt(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form });
      const j = await r.json().catch(() => []);
      if (!r.ok || !j[0] || !j[0].session_id) return res.json({ error: 'Could not create video session' });
      sessionId = j[0].session_id; dwRooms[room] = sessionId;
    }
    const token = videoJwt({ scope: 'session.connect', session_id: sessionId, role: 'publisher', initial_layout_class_list: '', sub: 'video', acl: { paths: { '/session/**': {} } } });
    res.json({ applicationId: VIDEO_APP_ID, sessionId, token, room });
  } catch (e) { res.json({ error: e.message }); }
});

// --- Browser softphone (Vonage Client SDK) -----------------------------------
// Token the browser uses to log in as a demo user and place a call.
let dwLastWebUser = null; // most recent browser softphone user - inbound calls route here
app.all('/dw/api/voice-jwt', async (req, res) => {
  try {
    if (!DWVOICE_KEY) return res.json({ error: 'Web calling not configured' });
    // The Client SDK can only log in as a user that exists on the app - create one per session.
    const user = 'dw-' + crypto.randomBytes(5).toString('hex');
    const r = await f(API_BASE + '/v1/users', { method: 'POST', headers: { Authorization: 'Bearer ' + dwAppJwt(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: user, display_name: 'Demo-World caller' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !(j.name || j.id)) return res.json({ error: 'Could not provision voice user (' + (j.title || j.detail || r.status) + ')' });
    dwLastWebUser = { user: j.name || user, at: Date.now() };
    res.json({ token: dwClientJwt(j.name || user), user: j.name || user, appId: DWVOICE_APP_ID, webLine: DW_WEB_LVN });
  } catch (e) { res.json({ error: e.message }); }
});
// Answer webhook: browser-originated calls bridge to the dialed phone; inbound PSTN calls
// to the web line ring the most recent browser client (two-way web calling).
app.all('/dw/voice/rtc-answer', (req, res) => {
  const q = Object.assign({}, req.query, req.body || {});
  const to = String(q.to || '').replace(/\D/g, '');
  const from = String(q.from || '').replace(/\D/g, '');
  if (to === DW_WEB_LVN) {
    const u = (dwLastWebUser && Date.now() - dwLastWebUser.at < 6 * 3600e3) ? dwLastWebUser.user : null;
    if (!u) return res.json([{ action: 'talk', text: 'No web agent is online right now. Open the Demo World web dialer, then call again.', voiceName: 'Amy', language: 'en-GB' }]);
    return res.json([
      { action: 'talk', text: 'Connecting you to the web agent.', voiceName: 'Amy', language: 'en-GB' },
      { action: 'connect', from: from.length >= 7 ? from : DW_WEB_LVN, ringbackTone: 'https://bigsoundbank.com/UPLOAD/mp3/1618.mp3', endpoint: [{ type: 'app', user: u }] },
    ]);
  }
  if (!to || to.length < 7) return res.json([{ action: 'talk', text: 'No valid destination number was provided. Goodbye.', voiceName: 'Amy', language: 'en-GB' }]);
  res.json([
    { action: 'talk', text: 'Connecting your call now.', voiceName: 'Amy', language: 'en-GB' },
    { action: 'connect', from: VOICE_NUMBER, endpoint: [{ type: 'phone', number: to }] },
  ]);
});
app.post('/dw/voice/rtc-event', (req, res) => res.sendStatus(200));

// --- Call from WhatsApp (WhatsApp Business Calling, Alpha) --------------------
// Per the WhatsApp Calling Alpha TSA guide: business-initiated calls only ALERT the user
// if they granted call permission. Step 1 sends a call_permission_request interactive
// message; step 2 places the call with from.type='phone' (the WABA number) + inline NCCO.
app.post('/dw/api/wa-call-permission', express.json(), async (req, res) => {
  try {
    const to = String(req.body.to || '').replace(/\D/g, '');
    if (to.length < 8) return res.json({ error: 'Enter a full number with country code, e.g. 447...' });
    const out = await vonageMessages({
      from: WA_NUMBER, to, channel: 'whatsapp', message_type: 'custom',
      custom: { type: 'interactive', interactive: {
        type: 'call_permission_request',
        body: { text: 'Vonage Demo-World would like to call you on WhatsApp to demo Business Calling. Do you allow calls from us?' },
        action: { name: 'call_permission_request' },
      } },
    });
    if (out.ok) return res.json({ ok: true, id: out.id });
    const hint = /24|window|re-engage|template|131047|1013/i.test(JSON.stringify(out.raw || out.error))
      ? 'Free-form permission requests need an open 24h window - have the customer message the WhatsApp line first, then send the request again.'
      : (/already|recently/i.test(String(out.error)) ? 'Permission may already be granted or was requested recently - try calling directly.' : null);
    res.json({ error: out.error || 'Could not send the permission request', hint });
  } catch (e) { res.json({ error: e.message }); }
});
app.post('/dw/api/wa-call', express.json(), async (req, res) => {
  try {
    const to = String(req.body.to || '').replace(/\D/g, '');
    if (to.length < 8) return res.json({ error: 'Enter a full number with country code, e.g. 447...' });
    const base = baseUrl(req);
    const payload = {
      ncco: [{ action: 'talk', text: 'Hi, this is a live WhatsApp voice call from the Vonage Demo World. This same flow lets your brand ring a customer right inside WhatsApp. Thanks for watching.', voiceName: 'Amy', language: 'en-GB' }],
      from: { type: 'phone', number: WA_NUMBER },
      to: [{ type: 'whatsapp', number: to }],
      event_url: [`${base}/dw/voice/rtc-event`],
    };
    const r = await f(API_BASE + '/v1/calls', { method: 'POST', headers: { Authorization: 'Bearer ' + vjwt(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && (j.uuid || j.call_uuid)) return res.json({ ok: true, uuid: j.uuid || j.call_uuid, status: j.status });
    const reason = (j.title || j.detail || (j[0] && j[0].error_text) || 'WhatsApp calling was rejected by Vonage.');
    res.json({ error: reason, needsEnable: /capab|not enabled|forbidden|whatsapp|permission/i.test(JSON.stringify(j)) });
  } catch (e) { res.json({ error: e.message }); }
});

// --- AI-scripted outbound call: Bedrock writes the script, the Voice API speaks it ---
app.post('/dw/api/ai-call', async (req, res) => {
  try {
    const to = String(req.body.to || '').replace(/\D/g, '');
    if (to.length < 8) return res.json({ error: 'Enter a valid number' });
    const brief = String(req.body.brief || '').trim().slice(0, 400);
    if (!brief) return res.json({ error: 'Describe the call first' });
    const j = await aiJSON(`You write short scripts for automated outbound phone calls, spoken by a friendly British voice named Amy. Brief from the agent: "${brief}".\nWrite exactly what the call should say: warm, natural spoken English, 40-70 words, no emojis, no placeholders like [name] - invent plausible specifics if the brief leaves gaps. End with a short goodbye. Return ONLY JSON: {"script":"the full spoken script"}`, 500);
    if (!j || !j.script) return res.json({ error: 'AI is busy - try again' });
    const script = String(j.script).replace(/\s+/g, ' ').slice(0, 850);
    const base = baseUrl(req);
    const payload = { to: [{ type: 'phone', number: to }], from: { type: 'phone', number: VOICE_NUMBER }, answer_url: [`${base}/dw/voice/answer?m=${encodeURIComponent(script)}`], answer_method: 'GET' };
    const r = await f(`${API_BASE}/v1/calls`, { method: 'POST', headers: { Authorization: `Bearer ${vjwt()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    res.json({ ok: r.ok, uuid: d.uuid, script, error: r.ok ? null : (d.title || d.detail || `HTTP ${r.status}`) });
  } catch (e) { res.json({ error: e.message }); }
});

// --- Instant conference bridge: call two numbers and join them in one conversation ---
app.all('/dw/voice/conf', (req, res) => res.json([
  { action: 'talk', text: 'Welcome to the Vonage conference bridge. Connecting you with the other participant now.', voiceName: 'Amy', language: 'en-GB' },
  { action: 'conversation', name: String(req.query.room || 'dwconf').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'dwconf' },
]));
app.post('/dw/api/bridge', async (req, res) => {
  try {
    const a = String(req.body.a || '').replace(/\D/g, ''), b = String(req.body.b || '').replace(/\D/g, '');
    if (a.length < 8 || b.length < 8) return res.json({ error: 'Enter both numbers in full international format' });
    if (a === b) return res.json({ error: 'Enter two different numbers' });
    const room = 'dwconf-' + crypto.randomBytes(4).toString('hex');
    const base = baseUrl(req);
    const place = async (num) => {
      const payload = { to: [{ type: 'phone', number: num }], from: { type: 'phone', number: VOICE_NUMBER }, answer_url: [`${base}/dw/voice/conf?room=${room}`], answer_method: 'GET', event_url: [`${base}/dw/voice/rtc-event`] };
      const r = await f(`${API_BASE}/v1/calls`, { method: 'POST', headers: { Authorization: `Bearer ${vjwt()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, uuid: d.uuid, err: d.title || d.detail };
    };
    const [ra, rb] = await Promise.all([place(a), place(b)]);
    if (!ra.ok || !rb.ok) return res.json({ error: ra.err || rb.err || 'Could not start both calls' });
    res.json({ ok: true, room, uuids: [ra.uuid, rb.uuid] });
  } catch (e) { res.json({ error: e.message }); }
});

// AI template drafting (Bedrock) for the Template Creator
app.post('/dw/api/ai-template', async (req, res) => {
  try {
    const channel = req.body.channel === 'rcs' ? 'rcs' : 'whatsapp';
    const brief = String(req.body.brief || '').slice(0, 600);
    const prompt = `You write ${channel === 'rcs' ? 'RCS Business Messaging' : 'WhatsApp Business'} marketing templates. Brief: "${brief}".\nReturn ONLY a JSON object: {"headline": "${channel === 'rcs' ? 'punchy title <=40 chars' : ''}", "body": "2-3 short lines, warm, at most one emoji", "buttons": [{"title":"<=20 chars","url":"https://example.com/..."}]}. Include 1-3 buttons with realistic URLs. No spammy words, no ALL CAPS. Keep it compliant and on-brand.`;
    const j = await aiJSON(prompt, 700);
    if (!j) return res.json({ error: 'AI is busy — try again' });
    res.json({ template: j });
  } catch (e) { res.json({ error: e.message }); }
});

// Template Creator — submit a WhatsApp template for Meta approval
app.post('/dw/api/wa-submit', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || ('dw_' + Date.now())).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    if (!name) return res.json({ error: 'Add a template name' });
    const components = [];
    if (b.headerImageUrl) components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [await waUploadHandle(b.headerImageUrl)] } });
    if (b.bodyText) components.push({ type: 'BODY', text: String(b.bodyText).slice(0, 1024) });
    const btns = (b.buttons || []).filter(x => x && x.title).slice(0, 3).map(bt => bt.url ? { type: 'URL', text: String(bt.title).slice(0, 25), url: bt.url } : { type: 'QUICK_REPLY', text: String(bt.title).slice(0, 25) });
    if (btns.length) components.push({ type: 'BUTTONS', buttons: btns });
    if (!components.length) return res.json({ error: 'Add body text or an image first' });
    const payload = { name, language: 'en', category: b.category || 'MARKETING', parameter_format: 'POSITIONAL', components };
    const r = await f(`${API_BASE}/v2/whatsapp-manager/wabas/${WA_WABA_ID}/templates`, { method: 'POST', headers: { Authorization: `Bearer ${vjwt()}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.json({ error: j.detail || j.title || 'Submission failed' });
    res.json({ ok: true, name, status: j.status || 'PENDING' });
  } catch (e) { res.json({ error: e.message }); }
});

// Template Creator — send a live RCS test card to a phone
app.post('/dw/api/rcs-test', async (req, res) => {
  try {
    const to = String(req.body.to || '').replace(/\D/g, ''); const b = req.body || {};
    if (to.length < 8) return res.json({ error: 'Enter a valid number' });
    const sugg = (b.buttons || []).filter(x => x && x.title).slice(0, 4).map(bt => bt.url ? { action: { text: String(bt.title).slice(0, 25), postbackData: 'b', openUrlAction: { url: bt.url, application: 'WEBVIEW', webviewViewMode: 'HALF' } } } : { reply: { text: String(bt.title).slice(0, 25), postbackData: 'b' } });
    const cardContent = { title: String(b.headline || '').slice(0, 60), description: String(b.bodyText || ' ').slice(0, 2000) };
    if (b.headerImageUrl) cardContent.media = { height: 'MEDIUM', contentInfo: { fileUrl: b.headerImageUrl, forceRefresh: false } };
    if (sugg.length) cardContent.suggestions = sugg;
    const payload = { from: RCS_SENDER, to, channel: 'rcs', message_type: 'custom', custom: { contentMessage: { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent } } } } };
    const out = await vonageMessages(payload);
    res.json({ ok: out.ok, id: out.id, error: out.error });
  } catch (e) { res.json({ error: e.message }); }
});

// --- RCS testers (Channel Manager test-agent id from the environment) ----------------------------
const RCS_AGENT_ID = env('RCS_TEST_AGENT_ID');
const cmAuth = () => 'Basic ' + Buffer.from(`${VONAGE_API_KEY}:${VONAGE_API_SECRET}`).toString('base64');
app.get('/dw/api/rcs/testers', async (req, res) => {
  try {
    const r = await f(`${API_BASE}/v1/channel-manager/rcs/agents/${RCS_AGENT_ID}`, { headers: { Authorization: cmAuth(), Accept: 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.json({ error: j.detail || j.title || 'Could not load testers', testers: [] });
    const b = j.basic_info || {};
    const testers = (j.test_devices || []).slice().sort((a, c) => String(c.created_at || '').localeCompare(String(a.created_at || '')));
    res.json({ agent: { id: j.id, state: j.state, sender: b.sender_id, name: b.display_name }, testers });
  } catch (e) { res.json({ error: e.message, testers: [] }); }
});
app.post('/dw/api/rcs/testers', express.json(), async (req, res) => {
  try {
    const digits = String(req.body.phone || '').replace(/\D/g, '');
    if (digits.length < 9) return res.json({ error: 'Enter a full number in international format.' });
    const r = await f(`${API_BASE}/v1/channel-manager/rcs/agents/${RCS_AGENT_ID}/test-devices`, { method: 'POST', headers: { Authorization: cmAuth(), 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ phone: '+' + digits }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.json({ error: j.detail || j.title || `Could not add tester (${r.status})` });
    res.json({ ok: true, tester: j });
  } catch (e) { res.json({ error: e.message }); }
});
app.post('/dw/api/rcs/testers/remove', express.json(), async (req, res) => {
  try {
    const id = String(req.body.id || '').replace(/[^a-zA-Z0-9-]/g, '');
    if (!id) return res.json({ error: 'Missing tester id' });
    const r = await f(`${API_BASE}/v1/channel-manager/rcs/agents/${RCS_AGENT_ID}/test-devices/${id}`, { method: 'DELETE', headers: { Authorization: cmAuth(), Accept: 'application/json' } });
    if (!r.ok && r.status !== 204) { const j = await r.json().catch(() => ({})); return res.json({ error: j.detail || j.title || `Could not remove tester (${r.status})` }); }
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});

// --- WhatsApp template library (live from the WABA) + direct sends -------------
app.get('/dw/api/wa/templates', async (req, res) => {
  try {
    const r = await f(`${API_BASE}/v2/whatsapp-manager/wabas/${WA_WABA_ID}/templates?limit=100`, { headers: { Authorization: `Bearer ${vjwt()}`, Accept: 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.json({ error: j.detail || j.title || 'Could not load templates', templates: [] });
    const raw = j.templates || j.message_templates || [];
    const out = raw.map(t => {
      const cm = t.components || [];
      const up = x => cm.find(c => String(c.type).toUpperCase() === x);
      const body = up('BODY'), header = up('HEADER'), btns = up('BUTTONS');
      const text = body ? (body.text || '') : '';
      let vars = 0; (text.match(/\{\{(\d+)\}\}/g) || []).forEach(m => { const v = parseInt(m.replace(/\D/g, ''), 10); if (v > vars) vars = v; });
      return { name: t.name, language: t.language || 'en', status: t.status || '', category: t.category || '', body: text, vars,
        header: header ? (header.format || 'TEXT') : '', buttons: btns ? (btns.buttons || []).map(x => ({ type: x.type, text: x.text })) : [] };
    });
    res.json({ templates: out });
  } catch (e) { res.json({ error: e.message, templates: [] }); }
});
app.post('/dw/api/wa/send-template', express.json(), async (req, res) => {
  try {
    const to = String(req.body.to || '').replace(/\D/g, '');
    if (to.length < 8) return res.json({ error: 'Enter a full number in international format.' });
    const name = String(req.body.name || '').trim();
    if (!name) return res.json({ error: 'Missing template name' });
    const params = Array.isArray(req.body.params) ? req.body.params.map(String) : [];
    const payload = { message_type: 'template', channel: 'whatsapp', to, from: WA_NUMBER,
      template: { name, ...(params.length ? { parameters: params } : {}) },
      whatsapp: { policy: 'deterministic', locale: String(req.body.locale || 'en').replace(/[^a-zA-Z_-]/g, '') || 'en' } };
    const s = await vonageMessages(payload);
    if (s.ok) return res.json({ ok: true, id: s.id });
    res.json({ error: s.error || 'Send failed' });
  } catch (e) { res.json({ error: e.message }); }
});

// --- RCS template library (saved account-side) + direct sends -------------------
function rcsCardPayload(to, t) {
  const sugg = (t.buttons || []).filter(x => x && x.title).slice(0, 4).map(bt => bt.url ? { action: { text: String(bt.title).slice(0, 25), postbackData: 'b', openUrlAction: { url: bt.url, application: 'WEBVIEW', webviewViewMode: 'HALF' } } } : { reply: { text: String(bt.title).slice(0, 25), postbackData: 'b' } });
  const cardContent = { title: String(t.title || '').slice(0, 60), description: String(t.body || ' ').slice(0, 2000) };
  if (t.image) cardContent.media = { height: 'MEDIUM', contentInfo: { fileUrl: t.image, forceRefresh: false } };
  if (sugg.length) cardContent.suggestions = sugg;
  return { from: RCS_SENDER, to, channel: 'rcs', message_type: 'custom', custom: { contentMessage: { richCard: { standaloneCard: { cardOrientation: 'VERTICAL', cardContent } } } } };
}
app.get('/dw/api/rcs/templates', async (req, res) => { res.json({ templates: await dget('dwRcsTemplates', []) }); });
app.post('/dw/api/rcs/templates', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const t = { id: 'rt_' + Date.now(), name: String(b.name || 'Untitled').slice(0, 60), title: String(b.title || '').slice(0, 200), body: String(b.body || '').slice(0, 2000), image: String(b.image || '').slice(0, 500),
      buttons: Array.isArray(b.buttons) ? b.buttons.slice(0, 4).map(x => ({ title: String(x.title || '').slice(0, 25), url: String(x.url || '').slice(0, 500) })) : [], created_at: new Date().toISOString() };
    if (!t.body && !t.title) return res.json({ error: 'A template needs at least a title or body' });
    const list = await dget('dwRcsTemplates', []); list.unshift(t); await dset('dwRcsTemplates', list.slice(0, 200));
    res.json({ ok: true, template: t });
  } catch (e) { res.json({ error: e.message }); }
});
app.post('/dw/api/rcs/templates/remove', express.json(), async (req, res) => {
  const id = String(req.body.id || ''); const list = await dget('dwRcsTemplates', []);
  await dset('dwRcsTemplates', list.filter(t => t.id !== id)); res.json({ ok: true });
});
app.post('/dw/api/rcs/send-template', express.json(), async (req, res) => {
  try {
    const to = String(req.body.to || '').replace(/\D/g, '');
    if (to.length < 8) return res.json({ error: 'Enter a full number in international format.' });
    const list = await dget('dwRcsTemplates', []);
    const t = list.find(x => x.id === String(req.body.id || ''));
    if (!t) return res.json({ error: 'Template not found' });
    const s = await vonageMessages(rcsCardPayload(to, t));
    if (s.ok) return res.json({ ok: true, id: s.id });
    res.json({ error: s.error || 'Send failed' });
  } catch (e) { res.json({ error: e.message }); }
});


app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/demoworld'));
app.listen(PORT, () => console.log('Vonage Demo-World listening on :' + PORT));

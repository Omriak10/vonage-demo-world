// ============================================================================
//  WhatsApp Opt-Out Manager  (path /optout)
//  - Manage WhatsApp senders (built-in account or an external Vonage account
//    via api key/secret or app id + private key), each with a business name,
//    configurable opt-out / opt-in keywords and confirmation messages.
//  - Inbound hook: when a customer texts the configured keyword, they are
//    added to (or removed from) that sender's suppression list and receive
//    the configured confirmation message.
//  - Vonage-compatible proxy: POST /optout/v1/messages accepts the EXACT
//    Vonage Messages API payload. Suppressed recipients are blocked with a
//    problem+json error; everything else is forwarded verbatim to
//    api.nexmo.com/v1/messages using the sender's own credentials, and the
//    Vonage response is passed straight back.
//  Storage: S3 (rcs-designer-storage) under the optout/ prefix.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const S3_BUCKET = 'rcs-designer-storage';
const PFX = 'optout/';
const s3 = new S3Client({ region: process.env.S3_REGION || 'eu-north-1' });

// Built-in Vonage account: from the environment (VONAGE_APP_ID, WA_NUMBER, private key).
const BUILTIN_APP_ID = process.env.VONAGE_APP_ID || '';
const BUILTIN_KEY = (() => { try { return fs.readFileSync(path.join(__dirname, process.env.VONAGE_PRIVATE_KEY_FILE || 'private.key'), 'utf8'); } catch (e) { return ''; } })();

const digits = (s) => String(s || '').replace(/\D/g, '');
const now = () => new Date().toISOString();

// ---------- storage (memory cache + S3) ----------
const mem = { config: null, suppress: null, events: null, at: 0 };
async function s3get(key, def) {
  try { const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: PFX + key + '.json' })); return JSON.parse(await r.Body.transformToString()); }
  catch (e) { return def; }
}
function s3set(key, val) {
  return s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: PFX + key + '.json', Body: JSON.stringify(val, null, 2), ContentType: 'application/json' }))
    .catch((e) => console.error('[OPTOUT] s3 save', key, e.message));
}
async function getConfig() {
  if (!mem.config) {
    mem.config = await s3get('config', { senders: [] });
    if (!mem.config.senders.length) {
      // Seed with the user's own WhatsApp so the demo works out of the box.
      mem.config.senders.push({
        id: 'snd_default', name: 'My WhatsApp (Vonage demo)', number: (process.env.WA_NUMBER || ''),
        wabaId: (process.env.WA_WABA_ID || ''), auth: { type: 'builtin' },
        optOutWords: ['STOP'], optInWords: ['START'],
        optOutMessage: "You've been unsubscribed and will no longer receive messages from us. Reply START to opt back in.",
        optInMessage: "Welcome back! You've opted back in and will receive messages again. Reply STOP to opt out.",
        active: true, createdAt: now(),
      });
      await s3set('config', mem.config);
    }
  }
  return mem.config;
}
async function getSuppress() { if (!mem.suppress) mem.suppress = await s3get('suppress', {}); return mem.suppress; }
async function getEvents() { if (!mem.events) mem.events = await s3get('events', []); return mem.events; }

// ---------- analytics: daily counters per sender (90-day retention) ----------
const dayOf = (t) => String(t || now()).slice(0, 10);
async function getStats() {
  if (!mem.stats) {
    mem.stats = await s3get('stats', null);
    if (!mem.stats) {
      // First run: backfill from whatever events we still have, so the
      // analytics don't start empty on an already-used instance.
      mem.stats = {};
      try {
        const cfg = await getConfig(); const evs = await getEvents();
        for (const e of evs) {
          const snd = cfg.senders.find((s) => digits(s.number) === digits(e.senderNumber));
          if (!snd || !e.kind) continue;
          const d = dayOf(e.at); mem.stats[d] = mem.stats[d] || {}; mem.stats[d][snd.id] = mem.stats[d][snd.id] || {};
          mem.stats[d][snd.id][e.kind] = (mem.stats[d][snd.id][e.kind] || 0) + 1;
        }
      } catch (e) {}
      s3set('stats', mem.stats);
    }
  }
  return mem.stats;
}
async function bumpStat(senderId, kind) {
  const st = await getStats();
  const d = dayOf();
  st[d] = st[d] || {}; st[d][senderId] = st[d][senderId] || {};
  st[d][senderId][kind] = (st[d][senderId][kind] || 0) + 1;
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  for (const k of Object.keys(st)) if (k < cutoff) delete st[k];
  s3set('stats', st);
}

async function logEvent(ev) {
  const list = await getEvents();
  list.unshift({ at: now(), ...ev });
  if (list.length > 200) list.length = 200;
  s3set('events', list);
  if (ev.senderId && ['optout', 'optin', 'blocked', 'sent', 'send_failed'].includes(ev.kind)) {
    bumpStat(ev.senderId, ev.kind).catch(() => {});
  }
}

// ---------- Vonage send with per-sender credentials ----------
function normalizeKey(k) {
  let s = String(k || '').trim();
  if (s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  return s;
}
function authHeader(snd) {
  const a = snd.auth || { type: 'builtin' };
  if (a.type === 'basic') return 'Basic ' + Buffer.from(a.apiKey + ':' + a.apiSecret).toString('base64');
  const appId = a.type === 'jwt' ? a.appId : BUILTIN_APP_ID;
  const key = a.type === 'jwt' ? normalizeKey(a.privateKey) : BUILTIN_KEY;
  const t = Math.floor(Date.now() / 1000);
  return 'Bearer ' + jwt.sign({ application_id: appId, iat: t, exp: t + 900, jti: crypto.randomUUID() }, key, { algorithm: 'RS256' });
}
async function vonageSend(snd, payload) {
  const r = await fetch('https://api.nexmo.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authHeader(snd) },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  return { status: r.status, data };
}
const problem = (title, detail, status) => ({
  type: 'https://developer.vonage.com/api-errors', title, detail, instance: crypto.randomUUID(), ...(status ? { status } : {}),
});

// ---------- core proxy logic (shared by the API proxy and the UI send) ----------
async function proxySend(body) {
  const b = body || {};
  if (!b.to || !b.from || !b.channel || !b.message_type) {
    return { status: 422, data: problem('Missing parameter', 'The request body must be a Vonage Messages API payload with at least: from, to, channel, message_type.') };
  }
  const cfg = await getConfig();
  const snd = cfg.senders.find((s) => digits(s.number) === digits(b.from) && s.active !== false);
  if (!snd) {
    return { status: 422, data: problem('Unknown sender', `The "from" number ${b.from} is not registered in the Opt-Out Manager. Add it on the /optout console first.`) };
  }
  const sup = await getSuppress();
  const entry = (sup[snd.id] || {})[digits(b.to)];
  if (entry) {
    logEvent({ kind: 'blocked', senderId: snd.id, sender: snd.name, senderNumber: snd.number, number: digits(b.to), detail: `Blocked by opt-out (keyword "${entry.word}" on ${entry.at})` });
    return { status: 403, data: {
      type: 'https://developer.vonage.com/api-errors#recipient-opted-out',
      title: 'Recipient has opted out',
      detail: `${b.to} opted out of messages from ${snd.name} (${snd.number}) on ${entry.at} via keyword "${entry.word}". The message was blocked by the opt-out proxy and NOT sent.`,
      instance: crypto.randomUUID(),
    } };
  }
  try {
    const r = await vonageSend(snd, b);
    logEvent({ kind: r.status < 300 ? 'sent' : 'send_failed', senderId: snd.id, sender: snd.name, senderNumber: snd.number, number: digits(b.to), detail: r.status < 300 ? `${b.channel} ${b.message_type} delivered to Vonage (${r.data.message_uuid || r.status})` : `Vonage rejected: ${r.status} ${JSON.stringify(r.data).slice(0, 140)}` });
    return r;
  } catch (e) {
    return { status: 502, data: problem('Upstream error', 'Could not reach the Vonage Messages API: ' + e.message) };
  }
}

// ---------- inbound hook (called from the main webhook handler) ----------
// Returns true when the message was an opt-out/opt-in keyword for a configured
// sender (fully handled here - the caller should stop further processing).
async function inboundHook(body) {
  try {
    if (!body || String(body.channel || '').toLowerCase() !== 'whatsapp') return false;
    const to = digits(body.to), from = digits(body.from);
    const text = String(body.text || '').trim();
    if (!to || !from || !text) return false;
    const cfg = await getConfig();
    const snd = cfg.senders.find((s) => digits(s.number) === to && s.active !== false);
    if (!snd) return false;
    const up = text.toUpperCase();
    const isOut = (snd.optOutWords || []).some((w) => String(w).trim().toUpperCase() === up);
    const isIn = !isOut && (snd.optInWords || []).some((w) => String(w).trim().toUpperCase() === up);
    if (!isOut && !isIn) return false;

    const sup = await getSuppress();
    sup[snd.id] = sup[snd.id] || {};
    if (isOut) {
      sup[snd.id][from] = { at: now(), word: text };
      await s3set('suppress', sup);
      logEvent({ kind: 'optout', senderId: snd.id, sender: snd.name, senderNumber: snd.number, number: from, detail: `Customer sent "${text}" - added to suppression list` });
      // Confirmation is part of the opt-out flow (compliance) - it bypasses suppression.
      if (snd.optOutMessage) {
        vonageSend(snd, { from: snd.number, to: from, channel: 'whatsapp', message_type: 'text', text: snd.optOutMessage })
          .catch((e) => console.error('[OPTOUT] confirm send', e.message));
      }
    } else {
      delete sup[snd.id][from];
      await s3set('suppress', sup);
      logEvent({ kind: 'optin', senderId: snd.id, sender: snd.name, senderNumber: snd.number, number: from, detail: `Customer sent "${text}" - removed from suppression list` });
      if (snd.optInMessage) {
        vonageSend(snd, { from: snd.number, to: from, channel: 'whatsapp', message_type: 'text', text: snd.optInMessage })
          .catch((e) => console.error('[OPTOUT] optin send', e.message));
      }
    }
    return true;
  } catch (e) { console.error('[OPTOUT] inboundHook', e.message); return false; }
}

// ---------- routes ----------
function attach(app) {
  // Console UI
  app.get('/optout', (req, res) => res.sendFile(path.join(__dirname, 'public', 'optout.html')));

  // ---- Vonage-compatible proxy: only the base URL differs from Vonage's ----
  app.post('/optout/v1/messages', async (req, res) => {
    const r = await proxySend(req.body);
    res.status(r.status).json(r.data);
  });

  // ---- console API ----
  app.get('/optout/api/state', async (req, res) => {
    const cfg = await getConfig();
    const sup = await getSuppress();
    const events = await getEvents();
    // Pin the public CloudFront host (CloudFront forwards with the EB origin Host).
    const PUB = process.env.OPTOUT_PUBLIC_BASE || '';
    res.json({
      ok: true,
      proxyBase: `${PUB}/optout`,
      inboundWebhook: `${PUB}/webhooks/inbound`,
      senders: cfg.senders.map((s) => ({
        ...s,
        auth: s.auth && s.auth.type === 'basic' ? { type: 'basic', apiKey: s.auth.apiKey }
          : s.auth && s.auth.type === 'jwt' ? { type: 'jwt', appId: s.auth.appId }
          : { type: 'builtin' },
        suppressed: Object.entries(sup[s.id] || {}).map(([number, e]) => ({ number, ...e })),
      })),
      events: events.slice(0, 60),
    });
  });

  // Opt-out / opt-in analytics: daily series + per-sender totals for a window.
  app.get('/optout/api/stats', async (req, res) => {
    const daysN = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 14));
    const senderFilter = req.query.sender && req.query.sender !== 'all' ? req.query.sender : null;
    const st = await getStats();
    const cfg = await getConfig();
    const sup = await getSuppress();
    const days = [];
    for (let i = daysN - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const agg = { date: d, optout: 0, optin: 0, blocked: 0, sent: 0, send_failed: 0 };
      for (const [sid, c] of Object.entries(st[d] || {})) {
        if (senderFilter && sid !== senderFilter) continue;
        for (const k in agg) if (k !== 'date') agg[k] += c[k] || 0;
      }
      days.push(agg);
    }
    const total = (k) => days.reduce((a, b) => a + b[k], 0);
    const inWindow = new Set(days.map((d) => d.date));
    const perSender = cfg.senders.map((s) => {
      const t = { optout: 0, optin: 0, blocked: 0, sent: 0 };
      for (const d of Object.keys(st)) {
        if (!inWindow.has(d)) continue;
        const c = (st[d] || {})[s.id]; if (!c) continue;
        for (const k in t) t[k] += c[k] || 0;
      }
      return { id: s.id, name: s.name, number: s.number, suppressedNow: Object.keys(sup[s.id] || {}).length, ...t };
    });
    const suppressedNow = senderFilter
      ? Object.keys(sup[senderFilter] || {}).length
      : Object.values(sup).reduce((a, m) => a + Object.keys(m).length, 0);
    res.json({ ok: true, windowDays: daysN, days, perSender, suppressedNow,
      totals: { optout: total('optout'), optin: total('optin'), blocked: total('blocked'), sent: total('sent') } });
  });

  app.post('/optout/api/senders', async (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.number) return res.status(400).json({ error: 'name and number are required' });
    const cfg = await getConfig();
    const words = (v, def) => Array.isArray(v) ? v.filter(Boolean) : String(v || def).split(',').map((x) => x.trim()).filter(Boolean);
    let snd = b.id && cfg.senders.find((s) => s.id === b.id);
    if (!snd) { snd = { id: 'snd_' + crypto.randomUUID().slice(0, 8), createdAt: now() }; cfg.senders.push(snd); }
    Object.assign(snd, {
      name: String(b.name).trim(), number: digits(b.number), wabaId: String(b.wabaId || '').trim(),
      optOutWords: words(b.optOutWords, 'STOP'), optInWords: words(b.optInWords, 'START'),
      optOutMessage: String(b.optOutMessage || '').trim(), optInMessage: String(b.optInMessage || '').trim(),
      active: b.active !== false,
    });
    // Auth: only replace when new credentials are provided (secrets never round-trip).
    if (b.authType === 'basic' && b.apiKey && b.apiSecret) snd.auth = { type: 'basic', apiKey: String(b.apiKey).trim(), apiSecret: String(b.apiSecret).trim() };
    else if (b.authType === 'jwt' && b.appId && b.privateKey) snd.auth = { type: 'jwt', appId: String(b.appId).trim(), privateKey: normalizeKey(b.privateKey) };
    else if (b.authType === 'builtin') snd.auth = { type: 'builtin' };
    else if (!snd.auth) snd.auth = { type: 'builtin' };
    await s3set('config', cfg);
    res.json({ ok: true, id: snd.id });
  });

  app.delete('/optout/api/senders/:id', async (req, res) => {
    const cfg = await getConfig();
    const i = cfg.senders.findIndex((s) => s.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'not found' });
    cfg.senders.splice(i, 1);
    await s3set('config', cfg);
    const sup = await getSuppress(); delete sup[req.params.id]; await s3set('suppress', sup);
    res.json({ ok: true });
  });

  // Manual suppression management
  app.post('/optout/api/suppress', async (req, res) => {
    const { senderId, number, remove } = req.body || {};
    const cfg = await getConfig();
    const snd = cfg.senders.find((s) => s.id === senderId);
    if (!snd || !digits(number)) return res.status(400).json({ error: 'senderId and number required' });
    const sup = await getSuppress(); sup[snd.id] = sup[snd.id] || {};
    if (remove) { delete sup[snd.id][digits(number)]; logEvent({ kind: 'optin', senderId: snd.id, sender: snd.name, senderNumber: snd.number, number: digits(number), detail: 'Removed from suppression manually (console)' }); }
    else { sup[snd.id][digits(number)] = { at: now(), word: 'manual (console)' }; logEvent({ kind: 'optout', senderId: snd.id, sender: snd.name, senderNumber: snd.number, number: digits(number), detail: 'Added to suppression manually (console)' }); }
    await s3set('suppress', sup);
    res.json({ ok: true });
  });

  // UI demo send - goes through the exact same proxy pipeline.
  app.post('/optout/api/send', async (req, res) => {
    const { senderId, to, text } = req.body || {};
    const cfg = await getConfig();
    const snd = cfg.senders.find((s) => s.id === senderId);
    if (!snd) return res.status(400).json({ error: 'unknown sender' });
    const payload = { from: snd.number, to: digits(to), channel: 'whatsapp', message_type: 'text', text: String(text || '').trim() || 'Hello from the Vonage opt-out demo!' };
    const r = await proxySend(payload);
    res.status(200).json({ proxyStatus: r.status, response: r.data, payload });
  });

  console.log('[OPTOUT] WhatsApp opt-out manager attached at /optout (proxy: POST /optout/v1/messages)');
}

module.exports = { attach, inboundHook };

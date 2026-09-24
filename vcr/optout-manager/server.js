// WhatsApp Opt-Out Manager - standalone VCR service.
// Moved from the Demo-World AWS box (2026-07-23): same module, same S3 state
// (bucket rcs-designer-storage, prefix optout/), so all senders, keywords,
// suppression lists and analytics carried over unchanged.
//
// Endpoints (same paths as before, new host):
//   GET  /optout                    - console UI
//   GET  /optout/api/*              - config/events/stats APIs (from optout.js)
//   POST /optout/v1/messages        - the Vonage-compatible proxy (Postman target)
//   POST /webhooks/inbound          - inbound keyword hook; Demo-World forwards each
//                                     inbound here and honours {handled:true}
//   GET  /_/health                  - health check
const express = require('express');
const path = require('path');
const optout = require('./optout');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.NERU_APP_PORT || process.env.PORT || 3000;

app.get('/_/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.redirect('/optout'));
app.get('/optout', (req, res) => res.sendFile(path.join(__dirname, 'public', 'optout.html')));

// Inbound keyword hook - Demo-World (which owns the Vonage inbound webhook) forwards
// every inbound here; we reply {handled} so Demo-World can stop bots on STOP/START.
app.post('/webhooks/inbound', async (req, res) => {
  try {
    const handled = await optout.inboundHook(req.body || {});
    res.json({ ok: true, handled: !!handled });
  } catch (e) { res.json({ ok: false, handled: false, error: e.message }); }
});

optout.attach(app);

app.listen(PORT, () => console.log('Opt-Out Manager (VCR) listening on :' + PORT));

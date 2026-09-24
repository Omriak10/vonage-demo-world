# Vonage Demo-World

> Personal open-source project by a Vonage solutions architect, published under the MIT licence. It is not an official Vonage product and is not supported by Vonage. Product names of the demo scenarios belong to their owners; no brand artwork or product data is distributed with the code.

Demo-World is an internal live-demo platform: a Vonage employee signs in, picks a customer scenario and runs a real Vonage API against their own phone in seconds. Messaging (RCS, WhatsApp, SMS, Viber), Verify v2, Voice, Video and Number Insight demos call the production Vonage platform; the Network API and Identity tiles are client-side simulators.

The architecture summary (diagram, languages, design system, webhooks, security, deployment) is in `docs/Vonage-Demo-World-Architecture.pdf`.

## Repository layout

```
server.js            Express application: auth, /dw/api/* demo actions, /webhooks/* Vonage callbacks, /dw/voice/* NCCO
peak.js              Peak Season event demo module (RCS + WhatsApp conversational flow, games, AI branded demo)
wayfair.js           Wayfair deals demo: RCS bot + mini storefront + abandoned-basket win-back (mounted at /wf)
public/              The single-page catalogue (demoworld.html), login/admin pages, Template Creator, video room,
                     web dialer, video maker, and the webviews opened from RCS cards (peak-*.html, epark*.html)
vcr/avon-skin        Vonage Cloud Runtime instance: RCS selfie -> AI skin analysis -> product carousel
vcr/optout-manager   Vonage Cloud Runtime instance: WhatsApp opt-out keywords, suppression list, Messages-compatible proxy
vcr/media-host       Vonage Cloud Runtime instance: static host for demo videos referenced by the Viber demos
docs/                Architecture summary PDF
```

## Running locally

```
npm install
cp .env.example .env      # fill in your Vonage account, applications, senders, bucket and mail settings
node server.js            # http://localhost:8081/demoworld
```

Keys are read from files named in `.env` (`private.key`, `video.key`, `dwvoice.key`) or from the matching `*_PRIVATE_KEY` variables. AWS credentials come from the default credential chain (instance role, profile or `AWS_*` variables). The `.gitignore` excludes `.env`, every `*.key` and `vcr.yml`.

Point the Vonage applications at the running instance:

| Application | Webhook | URL |
|---|---|---|
| Messaging | Inbound | `PUBLIC_BASE/webhooks/inbound` |
| Messaging | Status | `PUBLIC_BASE/webhooks/status` |
| Voice | Answer | `PUBLIC_BASE/dw/voice/answer` (per-demo answer URLs are passed on each call) |
| Voice | Event | `PUBLIC_BASE/dw/voice/rtc-event` |
| Client SDK | Answer / Event | `PUBLIC_BASE/dw/voice/rtc-answer`, `PUBLIC_BASE/dw/voice/rtc-event` |

## How a demo runs

1. The employee registers with a company email, verifies it by mail and signs in (session cookie, 14 days).
2. The catalogue is a JavaScript array in `public/demoworld.html`; every tile declares its run mode (`receive`, `converse`, `verify`, `call`, `webcall`, `wacall`, `video`, `aicall`, `bridge`, `riskflow`, `insight`, `mock`, `tool`, `install`).
3. A "send to my phone" tile posts to `/dw/api/send`, which validates the number and the demo id, builds the message and calls the Messages API with an application JWT.
4. Replies and button taps arrive on `/webhooks/inbound`, are de-duplicated and logged, then routed through an ordered chain of handlers (opt-out keywords, demo modules, conversational agents). The first handler that claims a message stops the chain.
5. Delivery receipts arrive on `/webhooks/status` and update the stored message.

## Satellite instances

Each folder under `vcr/` is an independent Vonage Cloud Runtime project with its own `vcr.example.yml`. Copy it to `vcr.yml`, set the application id and environment values, then deploy with `vcr deploy`. Set the resulting URLs in the main app's `.env` (`AVON_SKIN_URL`, `OPTOUT_URL`, `ASSET_BASE` for the media host).

## Security controls

- HTTPS is expected at the edge; HSTS, CSP, X-Frame-Options, Referrer-Policy and X-Content-Type-Options headers are set on every response.
- Registration is limited to the configured email domain and gated by mailbox verification; passwords are hashed with scrypt and a per-user random salt, minimum 10 characters.
- Sessions are signed HttpOnly, SameSite cookies. Every `/dw/api/*` call needs a verified session except the auth endpoints; the admin console is bound to the owner account.
- Login throttling: 10 auth attempts per minute per address, and a 15-minute account pause after 8 failed sign-ins.
- Demo actions are rate limited per address and per user (per minute and per day, see `DW_RATE_*`) and every action is written to the audit log with the user, path, demo and a masked destination.
- Inbound Vonage webhooks are verified when `VONAGE_SIGNATURE_SECRET` is set (signed JWT in the Authorization header, payload hash check, five-minute freshness); unsigned or stale payloads are rejected.
- Reset and verification tokens are random, single use and time-boxed. No customer data is stored; multi-step demo state expires.

## State

All durable state is JSON in S3 under `DATA_PREFIX` (users, agents, message logs, conversations, per-demo documents), read through a small in-memory cache. Public assets (generated images, videos, PDFs, shop pages) live under `ASSET_BASE`. No database is required, and the process is stateless apart from short-lived caches, so it can be redeployed or replaced at any time.

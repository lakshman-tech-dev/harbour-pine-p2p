# Harbour & Pine — Supplier Invoice Exception Resolution

A lightweight Procure to Pay workbench for UK supplier invoice exceptions. The app uses Express and SQLite on the server, with a single React/Tailwind page delivered from `public/index.html`.

## Requirements

- Node.js 22 or newer
- npm

## Run locally

```sh
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). SQLite creates and seeds `data/harbour-pine.sqlite` on first startup.

To enable the server-side Gemini summary, create a key in [Google AI Studio](https://aistudio.google.com/apikey), copy `.env.example` to `.env`, and set `GEMINI_API_KEY`. The app uses Google's `gemini-flash-lite-latest` model. Gemini API offers limited free-tier access for eligible models and accounts; usage limits and availability can change. If the key is missing or the free quota is unavailable, the app returns a safe rule-based summary. The key is only read by the server and is never sent to the browser.

Do not send real supplier invoices or confidential business data to a free-tier AI service unless Harbour & Pine has approved that data processing. The free-tier provider's data-use terms may differ from its paid tier.

## Deploy a free demo to Render

This repository includes a Render Blueprint in `render.yaml`.

1. Sign in to [Render](https://render.com/) and choose **New** > **Blueprint**.
2. Connect `lakshman-tech-dev/harbour-pine-p2p` and deploy the `master` branch.
3. When prompted for `GEMINI_API_KEY`, enter the key from Google AI Studio, or leave it empty to use fallback summaries.
4. Wait for the deployment to pass its `/api/kpis` health check. Render will provide a public `onrender.com` URL.

The free web service may sleep while idle, so its first request after inactivity can take longer. Its filesystem is ephemeral: SQLite demo data can reset after a restart or redeploy. The app has no sign-in, and anyone with the public URL can use the demo workflow. Do not put real invoice data or confidential information in this deployment.

## Included

- Ten representative UK invoice exceptions, including every requested exception type and example workflow states.
- Dynamic risk scoring and five-calendar-day SLA evaluation on each API read.
- Worklist filters, AP Clerk / AP Manager views, KPIs, detail timeline, AI summary, resolution actions, and newest-first audit history.
- Server-side comment, document ID, amount, status transition, and escalation-role validation.

## API

- `GET /api/exceptions?status=&type=&risk_band=&search=`
- `GET /api/exceptions/:id`
- `PATCH /api/exceptions/:id`
- `GET /api/kpis`
- `POST /api/summarise` with `{ "exceptionId": 1 }`

The PATCH body accepts `status`, `action`, `owner`, `comment`, `attachment`, and `performed_by`. Each accepted action creates a `resolution_log` entry in the same transaction as any exception update.

## Notes

The AP role selector is a prototype workflow control, not an authentication mechanism. Production use should connect it to Harbour & Pine identity and authorization services. SAP transaction buttons are intentionally disabled; no SAP data or transaction is modified.

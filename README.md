# Digits Trading App

A self-hosted digit trading app built on the Deriv WebSocket API. Supports Matches/Differs, Over/Under, and Even/Odd contract types with real-time tick streaming and digit frequency statistics.

## Prerequisites

- Node.js 18.18 or later

## Step 1: Register Your App ID

1. Log in to your Deriv account and go to the [API Token page](https://app.deriv.com/account/api-token) to create a token with the required scopes.
2. Navigate to [App Registration](https://developers.deriv.com/dashboard/) and register a new application.
3. Set the **Redirect URI** to the URL where you will host this app (e.g. `http://localhost:3000` for local development).
4. Copy the **App ID** shown after registration — you will need it in the next step.

## Step 2: Configure `.env.production`

Copy `.env.example` to `.env.production` and fill in your values:

```bash
cp .env.example .env.production
```

Edit `.env.production`:

```env
NEXT_PUBLIC_DERIV_APP_ID=your_app_id_here
NEXT_PUBLIC_DERIV_REDIRECT_URI=https://your-registered-redirect-uri.com
NEXT_PUBLIC_DERIV_APP_NAME=your_app_name_here
NEXT_PUBLIC_DERIV_SHOW_APP_NAME=true
NEXT_PUBLIC_DERIV_REFERRAL_LINK=your_referral_link_here
NEXT_PUBLIC_DERIV_OAUTH_SCOPES=trade,account_manage
NEXT_PUBLIC_DERIV_ENV=production
```

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_DERIV_APP_ID` | Your Deriv app ID from the App Registration dashboard |
| `NEXT_PUBLIC_DERIV_REDIRECT_URI` | OAuth redirect URI — must exactly match the URI registered in your Deriv app |
| `NEXT_PUBLIC_DERIV_APP_NAME` | In-app display name (header, tab title, favicon). Set in App Builder Customise. OAuth/consent registration name is configured separately and is not this env var. |
| `NEXT_PUBLIC_DERIV_SHOW_APP_NAME` | `true` (default) shows the name next to the logo on desktop; `false` hides it (logo only). Tab title / favicon still use `NEXT_PUBLIC_DERIV_APP_NAME`. |
| `NEXT_PUBLIC_DERIV_REFERRAL_LINK` | Affiliate referral link shown to unauthenticated users (optional) |
| `NEXT_PUBLIC_DERIV_OAUTH_SCOPES` | Comma-separated OAuth scopes (e.g. `trade,account_manage`) |
| `NEXT_PUBLIC_DERIV_ENV` | `production` to connect to the live Deriv endpoint; `preview` for staging |

For local development, copy `.env.production` to `.env.local` — Next.js will load `.env.local` automatically and it takes precedence over `.env.production`.

## Step 3: Local Development

```bash
npm install
npm run dev
```

The app is available at `http://localhost:3000`.

## Step 4: Build for Production

```bash
npm run build   # produces an optimized build in /.next
npm start       # serves it on http://localhost:3000
```

`next.config.js` does not set `output: 'export'`, so this is a normal Next.js
server build, not a static export. To host it as static files instead, add
`output: 'export'` to `next.config.js` (the build then writes `/out`) and check
that every page still builds.

## Notes

- Authenticated WebSocket URLs (OTPs) are single-use. The socket asks for a
  fresh one on every automatic reconnect (`getFreshWsUrl` in `hooks/use-auth.ts`).
- The bots (Martingale, Ra/Minerva, Differ) run in the browser tab. Closing the
  tab stops them, and their P/L and loss-streak state is not persisted. If a bot
  stops with "no response", check Reports for any contract it may have opened.

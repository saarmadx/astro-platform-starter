# Leonida 100%

An unofficial, members-only completion tracker and companion. Built with Astro + TypeScript and deployed to Netlify. Access is gated with "Sign in with Whop".

> Unofficial fan-made tool. Not affiliated with, endorsed by or sponsored by Rockstar Games or Take-Two Interactive.

## What's where

| Path | What it is |
|---|---|
| `src/content/*.json` | **All game content.** `regions.json`, `checklist.json` (categories + items), `money.json`, `guides.json` (Markdown bodies). |
| `src/pages/index.astro` | Public landing page with the "Get access" button. |
| `src/pages/app/` | The member app (Progress, Checklist, Money, Guide, Settings tabs) and guide articles. |
| `src/pages/admin/` | Password-protected content editor. |
| `src/pages/auth/` | Whop OAuth login, callback and logout. |
| `src/pages/api/` | Progress sync API and admin content API. |
| `src/lib/whop.ts` | Whop OAuth and membership check. |
| `src/middleware.ts` | Blocks `/app` and `/api/progress` for anyone who isn't a signed-in member. |

## How content works

- The JSON files in `src/content` are the defaults that ship with each deploy.
- Saving in `/admin` stores the content in Netlify Blobs and goes live immediately. No redeploy is needed. Admin edits take priority over the JSON files.
- **Admin → Backup & files** downloads the current content as the four JSON files. Commit them to the repo to make the edits permanent defaults.
- **Admin → Backup & files → Use the JSON files again** discards the admin edits.
- Item IDs are permanent because members' progress is stored by ID. Renaming an item is safe; deleting it removes it from everyone's checklist.
- A category with no items shows *"Coming soon – being mapped, added in an update."*

## How progress is saved

- Each member's progress is stored in Netlify Blobs (`leonida-progress` store), keyed by their Whop user ID, so it syncs across devices.
- It's also cached in `localStorage`, and a service worker caches the app, so it keeps working offline and syncs when the connection comes back.
- If two devices disagree, the most recently changed copy wins.

## Environment variables

| Name | Required | What it is |
|---|---|---|
| `WHOP_CLIENT_ID` | yes | Your Whop app's client ID (`app_…`). |
| `WHOP_CLIENT_SECRET` | yes | Your Whop app's client secret. |
| `WHOP_PRODUCT_ID` | yes | The product members must own (`prod_…`). |
| `WHOP_STORE_URL` | yes | Your public Whop store page. The "Get access" button links here. |
| `SESSION_SECRET` | yes | A long random string used to sign login cookies. Generate one with `openssl rand -hex 32`. |
| `ADMIN_PASSWORD` | yes | Password for `/admin`. |
| `WHOP_API_KEY` | recommended | A Whop API key that can check member access. With it, logins last 30 days and membership is re-checked every 6 hours. Without it, members sign in again every day. |
| `WHOP_OAUTH_AUTHORIZE_URL`, `WHOP_OAUTH_TOKEN_URL`, `WHOP_OAUTH_USERINFO_URL`, `WHOP_OAUTH_SCOPES`, `WHOP_API_BASE` | no | Overrides for Whop's endpoints, if Whop changes them. The defaults are in `src/lib/whop.ts`. |

See `.env.example`.

## Local development

```bash
npm install
cp .env.example .env    # fill in values
npm run dev             # http://localhost:4321
```

To try the member app locally without Whop, add `DEV_FAKE_USER=user_dev` to `.env`. This only works in `npm run dev` and is ignored in production builds. In plain `astro dev`, Netlify Blobs isn't available, so progress and admin edits are kept in memory until you restart. Use `netlify dev` to get real Blobs locally.

`npm run check` type-checks the project. `npm run build` builds it.

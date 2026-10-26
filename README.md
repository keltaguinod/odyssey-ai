# Odyssey AI

Odyssey is a private, Gmail-connected AI workspace. A user signs in with their own Google account, lands directly on the dashboard, asks natural-language questions about Gmail, sees real Google storage usage, and drafts or sends messages through Gmail after explicit confirmation.

Production deployment: `https://odyssey-ai-livid.vercel.app`

The deployment is live, but Google sign-in remains intentionally disabled until the production environment variables and a **Web application** OAuth client are added. If Vercel Deployment Protection is enabled on the account, public visitors will also need that project setting changed by the account owner.

## Included

- Per-user Google OAuth 2.0 for identity, Gmail, and Google storage
- Encrypted, HTTP-only credential cookie; no shared `token.json`
- Gmail search and AI summaries grounded in matching messages
- Prompt-injection boundary: email content is treated as untrusted data
- Gmail compose, save-draft, and confirmed-send flows
- Real account storage from the Google Drive `about.storageQuota` API
- Responsive ChatGPT-style dashboard with local conversation history
- Installable PWA for Android and iOS home screens
- Flask/Vercel deployment layout and security headers

## Important security cleanup

The original prototype contained a Gemini/Google API key in `app.py` and reusable Google tokens in `token.json`. Do not commit or deploy those files. Revoke and replace the exposed API key in Google Cloud, revoke the old account grant if the token was shared, and use only environment variables with this version.

## 1. Google Cloud setup

1. Create or select a Google Cloud project.
2. Enable **Gmail API** and **Google Drive API**.
3. Configure the OAuth consent screen. Add your own Gmail address as a test user while the app is in testing.
4. Create an OAuth client with application type **Web application**. The prototype's existing `credentials.json` is an installed/desktop client and cannot be reused for a production website.
5. Add these authorized redirect URIs:
   - Local: `http://localhost:5000/auth/callback`
   - Production: `https://odyssey-ai-livid.vercel.app/auth/callback`
6. Expect Google verification before offering the Gmail scopes broadly to users outside your test list.

If Google shows `Error 401: invalid_client` or “The OAuth client was not found,” the
value deployed as `GOOGLE_CLIENT_ID` is a placeholder, was deleted, or belongs to a
different Google Cloud project. Create a fresh **Web application** client, copy its
client ID and secret into the local/Vercel environment variables, and redeploy. Do
not reuse credentials that were ever committed to source control.

Odyssey requests `gmail.readonly`, `gmail.compose`, `gmail.modify`, and `drive.metadata.readonly`, plus standard OpenID profile scopes. Add `gmail.modify` to the OAuth consent screen's scopes. It does not request full mail access (`https://mail.google.com/`), so it can move messages to Trash but never permanently delete them.

## Mail actions from chat

Ask Odyssey to trash, restore, star, unstar, snooze, or unsnooze messages ("delete the Medium newsletters", "star the first one", "snooze those until tomorrow"). Odyssey shows the matching messages in a confirmation card; nothing changes until you confirm, and each action can be undone from the card.

Gmail has no snooze API, so Odyssey archives snoozed mail under an `Odyssey Snoozed/<time> UTC` label and returns it to the inbox the next time you open Odyssey after that time. If you don't open Odyssey, the message stays archived under that label in Gmail.

## Offline use

Odyssey keeps the latest 40 inbox emails (including their text) in IndexedDB on the device, plus the dashboard page in the service worker cache, so the app opens and the inbox is readable without a connection. While offline you can:

- read saved emails and reply,
- compose and send (queued until you're back online) or save drafts (added to Gmail drafts on reconnect),
- star, unstar, delete (Trash) and snooze saved messages.

Everything waits in the **Outbox** (Inbox panel), where items can be edited, cancelled or retried. When the connection returns, the outbox syncs in order and the inbox refreshes; with Background Sync (Chrome, Edge, Android) this also happens if Odyssey was closed. Safari and iOS sync the next time Odyssey is opened. Each queued email carries an `X-Odyssey-Client-Id` header, and retries check Gmail for it first, so a dropped connection can't cause a double send. AI chat needs a connection. New mail can only arrive while online; Odyssey checks every two minutes and on reconnect.

Saved mail and the outbox are tied to the signed-in account and deleted on sign-out (Odyssey warns first if anything hasn't synced).

Accounts that signed in before `gmail.modify` was added must sign out and sign in again to grant it; Odyssey prompts for this when an action needs it.

## 2. Local setup

```powershell
cd "C:\Users\Michael\OneDrive\Desktop\PersonalPortfolio\Odyssey"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Generate `APP_SECRET_KEY` and `TOKEN_ENCRYPTION_KEY` using the commands documented in `.env.example`, add the Web OAuth client values and Gemini key, then run:

```powershell
python app.py
```

Open `http://localhost:5000`.

## 3. Test

```powershell
$env:PYTHONPATH = "."
python -m unittest discover -s tests -v
```

## 4. Deploy to Vercel

Install and authenticate the CLI:

```powershell
npm install -g vercel
vercel login
```

From the `Odyssey` directory, deploy once to obtain the final domain:

```powershell
vercel
```

Add all production variables from `.env.example` in Vercel Project Settings → Environment Variables. Use new production secrets and set `OAUTH_REDIRECT_URI` to the exact HTTPS callback on the final domain. Add that same callback to the Google OAuth client. Then publish:

```powershell
vercel --prod
```

Vercel automatically detects the top-level Flask `app` and deploys it as one Python function. The `public` directory is served through Vercel's static asset layer.

## Mobile installation

- Android/Chrome: open the deployed HTTPS site and choose **Install app** or use Odyssey's sidebar install button.
- iPhone/iPad/Safari: Share → **Add to Home Screen**.

This is a Progressive Web App, so it behaves like a mobile app without requiring an App Store release. Gmail and AI actions still require an internet connection.

## Accuracy note on storage

Google exposes total account usage and Google Drive usage. It does not provide a reliable Gmail-only byte total through this endpoint, so Odyssey labels the remainder as “Gmail, Photos & more” rather than displaying a made-up Gmail figure.

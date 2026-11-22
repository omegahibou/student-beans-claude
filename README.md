# Student Beans Discord Bot

Fetch Student Beans discount codes from Discord using slash commands.

## Setup

### 1. Create a Discord bot
1. Go to https://discord.com/developers/applications
2. Click **New Application** → give it a name
3. Go to **Bot** → click **Reset Token** and copy it
4. Under **Privileged Gateway Intents**, nothing extra is needed
5. Go to **OAuth2 → URL Generator**, tick `bot` and `applications.commands`
6. Under Bot Permissions, tick **Send Messages**
7. Copy the generated URL and open it to invite the bot to your server

### 2. Configure environment
```bash
cp .env.example .env
```
Edit `.env` and fill in:
- `DISCORD_TOKEN` — your bot token from above
- `SB_EMAIL` — your Student Beans email
- `SB_PASSWORD` — your Student Beans password

### 3. Install & run
```bash
npm install
npm run install-browser   # downloads Chromium (one-time, ~100MB)
npm start
```

## Commands

| Command | Description |
|---|---|
| `/discount <retailer>` | Search for a retailer and get your unique discount code |
| `/sb-login` | Force re-login to Student Beans (use if codes stop working) |

## Examples

```
/discount ASOS
/discount Dominos
/discount Spotify
/discount JD Sports
```

If multiple retailers match your search, the bot shows buttons to pick the right one.

## Hosting on Railway

1. Push to a GitHub repo
2. Create a new project on https://railway.app
3. Connect your repo
4. Add the environment variables (`DISCORD_TOKEN`, `SB_EMAIL`, `SB_PASSWORD`, `HEADLESS=true`)
5. Add a start command: `npm start`

> ⚠️ Railway's free plan may not have enough memory for Playwright. Use the Hobby plan ($5/mo) or run it locally.

## Notes

- Codes from Student Beans are **unique and single-use** — don't share them
- The bot reuses a single browser session so it's fast after the first login
- If codes stop working, use `/sb-login` to refresh the session
- Some retailers use a redirect link instead of a code — the bot handles both

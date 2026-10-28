# Matchday Desk (multi-user)

Free football predictions. Everyone signs up with an email and password and sees the same
Weekly, Normal and Daily slips. Each user has their own tracker and bankroll.

## Run locally
    npm install        # only needed for Postgres; local mode has no dependencies
    cp .env.example .env   # or export the variables below
    FOOTBALL_DATA_KEY=yourkey ADMIN_EMAIL=you@example.com node server.js
Open http://localhost:3000, create your account (it becomes the admin), then open the
Admin tab and press Update fixtures (or Load demo data to test).
Data is stored in data/db.json when DATABASE_URL is empty.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render dashboard: New > Blueprint, pick the repo (it reads render.yaml and creates the web service plus a Postgres database).
3. Set FOOTBALL_DATA_KEY and ADMIN_EMAIL when asked, then deploy.
4. Sign up with the ADMIN_EMAIL address. That account is the admin.
Free Render plans sleep when idle and free databases can expire, so use a paid plan for a real launch.

## How it works
- The server fetches fixtures with your single football-data.org key (every 6 hours by default) and builds the slips once for everyone.
- Passwords are hashed with scrypt, sessions use HttpOnly cookies, logins are rate limited.
- Tracked slips settle automatically after each update.
- `npm test` starts a temporary server and checks accounts, permissions, slips and limits.

## Admin tab
Update or rebuild slips, load demo data, set the API key, leagues, pick quality, odds ranges
(Weekly is capped at 100) and manage users (disable, make admin).

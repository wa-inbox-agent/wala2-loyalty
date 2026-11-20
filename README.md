# ولاء (Wala2) - open loyalty app for any business

Multi-business loyalty web app. Arabic RTL, mobile first. A business signs up, picks **stamps** (per visit) or **points** (per amount spent), sets the reward. Staff register visits by customer phone; customers open `/b/<slug>` and type their phone to see their card.

- No dependencies. Node 22.5+ (uses built-in `node:sqlite`).
- Run: `npm start` (PORT, DB_FILE env vars). Data: single SQLite file.
- API is plain JSON, see `server.js`. WhatsApp reminders: planned next.
- Note: on free hosts with ephemeral disks (Render free) the SQLite file resets on redeploy. Use a persistent disk or an external database before real customers.

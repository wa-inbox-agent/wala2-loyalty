# ولاء (Wala2): open loyalty app for any business

Multi-business loyalty web app. Arabic RTL, mobile first.

- Stamps (per visit) or points (per amount spent), reward, per-business settings
- Owner and staff accounts (staff log in with business code, phone, PIN), branches
- Anti-fraud: cooldown between visits, daily cap per customer, blocked attempts log, owner can void
- Owner reports: customers, returning, inactive, 14-day chart, by staff and by branch, CSV export
- Password reset with a recovery code shown once at signup
- WhatsApp outbox: welcome / after visit / reward / inactive reminders. Messages queue until `WA_TOKEN` and `WA_PHONE_ID` are set, then send via the WhatsApp Cloud API (text, or approved template names)
- Free persistence: JSON backup to a private GitHub repo every ~20 s (env `GH_TOKEN`, `GH_DATA_REPO`), restored on boot when the database is empty

No dependencies. Node 22.5+ (built-in `node:sqlite` and `fetch`).

```
npm start
PORT, DB_FILE, GH_TOKEN, GH_DATA_REPO, WA_TOKEN, WA_PHONE_ID
```

See `SALES_PLAN_AR.md` for the go-to-market plan (Arabic).
Before real customers: move to a real database and a paid always-on server.

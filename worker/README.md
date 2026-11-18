# Azymut worker (laptop)

The search engine runs here as a long-lived Node process. Vercel only serves the page and puts
searches in a queue in Neon; the worker takes them, runs them without time limits from your home
IP, and writes progress back. The page shows "worker: online" while it reports in.

## Start by hand

```bash
npm run worker
```

Needs `.env.local` (DATABASE_URL) and `.env` in this folder. Optional `.env.worker`:

- `RESEND_API_KEY`, `ALERT_EMAIL` — mail when a deep search ends or finds something clearly cheaper than Google
  (free Resend account). Without them you get a desktop notification only.
- `ANTHROPIC_API_KEY` — the AI strategist uses Claude Haiku; without it, built-in heuristics.
- `WORKER_DEEP_HOURS` (default 6), `WORKER_FAST_MINUTES` (default 30).

## Autostart at login

```bash
./worker/install.sh
```

Logs: `journalctl --user -u azymut-worker -f`. Stop: `systemctl --user stop azymut-worker`.
Remove: `systemctl --user disable --now azymut-worker && rm ~/.config/systemd/user/azymut-worker.service`.

If no worker is online, quick searches fall back to Vercel (2-minute slices, 30 min max) and deep
searches wait in the queue until the worker starts.

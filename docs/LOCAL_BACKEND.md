# Local API

Express API in [`server/`](../server/). Port **3006**. Public hostname `api.epsynapse.com`.

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET` | `/health` | none | `{ ok, service: "jype-server", time }` |

## Env

Copy [`server/.env.example`](../server/.env.example) → `server/.env`. Default `PORT=3006`.

## Run

```bash
cd /Users/yanlevin/github/JYPE
npm install --prefix server
npm run server
```

Pushed `server/` changes do not go live until someone on the Mac Studio pulls and restarts. That sequence is at the top of [`STARTUP.md`](./STARTUP.md).

See also [`PUBLIC_TUNNEL.md`](./PUBLIC_TUNNEL.md).

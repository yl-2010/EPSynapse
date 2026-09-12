# Public API tunnel (`api.epsynapse.com`)

Same pattern as NoteLMs / yanylevin / SocketHR. A dedicated tunnel exposes only the Mac Express API.

```
Browser
  → https://api.epsynapse.com
       → Cloudflare Tunnel (cloudflared, config-jype.yml)
            → Express :3006
```

## Live setup (this Mac)

| Item | Value |
|------|--------|
| Vercel team | JYPE (`jype1`) |
| Zone / domain | `epsynapse.com` (registered on Vercel, DNS on Cloudflare) |
| Cloudflare account | `7147db2985dd609d51db0d7d2eb66378` |
| Zone id | `262bd841c3001e4a0519c6bda3f12f5f` |
| Nameservers | `hayes.ns.cloudflare.com`, `mallory.ns.cloudflare.com` |
| Tunnel | `jype-api` → `24e3b12c-5191-46b5-84d2-d0c808be0ba9` |
| Config | `~/.cloudflared/config-jype.yml` |
| DNS | Proxied CNAME `api` → `<tunnel-uuid>.cfargotunnel.com` |
| Apex / www | Proxied A records to Vercel so the static site stays on Vercel |

Do **not** attach `api.epsynapse.com` as a Vercel project domain.

SocketHR, NoteLMs, and Yan Levin keep their own tunnels. Four `cloudflared` processes.

## Runtime

LaunchAgents `com.jype.server` + `com.jype.cloudflared`, or manually:

```bash
npm run server
cloudflared tunnel --config ~/.cloudflared/config-jype.yml run
```

## Verify

```bash
npm run verify:public-api
# or
curl -sS https://api.epsynapse.com/health
```

Details: [`deploy/cloudflared/README.md`](../deploy/cloudflared/README.md).

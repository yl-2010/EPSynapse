# Cloudflare Tunnel (JYPE / EPSynapse)

`epsynapse.com` is registered on the **JYPE** Vercel team. Nameservers are Cloudflare (`hayes` / `mallory`). The site still lives on Vercel.

Do **not** put LM Studio (`:1234`) on this tunnel.

## Live pieces

| Piece | Value |
|-------|--------|
| Tunnel name | `jype-api` |
| Tunnel UUID | `484f13c6-2593-4b02-ae61-0dc724bab9a1` |
| Local config | `~/.cloudflared/config-jype.yml` |
| Credentials | `~/.cloudflared/484f13c6-2593-4b02-ae61-0dc724bab9a1.json` |
| Cloudflare account | JYPE (`7147db2985dd609d51db0d7d2eb66378`) |
| Hostname | `api.epsynapse.com` → `http://127.0.0.1:3006` |

The tunnel lives in the JYPE Cloudflare account, same as the zone. DNS for `api` is a proxied CNAME to `<uuid>.cfargotunnel.com`. Do not attach `api.epsynapse.com` as a Vercel project domain.

## Recreate (if needed)

```bash
bash deploy/cloudflared/setup-path-a.sh
# Then DNS: proxied CNAME api → 484f13c6-2593-4b02-ae61-0dc724bab9a1.cfargotunnel.com
```

`setup-path-a.sh` looks up `jype-api` with whatever origin cert `cloudflared` is using. The live tunnel is in the JYPE account, not NoteLMs.

## Every session / LaunchAgents

```bash
cd /Users/yanlevin/github/JYPE && npm run server
cloudflared tunnel --config ~/.cloudflared/config-jype.yml run
```

Or rely on `com.jype.server` + `com.jype.cloudflared`.

## Verify

```bash
curl -sS http://127.0.0.1:3006/health
curl -sS https://api.epsynapse.com/health
```

Expect: `{"ok":true,"service":"jype-server",...}`

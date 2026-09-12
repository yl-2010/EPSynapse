# Cloudflare Tunnel (JYPE / EPSynapse)

`epsynapse.com` is registered on the **JYPE** Vercel team. Nameservers are Cloudflare (`hayes` / `mallory`). The site still lives on Vercel. Same layout as `yanylevin.com` / `notelms.com`.

Do **not** put LM Studio (`:1234`) on this tunnel.

## Live pieces

| Piece | Value |
|-------|--------|
| Tunnel name | `jype-api` |
| Tunnel UUID | `24e3b12c-5191-46b5-84d2-d0c808be0ba9` |
| Local config | `~/.cloudflared/config-jype.yml` |
| Credentials | `~/.cloudflared/24e3b12c-5191-46b5-84d2-d0c808be0ba9.json` |
| Origin cert (create) | NoteLMs-account cert `~/.cloudflared/cert.pem.notelms.bak` |
| Hostname | `api.epsynapse.com` → `http://127.0.0.1:3006` |

The tunnel was created in the NoteLMs Cloudflare account because that cert was already on this Mac. DNS for `api` is a proxied CNAME on the JYPE Cloudflare zone to `<uuid>.cfargotunnel.com`. Do not attach `api.epsynapse.com` as a Vercel project domain.

## Recreate (if needed)

```bash
cp ~/.cloudflared/cert.pem.notelms.bak ~/.cloudflared/cert.pem
bash deploy/cloudflared/setup-path-a.sh
# Then DNS: CNAME api → 24e3b12c-5191-46b5-84d2-d0c808be0ba9.cfargotunnel.com
```

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

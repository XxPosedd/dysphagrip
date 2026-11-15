# Deploy: Vultr (hosting) + GoDaddy Registry (domain)

**What gets deployed:** the dashboard plus the Node API, as one Docker container, in **read-only demo mode**.
**What does not:** the Python audio/motion service. It runs on the presenter's MacBook next to the sensors, so the
public site honestly shows "Audio service offline" and a banner explaining why.

| Visitors can | Visitors cannot |
|---|---|
| See saved sessions from Neon, the resources panel (Bright Data and MedlinePlus), the signal lab, and the voice test (fixed phrases only, cached) | Save or delete sessions (HTTP 403), trigger collection, or make the voice say arbitrary text |

Time needed: about 30 minutes, most of it waiting for DNS and HTTPS.

---

## No domain? (privacy option, recommended if WHOIS privacy isn't available)
Some domain endings (e.g. `.us`) **do not allow WHOIS privacy**, so your name, address and phone number become public.
You can skip the domain entirely:
- Skip steps 1 and 4.
- In step 5, use the free **sslip.io** name for your server's IP instead of a domain: for IP `203.0.113.5` the name is
  `203-0-113-5.sslip.io`, which already points at that IP. Caddy gets a real HTTPS certificate for it automatically:
  ```
  203-0-113-5.sslip.io {
      reverse_proxy 127.0.0.1:3000
  }
  ```
- Your site is then `https://203-0-113-5.sslip.io` (use your server's IP with dashes). No registration, no personal data.
- Simplest of all: `http://SERVER_IP` works without Caddy if you publish port 80 instead
  (`-p 80:3000` in the docker run command), but without HTTPS.

## 1. Domain (GoDaddy Registry, code **MLHSH77**)
1. Register the domain using the MLH code **MLHSH77** (follow the MLH instructions for where to redeem it),
   e.g. `dysphagrip.<ending>`.
2. Leave DNS for now; you'll add records in step 4 once the server has an IP.

## 2. Server (Vultr)
1. Create a Vultr account and ask at the MLH table about **Vultr credits**.
2. **Deploy → Cloud Compute → Shared CPU**: pick the location nearest the event and the **Ubuntu 24.04** image, or the
   **Docker** Marketplace app. The smallest plan (1 vCPU / 1 GB) works.
3. Add your SSH key (or note the root password Vultr shows), deploy, and copy the server's **IPv4 address**.

## 3. Install and run the app (SSH into the server)
The repo must be reachable from the server, so **make the GitHub repo public first** (you were going to before
submitting), or clone with a GitHub personal access token.

```bash
ssh root@SERVER_IP

# Docker (skip if you chose the Docker Marketplace image) + a little swap so the build fits in 1 GB RAM
curl -fsSL https://get.docker.com | sh
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

git clone https://github.com/XxPosedd/dysphagrip.git /opt/dysphagrip
cd /opt/dysphagrip
```

Create the environment file **on the server only** (never commit it). Copy the values from your local `.env`:
```bash
cat > /opt/dysphagrip.env <<'EOF'
NODE_ENV=production
PORT=3000
DEMO_READ_ONLY=true
DATABASE_URL=postgresql://...pooler...neon.tech/neondb?sslmode=require
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
EOF
chmod 600 /opt/dysphagrip.env
```
The Bright Data token is **not** needed on the server; collection runs locally with `npm run resources:refresh`.

Build and start (it restarts automatically after reboots):
```bash
docker build -t dysphagrip .
docker run -d --name dysphagrip --restart unless-stopped --env-file /opt/dysphagrip.env -p 127.0.0.1:3000:3000 dysphagrip
curl -s localhost:3000/api/health      # expect "ok":true and "read_only":true
```

## 4. Point the domain at the server (GoDaddy DNS)
In the domain's **DNS / Manage DNS** page:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | `SERVER_IP` | 600 (10 min) |
| CNAME | `www` | `@` (or the bare domain) | 600 |

Delete any default "parked" A record for `@`. Check it with `nslookup yourdomain` (it can take a few minutes).

## 5. HTTPS (Caddy, automatic certificates)
```bash
apt-get install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
yourdomain.example, www.yourdomain.example {
    reverse_proxy 127.0.0.1:3000
}
EOF
systemctl reload caddy
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```
Caddy requests the certificate once DNS points at the server. Open `https://yourdomain…`: you should see the dashboard
with the **"Public read-only demo"** banner.

## 6. Check it
- [ ] `https://yourdomain/api/health` shows `"read_only":true` and database/elevenlabs `true`
- [ ] Session history and **Swallowing support resources** load
- [ ] **▶ Test voice** speaks
- [ ] `https://yourdomain/?view=lab` opens the signal lab
- [ ] Audio shows **offline** (expected) with the banner

## Update after new commits
```bash
cd /opt/dysphagrip && git pull && docker build -t dysphagrip . && docker rm -f dysphagrip && \
docker run -d --name dysphagrip --restart unless-stopped --env-file /opt/dysphagrip.env -p 127.0.0.1:3000:3000 dysphagrip
docker logs -f dysphagrip          # live logs
```

## Notes
- **Read-only is enforced by the API** (`DEMO_READ_ONLY=true`), not just hidden in the UI. For extra safety you can
  give the server a Neon role with read-only rights.
- Voice can only say the 13 approved phrases, and each is cached after its first use, so visitors can't spend your
  ElevenLabs credits beyond a handful of short phrases.
- The live demo (audio, motion, saving sessions) runs from the MacBook as usual: `npm run dev` plus the audio service.

# Setting up your own Linux vServer safely

Goal: a small server that hosts the game and is hard to break into. This guide is for a fresh **Debian 12/13 or Ubuntu 22.04/24.04** server. Do the steps in order. Commands starting with `sudo` are run as your normal user; keep a second terminal open while you change SSH or firewall settings so you cannot lock yourself out.

**What this protects and what it does not:** it makes the server hard to attack and limits the damage if one part fails. Nobody can promise "no security holes": keep the system updated, keep backups off the machine, and read the "Residual risks" list in [SECURITY.md](SECURITY.md).

The design in one picture:

```
internet ─► firewall (only 22, 80, 443) ─► Caddy (HTTPS, headers)  ─► 127.0.0.1:3000 ─► game container (non-root, read-only)
                                                                                              └─► /data volume (database, backups)
```

## 1. First login: a normal user, SSH keys only
```bash
# as root, once:
adduser deploy && usermod -aG sudo deploy
# on YOUR computer: create a key if you have none, then copy it to the server
ssh-keygen -t ed25519 -C "monstersgame-server"
ssh-copy-id deploy@YOUR_SERVER_IP
```
Log in as `deploy` in a **new terminal** and check that `sudo whoami` works. Only then lock SSH down:
```bash
sudo tee /etc/ssh/sshd_config.d/10-hardening.conf <<'EOT'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers deploy
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
EOT
sudo sshd -t && sudo systemctl reload ssh      # (service name is "sshd" on some distributions)
```
Test a new SSH login **before** closing the old session. Passwords for SSH are now impossible, which removes the most common attack (guessing passwords) entirely.

## 2. Firewall
```bash
sudo apt update && sudo apt install -y ufw
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw limit 22/tcp        # SSH, with automatic rate limiting
sudo ufw allow 80/tcp        # HTTP (needed by Caddy to get certificates and redirect to HTTPS)
sudo ufw allow 443/tcp       # HTTPS
sudo ufw enable && sudo ufw status verbose
```
**Docker warning:** Docker publishes ports by editing the firewall behind UFW's back. That is why `docker-compose.yml` publishes the game port as `127.0.0.1:3000:3000`: it is then reachable only from this machine. Never change it to `3000:3000`.

## 3. Ban repeated attackers, patch automatically
```bash
sudo apt install -y fail2ban unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades          # answer "Yes": security updates install by themselves
sudo tee /etc/fail2ban/jail.d/sshd.local <<'EOT'
[sshd]
enabled = true
maxretry = 4
findtime = 10m
bantime = 1h
EOT
sudo systemctl enable --now fail2ban
```
Reboot occasionally (`sudo reboot`) so kernel updates take effect; `/var/run/reboot-required` tells you when.

## 4. Docker
Install Docker Engine and the Compose plugin **from Docker's official repository** (follow the current instructions at docs.docker.com/engine/install for your distribution). Note: membership of the `docker` group is equivalent to root, so only add yourself (`sudo usermod -aG docker deploy`), nobody else.

## 5. Deploy the game
```bash
git clone <your repository> ~/monstersgame && cd ~/monstersgame
cp .env.example .env && chmod 600 .env && nano .env      # set REGISTRATION_CODE for a private server, BOTS, ...
docker compose up -d --build
```
**Check what is exposed** (this is the important test):
```bash
sudo ss -tlnp | grep -E ':(3000|80|443)\b'
#  the game must show 127.0.0.1:3000 (NOT 0.0.0.0:3000 or *:3000)
curl -s http://127.0.0.1:3000/api/catalog | head -c 100          # works on the server itself
curl -m 3 http://YOUR_SERVER_IP:3000/api/catalog                   # from your COMPUTER: must fail / time out
docker compose ps                                                    # status "healthy"
```

## 6. HTTPS with Caddy
Point your domain's A (and AAAA) record at the server, then:
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
# add Caddy's official apt repository (see caddyserver.com/docs/install#debian-ubuntu-raspbian), then:
sudo apt install caddy
sudo cp ~/monstersgame/deploy/Caddyfile /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile   # put YOUR domain in
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo systemctl reload caddy
```
Caddy obtains and renews the certificate by itself. Check from your computer: `curl -sI https://game.example.com/` shows `strict-transport-security`, `content-security-policy`, `x-frame-options: DENY`. You can also run the site through securityheaders.com and the Qualys SSL Labs test.

## 7. Backups that survive losing the server
The game writes a consistent snapshot every 6 hours into `/data/backups` (volume `mg-data`), keeps the newest 28, and takes a final one when it stops cleanly. That protects against mistakes, **not** against losing the disk. Copy them off the machine, encrypted. With `restic` (encrypts and deduplicates) to any S3-compatible storage, Backblaze B2 or a Hetzner Storage Box:
```bash
sudo apt install -y restic
# once: create the repository (choose a strong password and store it in your password manager!)
export RESTIC_REPOSITORY="b2:YOUR-BUCKET:monstersgame" RESTIC_PASSWORD_FILE=/root/.restic-pass   # plus the provider's key variables
sudo -E restic init
# nightly job (cron or a systemd timer): find the volume and back it up
VOL=$(docker volume inspect monstersgame_mg-data -f '{{ .Mountpoint }}')      # the exact volume name: `docker volume ls`
sudo -E restic backup "$VOL/backups" && sudo -E restic forget --keep-daily 14 --keep-weekly 8 --prune
```
**Test a restore** now and every few months: `docker compose stop`, copy a snapshot over `/data/monsters.db` inside the volume (a backup file is a normal game database), `docker compose start`, log in. A backup you never tested is a hope, not a backup.

## 8. Watching it
* Uptime: a free external monitor (UptimeRobot, Better Stack, ...) on `https://game.example.com/api/catalog` emails you when the server is down. Bots that stop playing usually mean the server is down.
* Logs: `docker compose logs -f game` (rotated automatically by the compose settings), `sudo journalctl -u caddy`, `sudo journalctl -u ssh`, `sudo fail2ban-client status sshd`.
* Disk: `df -h` now and then; alert on 80 %.

## 9. Updating
```bash
cd ~/monstersgame && git pull && docker compose up -d --build      # data volume untouched; a final backup is taken on shutdown
sudo apt update && sudo apt upgrade                                  # OS packages (unattended-upgrades does security ones daily)
docker system prune -f                                               # old images
```
Before deploying, run `npm audit --omit=dev` (dependencies of the game server: currently only `hono`).

## 10. If you suspect a break-in
1. **Log everybody out:** `docker compose exec game node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/monsters.db').exec('DELETE FROM sessions')"` (players simply log in again).
2. Change `REGISTRATION_CODE`, look at `docker compose logs game` and `/var/log/caddy/game.log` for the abuse pattern, block the address with `sudo ufw deny from <ip>`.
3. If the **server itself** may be compromised (unknown processes, files, users): do not clean it. Create a new server from scratch with this guide and restore only the newest **verified** database backup. Change all SSH keys and passwords that were ever used there.
4. Passwords are stored as salted scrypt hashes and session tokens only as SHA-256 hashes, so a stolen database does not directly hand out logins, but tell players to change passwords (the game has a password change feature).

## Checklist
- [ ] Only ports 22, 80, 443 open (`sudo ufw status`), `ss -tlnp` shows the game on `127.0.0.1` only
- [ ] SSH: keys only, no root login, fail2ban running
- [ ] Automatic security updates on, server rebooted after kernel updates
- [ ] `https://…` works, headers present, HTTP redirects to HTTPS
- [ ] `.env` has `chmod 600` and is not in git; private server has a `REGISTRATION_CODE`
- [ ] Off-site encrypted backup runs and a restore was tested
- [ ] External uptime monitor configured

# FrogTalk — Self-Host Guide

Full documentation: **https://frogtalk.xyz/docs/node**

## Quick Start

### 1. Clone & configure

```bash
git clone https://github.com/your-org/frogtalk.git
cd frogtalk
cp deploy/env.example .env
nano .env            # set ADMIN_PASSWORD, PORT, ALLOWED_ORIGINS, etc.
```

### 2. Install dependencies

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 3. Run

```bash
python main.py       # http://localhost:8080
```

---

## Production (systemd)

Copy the example service file and edit paths/user as needed:

```bash
sudo cp deploy/frogtalk.service /etc/systemd/system/frogtalk.service
sudo nano /etc/systemd/system/frogtalk.service   # adjust WorkingDirectory and User
sudo systemctl daemon-reload
sudo systemctl enable --now frogtalk
sudo systemctl status frogtalk
```

Logs: `journalctl -u frogtalk -f`

---

## Docker

```bash
docker build -t frogtalk .
docker run -d -p 8080:8080 \
  -e ADMIN_PASSWORD=your_password \
  -v $(pwd)/data:/app/data \
  --name frogtalk frogtalk
```

---

## Nginx reverse proxy (HTTPS)

```nginx
server {
    listen 443 ssl;
    server_name chat.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Federation (joining the network)

See **https://frogtalk.xyz/docs/node** for full federation setup, directory registration, and configuration options.

## API / Bots

See **https://frogtalk.xyz/docs/api** for the REST + WebSocket API reference.

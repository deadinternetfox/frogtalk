# FrogTalk backend node — container image.
#
# Quick start (from the repo root):
#   docker compose up -d            # builds this image + persistent volumes
# Or build/run directly:
#   docker build -f node/Dockerfile -t frogtalk .
#   docker run -d -p 8080:8080 -v ft-data:/app/data frogtalk
#
# Front it with nginx or a Cloudflare Tunnel for TLS — see /docs/run-a-node.
FROM python:3.12-slim

# Minimal runtime libs Pillow may dlopen (cryptography wheels are self-contained).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libjpeg62-turbo zlib1g \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first for layer caching.
COPY node/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App runtime (everything under node/).
COPY node/ .

# Persistent data dirs (mount as volumes) + a non-root runtime user.
RUN mkdir -p data secrets static/uploads board/board_data \
 && groupadd --system --gid 1001 frogtalk \
 && useradd  --system --uid 1001 --gid frogtalk --home /app frogtalk \
 && chown -R frogtalk:frogtalk /app
USER frogtalk

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=data/frogtalk.db \
    PYTHONUNBUFFERED=1

EXPOSE 8080

# Liveness: uvicorn answers /healthz with {"ok":true} once the app is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=4).status==200 else 1)"

CMD ["python", "main.py"]

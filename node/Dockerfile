# FrogTalk node container.
# Build from the repo root with:  docker build -f node/Dockerfile -t frogtalk .
FROM python:3.12-slim

WORKDIR /app

# Python deps first for layer cache.
COPY node/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the node runtime (everything under node/).
COPY node/ .

RUN mkdir -p data static/uploads \
 && groupadd --system --gid 1001 frogtalk \
 && useradd --system --uid 1001 --gid frogtalk --home /app frogtalk \
 && chown -R frogtalk:frogtalk /app

USER frogtalk

EXPOSE 8080

CMD ["python", "main.py"]

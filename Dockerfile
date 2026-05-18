FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p data static \
 && groupadd --system --gid 1001 frogtalk \
 && useradd --system --uid 1001 --gid frogtalk --home /app frogtalk \
 && chown -R frogtalk:frogtalk /app

USER frogtalk

EXPOSE 8080

CMD ["python", "main.py"]

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY sentinel ./sentinel
COPY apps ./apps
COPY manage.py entrypoint.sh ./

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir . \
    && chmod +x entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]
CMD ["gunicorn", "sentinel.wsgi:application", "--bind", "0.0.0.0:8000"]

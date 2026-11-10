# AcuMain: dashboard, agent and the trained Stage 2 model in one image.
#   docker compose up --build        then open http://localhost:8787
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ACUMAIN_HOST=0.0.0.0 \
    ACUMAIN_PORT=8787 \
    ACUMAIN_DATA_DIR=/data

# LightGBM needs the OpenMP runtime, which the slim image does not include.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements-app.txt .
RUN pip install -r requirements-app.txt

# The app, the trained model with its fitted preprocessing (acumain/artifacts), and the training code that
# defines the model classes. Nothing is trained when the image is built or started.
COPY acumain ./acumain
COPY risk_model/stage2/case1.py ./risk_model/stage2/case1.py

# Run as an ordinary user. /data holds the activity log, proposals and uploaded files.
RUN useradd --create-home --uid 10001 acumain && mkdir -p /data && chown acumain /data
USER acumain
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=3)"

CMD ["python", "-m", "acumain"]

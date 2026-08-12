# Worker documental e IA — TCL KOL OS
FROM python:3.11-slim

# Dependencias del sistema para OCR y procesamiento de imágenes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-spa \
        tesseract-ocr-eng \
        libjpeg62-turbo \
        zlib1g \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# El worker no corre como root (§12.1).
RUN useradd --create-home --shell /bin/bash worker \
    && chown -R worker:worker /app
USER worker

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

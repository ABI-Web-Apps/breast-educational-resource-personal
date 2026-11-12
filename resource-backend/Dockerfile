FROM python:3.11-slim

WORKDIR /resource_backend

COPY requirements.txt ./
RUN pip install --no-cache-dir --timeout=120 --retries=10 -r requirements.txt

# The catalogue (~350MB) before the code: it changes far less often, so a code
# change rebuilds only the small layer above it.
COPY static ./static
COPY app ./app

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8082/api/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8082"]

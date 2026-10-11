# Hugging Face Space (Docker SDK) — serves the Lineis FastAPI app + static UI.
FROM python:3.12-slim

WORKDIR /app

# Install Python deps first so the layer caches across code changes.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# App code + assets. main.py resolves BASE_DIR to /app, so frontend/,
# samples/ and test_batches/ must live at the image root alongside backend/.
COPY backend backend
COPY frontend frontend
COPY samples samples
COPY test_batches test_batches

# HF routes external traffic to app_port (declared in README front-matter).
ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860} --app-dir backend"]

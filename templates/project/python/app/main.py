"""FastAPI application entry point."""

from fastapi import FastAPI

app = FastAPI(title="{{PROJECT_NAME}}", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok"}

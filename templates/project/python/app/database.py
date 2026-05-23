"""SQLAlchemy database engine and session, configured from environment variables."""

import os
from pathlib import Path
from urllib.parse import quote_plus

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

# Load .env from repo root so DATABASE_URL is available regardless of how the
# process is started (uvicorn directly, pytest, etc.).  override=False means
# explicitly-set env vars (CI secrets, Docker --env) always win.
load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)


def _build_url() -> str:
    """Build database URL from DATABASE_URL or DB_* env vars."""
    # Prefer DATABASE_URL (postgresql:// with embedded credentials)
    url = os.getenv("DATABASE_URL")
    if url:
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
        if "sslmode" not in url:
            url += "?sslmode=require" if "?" not in url else "&sslmode=require"
        return url

    # Fallback: build from individual vars
    host = os.getenv("LAKEBASE_HOST", os.getenv("DB_HOST", "localhost"))
    port = os.getenv("DB_PORT", "5432")
    dbname = os.getenv("DB_NAME", "databricks_postgres")
    user = os.getenv("DB_USERNAME", "")
    password = os.getenv("DB_PASSWORD", "")

    if user and password:
        return f"postgresql+psycopg://{quote_plus(user)}:{quote_plus(password)}@{host}:{port}/{dbname}?sslmode=require"
    return f"postgresql+psycopg://{host}:{port}/{dbname}?sslmode=require"


DATABASE_URL = _build_url()
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

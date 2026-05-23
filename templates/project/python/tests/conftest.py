"""Shared fixtures for tests against the real Lakebase database."""

import pytest
from fastapi.testclient import TestClient

from app.database import SessionLocal  # .env already loaded by app.database
from app.main import app


@pytest.fixture()
def client():
    """FastAPI TestClient for making HTTP requests."""
    return TestClient(app)


@pytest.fixture()
def db_session():
    """Raw SQLAlchemy session for test setup / assertions."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()

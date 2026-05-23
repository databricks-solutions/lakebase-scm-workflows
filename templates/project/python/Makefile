.PHONY: install test migrate run

install:
	uv sync --all-extras

test:
	uv run --env-file .env pytest

migrate:
	uv run --env-file .env alembic upgrade head

run:
	uv run --env-file .env uvicorn app.main:app --reload

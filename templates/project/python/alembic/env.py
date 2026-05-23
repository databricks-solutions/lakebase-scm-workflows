"""Alembic environment configuration. Reads DATABASE_URL from environment."""

import sys
from pathlib import Path

# Ensure project root is on sys.path so 'from app.database import ...' works
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from logging.config import fileConfig
from alembic import context
from sqlalchemy import engine_from_config, pool
from app.database import Base, DATABASE_URL

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata
config.set_main_option("sqlalchemy.url", DATABASE_URL)


def run_migrations_offline():
    context.configure(url=DATABASE_URL, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

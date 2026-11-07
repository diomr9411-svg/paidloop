"""Database engine and sessions. SQLite needs no server, so setup stays free and simple."""

from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from paidloop.settings import REPO_ROOT


class Base(DeclarativeBase):
    pass


def make_engine(url: str) -> Engine:
    parsed = make_url(url)
    is_sqlite = parsed.get_backend_name() == "sqlite"
    is_file = is_sqlite and parsed.database not in (None, "", ":memory:")

    if is_file:
        path = Path(parsed.database)
        if not path.is_absolute():
            path = REPO_ROOT / path
        path.parent.mkdir(parents=True, exist_ok=True)
        parsed = parsed.set(database=str(path))

    connect_args = {"timeout": 30, "check_same_thread": False} if is_file else {}
    engine = create_engine(parsed, connect_args=connect_args)

    if is_sqlite:
        @event.listens_for(engine, "connect")
        def _configure(connection, _record):
            # SQLite ignores foreign keys unless each connection turns them on.
            connection.execute("PRAGMA foreign_keys=ON")
            if is_file:
                # Lets the screens read while the background payment check writes.
                connection.execute("PRAGMA journal_mode=WAL")

    return engine


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)

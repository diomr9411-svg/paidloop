"""Database engine and sessions. SQLite needs no server, so setup stays free and simple."""

from pathlib import Path

from sqlalchemy import Engine, create_engine, event, inspect, text
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
                connection.execute("PRAGMA synchronous=NORMAL")

    return engine


def prepare(engine: Engine) -> None:
    """Bring any database up to date: new tables, new columns and new indexes. Safe to run every start.

    create_all alone adds neither columns nor indexes to tables that already exist, so old data would
    silently stay without them.
    """
    Base.metadata.create_all(engine)
    existing = inspect(engine)
    with engine.begin() as connection:
        for table in Base.metadata.sorted_tables:
            present = {column["name"] for column in existing.get_columns(table.name)}
            for column in table.columns:
                if column.name not in present:
                    kind = column.type.compile(dialect=engine.dialect)
                    connection.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {kind}'))
    for table in Base.metadata.sorted_tables:
        for index in table.indexes:
            index.create(engine, checkfirst=True)
    with engine.begin() as connection:
        # Customers saved before this column existed get their search key now.
        rows = connection.execute(text("SELECT id, name FROM customer WHERE name_key IS NULL OR name_key = ''")).all()
        for customer_id, name in rows:
            connection.execute(
                text("UPDATE customer SET name_key = :key WHERE id = :id"),
                {"key": " ".join((name or "").casefold().split()), "id": customer_id},
            )
        # Lets SQLite learn the data, so it picks the best index for each query.
        connection.execute(text("PRAGMA optimize"))


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)

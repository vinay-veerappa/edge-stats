"""
Authoring tool for the external-bars fixtures: the golden-session CSVs written
as parquet in the exact schema of the market-data store the external mode reads
(<root>/<name>/<YYYY>.parquet):

  ts_open   timestamp[ms, tz=UTC]  open-stamped
  open high low close              double
  volume                           int64
  contract                         string, dictionary-encoded (null for STK)

Regenerate with:  python fixtures/external-bars/gen_fixture.py
(Committed output is the fixture; the engine test asserts its schema.)
"""
import csv
import os

import pyarrow as pa
import pyarrow.parquet as pq

here = os.path.dirname(os.path.abspath(__file__))
golden = os.path.join(here, "..", "golden-sessions")


def write(src: str, name: str, with_contract: bool) -> None:
    rows = list(csv.DictReader(open(os.path.join(golden, src), encoding="utf8")))
    cols = {
        "ts_open": pa.array([int(r["ts"]) for r in rows], type=pa.timestamp("ms", tz="UTC")),
        "open": pa.array([float(r["open"]) for r in rows], type=pa.float64()),
        "high": pa.array([float(r["high"]) for r in rows], type=pa.float64()),
        "low": pa.array([float(r["low"]) for r in rows], type=pa.float64()),
        "close": pa.array([float(r["close"]) for r in rows], type=pa.float64()),
        "volume": pa.array([int(float(r["volume"])) for r in rows], type=pa.int64()),
    }
    # the store always carries `contract`; it is null for a root with no contract month
    cols["contract"] = pa.array(
        [r["contract"] if with_contract else None for r in rows], type=pa.string()
    )
    out = os.path.join(here, "bars", "1h", name)
    os.makedirs(out, exist_ok=True)
    pq.write_table(
        pa.table(cols),
        os.path.join(out, "2024.parquet"),
        compression="snappy",
        use_dictionary=True,
        version="2.6",
        store_schema=False,
    )


write("fix-stk.csv", "STK", with_contract=False)
write("fix-fut.csv", "FUT", with_contract=True)

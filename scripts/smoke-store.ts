import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const db = new Database("/tmp/osm-test/memory/.cache/index.db");
sqliteVec.load(db);

const vec = db.prepare("SELECT count(*) AS n FROM chunk_vectors").get();
const fts = db.prepare("SELECT count(*) AS n FROM chunk_fts").get();
console.log("vec_n =", (vec as { n: number }).n);
console.log("fts_n =", (fts as { n: number }).n);

// quick FTS search
const rows = db
  .prepare("SELECT chunk_id, snippet(chunk_fts, 1, '[', ']', '...', 8) AS sn FROM chunk_fts WHERE chunk_fts MATCH ? LIMIT 5")
  .all('"flutter"');
console.log("fts hit on 'flutter':", rows);

db.close();

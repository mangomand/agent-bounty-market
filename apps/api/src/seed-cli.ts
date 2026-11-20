import { config } from "./config";
import { openDb } from "./db";
import { seed } from "./seed";

const db = openDb(config.dbPath);
console.log(`seeded ${seed(db)} demo bounties into ${config.dbPath}`);
db.close();

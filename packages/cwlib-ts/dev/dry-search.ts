/** Search the archive's own index (dry.db) by slot name. */
import { DatabaseSync } from 'node:sqlite';

const DB = process.env.DRY_DB ?? 'C:/Users/sgdc3/Desktop/LBP/lbp-download/dry.db';
const term = process.argv[2] ?? 'music';
const db = new DatabaseSync(DB, { readOnly: true });
const cols = db.prepare("select name from pragma_table_info('slot')").all();
console.log('slot columns:', cols.map((c: any) => c.name).join(', '));
const rows = db.prepare(
  `select id, name, game, hex(rootLevel) as root from slot where name like ? and game = 2 order by heartCount desc limit 25`,
).all(`%${term}%`);
for (const r of rows as any[]) console.log(`${r.id}\t${r.game}\t${String(r.root).toLowerCase()}\t${r.name}`);

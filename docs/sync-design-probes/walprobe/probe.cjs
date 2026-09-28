const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'conduit-probe-'));
const A = path.join(d, 'A.conduit');
let a = new Database(A); a.pragma('journal_mode = WAL'); a.pragma('wal_autocheckpoint = 0');
a.exec("CREATE TABLE entries(id TEXT PRIMARY KEY, name TEXT)");
for (let i = 0; i < 5; i++) a.prepare('INSERT INTO entries VALUES (?,?)').run('base' + i, 'base');
a.pragma('wal_checkpoint(TRUNCATE)');
// Version "published" by another device: same base, different later edits, written as a clean file
fs.copyFileSync(A, path.join(d, 'B.conduit'));
const b0 = new Database(path.join(d, 'B.conduit')); b0.prepare("UPDATE entries SET name='fromB' WHERE id='base0'").run(); b0.prepare("INSERT INTO entries VALUES ('onlyB','x')").run(); b0.pragma('wal_checkpoint(TRUNCATE)'); b0.pragma('journal_mode = DELETE'); b0.close();
// Legacy in-place session on A leaves uncheckpointed frames
a.prepare("DELETE FROM entries WHERE id='base3'").run();
a.prepare("INSERT INTO entries VALUES ('onlyA','y')").run();
fs.copyFileSync(A + '-wal', path.join(d, 'B.conduit-wal'));
a.close();
const b = new Database(path.join(d, 'B.conduit'));
console.log('rows seen opening B with A-wal:', b.prepare('SELECT id,name FROM entries ORDER BY id').all().map(r => r.id + '=' + r.name).join(', '));
console.log('quick_check:', b.pragma('quick_check', { simple: true }));

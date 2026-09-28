// Size probe for the compact sync layout (integer row keys, implicit default-valued genesis registers,
// derived genesis pids). Compares against the per-register TEXT-keyed layout from vacprobe.cjs.
const path=require('path'),fs=require('fs'),crypto=require('crypto'),zlib=require('zlib');
const Database=require('better-sqlite3');
const d=fs.mkdtempSync(path.join(require('os').tmpdir(),'conduit-probe-'));
const N=2000;
const CONTENT=`CREATE TABLE entries(id TEXT PRIMARY KEY,name TEXT,entry_type TEXT,folder_id TEXT,parent_entry_id TEXT,sort_order INTEGER,host TEXT,port INTEGER,credential_id TEXT,username TEXT,password_encrypted BLOB,domain TEXT,private_key_encrypted BLOB,totp_secret_encrypted BLOB,icon TEXT,color TEXT,credential_type TEXT,config TEXT,tags TEXT,is_favorite INTEGER,notes TEXT,created_at TEXT,updated_at TEXT);`;
// Registers with a non-default value in a typical connection entry (10 of 22).
const nonDefault=['_life','name','entry_type','container','host','port','username','password','config.resolution','created_at'];
const compactDDL=`
CREATE TABLE sync_rowkey(rid INTEGER PRIMARY KEY, tbl INTEGER NOT NULL, row_id TEXT NOT NULL, UNIQUE(tbl,row_id));
CREATE TABLE sync_reg(rid INTEGER NOT NULL, reg TEXT NOT NULL, dev INTEGER NOT NULL, hlc_ms INTEGER NOT NULL, hlc_c INTEGER NOT NULL,
  pid BLOB, vhash BLOB NOT NULL, lt INTEGER, pmem_ms INTEGER, pmem_ids BLOB, prev_vhash BLOB, mat TEXT, PRIMARY KEY(rid,reg)) WITHOUT ROWID;
CREATE TABLE sync_row(rid INTEGER PRIMARY KEY, materialized INTEGER NOT NULL, raw_hash BLOB);`;
function build(file, mode){
  const db=new Database(file);db.exec(CONTENT+compactDDL);
  const ie=db.prepare('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const ik=db.prepare('INSERT INTO sync_rowkey(tbl,row_id) VALUES (1,?)');
  const ir=db.prepare('INSERT INTO sync_reg VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const iw=db.prepare('INSERT INTO sync_row VALUES (?,?,?)');
  const now=Date.now();
  db.transaction(()=>{for(let i=0;i<N;i++){const id=crypto.randomUUID();
    ie.run(id,'Server '+i,'rdp',crypto.randomUUID(),null,0,'10.0.'+(i%255)+'.'+(i%200),3389,null,'admin',crypto.randomBytes(60),null,null,null,null,null,null,'{"resolution":"1920x1080","sound":"local"}','[]',0,null,new Date().toISOString(),new Date().toISOString());
    const rid=ik.run(id).lastInsertRowid;
    iw.run(rid,1,crypto.randomBytes(32));
    for(const r of nonDefault){
      if(mode==='genesis') ir.run(rid,r,0,0,0,null,crypto.randomBytes(16),now-1e9,null,null,null,null);
      else ir.run(rid,r,Math.floor(Math.random()*2**47),now-Math.floor(Math.random()*1e9),Math.floor(Math.random()*5),null,crypto.randomBytes(16),null,null,null,crypto.randomBytes(16),null);
    }}})();
  db.close();
}
for(const mode of ['genesis','edited']){
  const f=path.join(d,mode+'.conduit');build(f,mode);
  const out=path.join(d,mode+'-vac.conduit');const db=new Database(f);db.prepare('VACUUM INTO ?').run(out);db.close();
  const b=fs.readFileSync(out);
  console.log(mode,'compact file MB',(b.length/1e6).toFixed(2),'deflated MB',(zlib.deflateRawSync(b).length/1e6).toFixed(2),'bytes/entry',Math.round(b.length/N));
}
const c=path.join(d,'content.conduit');const db=new Database(c);db.exec(CONTENT);
const ie=db.prepare('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
db.transaction(()=>{for(let i=0;i<N;i++)ie.run(crypto.randomUUID(),'Server '+i,'rdp',crypto.randomUUID(),null,0,'10.0.'+(i%255)+'.'+(i%200),3389,null,'admin',crypto.randomBytes(60),null,null,null,null,null,null,'{"resolution":"1920x1080","sound":"local"}','[]',0,null,new Date().toISOString(),new Date().toISOString());})();
db.close();console.log('content only MB',(fs.statSync(c).size/1e6).toFixed(2));

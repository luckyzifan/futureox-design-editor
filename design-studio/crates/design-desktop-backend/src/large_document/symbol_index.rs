//! A revision-owned derived locator, not source authority. Small catalogs stay
//! in RAM; larger ones spill to a bounded-memory, open-addressed disk table.
//! Keys are compared in full after hashing, and the first source occurrence
//! wins. No mmap, detached worker, database runtime or source rewrite is used.
use std::{collections::HashMap, fs::{self,File,OpenOptions}, io::{self,Read,Seek,SeekFrom,Write},
    path::{Path,PathBuf}, sync::{Mutex,atomic::{AtomicBool,AtomicU64,Ordering}}};
use sha2::{Digest,Sha256};

const MEMORY_BYTES:usize=4*1024*1024;
const ROW_BYTES:u64=72;
type Location=(usize,usize);
enum Storage { Memory(HashMap<String,Location>), Disk(Disk) }
pub(super) struct Symbols { storage:Storage, bytes:usize, directory:PathBuf, count:u64 }
impl Symbols {
    pub(super) fn new(directory:&Path,count:usize)->io::Result<Self> {
        Ok(Self{storage:Storage::Memory(HashMap::new()),bytes:0,directory:directory.into(),
            count:u64::try_from(count).map_err(|_|invalid("Symbol count overflow"))?})
    }
    pub(super) fn insert(&mut self,key:String,location:Location,cancel:&AtomicBool)->io::Result<()> {
        super::check_cancel(cancel)?;
        let Storage::Memory(map)=&mut self.storage else {
            if let Storage::Disk(disk)=&mut self.storage {disk.insert(&key,location,cancel)?;}
            return Ok(());
        };
        if map.contains_key(&key) {return Ok(());}
        let bytes=self.bytes.checked_add(key.len()).and_then(|n|n.checked_add(128))
            .ok_or_else(||invalid("Symbol memory accounting overflow"))?;
        if bytes<=MEMORY_BYTES {map.insert(key,location);self.bytes=bytes;return Ok(());}
        let mut disk=Disk::new(&self.directory,self.count)?;
        for (key,location) in map.iter() {disk.insert(key,*location,cancel)?;}
        disk.insert(&key,location,cancel)?;
        self.storage=Storage::Disk(disk);self.bytes=0;
        Ok(())
    }
    pub(super) fn get(&self,key:&str,cancel:&AtomicBool)->io::Result<Option<Location>> {
        super::check_cancel(cancel)?;
        match &self.storage {Storage::Memory(map)=>Ok(map.get(key).copied()),Storage::Disk(disk)=>disk.get(key,cancel)}
    }
    pub(super) fn on_disk(&self)->bool {matches!(&self.storage,Storage::Disk(_))}
}
fn invalid(message:&str)->io::Error {io::Error::new(io::ErrorKind::InvalidData,message)}
fn open_private(path:&Path)->io::Result<File> {
    let mut options=OpenOptions::new();options.create_new(true).read(true).write(true);
    #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
    options.open(path)
}
struct Files { table:File, keys:File, key_end:u64 }
struct Disk { files:Mutex<Option<Files>>, paths:[PathBuf;2], slots:u64 }
impl Disk {
    fn new(directory:&Path,count:u64)->io::Result<Self> {
        static NEXT:AtomicU64=AtomicU64::new(0);
        let slots=count.max(1).checked_mul(2).and_then(u64::checked_next_power_of_two)
            .ok_or_else(||invalid("Symbol table size overflow"))?;
        let bytes=slots.checked_mul(ROW_BYTES).ok_or_else(||invalid("Symbol table byte overflow"))?;
        let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(io::Error::other)?.as_nanos();
        let stem=format!("symbol-locator-{}-{stamp}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed));
        let paths=[directory.join(format!("{stem}.rows")),directory.join(format!("{stem}.keys"))];
        let table=open_private(&paths[0])?;
        let keys=match open_private(&paths[1]) {Ok(file)=>file,Err(error)=>{drop(table);let _=fs::remove_file(&paths[0]);return Err(error);}};
        let result=Self{files:Mutex::new(Some(Files{table,keys,key_end:0})),paths,slots};
        // New sparse table bytes read as zero. Occupancy is explicit, so empty
        // symbol strings and an all-zero digest are still valid stored keys.
        result.files.lock().map_err(|_|invalid("Symbol table lock poisoned"))?.as_ref().unwrap().table.set_len(bytes)?;
        Ok(result)
    }
    fn insert(&mut self,key:&str,(part,node):Location,cancel:&AtomicBool)->io::Result<()> {
        let files=self.files.get_mut().map_err(|_|invalid("Symbol table lock poisoned"))?.as_mut().unwrap();
        let hash:[u8;32]=Sha256::digest(key.as_bytes()).into();
        let (slot,old)=probe(files,self.slots,key,&hash,cancel)?;
        if old.is_some() {return Ok(());}
        let start=files.key_end;
        let len=u64::try_from(key.len()).map_err(|_|invalid("Symbol key size overflow"))?;
        let end=start.checked_add(len).ok_or_else(||invalid("Symbol key range overflow"))?;
        files.keys.seek(SeekFrom::Start(start))?;files.keys.write_all(key.as_bytes())?;
        let mut row=[0u8;ROW_BYTES as usize];row[..8].copy_from_slice(&1u64.to_le_bytes());row[8..40].copy_from_slice(&hash);
        for (at,value) in [(40,start),(48,len),(56,u64::try_from(part).map_err(|_|invalid("Symbol part overflow"))?),
            (64,u64::try_from(node).map_err(|_|invalid("Symbol node overflow"))?)] {row[at..at+8].copy_from_slice(&value.to_le_bytes());}
        files.table.seek(SeekFrom::Start(slot*ROW_BYTES))?;files.table.write_all(&row)?;
        files.key_end=end;
        Ok(())
    }
    fn get(&self,key:&str,cancel:&AtomicBool)->io::Result<Option<Location>> {
        let mut guard=self.files.lock().map_err(|_|invalid("Symbol table lock poisoned"))?;
        let files=guard.as_mut().ok_or_else(||invalid("Retired symbol table"))?;
        let hash:[u8;32]=Sha256::digest(key.as_bytes()).into();
        Ok(probe(files,self.slots,key,&hash,cancel)?.1)
    }
}
fn word(row:&[u8],at:usize)->u64 {u64::from_le_bytes(row[at..at+8].try_into().unwrap())}
fn probe(files:&mut Files,slots:u64,key:&str,hash:&[u8;32],cancel:&AtomicBool)->io::Result<(u64,Option<Location>)> {
    let first=u64::from_le_bytes(hash[..8].try_into().unwrap())&(slots-1);
    let mut row=[0u8;ROW_BYTES as usize];
    for step in 0..slots {
        super::check_cancel(cancel)?;
        let slot=first.wrapping_add(step)&(slots-1);
        files.table.seek(SeekFrom::Start(slot*ROW_BYTES))?;files.table.read_exact(&mut row)?;
        match word(&row,0) {0=>return Ok((slot,None)),1=>(),_=>return Err(invalid("Invalid symbol locator row"))}
        if &row[8..40]!=hash || word(&row,48)!=key.len() as u64 {continue;}
        let start=word(&row,40);
        let end=start.checked_add(word(&row,48)).ok_or_else(||invalid("Invalid symbol key range"))?;
        if end>files.key_end {return Err(invalid("Truncated symbol key store"));}
        files.keys.seek(SeekFrom::Start(start))?;
        let mut buffer=[0u8;4096];let mut equal=true;
        for expected in key.as_bytes().chunks(buffer.len()) {
            super::check_cancel(cancel)?;
            files.keys.read_exact(&mut buffer[..expected.len()])?;
            if &buffer[..expected.len()]!=expected {equal=false;break;}
        }
        if equal {return Ok((slot,Some((usize::try_from(word(&row,56)).map_err(|_|invalid("Symbol part overflow"))?,
            usize::try_from(word(&row,64)).map_err(|_|invalid("Symbol node overflow"))?))));}
    }
    Err(invalid("Symbol locator table is full"))
}
impl Drop for Disk {
    fn drop(&mut self) {
        // Close handles before unlinking on every platform, including Windows.
        self.files.get_mut().unwrap_or_else(|error|error.into_inner()).take();
        for path in &self.paths {let _=fs::remove_file(path);}
    }
}

//! In-memory page index support for delta lookups.

use anyhow::{Context, Result, ensure};
use scc::HashMap;
use std::sync::atomic::AtomicUsize;
use universaldb::Subspace;

use crate::udb;

const PGNO_BYTES: usize = std::mem::size_of::<u32>();
const TXID_BYTES: usize = std::mem::size_of::<u64>();

#[derive(Debug, Default)]
pub struct DeltaPageIndex {
	entries: HashMap<u32, u64>,
}

impl DeltaPageIndex {
	pub fn new() -> Self {
		Self {
			entries: HashMap::default(),
		}
	}

	pub async fn load_from_store(
		db: &universaldb::Database,
		subspace: &Subspace,
		op_counter: &AtomicUsize,
		prefix: Vec<u8>,
	) -> Result<Self> {
		let rows = udb::scan_prefix_values(db, subspace, op_counter, prefix.clone()).await?;
		let index = Self::new();

		for (key, value) in rows {
			let pgno = decode_pgno(&key, &prefix)?;
			let txid = decode_txid(&value)?;
			let _ = index.entries.upsert_sync(pgno, txid);
		}

		Ok(index)
	}

	pub fn get(&self, pgno: u32) -> Option<u64> {
		self.entries.read_sync(&pgno, |_, txid| *txid)
	}

	pub fn insert(&self, pgno: u32, txid: u64) {
		let _ = self.entries.upsert_sync(pgno, txid);
	}

	pub fn remove(&self, pgno: u32) -> Option<u64> {
		self.entries.remove_sync(&pgno).map(|(_, txid)| txid)
	}

	pub fn clear(&self) {
		self.entries.clear_sync();
	}

	pub fn range(&self, start: u32, end: u32) -> Vec<(u32, u64)> {
		if start > end {
			return Vec::new();
		}

		let mut pages = Vec::new();
		self.entries.iter_sync(|pgno, txid| {
			if *pgno >= start && *pgno <= end {
				pages.push((*pgno, *txid));
			}
			true
		});
		pages.sort_unstable_by_key(|(pgno, _)| *pgno);
		pages
	}
}

fn decode_pgno(key: &[u8], prefix: &[u8]) -> Result<u32> {
	ensure!(
		key.starts_with(prefix),
		"pidx key did not start with expected prefix"
	);

	let suffix = &key[prefix.len()..];
	ensure!(
		suffix.len() == PGNO_BYTES,
		"pidx key suffix had {} bytes, expected {}",
		suffix.len(),
		PGNO_BYTES
	);

	Ok(u32::from_be_bytes(
		suffix
			.try_into()
			.context("pidx key suffix should decode as u32")?,
	))
}

fn decode_txid(value: &[u8]) -> Result<u64> {
	ensure!(
		value.len() == TXID_BYTES,
		"pidx value had {} bytes, expected {}",
		value.len(),
		TXID_BYTES
	);

	Ok(u64::from_be_bytes(
		value
			.try_into()
			.context("pidx value should decode as u64")?,
	))
}

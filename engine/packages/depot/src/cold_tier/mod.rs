use anyhow::Result;
use async_trait::async_trait;
use std::sync::Arc;

mod config;
mod disabled;
mod faulty;
mod filesystem;
mod s3;

pub use config::cold_tier_from_config;
pub use disabled::DisabledColdTier;
pub use faulty::{ColdTierOperation, FaultyColdTier};
pub use filesystem::FilesystemColdTier;
pub use s3::S3ColdTier;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColdTierObjectMetadata {
	pub key: String,
	pub size_bytes: u64,
}

#[async_trait]
pub trait ColdTier: Send + Sync + 'static {
	async fn put_object(&self, key: &str, bytes: &[u8]) -> Result<()>;

	async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>>;

	async fn delete_objects(&self, keys: &[String]) -> Result<()>;

	async fn list_prefix(&self, prefix: &str) -> Result<Vec<ColdTierObjectMetadata>>;
}

#[async_trait]
impl<T> ColdTier for Arc<T>
where
	T: ColdTier,
{
	async fn put_object(&self, key: &str, bytes: &[u8]) -> Result<()> {
		self.as_ref().put_object(key, bytes).await
	}

	async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>> {
		self.as_ref().get_object(key).await
	}

	async fn delete_objects(&self, keys: &[String]) -> Result<()> {
		self.as_ref().delete_objects(keys).await
	}

	async fn list_prefix(&self, prefix: &str) -> Result<Vec<ColdTierObjectMetadata>> {
		self.as_ref().list_prefix(prefix).await
	}
}

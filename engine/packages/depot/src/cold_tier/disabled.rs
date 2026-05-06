use anyhow::Result;
use async_trait::async_trait;

use super::{ColdTier, ColdTierObjectMetadata};

#[derive(Debug, Clone, Default)]
pub struct DisabledColdTier;

#[async_trait]
impl ColdTier for DisabledColdTier {
	async fn put_object(&self, _key: &str, _bytes: &[u8]) -> Result<()> {
		anyhow::bail!("sqlite cold tier is disabled")
	}

	async fn get_object(&self, _key: &str) -> Result<Option<Vec<u8>>> {
		anyhow::bail!("sqlite cold tier is disabled")
	}

	async fn delete_objects(&self, _keys: &[String]) -> Result<()> {
		anyhow::bail!("sqlite cold tier is disabled")
	}

	async fn list_prefix(&self, _prefix: &str) -> Result<Vec<ColdTierObjectMetadata>> {
		anyhow::bail!("sqlite cold tier is disabled")
	}
}

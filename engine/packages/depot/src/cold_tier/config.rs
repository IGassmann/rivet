use anyhow::Result;
use rivet_config::config::SqliteWorkflowColdStorage;
use std::path::PathBuf;
use std::sync::Arc;

use super::{ColdTier, FilesystemColdTier, S3ColdTier};

pub async fn cold_tier_from_config(
	config: &rivet_config::Config,
) -> Result<Option<Arc<dyn ColdTier>>> {
	match config.sqlite().workflow_cold_storage() {
		Some(SqliteWorkflowColdStorage::FileSystem(file_system)) => Ok(Some(Arc::new(
			FilesystemColdTier::new(PathBuf::from(&file_system.root)),
		))),
		Some(SqliteWorkflowColdStorage::S3(s3)) => Ok(Some(Arc::new(
			S3ColdTier::from_env(
				s3.bucket.clone(),
				s3.prefix.clone().unwrap_or_default(),
				s3.endpoint.clone(),
			)
			.await?,
		))),
		None => Ok(None),
	}
}

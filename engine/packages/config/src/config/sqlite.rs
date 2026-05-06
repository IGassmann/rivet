use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, Default, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Sqlite {
	#[serde(default)]
	pub workflow_cold_storage: Option<SqliteWorkflowColdStorage>,
}

impl Sqlite {
	pub fn workflow_cold_storage(&self) -> Option<&SqliteWorkflowColdStorage> {
		self.workflow_cold_storage.as_ref()
	}
}

#[derive(Debug, Serialize, Deserialize, Clone, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SqliteWorkflowColdStorage {
	FileSystem(SqliteWorkflowColdStorageFileSystem),
	S3(SqliteWorkflowColdStorageS3),
}

#[derive(Debug, Serialize, Deserialize, Clone, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SqliteWorkflowColdStorageFileSystem {
	pub root: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SqliteWorkflowColdStorageS3 {
	pub bucket: String,
	#[serde(default)]
	pub prefix: Option<String>,
	#[serde(default)]
	pub endpoint: Option<String>,
}

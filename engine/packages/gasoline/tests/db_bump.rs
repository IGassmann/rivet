use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::StreamExt;
use gas::prelude::Id;
use gasoline as gas;
use gasoline::db::{BumpSubSubject, Database, DatabaseKv};
use serde_json::json;

#[tokio::test]
async fn workflow_created_bump_fires_for_workflow_tag() -> Result<()> {
	let test_deps = rivet_test_deps::TestDeps::new().await?;
	let config = test_deps.config().clone();
	let pools = test_deps.pools().clone();
	let db = <DatabaseKv as Database>::new(config.clone(), pools).await?;
	let tag = format!("workflow-created-{}", Id::new_v1(config.dc_label()));
	let mut bump_sub = db
		.bump_sub(BumpSubSubject::WorkflowCreated { tag: tag.clone() })
		.await?;

	let tags = json!({ "test_tag": tag });
	let input = serde_json::value::to_raw_value(&json!({ "value": "unused" }))?;
	db.dispatch_workflow(
		Id::new_v1(config.dc_label()),
		Id::new_v1(config.dc_label()),
		"workflow-created-bump-test",
		Some(&tags),
		input.as_ref(),
		false,
	)
	.await?;

	tokio::time::timeout(Duration::from_secs(2), bump_sub.next())
		.await
		.context("timed out waiting for workflow-created bump")?
		.context("workflow-created bump stream closed")?;

	Ok(())
}

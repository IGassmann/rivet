use anyhow::{Context, Result};
use async_trait::async_trait;
use aws_sdk_s3::operation::get_object::GetObjectError;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};

use super::filesystem::validate_object_key;
use super::{ColdTier, ColdTierObjectMetadata};

#[derive(Debug, Clone)]
pub struct S3ColdTier {
	client: aws_sdk_s3::Client,
	bucket: String,
	root_prefix: String,
}

impl S3ColdTier {
	pub fn new(
		client: aws_sdk_s3::Client,
		bucket: impl Into<String>,
		root_prefix: impl Into<String>,
	) -> Self {
		S3ColdTier {
			client,
			bucket: bucket.into(),
			root_prefix: normalize_prefix(root_prefix.into()),
		}
	}

	pub async fn from_env(
		bucket: impl Into<String>,
		root_prefix: impl Into<String>,
		endpoint_url: Option<String>,
	) -> Result<Self> {
		let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest());

		if let Some(endpoint_url) = endpoint_url {
			loader = loader.endpoint_url(endpoint_url);
		}

		let config = loader.load().await;
		Ok(S3ColdTier::new(
			aws_sdk_s3::Client::new(&config),
			bucket,
			root_prefix,
		))
	}

	fn s3_key(&self, key: &str) -> Result<String> {
		validate_object_key(key)?;

		if self.root_prefix.is_empty() {
			Ok(key.to_string())
		} else {
			Ok(format!("{}/{}", self.root_prefix, key))
		}
	}

	fn strip_root_prefix(&self, key: &str) -> Option<String> {
		if self.root_prefix.is_empty() {
			Some(key.to_string())
		} else {
			key.strip_prefix(&format!("{}/", self.root_prefix))
				.map(str::to_string)
		}
	}
}

#[async_trait]
impl ColdTier for S3ColdTier {
	async fn put_object(&self, key: &str, bytes: &[u8]) -> Result<()> {
		let key = self.s3_key(key)?;
		self.client
			.put_object()
			.bucket(&self.bucket)
			.key(&key)
			.body(ByteStream::from(bytes.to_vec()))
			.send()
			.await
			.with_context(|| format!("put cold-tier S3 object {key}"))?;

		Ok(())
	}

	async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>> {
		let key = self.s3_key(key)?;
		let output = match self
			.client
			.get_object()
			.bucket(&self.bucket)
			.key(&key)
			.send()
			.await
		{
			Ok(output) => output,
			Err(err) if is_s3_no_such_key_error(&err) => return Ok(None),
			Err(err) => return Err(err).with_context(|| format!("get cold-tier S3 object {key}")),
		};

		let bytes = output
			.body
			.collect()
			.await
			.with_context(|| format!("read cold-tier S3 object body {key}"))?
			.into_bytes()
			.to_vec();

		Ok(Some(bytes))
	}

	async fn delete_objects(&self, keys: &[String]) -> Result<()> {
		for chunk in keys.chunks(1000) {
			if chunk.is_empty() {
				continue;
			}

			let mut objects = Vec::with_capacity(chunk.len());
			for key in chunk {
				objects.push(
					ObjectIdentifier::builder()
						.key(self.s3_key(key)?)
						.build()
						.context("build cold-tier S3 delete object identifier")?,
				);
			}

			self.client
				.delete_objects()
				.bucket(&self.bucket)
				.delete(
					Delete::builder()
						.set_objects(Some(objects))
						.build()
						.context("build cold-tier S3 delete request")?,
				)
				.send()
				.await
				.context("delete cold-tier S3 objects")?;
		}

		Ok(())
	}

	async fn list_prefix(&self, prefix: &str) -> Result<Vec<ColdTierObjectMetadata>> {
		let prefix = if prefix.is_empty() {
			self.root_prefix.clone()
		} else {
			self.s3_key(prefix)?
		};
		let mut continuation_token = None;
		let mut objects = Vec::new();

		loop {
			let output = self
				.client
				.list_objects_v2()
				.bucket(&self.bucket)
				.prefix(&prefix)
				.set_continuation_token(continuation_token)
				.send()
				.await
				.with_context(|| format!("list cold-tier S3 prefix {prefix}"))?;

			for object in output.contents() {
				if let Some(key) = object.key() {
					if let Some(key) = self.strip_root_prefix(key) {
						objects.push(ColdTierObjectMetadata {
							key,
							size_bytes: object.size().unwrap_or_default() as u64,
						});
					}
				}
			}

			if output.is_truncated().unwrap_or(false) {
				continuation_token = output.next_continuation_token().map(str::to_string);
			} else {
				break;
			}
		}

		objects.sort_by(|a, b| a.key.cmp(&b.key));

		Ok(objects)
	}
}

fn is_s3_no_such_key_error<R>(err: &aws_sdk_s3::error::SdkError<GetObjectError, R>) -> bool {
	err.as_service_error()
		.is_some_and(GetObjectError::is_no_such_key)
}

fn normalize_prefix(prefix: String) -> String {
	prefix
		.trim_matches('/')
		.split('/')
		.filter(|part| !part.is_empty())
		.collect::<Vec<_>>()
		.join("/")
}

#[cfg(test)]
#[path = "../../tests/inline/cold_tier.rs"]
mod tests;

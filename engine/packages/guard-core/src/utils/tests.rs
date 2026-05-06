use hyper::header::HeaderValue;

use super::*;

#[test]
fn retries_guard_actor_ready_timeout_response() {
	let mut headers = hyper::HeaderMap::new();
	headers.insert(
		X_RIVET_ERROR,
		HeaderValue::from_static("guard.actor_ready_timeout"),
	);

	assert!(should_retry_request_inner(
		StatusCode::SERVICE_UNAVAILABLE,
		&headers,
	));
}

#[test]
fn skips_service_unavailable_without_rivet_error_header() {
	let headers = hyper::HeaderMap::new();

	assert!(!should_retry_request_inner(
		StatusCode::SERVICE_UNAVAILABLE,
		&headers,
	));
}

#[test]
fn skips_non_service_unavailable_with_rivet_error_header() {
	let mut headers = hyper::HeaderMap::new();
	headers.insert(X_RIVET_ERROR, HeaderValue::from_static("guard.no_route"));

	assert!(!should_retry_request_inner(StatusCode::NOT_FOUND, &headers));
}

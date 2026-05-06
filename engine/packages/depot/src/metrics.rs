//! Metrics definitions shared by depot runtime components.

use rivet_metrics::{REGISTRY, prometheus::*};

lazy_static::lazy_static! {
	pub static ref SQLITE_S3_REQUEST_FAILURES_TOTAL: IntCounterVec = register_int_counter_vec_with_registry!(
		"sqlite_s3_request_failures_total",
		"Total sqlite cold-tier request failures.",
		&["node_id", "op"],
		*REGISTRY
	).unwrap();
}

#[cfg(debug_assertions)]
lazy_static::lazy_static! {
	pub static ref SQLITE_TAKEOVER_INVARIANT_VIOLATION_TOTAL: IntCounterVec = register_int_counter_vec_with_registry!(
		"sqlite_takeover_invariant_violation_total",
		"Total debug sqlite takeover invariant violations.",
		&["node_id", "kind"],
		*REGISTRY
	).unwrap();
}

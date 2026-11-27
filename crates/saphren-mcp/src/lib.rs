//! Local Streamable HTTP MCP server for Saphren.
//!
//! Exposes workspace tools over `rmcp` + `axum` and depends only on `saphren-core`.

use axum::Router;

/// Default local bind address for the Saphren MCP server.
pub const DEFAULT_BIND_ADDR: &str = "127.0.0.1:4721";

/// HTTP path where the Streamable HTTP MCP endpoint is mounted.
pub const MCP_PATH: &str = "/mcp";

/// Returns the underlying core version coupled to this MCP crate.
pub fn core_version() -> &'static str {
    saphren_core::VERSION
}

/// Builds a placeholder router for the local MCP HTTP server.
pub fn placeholder_router() -> Router {
    Router::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_core_version_and_defaults() {
        assert!(!core_version().is_empty());
        assert_eq!(DEFAULT_BIND_ADDR, "127.0.0.1:4721");
        assert_eq!(MCP_PATH, "/mcp");
        let _router = placeholder_router();
    }
}

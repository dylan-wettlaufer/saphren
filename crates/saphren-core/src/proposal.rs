use serde::{Deserialize, Serialize};

/// Unique identifier for a pending agent proposal (UUID string).
pub type ProposalId = String;

/// A single line in a computed proposal diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "content", rename_all = "snake_case")]
pub enum DiffLine {
    /// An unchanged line providing context around edits.
    Context(String),
    /// A line added by the proposal.
    Added(String),
    /// A line removed by the proposal.
    Removed(String),
}

/// A staged edit proposed by an MCP agent awaiting explicit user review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingChange {
    /// Unique identifier for this proposal.
    pub id: ProposalId,
    /// Forward-slash path relative to the workspace root.
    pub path: String,
    /// Hex-encoded SHA-256 hash of the content the proposal was generated against.
    pub base_hash: String,
    /// Full proposed file content.
    pub proposed_content: String,
    /// Human-readable reason provided by the agent.
    pub reason: String,
    /// Line-level diff between the base content and `proposed_content`.
    pub diff_lines: Vec<DiffLine>,
    /// ISO-8601 UTC timestamp when the proposal was created.
    pub created_at: String,
}

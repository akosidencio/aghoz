//! Topic validation — §3.

use crate::CONTROL_PREFIX;

/// §3 — a topic is between 1 and 255 **bytes**.
pub const MAX_TOPIC_BYTES: usize = 255;

/// Why a topic was rejected. Bindings map these to `400` responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TopicError {
    /// Zero bytes.
    Empty,
    /// Longer than [`MAX_TOPIC_BYTES`] in UTF-8 bytes.
    TooLong,
    /// Contains a C0 control character or DEL, which would split the frame.
    ControlCharacter,
    /// Begins with `~`, which is reserved for control frames.
    ReservedPrefix,
}

/// Validates a topic for publication or subscription.
///
/// The length bound is in **bytes**, not characters. Measuring UTF-16 units — which is
/// what `String.length` gives in JavaScript, and `len()` gives for a Python `str` —
/// admits topics up to three times over the limit. That is conformance vector T15, and
/// it is a real bug this corpus caught rather than a hypothetical one.
// `bytes[0]` follows the `is_empty` check above.
#[allow(clippy::indexing_slicing)]
pub fn validate_topic(topic: &str) -> Result<(), TopicError> {
    let bytes = topic.as_bytes();
    if bytes.is_empty() {
        return Err(TopicError::Empty);
    }
    if bytes.len() > MAX_TOPIC_BYTES {
        return Err(TopicError::TooLong);
    }
    if bytes[0] == CONTROL_PREFIX {
        return Err(TopicError::ReservedPrefix);
    }
    if bytes.iter().any(|&c| c < 0x20 || c == 0x7f) {
        return Err(TopicError::ControlCharacter);
    }
    Ok(())
}

#[allow(
    // See the note on the integration tests: a test asserts by panicking.
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_and_rejects_per_spec() {
        assert!(validate_topic("org/42/orders").is_ok());
        assert!(validate_topic("a~b").is_ok(), "tilde is reserved only in first position");
        assert!(validate_topic(&"x".repeat(255)).is_ok());

        assert_eq!(validate_topic(""), Err(TopicError::Empty));
        assert_eq!(validate_topic("~gap"), Err(TopicError::ReservedPrefix));
        assert_eq!(validate_topic("a\nb"), Err(TopicError::ControlCharacter));
        assert_eq!(validate_topic(&"x".repeat(256)), Err(TopicError::TooLong));
        // 86 characters, 258 UTF-8 bytes — the vector that catches char-vs-byte length.
        assert_eq!(validate_topic(&"日".repeat(86)), Err(TopicError::TooLong));
    }
}

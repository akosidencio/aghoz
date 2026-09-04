//! Origin validation — §6.0.

/// §6.0 — an origin is between 1 and 64 **bytes**.
///
/// Shorter than a topic on purpose: an origin is a correlation token minted by a client,
/// not a name anyone reads, and a generous bound on a client-supplied string that reaches
/// the wire buys nothing.
pub const MAX_ORIGIN_BYTES: usize = 64;

/// Why an origin was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginError {
    /// Zero bytes. Absent and empty are the same thing; callers pass `None`.
    Empty,
    /// Longer than [`MAX_ORIGIN_BYTES`] in UTF-8 bytes.
    TooLong,
    /// Contains a C0 control character or DEL, which would split the frame.
    ControlCharacter,
}

/// Validates an origin for publication.
///
/// The same shape as [`crate::validate_topic`], minus the reserved prefix — `~` means
/// nothing in this field. What it shares with a topic is the reason it exists at all: the
/// value is written into a frame, so a byte of LF in it ends the frame and everything
/// after parses as a new field. Unlike a topic, an origin comes from whichever client
/// issued the write, which makes it the more exposed of the two and the one that must
/// never be sanitised into validity.
pub fn validate_origin(origin: &str) -> Result<(), OriginError> {
    let bytes = origin.as_bytes();
    if bytes.is_empty() {
        return Err(OriginError::Empty);
    }
    if bytes.len() > MAX_ORIGIN_BYTES {
        return Err(OriginError::TooLong);
    }
    if bytes.iter().any(|&c| c < 0x20 || c == 0x7f) {
        return Err(OriginError::ControlCharacter);
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
        assert!(validate_origin("7f3a1c0e").is_ok());
        assert!(validate_origin("~tilde-is-not-reserved-here").is_ok());
        assert!(validate_origin(&"x".repeat(64)).is_ok());

        assert_eq!(validate_origin(""), Err(OriginError::Empty));
        assert_eq!(validate_origin(&"x".repeat(65)), Err(OriginError::TooLong));
        // The one that matters: an LF would end the frame and forge the next one.
        assert_eq!(validate_origin("a\nid: 1-0"), Err(OriginError::ControlCharacter));
        assert_eq!(validate_origin("a\rb"), Err(OriginError::ControlCharacter));
        // 22 characters, 66 UTF-8 bytes — byte length, not character count.
        assert_eq!(validate_origin(&"日".repeat(22)), Err(OriginError::TooLong));
    }
}

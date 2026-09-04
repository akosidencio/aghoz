//! Frame encoding — §6.

use crate::id::EventId;

/// Encodes one data frame: `id`, `event`, then one `data:` line per segment.
///
/// The payload is split on every CR, LF or CRLF. Emitting it raw is a forgery
/// primitive — a payload containing a blank line ends the frame, and the next line is
/// parsed as `event:` or `id:` — and it is reachable from any user-supplied string that
/// reaches `publish`. Conformance vector E2 exists for exactly this.
///
/// CR and CRLF are normalised to LF on the way out. That is lossy and normative;
/// callers needing byte-exact payloads must encode them, which is why non-string data
/// is JSON-serialised by the bindings.
pub fn encode_frame(id: EventId, topic: &str, payload: &str, origin: Option<&str>) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len().saturating_add(topic.len()).saturating_add(48));

    out.extend_from_slice(b"id: ");
    push_u64(&mut out, id.ms());
    out.push(b'-');
    push_u64(&mut out, id.seq());
    out.push(b'\n');

    out.extend_from_slice(b"event: ");
    out.extend_from_slice(topic.as_bytes());
    out.push(b'\n');

    // §6.0 — omitted entirely when absent, never emitted empty, so a frame without an
    // origin is byte-identical to one from an implementation that predates the field.
    if let Some(origin) = origin.filter(|o| !o.is_empty()) {
        out.extend_from_slice(b"origin: ");
        out.extend_from_slice(origin.as_bytes());
        out.push(b'\n');
    }

    write_data_lines(&mut out, payload.as_bytes());
    out.push(b'\n');
    out
}

/// Encodes a control frame (§7).
///
/// Deliberately carries no `id:`. Control frames are not part of the event sequence and
/// must never advance a client's cursor — if `~gap` had an id, the client would record
/// it and then discard the very replay it was told to expect.
pub fn encode_control(name: &str, json_payload: &str) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(json_payload.len().saturating_add(name.len()).saturating_add(24));
    out.extend_from_slice(b"event: ~");
    out.extend_from_slice(name.as_bytes());
    out.push(b'\n');
    write_data_lines(&mut out, json_payload.as_bytes());
    out.push(b'\n');
    out
}

// Indexing and `+ 1` are bounded by the loop itself: `i < payload.len()` guards every
// read, `start` is only ever set to an index the loop has already passed, and the final
// slice runs from `start` to the end. The alternative — `get`/`split_at_checked` with an
// unreachable arm on each — adds branches that can only be dead and hides the bound
// rather than stating it. 97 conformance vectors pin this function's output byte for byte.
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)]
fn write_data_lines(out: &mut Vec<u8>, payload: &[u8]) {
    let mut start = 0usize;
    let mut i = 0usize;
    while i < payload.len() {
        if payload[i] == b'\r' || payload[i] == b'\n' {
            out.extend_from_slice(b"data: ");
            out.extend_from_slice(&payload[start..i]);
            out.push(b'\n');
            if payload[i] == b'\r' && payload.get(i + 1) == Some(&b'\n') {
                i += 1;
            }
            start = i + 1;
        }
        i += 1;
    }
    out.extend_from_slice(b"data: ");
    out.extend_from_slice(&payload[start..]);
    out.push(b'\n');
}

// `buf` is 20 bytes, which is the digit count of `u64::MAX`, so `i` cannot reach zero
// before `n` does; `n % 10` is a single digit and `n /= 10` terminates.
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)]
fn push_u64(out: &mut Vec<u8>, mut n: u64) {
    if n == 0 {
        out.push(b'0');
        return;
    }
    let mut buf = [0u8; 20];
    let mut i = buf.len();
    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    out.extend_from_slice(&buf[i..]);
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

    fn s(v: Vec<u8>) -> String {
        String::from_utf8(v).unwrap()
    }

    #[test]
    fn no_payload_can_inject_a_field() {
        let f = s(encode_frame(
            EventId::new(1, 0).expect("inside §2's range"),
            "chat",
            "hello\n\nevent: ~gap\ndata: forged",
            None,
        ));
        assert_eq!(
            f,
            "id: 1-0\nevent: chat\ndata: hello\ndata: \ndata: event: ~gap\ndata: data: forged\n\n"
        );
        for line in f.lines().skip(2).filter(|l| !l.is_empty()) {
            assert!(line.starts_with("data: "), "injected: {line}");
        }
    }

    #[test]
    fn control_frames_carry_no_id() {
        let f = s(encode_control("gap", r#"{"reason":"slow-consumer"}"#));
        assert!(!f.contains("id:"));
        assert!(f.starts_with("event: ~gap\n"));
    }
}

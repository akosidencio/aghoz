//! Drives the ABI exactly as a C caller would: raw pointers, manual frees, no Rust
//! conveniences.
//!
//! Run normally this checks behaviour. Run under Miri — `cargo +nightly miri test -p
//! aghoz-abi` — it also checks the unsafe for undefined behaviour: out-of-bounds
//! reads, use-after-free, invalid aliasing, uninitialised memory. That is the actual
//! answer to "how do you know the unsafe is right", and it is why these tests allocate
//! and free rather than leaking on purpose.

// A test asserts by panicking, so the lints that forbid panicking in library code are
// exactly wrong here: `unwrap` on a value the corpus guarantees, or an index into a
// vector this file just built, is the assertion. The library's own targets keep the rule.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use aghoz::*;

/// An absent origin — §6.0's optional field, expressed as a null pointer.
fn none() -> ag_str {
    ag_str { ptr: std::ptr::null(), len: 0 }
}

fn s(text: &str) -> ag_str {
    ag_str { ptr: text.as_ptr(), len: text.len() }
}

/// Reads a frame out of a publish result the way a binding would.
///
/// # Safety
/// `result` must be a live result from `ag_publish` or `ag_append`.
unsafe fn frame_of(result: *const ag_publish_result) -> String {
    let mut len = 0usize;
    // SAFETY: the caller guarantees a live result, which is what this accessor wants.
    let ptr = unsafe { ag_publish_frame(result, &mut len) };
    assert!(!ptr.is_null());
    // SAFETY: `ag_publish_frame` just wrote the frame's own length through `len`, and
    // the bytes it points at live until the result is freed.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[test]
fn version_is_exposed() {
    assert_eq!(ag_abi_version(), AG_ABI_VERSION);
}

#[test]
fn publish_produces_a_frame_and_is_freed_cleanly() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        assert!(!hub.is_null());

        let mut result: *mut ag_publish_result = std::ptr::null_mut();
        let code = ag_publish(
            hub,
            1755083412346,
            s("org/42/orders"),
            s(r#"{"id":"ord_918"}"#),
            none(),
            &mut result,
        );
        assert_eq!(code, AG_OK);
        assert!(!result.is_null());

        assert_eq!(
            frame_of(result),
            "id: 1755083412346-0\nevent: org/42/orders\ndata: {\"id\":\"ord_918\"}\n\n"
        );

        let (mut ms, mut seq) = (0u64, 0u64);
        ag_publish_id(result, &mut ms, &mut seq);
        assert_eq!((ms, seq), (1755083412346, 0));

        ag_publish_result_free(result);
        ag_hub_free(hub);
    }
}

#[test]
fn a_payload_containing_a_blank_line_cannot_inject() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();
        assert_eq!(
            ag_publish(
                hub,
                1,
                s("chat"),
                s("hello\n\nevent: ~gap\ndata: forged"),
                none(),
                &mut result
            ),
            AG_OK
        );
        let frame = frame_of(result);
        for line in frame.lines().skip(2).filter(|l| !l.is_empty()) {
            assert!(line.starts_with("data: "), "injected line: {line}");
        }
        ag_publish_result_free(result);
        ag_hub_free(hub);
    }
}

#[test]
fn a_payload_may_contain_nul() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        // Rule 2 in the module docs: nothing is assumed null-terminated. A `strlen` here
        // would truncate the payload at the NUL and silently deliver half the data.
        let hub = ag_hub_new(std::ptr::null());
        let payload = "before\u{0}after";
        let mut result: *mut ag_publish_result = std::ptr::null_mut();
        assert_eq!(ag_publish(hub, 1, s("t"), s(payload), none(), &mut result), AG_OK);
        assert!(frame_of(result).contains("before\u{0}after"));
        ag_publish_result_free(result);
        ag_hub_free(hub);
    }
}

#[test]
fn topic_errors_map_to_distinct_codes() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();

        let cases = [
            ("", AG_ERR_TOPIC_EMPTY),
            ("~gap", AG_ERR_TOPIC_RESERVED),
            ("a\nb", AG_ERR_TOPIC_CONTROL),
        ];
        for (topic, expected) in cases {
            assert_eq!(
                ag_publish(hub, 1, s(topic), s("x"), none(), &mut result),
                expected,
                "topic {topic:?}"
            );
        }
        let long = "x".repeat(256);
        assert_eq!(
            ag_publish(hub, 1, s(&long), s("x"), none(), &mut result),
            AG_ERR_TOPIC_TOO_LONG
        );

        ag_hub_free(hub);
    }
}

#[test]
fn subscribe_matches_publish_and_replays_from_a_cursor() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());

        // Three events, remembering the first id as a cursor.
        let mut first_ms = 0u64;
        let mut first_seq = 0u64;
        for (i, body) in ["one", "two", "three"].iter().enumerate() {
            let mut r: *mut ag_publish_result = std::ptr::null_mut();
            assert_eq!(ag_publish(hub, 1000 + i as u64, s("t"), s(body), none(), &mut r), AG_OK);
            if i == 0 {
                ag_publish_id(r, &mut first_ms, &mut first_seq);
            }
            ag_publish_result_free(r);
        }

        let topics = [s("t")];
        let mut sub: *mut ag_subscribe_result = std::ptr::null_mut();
        let code = ag_subscribe(
            hub,
            topics.as_ptr(),
            topics.len(),
            s(""),
            1,
            first_ms,
            first_seq,
            &mut sub,
        );
        assert_eq!(code, AG_OK);
        assert_eq!(ag_subscribe_checkpoint(sub), AG_CHECKPOINT_ECHO);
        assert_ne!(ag_subscribe_id(sub), 0);

        // The cursor event itself is not replayed.
        assert_eq!(ag_subscribe_replay_count(sub), 2);
        let mut len = 0usize;
        let ptr = ag_subscribe_replay_at(sub, 0, &mut len);
        let first = std::slice::from_raw_parts(ptr, len);
        assert!(String::from_utf8_lossy(first).contains("data: two"));

        // Out-of-range index is null rather than undefined behaviour.
        assert!(ag_subscribe_replay_at(sub, 99, &mut len).is_null());

        let sub_id = ag_subscribe_id(sub);
        ag_subscribe_result_free(sub);

        // A later publish targets the subscriber.
        let mut r: *mut ag_publish_result = std::ptr::null_mut();
        assert_eq!(ag_publish(hub, 2000, s("t"), s("four"), none(), &mut r), AG_OK);
        let mut count = 0usize;
        let targets = ag_publish_targets(r, &mut count);
        assert_eq!(count, 1);
        assert_eq!(*targets, sub_id);
        ag_publish_result_free(r);

        ag_hub_free(hub);
    }
}

#[test]
fn a_truncated_cursor_reports_earliest() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let cfg = ag_config { max_history_bytes: 400, ..Default::default() };
        let hub = ag_hub_new(&cfg);

        let mut first_ms = 0u64;
        let mut first_seq = 0u64;
        for i in 0..30u64 {
            let mut r: *mut ag_publish_result = std::ptr::null_mut();
            let body = "x".repeat(90);
            assert_eq!(ag_publish(hub, 1000 + i, s("t"), s(&body), none(), &mut r), AG_OK);
            if i == 0 {
                ag_publish_id(r, &mut first_ms, &mut first_seq);
            }
            ag_publish_result_free(r);
        }

        let topics = [s("t")];
        let mut sub: *mut ag_subscribe_result = std::ptr::null_mut();
        assert_eq!(
            ag_subscribe(
                hub,
                topics.as_ptr(),
                topics.len(),
                s(""),
                1,
                first_ms,
                first_seq,
                &mut sub
            ),
            AG_OK
        );
        assert_eq!(ag_subscribe_checkpoint(sub), AG_CHECKPOINT_EARLIEST);

        let gap = ag_gap_frame(hub, ag_subscribe_id(sub), AG_GAP_HISTORY_TRUNCATED);
        assert!(!gap.is_null());
        let mut len = 0usize;
        let ptr = ag_buf_data(gap, &mut len);
        let text = String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len)).to_string();
        assert!(text.starts_with("event: ~gap\n"));
        assert!(text.contains("history-truncated"));
        assert!(!text.contains("id:"), "control frames must not advance a cursor");
        ag_buf_free(gap);

        ag_subscribe_result_free(sub);
        ag_hub_free(hub);
    }
}

#[test]
fn connection_caps_and_removal() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let cfg = ag_config { max_connections: 1, ..Default::default() };
        let hub = ag_hub_new(&cfg);
        let topics = [s("t")];

        let mut a: *mut ag_subscribe_result = std::ptr::null_mut();
        assert_eq!(ag_subscribe(hub, topics.as_ptr(), 1, s(""), 0, 0, 0, &mut a), AG_OK);
        assert_eq!(ag_connection_count(hub), 1);

        let mut b: *mut ag_subscribe_result = std::ptr::null_mut();
        assert_eq!(
            ag_subscribe(hub, topics.as_ptr(), 1, s(""), 0, 0, 0, &mut b),
            AG_ERR_MAX_CONNECTIONS
        );

        let id = ag_subscribe_id(a);
        assert_eq!(ag_remove(hub, id), 1);
        assert_eq!(ag_remove(hub, id), 0, "removal is idempotent");
        assert_eq!(ag_connection_count(hub), 0);

        ag_subscribe_result_free(a);
        ag_hub_free(hub);
    }
}

#[test]
fn buffer_verdicts() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let cfg = ag_config { max_buffer_bytes: 1000, ..Default::default() };
        let hub = ag_hub_new(&cfg);
        let topics = [s("t")];
        let mut sub: *mut ag_subscribe_result = std::ptr::null_mut();
        assert_eq!(ag_subscribe(hub, topics.as_ptr(), 1, s(""), 0, 0, 0, &mut sub), AG_OK);
        let id = ag_subscribe_id(sub);

        assert_eq!(ag_note_buffer(hub, id, 1000), AG_BUFFER_OK, "at the limit is not over it");
        assert_eq!(ag_note_buffer(hub, id, 1001), AG_BUFFER_SLOW_CONSUMER);
        assert_eq!(ag_note_buffer(hub, id, 0), AG_BUFFER_OK, "a drained socket recovers");
        assert_eq!(ag_note_buffer(hub, 99_999, 0), AG_BUFFER_UNKNOWN);

        ag_subscribe_result_free(sub);
        ag_hub_free(hub);
    }
}

#[test]
fn cursor_starts_at_zero_and_advances() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let (mut ms, mut seq) = (7u64, 7u64);
        assert_eq!(ag_cursor(hub, &mut ms, &mut seq), AG_OK);
        assert_eq!((ms, seq), (0, 0));

        let mut r: *mut ag_publish_result = std::ptr::null_mut();
        ag_publish(hub, 1234, s("t"), s("v"), none(), &mut r);
        ag_publish_result_free(r);

        assert_eq!(ag_cursor(hub, &mut ms, &mut seq), AG_OK);
        assert_eq!((ms, seq), (1234, 0));
        ag_hub_free(hub);
    }
}

#[test]
fn null_arguments_are_errors_not_crashes() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        // A binding with a bug must get a status code back, not take the host process down.
        let mut result: *mut ag_publish_result = std::ptr::null_mut();
        assert_eq!(
            ag_publish(std::ptr::null_mut(), 1, s("t"), s("x"), none(), &mut result),
            AG_ERR_NULL
        );

        let hub = ag_hub_new(std::ptr::null());
        assert_eq!(ag_publish(hub, 1, s("t"), s("x"), none(), std::ptr::null_mut()), AG_ERR_NULL);
        assert_eq!(ag_cursor(hub, std::ptr::null_mut(), std::ptr::null_mut()), AG_ERR_NULL);
        assert_eq!(ag_subscribe_id(std::ptr::null()), 0);
        assert_eq!(ag_subscribe_replay_count(std::ptr::null()), 0);

        // Frees tolerate null.
        ag_hub_free(std::ptr::null_mut());
        ag_buf_free(std::ptr::null_mut());
        ag_publish_result_free(std::ptr::null_mut());
        ag_subscribe_result_free(std::ptr::null_mut());

        ag_hub_free(hub);
    }
}

#[test]
fn invalid_utf8_is_rejected_rather_than_reinterpreted() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let bad = [0xffu8, 0xfe];
        let topic = ag_str { ptr: bad.as_ptr(), len: bad.len() };
        let mut result: *mut ag_publish_result = std::ptr::null_mut();
        assert_eq!(ag_publish(hub, 1, topic, s("x"), none(), &mut result), AG_ERR_UTF8);
        ag_hub_free(hub);
    }
}

#[test]
fn zeroed_config_means_defaults() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        // A caller that memsets the struct must get a working hub, not one that refuses
        // every connection because every limit read as zero.
        let cfg = ag_config::default();
        let hub = ag_hub_new(&cfg);
        let topics = [s("t")];
        let mut sub: *mut ag_subscribe_result = std::ptr::null_mut();
        assert_eq!(ag_subscribe(hub, topics.as_ptr(), 1, s(""), 0, 0, 0, &mut sub), AG_OK);
        ag_subscribe_result_free(sub);
        ag_hub_free(hub);
    }
}

#[test]
fn origin_is_echoed_on_the_frame() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();

        assert_eq!(ag_publish(hub, 1, s("t"), s("v"), s("7f3a1c0e"), &mut result), AG_OK);
        assert_eq!(frame_of(result), "id: 1-0\nevent: t\norigin: 7f3a1c0e\ndata: v\n\n");
        ag_publish_result_free(result);
        ag_hub_free(hub);
    }
}

#[test]
fn an_empty_origin_means_absent_rather_than_an_error() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        // Bindings produce empty strings where a value was missing — `?? ''` in JavaScript,
        // a header that was not sent — and both cores treat that as "no origin". Rejecting
        // it would make the ordinary case the one that throws.
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();

        assert_eq!(ag_publish(hub, 1, s("t"), s("v"), s(""), &mut result), AG_OK);
        assert_eq!(frame_of(result), "id: 1-0\nevent: t\ndata: v\n\n");
        ag_publish_result_free(result);
        ag_hub_free(hub);
    }
}

#[test]
fn an_absent_origin_is_a_null_pointer_and_omits_the_field() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();

        // Byte-identical to what an implementation predating the field would emit — which
        // is what makes §6.0 additive rather than a version.
        assert_eq!(ag_publish(hub, 1, s("t"), s("v"), none(), &mut result), AG_OK);
        assert_eq!(frame_of(result), "id: 1-0\nevent: t\ndata: v\n\n");
        ag_publish_result_free(result);
        ag_hub_free(hub);
    }
}

#[test]
fn a_rejected_origin_never_reaches_the_wire() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();

        // The one that matters: an LF would end the frame and forge the next one.
        assert_eq!(
            ag_publish(hub, 1, s("t"), s("v"), s("a\nid: 9-9"), &mut result),
            AG_ERR_ORIGIN_CONTROL
        );
        assert_eq!(
            ag_publish(hub, 1, s("t"), s("v"), s(&"x".repeat(65)), &mut result),
            AG_ERR_ORIGIN_TOO_LONG
        );
        // `out` is untouched on error, so nothing was allocated and nothing leaks.
        assert!(result.is_null());

        // And no id was consumed by either rejection.
        assert_eq!(ag_publish(hub, 1, s("t"), s("v"), none(), &mut result), AG_OK);
        assert_eq!(frame_of(result), "id: 1-0\nevent: t\ndata: v\n\n");
        ag_publish_result_free(result);
        ag_hub_free(hub);
    }
}

// ---------------------------------------------------------------- ABI 3000: append

#[test]
fn append_uses_the_supplied_id_and_frees_cleanly() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();

        let code = ag_append(hub, s("1755083412346-4"), s("t"), s("v"), none(), &mut result);
        assert_eq!(code, AG_OK);
        assert_eq!(frame_of(result), "id: 1755083412346-4\nevent: t\ndata: v\n\n");

        let (mut ms, mut seq) = (0u64, 0u64);
        ag_publish_id(result, &mut ms, &mut seq);
        assert_eq!((ms, seq), (1755083412346, 4));

        ag_publish_result_free(result);
        ag_hub_free(hub);
    }
}

#[test]
fn append_advances_the_cursor_so_local_ids_cannot_collide() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();

        assert_eq!(ag_append(hub, s("1000-4"), s("t"), s("v"), none(), &mut result), AG_OK);
        ag_publish_result_free(result);

        let (mut ms, mut seq) = (0u64, 0u64);
        assert_eq!(ag_cursor(hub, &mut ms, &mut seq), AG_OK);
        assert_eq!((ms, seq), (1000, 4));

        // Falling back to local assignment in the same millisecond the sequencer was using
        // must not reissue an id another process already spent.
        result = std::ptr::null_mut();
        assert_eq!(ag_publish(hub, 1000, s("t"), s("v"), none(), &mut result), AG_OK);
        assert_eq!(frame_of(result), "id: 1000-5\nevent: t\ndata: v\n\n");
        ag_publish_result_free(result);
        ag_hub_free(hub);
    }
}

#[test]
fn a_malformed_id_is_rejected_rather_than_coerced() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();

        // §2.1 is canonical: no padding, no signs, no exponents, no empty halves. Coercing
        // any of these would let two processes disagree about which event an id names.
        for bad in ["", "1", "-0", "1-", "01-0", "1-00", "a-b", "1e5-0", " 1-0", "1-0 "] {
            assert_eq!(
                ag_append(hub, s(bad), s("t"), s("v"), none(), &mut result),
                AG_ERR_MALFORMED_ID,
                "should reject {bad:?}"
            );
            assert!(result.is_null(), "nothing may be allocated for {bad:?}");
        }

        // A rejected append records nothing, so the cursor has not moved.
        let (mut ms, mut seq) = (1u64, 1u64);
        assert_eq!(ag_cursor(hub, &mut ms, &mut seq), AG_OK);
        assert_eq!((ms, seq), (0, 0));
        ag_hub_free(hub);
    }
}

#[test]
fn append_enforces_the_same_injection_defence_as_publish() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();

        assert_eq!(
            ag_append(hub, s("1-0"), s("~gap"), s("v"), none(), &mut result),
            AG_ERR_TOPIC_RESERVED
        );
        assert_eq!(
            ag_append(hub, s("1-0"), s("t"), s("v"), s("a\nid: 9-9"), &mut result),
            AG_ERR_ORIGIN_CONTROL
        );
        assert!(result.is_null());
        ag_hub_free(hub);
    }
}

#[test]
fn append_matches_subscribers_like_publish() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let topics = [s("t")];
        let mut sub: *mut ag_subscribe_result = std::ptr::null_mut();
        assert_eq!(ag_subscribe(hub, topics.as_ptr(), 1, none(), 0, 0, 0, &mut sub), AG_OK);
        let sub_id = ag_subscribe_id(sub);
        ag_subscribe_result_free(sub);

        let mut result: *mut ag_publish_result = std::ptr::null_mut();
        assert_eq!(ag_append(hub, s("1-0"), s("t"), s("v"), none(), &mut result), AG_OK);
        let mut count = 0usize;
        let targets = ag_publish_targets(result, &mut count);
        assert_eq!(count, 1);
        assert_eq!(*targets, sub_id);
        ag_publish_result_free(result);
        ag_hub_free(hub);
    }
}

// ---------------------------------------------------------------- ABI 3000: encode

#[test]
fn encode_produces_the_frame_publish_would_have() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();
        assert_eq!(ag_publish(hub, 1000, s("t"), s("v"), s("tab-7"), &mut result), AG_OK);
        let published = frame_of(result);
        ag_publish_result_free(result);

        let other = ag_hub_new(std::ptr::null());
        let mut buf: *mut ag_buf = std::ptr::null_mut();
        assert_eq!(ag_encode(other, s("1000-0"), s("t"), s("v"), s("tab-7"), &mut buf), AG_OK);
        let mut len = 0usize;
        let ptr = ag_buf_data(buf, &mut len);
        let encoded = String::from_utf8(std::slice::from_raw_parts(ptr, len).to_vec()).unwrap();
        ag_buf_free(buf);

        assert_eq!(published, encoded, "one encoder, or the wire diverges");
        ag_hub_free(hub);
        ag_hub_free(other);
    }
}

#[test]
fn encode_records_nothing() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut buf: *mut ag_buf = std::ptr::null_mut();
        assert_eq!(ag_encode(hub, s("9999-9"), s("t"), s("v"), none(), &mut buf), AG_OK);
        ag_buf_free(buf);

        // Neither the cursor nor history may have moved — this is the whole reason encode
        // exists separately from append.
        let (mut ms, mut seq) = (1u64, 1u64);
        assert_eq!(ag_cursor(hub, &mut ms, &mut seq), AG_OK);
        assert_eq!((ms, seq), (0, 0));
        ag_hub_free(hub);
    }
}

#[test]
fn encode_rejects_what_it_must_and_allocates_nothing() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut buf: *mut ag_buf = std::ptr::null_mut();

        assert_eq!(
            ag_encode(hub, s("nope"), s("t"), s("v"), none(), &mut buf),
            AG_ERR_MALFORMED_ID
        );
        assert_eq!(
            ag_encode(hub, s("1-0"), s("~gap"), s("v"), none(), &mut buf),
            AG_ERR_TOPIC_RESERVED
        );
        assert_eq!(
            ag_encode(hub, s("1-0"), s("t"), s("v"), s("a\nid: 9-9"), &mut buf),
            AG_ERR_ORIGIN_CONTROL
        );
        assert!(buf.is_null());
        ag_hub_free(hub);
    }
}

#[test]
fn append_and_encode_reject_a_null_out_pointer() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        assert_eq!(
            ag_append(hub, s("1-0"), s("t"), s("v"), none(), std::ptr::null_mut()),
            AG_ERR_NULL
        );
        assert_eq!(
            ag_encode(hub, s("1-0"), s("t"), s("v"), none(), std::ptr::null_mut()),
            AG_ERR_NULL
        );
        // And a null hub, which a binding hits if it ignores an ag_hub_new failure.
        let mut result: *mut ag_publish_result = std::ptr::null_mut();
        assert_eq!(
            ag_append(std::ptr::null_mut(), s("1-0"), s("t"), s("v"), none(), &mut result),
            AG_ERR_NULL
        );
        ag_hub_free(hub);
    }
}

#[test]
fn an_out_of_order_append_never_drags_the_cursor_backwards() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();

        assert_eq!(ag_append(hub, s("1000-4"), s("t"), s("v"), none(), &mut result), AG_OK);
        ag_publish_result_free(result);
        result = std::ptr::null_mut();
        assert_eq!(ag_append(hub, s("999-0"), s("t"), s("v"), none(), &mut result), AG_OK);
        ag_publish_result_free(result);

        let (mut ms, mut seq) = (0u64, 0u64);
        assert_eq!(ag_cursor(hub, &mut ms, &mut seq), AG_OK);
        assert_eq!((ms, seq), (1000, 4), "an older event must not rewind the cursor");
        ag_hub_free(hub);
    }
}

// ------------------------------------------------- ABI 3100: delta backpressure

/// Subscribes to topic `t` on a hub whose buffer cap is `max_buffer_bytes`.
fn capped_sub(max_buffer_bytes: u64) -> (*mut ag_hub, u64) {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let config = ag_config { max_buffer_bytes, ..ag_config::default() };
        let hub = ag_hub_new(&config);
        let topics = [s("t")];
        let mut sub: *mut ag_subscribe_result = std::ptr::null_mut();
        assert_eq!(ag_subscribe(hub, topics.as_ptr(), 1, none(), 0, 0, 0, &mut sub), AG_OK);
        let id = ag_subscribe_id(sub);
        ag_subscribe_result_free(sub);
        (hub, id)
    }
}

#[test]
fn sent_and_flushed_accumulate_toward_one_threshold() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let (hub, id) = capped_sub(100);
        assert_eq!(ag_note_sent(hub, id, 60), AG_BUFFER_OK);
        assert_eq!(ag_note_sent(hub, id, 60), AG_BUFFER_SLOW_CONSUMER);
        // Draining brings it back under, so a subscriber that catches up is kept.
        assert_eq!(ag_note_flushed(hub, id, 100), AG_BUFFER_OK);
        ag_hub_free(hub);
    }
}

#[test]
fn the_delta_path_reaches_the_same_verdict_as_the_absolute_one() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let (absolute, a) = capped_sub(100);
        let (delta, d) = capped_sub(100);
        // §8.2's rule is about outstanding bytes; how a host arrived at the number must not
        // change the answer, or the same traffic drops a subscriber in Python and not in Node.
        assert_eq!(ag_note_buffer(absolute, a, 120), ag_note_sent(delta, d, 120));
        ag_hub_free(absolute);
        ag_hub_free(delta);
    }
}

#[test]
fn the_cap_is_exclusive_on_the_delta_path_too() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let (hub, id) = capped_sub(100);
        assert_eq!(ag_note_sent(hub, id, 100), AG_BUFFER_OK, "at the cap is not past it");
        assert_eq!(ag_note_sent(hub, id, 1), AG_BUFFER_SLOW_CONSUMER);
        ag_hub_free(hub);
    }
}

#[test]
fn an_over_reported_flush_cannot_underflow_the_counter() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let (hub, id) = capped_sub(100);
        assert_eq!(ag_note_sent(hub, id, 10), AG_BUFFER_OK);
        // Wrapping here would put the subscriber usize::MAX bytes behind and drop it while
        // it is entirely caught up.
        assert_eq!(ag_note_flushed(hub, id, 9_999), AG_BUFFER_OK);
        assert_eq!(ag_note_sent(hub, id, 1), AG_BUFFER_OK, "the counter really is at zero");
        ag_hub_free(hub);
    }
}

#[test]
fn a_missed_flush_cannot_wrap_the_counter_to_zero() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let (hub, id) = capped_sub(100);
        assert_eq!(ag_note_sent(hub, id, u64::MAX), AG_BUFFER_SLOW_CONSUMER);
        // Wrapping would read as a perfectly healthy subscriber at the moment it is furthest
        // behind — the one failure mode worth engineering against here.
        assert_eq!(ag_note_sent(hub, id, 4_096), AG_BUFFER_SLOW_CONSUMER);
        ag_hub_free(hub);
    }
}

#[test]
fn every_backpressure_entry_point_answers_unknown_for_a_gone_subscriber() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let (hub, id) = capped_sub(100);
        assert_eq!(ag_remove(hub, id), 1);
        // A write completing after teardown. All three must agree, or a host using one style
        // silently misses a drop the other would have reported.
        assert_eq!(ag_note_buffer(hub, id, 1), AG_BUFFER_UNKNOWN);
        assert_eq!(ag_note_sent(hub, id, 1), AG_BUFFER_UNKNOWN);
        assert_eq!(ag_note_flushed(hub, id, 1), AG_BUFFER_UNKNOWN);
        ag_hub_free(hub);
    }
}

#[test]
fn the_delta_entry_points_reject_a_null_hub() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        assert_eq!(ag_note_sent(std::ptr::null_mut(), 1, 1), AG_ERR_NULL);
        assert_eq!(ag_note_flushed(std::ptr::null_mut(), 1, 1), AG_ERR_NULL);
    }
}

// ------------------------------------------------------ ABI 3200: id comparison

#[test]
fn compare_ids_orders_numerically_not_lexicographically() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let mut out = 0i32;
        // The one every string comparison gets backwards, and the reason this is exposed at
        // all rather than left to each binding.
        assert_eq!(ag_compare_ids(s("1755083412345-7"), s("1755083412345-10"), &mut out), AG_OK);
        assert_eq!(out, -1);
        assert_eq!(ag_compare_ids(s("1755083412345-10"), s("1755083412345-7"), &mut out), AG_OK);
        assert_eq!(out, 1);
        assert_eq!(ag_compare_ids(s("1000-0"), s("1000-0"), &mut out), AG_OK);
        assert_eq!(out, 0);
        // ms dominates seq.
        assert_eq!(ag_compare_ids(s("2-0"), s("1-999"), &mut out), AG_OK);
        assert_eq!(out, 1);
    }
}

#[test]
fn compare_ids_rejects_a_non_canonical_side() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let mut out = 7i32;
        assert_eq!(ag_compare_ids(s("01-0"), s("1-0"), &mut out), AG_ERR_MALFORMED_ID);
        assert_eq!(ag_compare_ids(s("1-0"), s("nonsense"), &mut out), AG_ERR_MALFORMED_ID);
        assert_eq!(out, 7, "out is untouched on error");
        assert_eq!(ag_compare_ids(s("1-0"), s("2-0"), std::ptr::null_mut()), AG_ERR_NULL);
    }
}

#[test]
fn a_clock_in_the_wrong_unit_is_refused_rather_than_minted() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let mut result: *mut ag_publish_result = std::ptr::null_mut();

        // Nanoseconds where §2 wants milliseconds — the way a binding actually gets this
        // wrong. Minting the id anyway would put a number on the wire that every
        // JavaScript client rounds to a different event.
        let code = ag_publish(hub, 1_757_000_000_000_000_000, s("t"), s("x"), none(), &mut result);
        assert_eq!(code, AG_ERR_MALFORMED_ID);
        assert!(result.is_null(), "*out must be untouched on error");

        // And the refusal spent no id: the next publish is still the first one.
        let code = ag_publish(hub, 1_755_083_412_346, s("t"), s("x"), none(), &mut result);
        assert_eq!(code, AG_OK);
        let (mut ms, mut seq) = (0u64, 0u64);
        ag_publish_id(result, &mut ms, &mut seq);
        assert_eq!((ms, seq), (1_755_083_412_346, 0));

        ag_publish_result_free(result);
        ag_hub_free(hub);
    }
}

#[test]
fn a_cursor_outside_the_id_range_is_rejected() {
    // SAFETY: every pointer below either came from this ABI — a handle from
    // `ag_hub_new`, a result from `ag_publish` — or points at a live local, and
    // each is freed exactly once. Miri runs this file to check that claim.
    unsafe {
        let hub = ag_hub_new(std::ptr::null());
        let topics = [s("t")];
        let mut result: *mut ag_subscribe_result = std::ptr::null_mut();

        // The one id that never passes the parser, because it arrives as two integers.
        let code = ag_subscribe(hub, topics.as_ptr(), 1, none(), 1, u64::MAX, 0, &mut result);
        assert_eq!(code, AG_ERR_MALFORMED_ID);
        assert!(result.is_null());
        assert_eq!(ag_connection_count(hub), 0, "a refused cursor registers nobody");

        // The boundary itself is still a cursor.
        let code =
            ag_subscribe(hub, topics.as_ptr(), 1, none(), 1, 9_007_199_254_740_991, 0, &mut result);
        assert_eq!(code, AG_OK);
        ag_subscribe_result_free(result);
        ag_hub_free(hub);
    }
}

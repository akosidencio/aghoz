//! Runs the shared corpus at `../conformance/vectors.json` — the same file the
//! JavaScript runner consumes.
//!
//! A vector added once is enforced on every implementation. That property is the entire
//! reason more than one implementation of this protocol is a defensible position, so it
//! must never fork.

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

use aghoz_core::{
    encode_frame, validate_origin, validate_topic, BufferVerdict, Checkpoint, EventId, Hub,
    HubConfig,
};
use serde_json::Value;

fn corpus() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/vectors.json");
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read the corpus at {path}: {e}"));
    serde_json::from_str(&raw).expect("corpus is not valid JSON")
}

#[test]
fn encode_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["encode"].as_array().unwrap() {
        let id = EventId::new(v["ms"].as_u64().unwrap(), v["seq"].as_u64().unwrap())
            .expect("every vector id is inside §2's range");
        let got = String::from_utf8(encode_frame(
            id,
            v["topic"].as_str().unwrap(),
            v["payload"].as_str().unwrap(),
            v["origin"].as_str(),
        ))
        .unwrap();
        let want = v["frame"].as_str().unwrap();
        if got != want {
            failures.push(format!(
                "  {}  {}\n      expected: {want:?}\n      actual:   {got:?}",
                v["id"].as_str().unwrap(),
                v["desc"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn topic_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["topic"].as_array().unwrap() {
        let got = validate_topic(v["topic"].as_str().unwrap()).is_ok();
        let want = v["valid"].as_bool().unwrap();
        if got != want {
            failures.push(format!(
                "  {}  {}\n      expected valid={want}, got {got}",
                v["id"].as_str().unwrap(),
                v["desc"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn origin_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["origin"].as_array().unwrap() {
        let got = validate_origin(v["origin"].as_str().unwrap()).is_ok();
        let want = v["valid"].as_bool().unwrap();
        if got != want {
            failures.push(format!(
                "  {}  {}\n      expected valid={want}, got {got}",
                v["id"].as_str().unwrap(),
                v["desc"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn id_order_vectors() {
    let c = corpus();
    for v in c["idOrder"].as_array().unwrap() {
        let a = v["a"].as_array().unwrap();
        let b = v["b"].as_array().unwrap();
        let a = EventId::new(a[0].as_u64().unwrap(), a[1].as_u64().unwrap()).unwrap();
        let b = EventId::new(b[0].as_u64().unwrap(), b[1].as_u64().unwrap()).unwrap();
        let got = match a.cmp(&b) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        };
        assert_eq!(
            got,
            v["cmp"].as_i64().unwrap(),
            "{}  {}",
            v["id"].as_str().unwrap(),
            v["desc"].as_str().unwrap()
        );
    }
}

/// §4.5 / §7.1 — whether a reconnecting client is told it missed events.
///
/// Runs the same corpus the JavaScript runner does. This category exists because the two
/// implementations diverging here would be invisible: both would serve a stream, and only
/// one would be honest about what it had dropped.
#[test]
fn checkpoint_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["checkpoint"].as_array().unwrap() {
        let config = HubConfig {
            max_history_bytes: v["maxHistoryBytes"]
                .as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .unwrap(),
            ..HubConfig::default()
        };
        let mut hub = Hub::new(config);
        for p in v["publishes"].as_array().unwrap() {
            let a = p.as_array().unwrap();
            hub.publish(
                a[0].as_u64().unwrap(),
                a[1].as_str().unwrap(),
                a[2].as_str().unwrap(),
                None,
            )
            .unwrap();
        }

        let cursor = v["cursor"].as_array().map(|a| {
            EventId::new(a[0].as_u64().unwrap(), a[1].as_u64().unwrap())
                .expect("every vector cursor is inside §2's range")
        });
        let effect = hub.subscribe(vec!["t".to_string()], None, cursor).unwrap();
        let got = match effect.checkpoint {
            Checkpoint::Absent => "absent",
            Checkpoint::Echo(_) => "echo",
            Checkpoint::Earliest => "earliest",
        };
        let want = v["expected"].as_str().unwrap();
        if got != want {
            failures.push(format!(
                "  {}  {}\n      expected: {want}\n      actual:   {got}",
                v["id"].as_str().unwrap(),
                v["desc"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// §2.1 — which strings are ids at all.
///
/// This group exists because the rule reaches the wire from two directions — a client's
/// `Last-Event-ID` and a backplane-assigned id — and because it caught a real divergence:
/// §2 once said "unsigned 64-bit", which no JavaScript host can represent, so this core
/// accepted ids the TypeScript one refused. See DECISIONS.md D9.
#[test]
fn id_parse_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["idParse"].as_array().unwrap() {
        let raw = v["raw"].as_str().unwrap();
        let got = EventId::parse(raw).is_some();
        let want = v["valid"].as_bool().unwrap();
        if got != want {
            failures.push(format!(
                "  {}  {}\n      expected valid={want}, got {got} for {raw:?}",
                v["id"].as_str().unwrap(),
                v["desc"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// The externally-assigned-id path — what a backplane, and therefore every multi-worker
/// runtime, depends on.
#[test]
fn append_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["append"].as_array().unwrap() {
        let mut hub = Hub::new(HubConfig::default());
        let mut frames: Vec<String> = Vec::new();

        for op in v["ops"].as_array().unwrap() {
            let a = op.as_array().unwrap();
            let topic = a[2].as_str().unwrap();
            let payload = a[3].as_str().unwrap();
            // JSON has no undefined; an absent origin arrives as null.
            let origin = a[4].as_str();

            let bytes = match a[0].as_str().unwrap() {
                "publish" => {
                    hub.publish(a[1].as_u64().unwrap(), topic, payload, origin).unwrap().frame
                }
                "append" => {
                    let id =
                        EventId::parse(a[1].as_str().unwrap()).expect("corpus id is canonical");
                    hub.append(id, topic, payload, origin).unwrap().frame
                }
                "encode" => {
                    let id =
                        EventId::parse(a[1].as_str().unwrap()).expect("corpus id is canonical");
                    hub.encode(id, topic, payload, origin).unwrap()
                }
                other => panic!("unknown op: {other}"),
            };
            frames.push(String::from_utf8(bytes).unwrap());
        }

        let want_frames: Vec<String> = v["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let want_cursor = v["cursor"].as_str().unwrap();
        let got_cursor = hub.cursor().to_string();

        if frames != want_frames || got_cursor != want_cursor {
            failures.push(format!(
                "  {}  {}\n      expected: frames={want_frames:?} cursor={want_cursor}\n      actual:   frames={frames:?} cursor={got_cursor}",
                v["id"].as_str().unwrap(),
                v["desc"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// §8.2 — whether a subscriber that cannot drain its socket is dropped.
///
/// Two ways to feed one counter, because the absolute depth Node reads off
/// `res.writableLength` is a question ASGI, `net/http` and Swoole cannot answer. Both must
/// reach the same verdict from the same outstanding total, or identical traffic drops a
/// subscriber in one language and not in another.
#[test]
fn buffer_vectors() {
    let c = corpus();
    let mut failures = Vec::new();
    for v in c["buffer"].as_array().unwrap() {
        let config = HubConfig {
            max_buffer_bytes: v["maxBufferBytes"]
                .as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .unwrap(),
            ..HubConfig::default()
        };
        let mut hub = Hub::new(config);
        let id = hub.subscribe(vec!["t".to_string()], None, None).unwrap().id;

        let got: Vec<&str> = v["ops"]
            .as_array()
            .unwrap()
            .iter()
            .map(|op| {
                let a = op.as_array().unwrap();
                let n = a[1].as_u64().and_then(|v| usize::try_from(v).ok()).unwrap();
                let verdict = match a[0].as_str().unwrap() {
                    "buffer" => hub.note_buffer(id, n),
                    "sent" => hub.note_sent(id, n),
                    "flushed" => hub.note_flushed(id, n),
                    other => panic!("unknown op: {other}"),
                };
                match verdict {
                    BufferVerdict::Ok => "ok",
                    BufferVerdict::SlowConsumer => "slow-consumer",
                    BufferVerdict::Unknown => "unknown",
                }
            })
            .collect();

        let want: Vec<&str> =
            v["expected"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
        if got != want {
            failures.push(format!(
                "  {}  {}\n      expected: {want:?}\n      actual:   {got:?}",
                v["id"].as_str().unwrap(),
                v["desc"].as_str().unwrap()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn monotonic_vectors() {
    let c = corpus();
    for v in c["monotonic"].as_array().unwrap() {
        let mut hub = Hub::new(HubConfig::default());
        let got: Vec<String> = v["nowMs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|ms| hub.publish(ms.as_u64().unwrap(), "t", "x", None).unwrap().id.to_string())
            .collect();
        let want: Vec<String> = v["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        assert_eq!(got, want, "{}  {}", v["id"].as_str().unwrap(), v["desc"].as_str().unwrap());
    }
}

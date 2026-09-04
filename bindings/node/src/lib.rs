//! Node binding for [`aghoz_core`].
//!
//! Deliberately does **not** go through the C ABI. `napi-rs` is a Rust crate, so this
//! can depend on the core directly — which is both faster (no pointer marshalling, no
//! double indirection) and safer (no unsafe of our own; the macros own it). The C ABI
//! exists for hosts that can only speak C: Go through cgo, Ruby through FFI, Python
//! through ctypes.
//!
//! Nothing here makes protocol decisions. It converts types, and everything else is a
//! call into the core, so the conformance corpus still governs behaviour.

// napi-derive expands each `#[napi]` item into registration glue — `from_napi_value`,
// constructor shims — that carries no docs and is not this crate's surface. The lint
// fires on the macro's output, at the macro's call site, where no scoped `allow` can
// reach it. Every hand-written item here is documented; `core` and `abi` keep the
// workspace rule, and `core` keeps its own `deny`.
#![allow(missing_docs)]
// Kept from before the workspace policy existed: `all` is a warning there, and this is
// the one crate whose lints a contributor sees only through a `cargo build`.
#![deny(clippy::all)]

use aghoz_core::{
    BufferVerdict, Checkpoint, EventId, Hub as CoreHub, HubConfig, OriginError, PublishError,
    SubscribeError, SubscriberId, TopicError,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Options mirroring `HubConfig`. Absent fields take the core's defaults.
#[napi(object)]
#[derive(Default)]
pub struct JsHubConfig {
    /// Bytes of history retained. Bytes, not events.
    pub max_history_bytes: Option<u32>,
    /// Queued bytes before a subscriber is a slow consumer.
    pub max_buffer_bytes: Option<u32>,
    /// Connections per process.
    pub max_connections: Option<u32>,
    /// Connections per key.
    pub max_connections_per_key: Option<u32>,
    /// Topics per connection.
    pub max_topics_per_connection: Option<u32>,
}

/// What a publish produced.
#[napi(object)]
pub struct JsPublish {
    /// The assigned id, formatted `<ms>-<seq>`.
    pub id: String,
    /// The encoded frame, ready to write to a socket.
    pub frame: Buffer,
    /// Subscriber ids the frame should go to.
    ///
    /// `f64` rather than `u32`, for the reason [`Hub::subscribe`] gives: a subscriber id
    /// is a u64 that only ever counts up, and truncating it to 32 bits eventually hands
    /// two live sockets the same number.
    pub targets: Vec<f64>,
}

/// What a subscribe produced.
#[napi(object)]
pub struct JsSubscribe {
    /// The registered subscriber.
    pub id: f64,
    /// `"absent"`, `"echo"` or `"earliest"` — what the checkpoint header must say.
    pub checkpoint: String,
    /// Frames to replay, oldest first.
    pub replay: Vec<Buffer>,
}

/// The seam's reason for a topic rejection, with the detail after it.
///
/// Every message this binding produces for a rejection begins with one of the tokens in
/// `core-native.ts`'s `REASONS`, followed by `: ` and something a human can read. That
/// prefix is the contract, and it exists because napi gives a thrown error exactly two
/// string channels: `code`, which napi fills with its own coarse status (`InvalidArg` for
/// a rejection here and for its own argument-conversion failures alike), and the message.
/// So the reason has to travel in the message — but as a token to look up, never as prose
/// to search. The half above matched substrings and called anything unrecognised an
/// invalid topic, which turned every failure of the binding *itself* into a 400 blaming
/// the caller. A token that is absent now means "not a rejection", and says so as a 500.
fn topic_message(e: TopicError) -> String {
    let detail = match e {
        TopicError::Empty => "topic is empty",
        TopicError::TooLong => "topic exceeds 255 bytes",
        TopicError::ControlCharacter => "topic contains a control character",
        TopicError::ReservedPrefix => "topic begins with the reserved '~'",
    };
    format!("invalid-topic: {detail}")
}

/// Maps a publish rejection onto the token `core-native.ts` looks up — see `topic_message`.
///
/// The tokens are part of the binding's contract rather than incidental strings; the
/// parity tests assert them.
fn publish_message(e: PublishError) -> String {
    match e {
        PublishError::Topic(t) => topic_message(t),
        PublishError::Origin(o) => {
            let detail = match o {
                OriginError::Empty => "origin is empty",
                OriginError::TooLong => "origin exceeds 64 bytes",
                OriginError::ControlCharacter => "origin contains a control character",
            };
            format!("invalid-origin: {detail}")
        }
        // Deliberately *not* one of the seam's tokens. Every other variant here is
        // something the request asked for; this one is the server's own clock in the
        // wrong unit, or an id space this process has spent. `core-native.ts` answers
        // 500 for a message it does not recognise, which is the honest status for a
        // fault the caller had no part in — see `asCoreError` there.
        PublishError::IdOutOfRange => {
            "id-out-of-range; nowMs must be milliseconds below 2^53-1".to_string()
        }
    }
}

/// A subscriber id on its way out to JavaScript.
///
/// `f64`, never `u32`. The core issues these from a counter that only ever moves forward
/// — `registry.rs` explains at length that a *recycled* id lets a write scheduled for a
/// closed subscriber land on whoever inherited the number — and `as u32` reintroduced
/// exactly that at 2^32 subscribes, where the handler's `connections` map would hand the
/// new socket the old one's fan-out. An f64 holds every integer below 2^53 exactly, which
/// is the same bound §2 already puts on an event id.
// Lossless for every id a process can issue: ids count up from 1, and an f64 is exact
// to 2^53 — the same bound §2 puts on an event id.
#[allow(clippy::cast_precision_loss)]
fn subscriber_to_js(id: SubscriberId) -> f64 {
    id.0 as f64
}

/// A subscriber id arriving from JavaScript.
///
/// Anything that is not a whole number this process could have issued becomes `0`, which
/// is the one id the registry never assigns — so it reports `unknown` rather than
/// landing on a real subscriber.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn subscriber_from_js(id: f64) -> SubscriberId {
    if !id.is_finite() || id < 1.0 || id.fract() != 0.0 {
        return SubscriberId(0);
    }
    // Positive, finite and whole by the guard above.
    SubscriberId(id as u64)
}

/// A JavaScript timestamp on its way into the core.
///
/// `Date.now()` is a whole, finite, positive number of milliseconds. `as u64` alone maps
/// NaN to 0 and a negative to 0, either of which would quietly assign `0-n` — an id below
/// every cursor a client holds, which reads as "nothing new" forever. The core rejects
/// the *upper* half of this range on its own; this is the half a cast cannot express.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn millis_from_js(now_ms: f64) -> Option<u64> {
    if !now_ms.is_finite() || now_ms < 0.0 || now_ms.fract() != 0.0 {
        return None;
    }
    // Positive, finite and whole by the guard above; the core rejects the rest.
    Some(now_ms as u64)
}

/// A byte count arriving from JavaScript.
///
/// §8.2 is about how far behind a subscriber is, so the only wrong answer is one that
/// reads *better* than the truth. `as usize` alone maps NaN and a negative to zero —
/// "perfectly caught up" — and a number past `usize::MAX` to something arbitrary.
/// Clamping keeps a nonsense report from looking like a healthy one.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn bytes_from_js(bytes: f64) -> usize {
    if bytes.is_nan() || bytes <= 0.0 {
        return 0;
    }
    // `usize::MAX as f64` rounds up, so the comparison is conservative — a value at the
    // very top clamps rather than wrapping, which is the direction that cannot lie.
    #[allow(clippy::cast_precision_loss)]
    if bytes >= usize::MAX as f64 {
        return usize::MAX;
    }
    // Positive, finite and below `usize::MAX` by the guards above.
    bytes as usize
}

/// The in-process hub.
#[napi]
pub struct Hub {
    inner: CoreHub,
}

#[napi]
impl Hub {
    /// Creates a hub.
    #[napi(constructor)]
    pub fn new(config: Option<JsHubConfig>) -> Hub {
        let c = config.unwrap_or_default();
        let d = HubConfig::default();
        Hub {
            inner: CoreHub::new(HubConfig {
                max_history_bytes: c.max_history_bytes.map_or(d.max_history_bytes, |v| v as usize),
                max_buffer_bytes: c.max_buffer_bytes.map_or(d.max_buffer_bytes, |v| v as usize),
                max_connections: c.max_connections.map_or(usize::MAX, |v| v as usize),
                max_connections_per_key: c
                    .max_connections_per_key
                    .map_or(usize::MAX, |v| v as usize),
                max_topics_per_connection: c
                    .max_topics_per_connection
                    .map_or(d.max_topics_per_connection, |v| v as usize),
            }),
        }
    }

    /// Assigns an id, encodes a frame, and matches subscribers.
    ///
    /// `now_ms` is f64 rather than u64 on purpose: a u64 would surface in JavaScript as
    /// a BigInt, forcing `hub.publish(BigInt(Date.now()), ...)` on every caller and
    /// costing a boxed allocation per publish. f64 is exact for every integer below
    /// 2^53, and Unix milliseconds do not reach that until the year 287396.
    #[napi]
    pub fn publish(
        &mut self,
        now_ms: f64,
        topic: String,
        payload: String,
        origin: Option<String>,
    ) -> Result<JsPublish> {
        // Empty means absent, matching the ABI and the TypeScript core: JavaScript
        // callers produce `''` wherever a value was missing.
        let origin = origin.filter(|o| !o.is_empty());
        let Some(now_ms) = millis_from_js(now_ms) else {
            return Err(Error::new(
                Status::InvalidArg,
                "id-out-of-range; nowMs must be a whole, positive number of milliseconds",
            ));
        };
        match self.inner.publish(now_ms, &topic, &payload, origin.as_deref()) {
            Err(e) => Err(Error::new(Status::InvalidArg, publish_message(e))),
            Ok(effect) => Ok(JsPublish {
                id: effect.id.to_string(),
                frame: effect.frame.into(),
                targets: effect.targets.iter().map(|s| subscriber_to_js(*s)).collect(),
            }),
        }
    }

    /// Records an event whose id a backplane assigned, and returns who should get it.
    ///
    /// The id arrives as its canonical `<ms>-<seq>` text and is parsed here rather than
    /// in TypeScript. §2.1's canonical form — no padding, no signs, no exponents — is
    /// precisely the kind of rule D3 exists to keep in exactly one place.
    #[napi]
    pub fn append(
        &mut self,
        id: String,
        topic: String,
        payload: String,
        origin: Option<String>,
    ) -> Result<JsPublish> {
        let Some(parsed) = EventId::parse(&id) else {
            return Err(Error::new(
                Status::InvalidArg,
                format!("malformed-cursor: malformed id {id}"),
            ));
        };
        let origin = origin.filter(|o| !o.is_empty());
        match self.inner.append(parsed, &topic, &payload, origin.as_deref()) {
            Err(e) => Err(Error::new(Status::InvalidArg, publish_message(e))),
            Ok(effect) => Ok(JsPublish {
                id: effect.id.to_string(),
                frame: effect.frame.into(),
                targets: effect.targets.iter().map(|s| subscriber_to_js(*s)).collect(),
            }),
        }
    }

    /// Encodes a frame for an event whose id was assigned elsewhere, recording nothing.
    ///
    /// Replay from a *shared* history needs the bytes and nothing else — those events are
    /// already in the shared log. Going through `append` for this instead duplicates them
    /// into the local ring on every reconnect, out of id order.
    #[napi]
    pub fn encode(
        &self,
        id: String,
        topic: String,
        payload: String,
        origin: Option<String>,
    ) -> Result<Buffer> {
        let Some(parsed) = EventId::parse(&id) else {
            return Err(Error::new(
                Status::InvalidArg,
                format!("malformed-cursor: malformed id {id}"),
            ));
        };
        let origin = origin.filter(|o| !o.is_empty());
        match self.inner.encode(parsed, &topic, &payload, origin.as_deref()) {
            Err(e) => Err(Error::new(Status::InvalidArg, publish_message(e))),
            Ok(bytes) => Ok(bytes.into()),
        }
    }

    /// Registers a subscriber, decides the checkpoint, and snapshots the replay set.
    ///
    /// One call, because §4.5 requires the three to describe one instant. Exposing them
    /// separately would let a caller interleave an `await` and reintroduce exactly the
    /// race this prevents.
    #[napi]
    pub fn subscribe(
        &mut self,
        topics: Vec<String>,
        key: Option<String>,
        cursor: Option<String>,
    ) -> Result<JsSubscribe> {
        let parsed = match cursor.as_deref() {
            None => None,
            Some(raw) => match EventId::parse(raw) {
                Some(id) => Some(id),
                // A malformed cursor must not be treated as "no cursor": the client
                // would believe it resumed and would never be told otherwise.
                None => {
                    return Err(Error::new(Status::InvalidArg, format!("malformed-cursor: {raw}")))
                }
            },
        };

        match self.inner.subscribe(topics, key, parsed) {
            Err(SubscribeError::Topic(t)) => Err(Error::new(Status::InvalidArg, topic_message(t))),
            Err(SubscribeError::TopicCount) => {
                Err(Error::new(Status::InvalidArg, "too-many-topics"))
            }
            Err(SubscribeError::MaxConnections) => {
                Err(Error::new(Status::GenericFailure, "max-connections"))
            }
            Err(SubscribeError::MaxConnectionsPerKey) => {
                Err(Error::new(Status::GenericFailure, "max-connections-per-key"))
            }
            Ok(effect) => Ok(JsSubscribe {
                id: subscriber_to_js(effect.id),
                checkpoint: match effect.checkpoint {
                    Checkpoint::Absent => "absent".to_string(),
                    Checkpoint::Echo(_) => "echo".to_string(),
                    Checkpoint::Earliest => "earliest".to_string(),
                },
                replay: effect.replay.into_iter().map(Buffer::from).collect(),
            }),
        }
    }

    /// Reports a subscriber's *absolute* queued depth. Returns `"ok"`, `"slow-consumer"`
    /// or `"unknown"`.
    ///
    /// What the Node handler uses, because `res.writableLength` is exactly this and the
    /// socket is a better authority than any accounting kept alongside it.
    #[napi]
    pub fn note_buffer(&mut self, subscriber: f64, queued_bytes: f64) -> String {
        verdict_name(
            self.inner.note_buffer(subscriber_from_js(subscriber), bytes_from_js(queued_bytes)),
        )
    }

    /// Reports that `bytes` were handed to the transport, with no absolute depth known.
    ///
    /// Node does not need this — it is here so the corpus can drive the same rule through
    /// this binding that a ctypes or cgo binding will drive through the C ABI.
    #[napi]
    pub fn note_sent(&mut self, subscriber: f64, bytes: f64) -> String {
        verdict_name(self.inner.note_sent(subscriber_from_js(subscriber), bytes_from_js(bytes)))
    }

    /// Reports that `bytes` previously passed to `noteSent` have drained.
    #[napi]
    pub fn note_flushed(&mut self, subscriber: f64, bytes: f64) -> String {
        verdict_name(self.inner.note_flushed(subscriber_from_js(subscriber), bytes_from_js(bytes)))
    }

    /// Removes a subscriber. Idempotent.
    #[napi]
    pub fn remove(&mut self, subscriber: f64) -> bool {
        self.inner.remove(subscriber_from_js(subscriber))
    }

    /// The newest assigned id, or `0-0`.
    #[napi]
    pub fn cursor(&self) -> String {
        self.inner.cursor().to_string()
    }

    /// Open subscribers.
    #[napi]
    #[allow(clippy::cast_precision_loss)]
    pub fn connection_count(&self) -> f64 {
        // Exact for every count a process can actually hold; `as u32` was not, and a
        // wrapped connection count is a metric that reads healthy while it is not.
        self.inner.connection_count() as f64
    }

    /// A `~gap` frame for a subscriber that fell behind.
    #[napi]
    pub fn slow_consumer_frame(&self, subscriber: f64) -> Buffer {
        self.inner.slow_consumer_frame(subscriber_from_js(subscriber)).into()
    }

    /// A `~gap` frame for a cursor history no longer reaches.
    #[napi]
    pub fn truncated_frame(&self, subscriber: f64) -> Buffer {
        self.inner.truncated_frame(subscriber_from_js(subscriber)).into()
    }

    /// A `~denied` frame naming refused topics.
    #[napi]
    pub fn denied_frame(&self, topics: Vec<String>) -> Buffer {
        self.inner.denied_frame(&topics).into()
    }
}

/// One mapping for all three backpressure entry points, so they cannot disagree.
fn verdict_name(verdict: BufferVerdict) -> String {
    match verdict {
        BufferVerdict::Ok => "ok",
        BufferVerdict::SlowConsumer => "slow-consumer",
        BufferVerdict::Unknown => "unknown",
    }
    .to_string()
}

/// §3 — exposed so the HTTP layer can reject a topic before opening a stream.
#[napi]
pub fn validate_topic(topic: String) -> bool {
    aghoz_core::validate_topic(&topic).is_ok()
}

/// §6.0 — exposed so the HTTP layer can reject an origin before it reaches a frame.
#[napi]
pub fn validate_origin(origin: String) -> bool {
    aghoz_core::validate_origin(&origin).is_ok()
}

/// §2.1 — whether a string is a canonical id at all.
///
/// Exposed for the corpus, which pins this rule in its own group: a cursor and a
/// backplane-assigned id both reach the wire, and "which strings are ids" is the kind of
/// thing each language answers differently unless something holds them to one answer.
#[napi]
pub fn validate_id(id: String) -> bool {
    EventId::parse(&id).is_some()
}

/// §2.1 — compares two canonical ids, returning -1, 0 or 1.
///
/// Invalid ids are an error, never equality. The handler uses this to decide whether a
/// persisted floor or backplane cursor can be trusted; treating malformed input as equal
/// would turn corrupt metadata into an unreported gap.
#[napi]
pub fn compare_ids(a: String, b: String) -> Result<i32> {
    let x = EventId::parse(&a)
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("malformed-cursor: {a}")))?;
    let y = EventId::parse(&b)
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("malformed-cursor: {b}")))?;
    Ok(match x.cmp(&y) {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    })
}

/// Encodes a frame directly, for the conformance runner.
///
/// Throws for an id outside §2's range rather than encoding one: this is the only entry
/// point that takes the two halves as numbers, and it would otherwise be the way to put
/// an id on the wire that no client can parse back.
#[napi]
pub fn encode_frame(
    ms: f64,
    seq: f64,
    topic: String,
    payload: String,
    origin: Option<String>,
) -> Result<Buffer> {
    let id = millis_from_js(ms)
        .zip(millis_from_js(seq))
        .and_then(|(ms, seq)| EventId::new(ms, seq))
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("malformed-cursor: {ms}-{seq}")))?;
    Ok(aghoz_core::encode_frame(id, &topic, &payload, origin.as_deref()).into())
}

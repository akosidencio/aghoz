//! The hub — §2, §4.5, §5, §8, §10.

use crate::codec::{encode_control, encode_frame};
use crate::history::{Entry, History};
use crate::id::{EventId, Sequence};
use crate::origin::{validate_origin, OriginError};
use crate::registry::{dedupe, Registry, SubscriberId};
use crate::topic::{validate_topic, TopicError};

/// Limits, all of which §10 requires to exist even where they default to unbounded.
#[derive(Debug, Clone)]
pub struct HubConfig {
    /// Bytes of history retained. Not a count — see [`crate::Hub`].
    pub max_history_bytes: usize,
    /// Queued bytes past which a subscriber is a slow consumer.
    pub max_buffer_bytes: usize,
    /// Connections per process.
    pub max_connections: usize,
    /// Connections per key, typically per user.
    pub max_connections_per_key: usize,
    /// Topics per connection.
    pub max_topics_per_connection: usize,
}

impl Default for HubConfig {
    fn default() -> Self {
        HubConfig {
            max_history_bytes: 8 * 1024 * 1024,
            max_buffer_bytes: 1024 * 1024,
            max_connections: usize::MAX,
            max_connections_per_key: usize::MAX,
            max_topics_per_connection: 64,
        }
    }
}

/// What a publish produced.
pub struct PublishEffect {
    /// The assigned id.
    pub id: EventId,
    /// The encoded frame, to be written to each target.
    pub frame: Vec<u8>,
    /// Subscribers whose topic set matched.
    pub targets: Vec<SubscriberId>,
}

/// §4.4 — what the `last-event-id-checkpoint` header must say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checkpoint {
    /// No cursor was presented; the header is omitted entirely.
    Absent,
    /// History reaches the cursor. Echo it back.
    Echo(EventId),
    /// History no longer reaches it. Send `earliest`, and a `~gap` frame.
    Earliest,
}

/// What a subscription produced. Registration, the checkpoint decision and the replay
/// snapshot are one operation deliberately — see [`Hub::subscribe`].
pub struct SubscribeEffect {
    /// The registered subscriber.
    pub id: SubscriberId,
    /// What the response header must carry.
    pub checkpoint: Checkpoint,
    /// Frames to replay, oldest first.
    pub replay: Vec<Vec<u8>>,
}

/// Why a subscription was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscribeError {
    /// A topic violated §3. Bindings map this to `400`.
    Topic(TopicError),
    /// Zero topics, or more than `max_topics_per_connection`. `400`.
    TopicCount,
    /// `max_connections` reached. `429`.
    MaxConnections,
    /// `max_connections_per_key` reached. `429`.
    MaxConnectionsPerKey,
}

/// Why a publish was refused.
///
/// Both variants are caller errors rather than request failures: a topic and an origin
/// are supplied by application code, not parsed off the wire, so a binding surfaces these
/// as a thrown error rather than a status code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishError {
    /// A topic violated §3.
    Topic(TopicError),
    /// An origin violated §6.0.
    Origin(OriginError),
    /// The id this publish would have been given falls outside §2's range.
    ///
    /// Reachable two ways, and the first is the one that will actually happen: a host
    /// passing `now_ms` in the wrong unit. Nanoseconds land two orders of magnitude past
    /// [`crate::MAX_ID_COMPONENT`], and the id that would be minted from them is one no
    /// JavaScript client can hold exactly. The second is a sequence already at the bound
    /// inside a millisecond that has not advanced — see `Sequence::next`.
    ///
    /// A refusal rather than a clamp: two publishes sharing an id is the one outcome
    /// worse than a rejected publish, because client-side dedupe silently drops the
    /// second one.
    IdOutOfRange,
}

/// §8.2 — what to do about a subscriber's buffer depth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BufferVerdict {
    /// Keeping up.
    Ok,
    /// Past `max_buffer_bytes`. Write the returned frame, then close.
    SlowConsumer,
    /// No such subscriber — a write that completed after teardown.
    Unknown,
}

/// The in-process hub.
///
/// Not internally synchronised. Node is single-threaded and should not pay for locks it
/// cannot contend; threaded hosts get a mutex in the ABI layer instead.
pub struct Hub {
    config: HubConfig,
    sequence: Sequence,
    history: History,
    registry: Registry,
    targets: Vec<SubscriberId>,
}

impl Hub {
    /// Creates a hub.
    pub fn new(config: HubConfig) -> Hub {
        let history = History::new(config.max_history_bytes);
        Hub {
            config,
            sequence: Sequence::default(),
            history,
            registry: Registry::new(),
            targets: Vec::new(),
        }
    }

    /// §5 — the newest id assigned, or `0-0`.
    ///
    /// Handing this to a page alongside its initial data is what closes the window
    /// between rendering and the stream opening. Without it, anything published in
    /// between is lost with nothing reported — on every first page load.
    pub fn cursor(&self) -> EventId {
        self.sequence.current()
    }

    /// Assigns an id, encodes, appends to history and matches subscribers.
    pub fn publish(
        &mut self,
        now_ms: u64,
        topic: &str,
        payload: &str,
        origin: Option<&str>,
    ) -> Result<PublishEffect, PublishError> {
        // Validated before an id is drawn: a rejected publish must not consume one, or
        // the sequence develops holes that look like lost events to anyone auditing it.
        validate(topic, origin)?;

        let id = self.sequence.next(now_ms).ok_or(PublishError::IdOutOfRange)?;
        Ok(self.record(id, topic, payload, origin))
    }

    /// Records an event whose id was assigned elsewhere, and returns who should get it.
    ///
    /// Separate from [`Hub::publish`] because the id must not be reassigned. A backplane
    /// owns id assignment rather than merely transporting events: per-process counters
    /// collide, so two pods publishing in the same millisecond would both mint
    /// `<ms>-0`, and every client's dedupe would silently discard one of them as
    /// already-seen. §2 fixed the id format precisely so a shared sequencer — `XADD`'s
    /// id, in the Redis case — could issue it.
    ///
    /// The local sequence advances past the supplied id, so a later fall back to local
    /// assignment cannot reuse one another process already spent.
    pub fn append(
        &mut self,
        id: EventId,
        topic: &str,
        payload: &str,
        origin: Option<&str>,
    ) -> Result<PublishEffect, PublishError> {
        validate(topic, origin)?;
        self.sequence.observe(id);
        Ok(self.record(id, topic, payload, origin))
    }

    /// Encodes a frame for an event whose id was assigned elsewhere, recording nothing.
    ///
    /// This is what replay from a *shared* history needs. Those events are already in the
    /// shared log, and this process either recorded them when they arrived live or was
    /// not running yet; either way the only thing missing is their bytes. Routing them
    /// through [`Hub::append`] instead would push a duplicate into the local ring on
    /// every reconnect, out of id order — which breaks the ring's "oldest entry is at the
    /// head" assumption that [`Hub::subscribe`]'s truncation decision rests on.
    ///
    /// Takes `&self` for exactly that reason: encoding must be observably free of side
    /// effects, and the compiler is a better guarantee of that than a comment.
    pub fn encode(
        &self,
        id: EventId,
        topic: &str,
        payload: &str,
        origin: Option<&str>,
    ) -> Result<Vec<u8>, PublishError> {
        validate(topic, origin)?;
        Ok(encode_frame(id, topic, payload, origin))
    }

    /// The shared tail of `publish` and `append`: encode, match, retain.
    ///
    /// Both must produce byte-identical frames and identical target sets for the same id,
    /// so they share one body rather than two that agree today.
    fn record(
        &mut self,
        id: EventId,
        topic: &str,
        payload: &str,
        origin: Option<&str>,
    ) -> PublishEffect {
        let frame = encode_frame(id, topic, payload, origin);

        self.registry.matching(topic, &mut self.targets);
        let targets = self.targets.clone();

        self.history.push(Entry { id, topic: topic.to_string(), frame: frame.clone() });
        PublishEffect { id, frame, targets }
    }

    /// Registers a subscriber, decides the checkpoint, and snapshots the replay set.
    ///
    /// These are one call because §4.5 requires them to describe one instant. Split
    /// apart, a publish landing in between can trim history after the checkpoint has
    /// already said "nothing was missed" — under-reporting a real gap, which is exactly
    /// the silent staleness this protocol exists to eliminate.
    ///
    /// Registration happens *before* the snapshot, which can deliver one event twice.
    /// That is the intended trade: clients dedupe by id, so a duplicate is a rendering
    /// no-op, whereas the reverse order drops anything published between the two steps
    /// and nothing fails.
    pub fn subscribe(
        &mut self,
        topics: Vec<String>,
        key: Option<String>,
        cursor: Option<EventId>,
    ) -> Result<SubscribeEffect, SubscribeError> {
        if topics.is_empty() || topics.len() > self.config.max_topics_per_connection {
            return Err(SubscribeError::TopicCount);
        }
        for topic in &topics {
            validate_topic(topic).map_err(SubscribeError::Topic)?;
        }
        if self.registry.len() >= self.config.max_connections {
            return Err(SubscribeError::MaxConnections);
        }
        if let Some(k) = &key {
            if self.registry.count_for_key(k) >= self.config.max_connections_per_key {
                return Err(SubscribeError::MaxConnectionsPerKey);
            }
        }

        // Deduped here rather than read back out of the registry. Asking for the topics
        // of the subscriber registered one line above cannot fail, but saying so needed an
        // `expect`, and an `expect` that "cannot fail" is a claim no reader can check.
        let subscribed = dedupe(topics);
        let id = self.registry.add(subscribed.clone(), key);

        let (checkpoint, replay) = match cursor {
            None => (Checkpoint::Absent, Vec::new()),
            Some(c) => {
                // Two ways a cursor can be one this hub cannot vouch for.
                //
                // Below what the ring evicted — "was anything dropped that this cursor had
                // not already seen?", the question §7.1 actually asks. See
                // `History::last_trimmed` for why the oldest *retained* entry is the wrong
                // thing to compare against. A cursor equal to the evicted id is NOT a gap:
                // that is the event the client already holds, and the rest is still here.
                let evicted = self.history.last_trimmed().is_some_and(|t| c < t);

                // Or *above* every id this hub has ever issued or recorded, which means
                // the cursor came from somewhere this hub has never been — a previous
                // life, most often. A restarted process has an empty ring and nothing
                // trimmed, so the rule above alone answers "you missed nothing" to a
                // client resuming across the restart, and everything published before the
                // shutdown is gone with no one told. That is precisely the silent
                // staleness §0 exists to eliminate, and it needs no configuration to
                // detect: a hub that has never seen an id this high cannot possibly know
                // what came after it.
                //
                // Costs nothing in normal operation, where a client's cursor is by
                // construction an id this hub handed out.
                let beyond = c > self.sequence.current();

                let truncated = evicted || beyond;
                let frames: Vec<Vec<u8>> =
                    self.history.since(c, &subscribed).map(|e| e.frame.clone()).collect();
                (if truncated { Checkpoint::Earliest } else { Checkpoint::Echo(c) }, frames)
            }
        };

        Ok(SubscribeEffect { id, checkpoint, replay })
    }

    /// §8.2 — the host reports a subscriber's *absolute* queued depth; the hub decides.
    ///
    /// The right call wherever the socket can be asked how much is outstanding, because
    /// then the socket is the authority and no accounting can drift away from it. Node's
    /// `res.writableLength` is exactly that, so the Node handler uses this and nothing
    /// else.
    ///
    /// Hosts that cannot answer that question use [`Hub::note_sent`] and
    /// [`Hub::note_flushed`] instead. The two styles share one counter and one threshold,
    /// so the drop decision is identical either way; a host that has an absolute depth
    /// should always prefer this one.
    pub fn note_buffer(&mut self, id: SubscriberId, queued_bytes: usize) -> BufferVerdict {
        let queued = self.registry.set_queued(id, queued_bytes);
        self.verdict(queued)
    }

    /// §8.2 — the host handed `bytes` to the transport but cannot say what is still
    /// outstanding.
    ///
    /// This exists because the absolute depth [`Hub::note_buffer`] wants is a Node-shaped
    /// question. ASGI has no equivalent: `await send()` suspends until the transport
    /// accepts the data and returns nothing, and neither Go's `http.ResponseWriter` nor
    /// Swoole exposes a queue depth either. Without this pair, §8.2 — half of the loss
    /// story this protocol exists for — would be unimplementable in every runtime the C
    /// ABI was built to serve.
    ///
    /// **On the drift this was once rejected over.** Delta accounting does drift against a
    /// transport that reports partial writes, which is why Node must not use it. The hosts
    /// that need it have no partial write to observe: `await send()` either completes for
    /// the whole frame or the connection is gone, so the delta is always a whole frame and
    /// there is no fractional flush to lose track of. The rejection was right about Node
    /// and wrong as a general rule — see DECISIONS.md D10.
    pub fn note_sent(&mut self, id: SubscriberId, bytes: usize) -> BufferVerdict {
        let queued = self.registry.add_queued(id, bytes);
        self.verdict(queued)
    }

    /// §8.2 — the host confirms `bytes` have drained.
    ///
    /// The counterpart to [`Hub::note_sent`]. Saturates at zero rather than underflowing,
    /// so an over-reported flush cannot turn a caught-up subscriber into one that looks
    /// `usize::MAX` bytes behind.
    pub fn note_flushed(&mut self, id: SubscriberId, bytes: usize) -> BufferVerdict {
        let queued = self.registry.sub_queued(id, bytes);
        self.verdict(queued)
    }

    /// One threshold, whichever way the counter was reached.
    ///
    /// Shared rather than repeated three times: §8.2's rule is "outstanding bytes exceed
    /// the cap", and the way a host arrives at that number must not change the answer.
    fn verdict(&self, queued: Option<usize>) -> BufferVerdict {
        match queued {
            None => BufferVerdict::Unknown,
            Some(bytes) if bytes > self.config.max_buffer_bytes => BufferVerdict::SlowConsumer,
            Some(_) => BufferVerdict::Ok,
        }
    }

    /// Builds the `~gap` frame for a subscriber being dropped as a slow consumer.
    pub fn slow_consumer_frame(&self, id: SubscriberId) -> Vec<u8> {
        let topics = self.registry.topics_of(id).unwrap_or(&[]);
        let list = topics.iter().map(|t| json_string(t)).collect::<Vec<_>>().join(",");
        encode_control("gap", &format!(r#"{{"reason":"slow-consumer","topics":[{list}]}}"#))
    }

    /// Builds the `~gap` frame for a cursor that history no longer reaches.
    pub fn truncated_frame(&self, id: SubscriberId) -> Vec<u8> {
        let topics = self.registry.topics_of(id).unwrap_or(&[]);
        let list = topics.iter().map(|t| json_string(t)).collect::<Vec<_>>().join(",");
        encode_control("gap", &format!(r#"{{"reason":"history-truncated","topics":[{list}]}}"#))
    }

    /// Builds the `~denied` frame naming topics `authorize` refused.
    pub fn denied_frame(&self, topics: &[String]) -> Vec<u8> {
        let list = topics.iter().map(|t| json_string(t)).collect::<Vec<_>>().join(",");
        encode_control("denied", &format!(r#"{{"topics":[{list}]}}"#))
    }

    /// Removes a subscriber. Idempotent.
    pub fn remove(&mut self, id: SubscriberId) -> bool {
        self.registry.remove(id)
    }

    /// Open subscribers.
    pub fn connection_count(&self) -> usize {
        self.registry.len()
    }

    /// Distinct subscribed topics. Diagnostics only.
    pub fn topic_count(&self) -> usize {
        self.registry.topic_count()
    }

    /// Retained history entries.
    pub fn history_len(&self) -> usize {
        self.history.len()
    }

    /// Retained history bytes.
    pub fn history_bytes(&self) -> usize {
        self.history.bytes()
    }
}

/// Everything that reaches the wire is checked here, on every path that writes a frame.
///
/// Shared by `publish`, `append` and `encode` rather than repeated: these two rules are
/// the injection defence (§3, §6.0), and a path that forgot one would be a forgery
/// primitive reachable from application input.
///
/// An empty origin is absent, not invalid. Callers on the far side of a binding produce
/// `""` for a missing value as a matter of course — `?? ''`, an unsent header — and
/// rejecting that would make the common case the hostile one.
fn validate(topic: &str, origin: Option<&str>) -> Result<(), PublishError> {
    validate_topic(topic).map_err(PublishError::Topic)?;
    if let Some(origin) = origin.filter(|o| !o.is_empty()) {
        validate_origin(origin).map_err(PublishError::Origin)?;
    }
    Ok(())
}

/// JSON string escaping, so the core needs no serialisation dependency.
///
/// Escapes the control range as well as the two structural characters. It used to escape
/// only `"` and `\\`, on the grounds that §3 forbids control characters in a topic — but
/// the rule was enforced on the *subscribe* path and this function is reached from
/// [`Hub::denied_frame`], which takes whatever list a binding hands it. A raw LF in a
/// topic there did not forge a frame — `write_data_lines` splits it into another
/// `data:` line — but the client rejoins those lines with a newline, so the payload
/// arrived as JSON with a literal newline inside a string and `JSON.parse` threw. The
/// `~denied` frame naming the refused topics was then the one frame the client could not
/// read, which is a silent authorization failure.
///
/// Escaping rather than validating: this is the last thing between a string and the
/// wire, and a total function here cannot be forgotten by a caller.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len().saturating_add(2));
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            // The rest of C0. RFC 8259 forbids every one of them raw inside a string.
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
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

    fn hub() -> Hub {
        Hub::new(HubConfig::default())
    }

    fn id(ms: u64, seq: u64) -> EventId {
        EventId::new(ms, seq).expect("test ids are inside §2's range")
    }

    #[test]
    fn append_uses_the_supplied_id_verbatim() {
        let mut h = hub();
        let effect = h.append(id(1000, 4), "t", "x", None).unwrap();
        assert_eq!(effect.id, id(1000, 4));
        assert!(effect.frame.starts_with(b"id: 1000-4\n"));
    }

    #[test]
    fn append_advances_the_cursor_past_a_foreign_id() {
        let mut h = hub();
        h.append(id(1000, 4), "t", "x", None).unwrap();
        assert_eq!(h.cursor(), id(1000, 4));
    }

    #[test]
    fn an_older_append_never_drags_the_cursor_backwards() {
        let mut h = hub();
        h.append(id(1000, 4), "t", "x", None).unwrap();
        // Out of order, as a reconnect replaying shared history delivers them.
        h.append(id(999, 0), "t", "x", None).unwrap();
        assert_eq!(h.cursor(), id(1000, 4), "the cursor must not regress");
    }

    #[test]
    fn a_local_publish_after_an_append_cannot_reuse_the_spent_id() {
        let mut h = hub();
        h.append(id(1000, 4), "t", "x", None).unwrap();
        // The clock says the same millisecond the backplane already issued ids in. If
        // the sequence had stayed at 0-0 this would mint 1000-0, which another process
        // has already used — and every client would discard one of the two as seen.
        let next = h.publish(1000, "t", "x", None).unwrap();
        assert!(next.id > id(1000, 4), "{} must be newer than 1000-4", next.id);
    }

    #[test]
    fn encode_matches_what_publish_would_have_written() {
        let mut h = hub();
        let published = h.publish(1000, "t", r#"{"a":1}"#, Some("tab-7")).unwrap();
        let encoded = hub().encode(published.id, "t", r#"{"a":1}"#, Some("tab-7")).unwrap();
        assert_eq!(published.frame, encoded, "one encoder, or the wire diverges");
    }

    #[test]
    fn encode_records_nothing() {
        let mut h = hub();
        h.append(id(1000, 0), "t", "x", None).unwrap();
        let before = (h.history_len(), h.history_bytes(), h.cursor());
        h.encode(id(9999, 9), "t", "x", None).unwrap();
        assert_eq!(
            (h.history_len(), h.history_bytes(), h.cursor()),
            before,
            "encode must not touch history or the sequence",
        );
    }

    #[test]
    fn append_matches_subscribers_like_publish_does() {
        let mut h = hub();
        let sub = h.subscribe(vec!["t".into()], None, None).unwrap().id;
        let effect = h.append(id(1000, 0), "t", "x", None).unwrap();
        assert_eq!(effect.targets, vec![sub]);
        let elsewhere = h.append(id(1000, 1), "other", "x", None).unwrap();
        assert!(elsewhere.targets.is_empty());
    }

    #[test]
    fn append_and_encode_reject_what_publish_rejects() {
        let mut h = hub();
        // §3 and §6.0 are the injection defence. A path that skipped either would be a
        // forgery primitive reachable from whatever the backplane carries.
        assert!(matches!(h.append(id(1, 0), "~gap", "x", None), Err(PublishError::Topic(_))));
        assert!(matches!(
            h.append(id(1, 0), "t", "x", Some("bad\norigin")),
            Err(PublishError::Origin(_))
        ));
        assert!(matches!(h.encode(id(1, 0), "a\nb", "x", None), Err(PublishError::Topic(_))));
        assert!(matches!(
            h.encode(id(1, 0), "t", "x", Some("bad\norigin")),
            Err(PublishError::Origin(_))
        ));
    }

    #[test]
    fn a_rejected_append_records_nothing() {
        let mut h = hub();
        assert!(h.append(id(5000, 0), "~gap", "x", None).is_err());
        assert_eq!(h.cursor(), EventId::ZERO, "a refused append must not move the cursor");
        assert_eq!(h.history_len(), 0);
    }

    fn capped(max_buffer_bytes: usize) -> Hub {
        Hub::new(HubConfig { max_buffer_bytes, ..HubConfig::default() })
    }

    #[test]
    fn the_two_backpressure_styles_reach_the_same_verdict() {
        let mut absolute = capped(100);
        let a = absolute.subscribe(vec!["t".into()], None, None).unwrap().id;
        let mut delta = capped(100);
        let d = delta.subscribe(vec!["t".into()], None, None).unwrap().id;

        // 60 outstanding, then 120 — reported as a running total by one host and as two
        // writes by the other. §8.2's rule is about outstanding bytes, so the way the
        // number was reached must not change the answer.
        assert_eq!(absolute.note_buffer(a, 60), BufferVerdict::Ok);
        assert_eq!(delta.note_sent(d, 60), BufferVerdict::Ok);

        assert_eq!(absolute.note_buffer(a, 120), BufferVerdict::SlowConsumer);
        assert_eq!(delta.note_sent(d, 60), BufferVerdict::SlowConsumer);
    }

    #[test]
    fn a_flush_brings_a_subscriber_back_under_the_cap() {
        let mut h = capped(100);
        let id = h.subscribe(vec!["t".into()], None, None).unwrap().id;
        assert_eq!(h.note_sent(id, 150), BufferVerdict::SlowConsumer);
        assert_eq!(h.note_flushed(id, 100), BufferVerdict::Ok);
    }

    #[test]
    fn the_cap_is_exclusive_on_both_paths() {
        // §8.2 drops past the cap, not at it. An off-by-one here disconnects a subscriber
        // that is exactly at its budget and doing nothing wrong.
        let mut h = capped(100);
        let id = h.subscribe(vec!["t".into()], None, None).unwrap().id;
        assert_eq!(h.note_sent(id, 100), BufferVerdict::Ok);
        assert_eq!(h.note_sent(id, 1), BufferVerdict::SlowConsumer);

        let mut other = capped(100);
        let id = other.subscribe(vec!["t".into()], None, None).unwrap().id;
        assert_eq!(other.note_buffer(id, 100), BufferVerdict::Ok);
        assert_eq!(other.note_buffer(id, 101), BufferVerdict::SlowConsumer);
    }

    #[test]
    fn an_over_reported_flush_saturates_at_zero() {
        let mut h = capped(100);
        let id = h.subscribe(vec!["t".into()], None, None).unwrap().id;
        h.note_sent(id, 10);
        // More flushed than was ever sent — a double count, or a frame written before the
        // subscriber registered. Underflowing here would wrap to usize::MAX and drop a
        // subscriber that is completely caught up.
        assert_eq!(h.note_flushed(id, 999), BufferVerdict::Ok);
        assert_eq!(h.note_sent(id, 1), BufferVerdict::Ok, "the counter really is at zero");
    }

    #[test]
    fn sending_saturates_rather_than_wrapping() {
        let mut h = capped(100);
        let id = h.subscribe(vec!["t".into()], None, None).unwrap().id;
        h.note_sent(id, usize::MAX);
        // Wrapping would read as a perfectly healthy subscriber at the exact moment it is
        // furthest behind.
        assert_eq!(h.note_sent(id, 4096), BufferVerdict::SlowConsumer);
    }

    #[test]
    fn every_backpressure_path_reports_an_unknown_subscriber() {
        let mut h = capped(100);
        let ghost = SubscriberId(9999);
        // A write that completed after teardown. All three must agree, or a host using
        // one style leaks a drop the other would have reported.
        assert_eq!(h.note_buffer(ghost, 1), BufferVerdict::Unknown);
        assert_eq!(h.note_sent(ghost, 1), BufferVerdict::Unknown);
        assert_eq!(h.note_flushed(ghost, 1), BufferVerdict::Unknown);
    }

    #[test]
    fn removal_forgets_the_outstanding_count() {
        let mut h = capped(100);
        let id = h.subscribe(vec!["t".into()], None, None).unwrap().id;
        h.note_sent(id, 500);
        assert!(h.remove(id));
        // A recycled counter would follow the id, but ids are never recycled — so the
        // only correct answer for a gone subscriber is "unknown", not a stale total.
        assert_eq!(h.note_sent(id, 1), BufferVerdict::Unknown);
    }

    #[test]
    fn an_empty_origin_is_absent_on_every_path() {
        let mut h = hub();
        let appended = h.append(id(1000, 0), "t", "x", Some("")).unwrap();
        let bare = hub().encode(id(1000, 0), "t", "x", None).unwrap();
        assert_eq!(appended.frame, bare, "empty and absent must encode identically");
    }

    #[test]
    fn a_clock_outside_the_id_range_is_refused_not_emitted() {
        let mut h = hub();
        // Nanoseconds where §2 wants milliseconds. Minting the id anyway would put a
        // number on the wire that every JavaScript client rounds to a different event.
        assert_eq!(
            h.publish(1_757_000_000_000_000_000, "t", "x", None).err(),
            Some(PublishError::IdOutOfRange)
        );
        assert_eq!(h.cursor(), EventId::ZERO, "and it costs no id");
        assert_eq!(h.history_len(), 0, "and records nothing");
    }

    #[test]
    fn a_denied_frame_stays_parseable_whatever_the_topics_hold() {
        let h = hub();
        // `denied_frame` takes whatever list a binding hands it — nothing on this path
        // has been through §3. A raw LF used to reach the payload, where the client's
        // rejoin turned it back into a newline inside a JSON string and `JSON.parse`
        // threw on the one frame that names what was refused.
        let frame = h.denied_frame(&[
            "a\nb".to_string(),
            "q\"uote".to_string(),
            "tab\there".to_string(),
            "bell\u{7}".to_string(),
        ]);
        let text = String::from_utf8(frame).expect("frames are utf-8");
        assert_eq!(
            text,
            "event: ~denied\ndata: {\"topics\":[\"a\\nb\",\"q\\\"uote\",\"tab\\there\",\"bell\\u0007\"]}\n\n"
        );
        // One `data:` line, so the payload the client rejoins is the payload we wrote.
        assert_eq!(text.matches("data: ").count(), 1);
    }
}

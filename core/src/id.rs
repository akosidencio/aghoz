//! Event ids — §2.

use std::cmp::Ordering;
use std::fmt;

/// A monotonic event id, rendered on the wire as `<ms>-<seq>`.
///
/// Compared by parsed halves, never as a string: `1755083412345-10` sorts *before*
/// `1755083412345-7` lexicographically, and a client that gets this wrong silently
/// discards live events as already-seen.
/// Both halves are private, and the only ways in are [`EventId::new`] and
/// [`EventId::parse`], which both refuse anything above [`MAX_ID_COMPONENT`]. Public
/// fields made that bound advisory: it held on the string path and nowhere else, so a
/// caller assembling an id from two integers — an ABI cursor, a binding's clock — could
/// mint one no JavaScript host can represent, and `Sequence` would then carry it forward
/// into every id after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct EventId {
    ms: u64,
    seq: u64,
}

/// The largest value either half of an id may take — 2^53 − 1.
///
/// §2 once said "unsigned 64-bit", which no JavaScript host can represent: `Number` is an
/// f64, so `9007199254740993` and `9007199254740992` are the same value and every id above
/// 2^53 − 1 is ambiguous. The TypeScript core therefore rejected them while this one
/// accepted the full u64 range, which meant the *same cursor string* resolved to two
/// different events depending on which implementation received it.
///
/// Narrowed rather than fixed with BigInt: BigInt on the id path costs a boxed allocation
/// per publish for a range that runs out in the year 287396, and 2^53 − 1 events inside one
/// millisecond is not a limit anything will meet. See DECISIONS.md D9.
pub const MAX_ID_COMPONENT: u64 = 9_007_199_254_740_991;

impl EventId {
    /// The id meaning "nothing has been published yet".
    pub const ZERO: EventId = EventId { ms: 0, seq: 0 };

    /// Builds an id from its two halves, or `None` if either exceeds
    /// [`MAX_ID_COMPONENT`].
    ///
    /// The numeric counterpart to [`EventId::parse`], and it applies the same rule: a
    /// host that reports nanoseconds where §2 wants milliseconds, or an ABI caller that
    /// assembles a cursor from two `uint64_t`s, would otherwise produce an id that this
    /// implementation accepts and every JavaScript one rounds to a different event.
    pub fn new(ms: u64, seq: u64) -> Option<EventId> {
        if ms > MAX_ID_COMPONENT || seq > MAX_ID_COMPONENT {
            return None;
        }
        Some(EventId { ms, seq })
    }

    /// Unix milliseconds.
    pub fn ms(&self) -> u64 {
        self.ms
    }

    /// The counter within that millisecond.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Parses a canonical `<ms>-<seq>`.
    ///
    /// Rejects leading zeros, signs, whitespace and exponents. A malformed cursor must
    /// be a `400`, never a silent downgrade to "no cursor": a client that believes it
    /// resumed and did not would never be told.
    pub fn parse(raw: &str) -> Option<EventId> {
        let (ms, seq) = raw.split_once('-')?;
        EventId::new(canonical_u64(ms)?, canonical_u64(seq)?)
    }
}

// `b[0]` follows an `is_empty` guard, so the slice has a first byte.
#[allow(clippy::indexing_slicing)]
fn canonical_u64(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    // 16 digits is the most that can fit under MAX_ID_COMPONENT, so anything longer is
    // rejected before parsing rather than after.
    if b.is_empty() || b.len() > 16 {
        return None;
    }
    if b.len() > 1 && b[0] == b'0' {
        return None;
    }
    if !b.iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok().filter(|n| *n <= MAX_ID_COMPONENT)
}

impl Ord for EventId {
    fn cmp(&self, other: &Self) -> Ordering {
        self.ms.cmp(&other.ms).then(self.seq.cmp(&other.seq))
    }
}

impl PartialOrd for EventId {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for EventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}-{}", self.ms, self.seq)
    }
}

/// Assigns ids that never go backwards, even when the wall clock does.
#[derive(Debug, Default)]
pub(crate) struct Sequence {
    last: EventId,
}

impl Sequence {
    /// §2.2 — if the clock regresses or stalls, reuse the millisecond and advance the
    /// sequence. A backwards clock must never surface as a backwards cursor.
    ///
    /// `None` when the id space is exhausted, which is one of two things and neither is
    /// a value to silently emit. A `now_ms` above [`MAX_ID_COMPONENT`] is a host
    /// reporting the wrong unit — nanoseconds where §2 wants milliseconds is the
    /// plausible one, and it lands two orders of magnitude past the bound. A `seq` at the
    /// bound needs 2^53 publishes inside one millisecond, so in practice it can only
    /// follow a foreign id already at the top. Either way, emitting the id anyway hands
    /// every JavaScript client a number it will round to a *different* event, which is
    /// the ambiguity D9 narrowed the range to eliminate.
    pub(crate) fn next(&mut self, now_ms: u64) -> Option<EventId> {
        let next = if now_ms > self.last.ms {
            EventId::new(now_ms, 0)?
        } else {
            EventId::new(self.last.ms, self.last.seq.checked_add(1)?)?
        };
        self.last = next;
        Some(next)
    }

    pub(crate) fn current(&self) -> EventId {
        self.last
    }

    /// Advances past an id assigned somewhere else, if it is newer than anything seen.
    ///
    /// A backplane owns id assignment, so ids arrive that this sequence never drew. If
    /// the local counter stayed behind them, a later fall back to local assignment — a
    /// backplane outage, say — would mint an id already used by another process, and
    /// every client's dedupe would discard the second one as already-seen.
    ///
    /// Conditional rather than unconditional: events arrive out of order after a
    /// reconnect, and an older id must never drag the cursor backwards.
    pub(crate) fn observe(&mut self, id: EventId) {
        if id > self.last {
            self.last = id;
        }
    }
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
    fn parses_only_canonical_ids() {
        assert_eq!(EventId::parse("0-0"), Some(EventId::ZERO));
        assert_eq!(EventId::parse("1755083412345-7").unwrap().seq, 7);
        for bad in
            ["", "1", "-0", "1-", "01-0", "1-00", "a-b", "1e5-0", " 1-0", "1-0 ", "+1-0", "1.0-0"]
        {
            assert!(EventId::parse(bad).is_none(), "should reject {bad:?}");
        }
    }

    #[test]
    fn refuses_ids_no_javascript_host_could_represent() {
        // The boundary itself parses.
        assert_eq!(EventId::parse("9007199254740991-0").unwrap().ms, MAX_ID_COMPONENT);
        assert_eq!(EventId::parse("0-9007199254740991").unwrap().seq, MAX_ID_COMPONENT);

        // Past it, an f64 cannot tell neighbouring integers apart, so accepting these
        // would mean one cursor string naming two different events across languages.
        for bad in [
            "9007199254740992-0",
            "9007199254740993-0",
            "0-9007199254740992",
            "18446744073709551615-0",
            "99999999999999999-0",
        ] {
            assert!(EventId::parse(bad).is_none(), "should reject {bad:?}");
        }
    }

    #[test]
    fn orders_numerically_not_lexicographically() {
        let a = EventId { ms: 1755083412345, seq: 7 };
        let b = EventId { ms: 1755083412345, seq: 10 };
        assert!(a < b);
        assert!(b.to_string() < a.to_string(), "string order really is inverted");
    }

    #[test]
    fn the_numeric_constructor_applies_the_same_bound_as_the_parser() {
        assert!(EventId::new(MAX_ID_COMPONENT, MAX_ID_COMPONENT).is_some());
        // The path that had no bound at all: two integers, no string in sight.
        assert!(EventId::new(MAX_ID_COMPONENT + 1, 0).is_none());
        assert!(EventId::new(0, MAX_ID_COMPONENT + 1).is_none());
        assert!(EventId::new(u64::MAX, u64::MAX).is_none());
    }

    #[test]
    fn a_clock_in_the_wrong_unit_is_refused_rather_than_emitted() {
        // Nanoseconds where §2 wants milliseconds — the realistic way a binding gets
        // this wrong, and two orders of magnitude past what an f64 can name exactly.
        let mut s = Sequence::default();
        assert!(s.next(1_757_000_000_000_000_000).is_none());
        // And the sequence is untouched, so the mistake costs no ids.
        assert_eq!(s.current(), EventId::ZERO);
        assert_eq!(s.next(1000).map(|id| id.to_string()), Some("1000-0".to_string()));
    }

    #[test]
    fn the_sequence_stops_at_the_bound_rather_than_stepping_over_it() {
        let mut s = Sequence::default();
        // A foreign id at the top, as a backplane could deliver.
        s.observe(EventId::new(1000, MAX_ID_COMPONENT).unwrap());
        // The clock has stalled inside that millisecond, so the only way forward is seq.
        assert!(s.next(1000).is_none(), "seq must not step past 2^53-1");
        assert_eq!(s.current().seq(), MAX_ID_COMPONENT, "and nothing moved");
        // A later millisecond is still fine: only the seq half was exhausted.
        assert_eq!(s.next(1001).map(|id| id.to_string()), Some("1001-0".to_string()));
    }

    #[test]
    fn never_regresses_when_the_clock_does() {
        let mut s = Sequence::default();
        let ids: Vec<String> = [1000u64, 999, 999, 1001]
            .iter()
            .map(|ms| s.next(*ms).expect("well inside the id space").to_string())
            .collect();
        assert_eq!(ids, ["1000-0", "1000-1", "1000-2", "1001-0"]);
    }
}

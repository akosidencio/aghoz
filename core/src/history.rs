//! The history ring — §10.

use crate::id::EventId;
use std::collections::VecDeque;

pub(crate) struct Entry {
    pub(crate) id: EventId,
    pub(crate) topic: String,
    pub(crate) frame: Vec<u8>,
}

/// A byte-bounded ring of recent events.
///
/// Bounded in **bytes**, not entries: N events multiplied by an arbitrary payload size
/// is not a memory bound, and the failure mode is an OOM under exactly the traffic the
/// product is for.
pub(crate) struct History {
    entries: VecDeque<Entry>,
    bytes: usize,
    max_bytes: usize,
    /// The highest id ever evicted, or `None` if nothing has been.
    ///
    /// This — not the oldest *retained* entry — is what decides whether a cursor missed
    /// something. The two differ in both directions, and both were wrong:
    ///
    /// - A ring that has never trimmed still has an oldest entry, and every cursor below
    ///   it compared as truncated even though nothing was dropped. `0-0`, the cold-start
    ///   cursor §5 hands out, is below every real id — so the documented first-page-load
    ///   path reported a gap to a client that had missed nothing.
    /// - A single frame larger than the whole budget is evicted on the push that added
    ///   it, leaving the ring *empty*. With no oldest entry there was nothing to compare
    ///   against, so a real loss was reported as "nothing missed" — silent staleness,
    ///   which is the one failure this protocol exists to eliminate.
    ///
    /// Kept as a maximum rather than "the last one evicted" so that an out-of-order
    /// `append` — a backplane replaying into the ring — can only push the mark forward.
    /// Over-reporting is a false alarm; under-reporting is data loss with no symptom.
    last_trimmed: Option<EventId>,
}

impl History {
    pub(crate) fn new(max_bytes: usize) -> History {
        History { entries: VecDeque::new(), bytes: 0, max_bytes, last_trimmed: None }
    }

    /// `self.bytes` is the sum of the retained frames' lengths, so neither the add nor
    /// the subtract below can leave that range: a frame long enough to overflow a `usize`
    /// could not have been allocated in the first place, and every subtraction pairs with
    /// the addition made when that same frame was pushed.
    #[allow(clippy::arithmetic_side_effects)]
    pub(crate) fn push(&mut self, entry: Entry) {
        self.bytes += entry.frame.len();
        self.entries.push_back(entry);
        while self.bytes > self.max_bytes {
            match self.entries.pop_front() {
                Some(dropped) => {
                    self.bytes -= dropped.frame.len();
                    if self.last_trimmed.is_none_or(|t| dropped.id > t) {
                        self.last_trimmed = Some(dropped.id);
                    }
                }
                None => break,
            }
        }
    }

    pub(crate) fn last_trimmed(&self) -> Option<EventId> {
        self.last_trimmed
    }

    pub(crate) fn since<'a>(
        &'a self,
        cursor: EventId,
        topics: &'a [String],
    ) -> impl Iterator<Item = &'a Entry> + 'a {
        self.entries.iter().filter(move |e| e.id > cursor && topics.contains(&e.topic))
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
}

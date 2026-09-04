//! Subscriber bookkeeping — §4.5, §8.2, §9.3, §10.

use std::collections::{HashMap, HashSet};

/// Opaque subscriber handle. Never reused, even after removal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SubscriberId(pub u64);

pub(crate) struct Subscriber {
    pub(crate) topics: Vec<String>,
    pub(crate) key: Option<String>,
    pub(crate) queued: usize,
}

pub(crate) struct Registry {
    next: u64,
    subs: HashMap<SubscriberId, Subscriber>,
    /// §4.5 — topic index, so a publish costs O(matching) not O(subscribers).
    by_topic: HashMap<String, HashSet<SubscriberId>>,
    by_key: HashMap<String, usize>,
}

impl Registry {
    pub(crate) fn new() -> Registry {
        Registry {
            // Starts at 1 so that 0 can mean "none" across the C ABI.
            next: 1,
            subs: HashMap::new(),
            by_topic: HashMap::new(),
            by_key: HashMap::new(),
        }
    }

    pub(crate) fn count_for_key(&self, key: &str) -> usize {
        self.by_key.get(key).copied().unwrap_or(0)
    }

    /// Registers a subscriber. `topics` must already be deduplicated — see [`dedupe`].
    ///
    /// `self.next += 1` cannot overflow: it advances once per subscribe, and a `u64`
    /// exhausted at a million connections a second takes half a million years.
    #[allow(clippy::arithmetic_side_effects)]
    pub(crate) fn add(&mut self, unique: Vec<String>, key: Option<String>) -> SubscriberId {
        // A recycled id lets a write scheduled for a closed subscriber land on whoever
        // inherited the number — a cross-tenant leak that would be near-impossible to
        // reproduce. So ids only ever move forward.
        let id = SubscriberId(self.next);
        self.next += 1;

        for topic in &unique {
            self.by_topic.entry(topic.clone()).or_default().insert(id);
        }
        if let Some(k) = &key {
            // One per live subscriber, so it is bounded by `self.next` above.
            *self.by_key.entry(k.clone()).or_insert(0) += 1;
        }
        self.subs.insert(id, Subscriber { topics: unique, key, queued: 0 });
        id
    }

    /// Idempotent — §8.2 requires removal on both the request's and the response's
    /// close event, and both fire in the ordinary case.
    pub(crate) fn remove(&mut self, id: SubscriberId) -> bool {
        let Some(sub) = self.subs.remove(&id) else { return false };

        for topic in &sub.topics {
            if let Some(set) = self.by_topic.get_mut(topic) {
                set.remove(&id);
                // Without this the index grows forever on per-entity topics, and
                // nothing user-visible ever fails.
                if set.is_empty() {
                    self.by_topic.remove(topic);
                }
            }
        }
        if let Some(k) = sub.key {
            match self.by_key.get_mut(&k) {
                // Guarded at two or more, so this cannot underflow; the count reaching
                // one is the removal that takes the entry out entirely.
                #[allow(clippy::arithmetic_side_effects)]
                Some(n) if *n > 1 => *n -= 1,
                _ => {
                    self.by_key.remove(&k);
                }
            }
        }
        true
    }

    pub(crate) fn matching(&self, topic: &str, out: &mut Vec<SubscriberId>) {
        out.clear();
        if let Some(set) = self.by_topic.get(topic) {
            out.extend(set.iter().copied());
            // Deterministic order so bindings and tests see stable fan-out.
            out.sort_unstable();
        }
    }

    pub(crate) fn set_queued(&mut self, id: SubscriberId, bytes: usize) -> Option<usize> {
        let sub = self.subs.get_mut(&id)?;
        sub.queued = bytes;
        Some(bytes)
    }

    /// Adds to the outstanding count, for a host that cannot report an absolute depth.
    ///
    /// Saturating, so a host that writes more than `usize::MAX` bytes without ever
    /// reporting a flush pins the counter at the top rather than wrapping to zero — which
    /// would read as a perfectly healthy subscriber at the exact moment it is furthest
    /// behind.
    pub(crate) fn add_queued(&mut self, id: SubscriberId, bytes: usize) -> Option<usize> {
        let sub = self.subs.get_mut(&id)?;
        sub.queued = sub.queued.saturating_add(bytes);
        Some(sub.queued)
    }

    /// Subtracts from the outstanding count.
    ///
    /// Saturating for the same class of reason in the other direction: a host that
    /// reports a flush for bytes it never reported sending — a double count, or a frame
    /// written before the subscriber registered — must land on zero, not underflow to
    /// `usize::MAX` and drop a subscriber that is entirely caught up.
    pub(crate) fn sub_queued(&mut self, id: SubscriberId, bytes: usize) -> Option<usize> {
        let sub = self.subs.get_mut(&id)?;
        sub.queued = sub.queued.saturating_sub(bytes);
        Some(sub.queued)
    }

    pub(crate) fn topics_of(&self, id: SubscriberId) -> Option<&[String]> {
        self.subs.get(&id).map(|s| s.topics.as_slice())
    }

    pub(crate) fn len(&self) -> usize {
        self.subs.len()
    }

    pub(crate) fn topic_count(&self) -> usize {
        self.by_topic.len()
    }
}

/// Removes repeated topics, keeping the order the caller asked for.
///
/// A duplicate would deliver one event to one socket twice, with the same id both times,
/// which is the one shape of duplicate no client-side dedupe can repair — the second copy
/// is indistinguishable from the first.
pub(crate) fn dedupe(topics: Vec<String>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::with_capacity(topics.len());
    for topic in topics {
        if !unique.contains(&topic) {
            unique.push(topic);
        }
    }
    unique
}

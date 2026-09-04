//! The stable C ABI over [`aghoz_core`].
//!
//! Every language binding targets this surface — napi for Node, PyO3 or ctypes for
//! Python, cgo for Go, FFI for Ruby. It is the expensive thing to change, so it is
//! deliberately small: a handle, five operations (publish, append, encode, subscribe and
//! the backpressure reports) and accessors for what they return. See `ADAPTERS.md` for
//! how a binding is expected to use them.
//!
//! Three rules hold everywhere in this file, and breaking any of them is a soundness
//! bug rather than a style question:
//!
//! 1. **No panic crosses the boundary.** Unwinding into C is undefined behaviour, so
//!    every entry point is wrapped in [`std::panic::catch_unwind`] and turns a panic
//!    into [`AG_ERR_PANIC`].
//! 2. **Nothing is assumed null-terminated.** Every string is a pointer and a length.
//!    Payloads may legitimately contain NUL — §3 forbids it in *topics*, not in data —
//!    and a `strlen` here would silently truncate user content.
//! 3. **Rust allocations are freed by Rust.** Anything handed out has a matching
//!    `*_free`; callers must never `free()` it themselves.
//!
//! `aghoz-core` is `forbid(unsafe_code)` and stays that way. **All of the unsafe in
//! the project lives here, in one auditable file**, and it is all one of three shapes:
//! turn a caller's pointer+length into a slice, read through a pointer the caller
//! promised is valid, or write a result through an out-pointer.
//!
//! A C ABI cannot be written without unsafe — dereferencing a caller-supplied pointer
//! is unsafe by definition, and that is the entire content of an FFI boundary. What can
//! be done is to make it small, uniform, and verified: `unsafe_op_in_unsafe_fn` is
//! denied below so no operation hides inside an `unsafe fn` signature, and CI runs the
//! ABI test suite under Miri, which actually executes these paths looking for undefined
//! behaviour rather than trusting review.

// These names appear verbatim in `include/aghoz.h` and in every binding's
// declarations. Renaming them to Rust convention would make the two disagree.
#![allow(non_camel_case_types)]
// An `unsafe fn` does not implicitly make its body an unsafe block: every dereference
// must be spelled out, so none of them can be added later without review noticing.
#![deny(unsafe_op_in_unsafe_fn)]

use aghoz_core::{
    BufferVerdict, Checkpoint, EventId, Hub, HubConfig, OriginError, PublishEffect, PublishError,
    SubscribeEffect, SubscribeError, SubscriberId, TopicError,
};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

// ---------------------------------------------------------------- status codes

/// Success.
pub const AG_OK: i32 = 0;
/// A topic was empty.
pub const AG_ERR_TOPIC_EMPTY: i32 = -1;
/// A topic exceeded 255 bytes. Bytes, not characters.
pub const AG_ERR_TOPIC_TOO_LONG: i32 = -2;
/// A topic contained a C0 control character or DEL.
pub const AG_ERR_TOPIC_CONTROL: i32 = -3;
/// A topic began with the reserved `~`.
pub const AG_ERR_TOPIC_RESERVED: i32 = -4;
/// Zero topics, or more than the configured maximum.
pub const AG_ERR_TOPIC_COUNT: i32 = -5;
/// The per-process connection cap was reached. Bindings map this to `429`.
pub const AG_ERR_MAX_CONNECTIONS: i32 = -6;
/// The per-key connection cap was reached. `429`.
pub const AG_ERR_MAX_CONNECTIONS_PER_KEY: i32 = -7;
/// A required pointer was null.
pub const AG_ERR_NULL: i32 = -8;
/// A string argument was not valid UTF-8.
pub const AG_ERR_UTF8: i32 = -9;
/// A panic was caught at the boundary. Indicates a bug in the core.
pub const AG_ERR_PANIC: i32 = -10;
/// The hub's lock was poisoned by an earlier panic; the hub is no longer usable.
pub const AG_ERR_POISONED: i32 = -11;
/// An origin was validated on its own and was zero bytes. `ag_publish` never returns
/// this: there, empty and absent are the same thing.
pub const AG_ERR_ORIGIN_EMPTY: i32 = -12;
/// An origin exceeded 64 bytes. Bytes, not characters.
pub const AG_ERR_ORIGIN_TOO_LONG: i32 = -13;
/// An origin contained a C0 control character or DEL.
pub const AG_ERR_ORIGIN_CONTROL: i32 = -14;
/// An id was not a canonical `<ms>-<seq>` — §2.1 forbids padding, signs and exponents —
/// or one of its halves exceeded 2^53 − 1.
///
/// Parsing lives here rather than in each binding on purpose: "which strings are ids" is
/// exactly the class of rule that every language gets subtly wrong in its own way, and D3
/// exists to keep it in one place.
///
/// The range half of that rule now answers for the paths with no string in them, which is
/// why [`ag_publish`] and [`ag_subscribe`] can return this and once could not: a `now_ms`
/// in the wrong unit and a cursor assembled from two `uint64_t`s both produce an id that
/// this implementation could hold and every JavaScript one would round to a different
/// event. One code rather than two, because it is one rule being broken.
pub const AG_ERR_MALFORMED_ID: i32 = -15;

/// Subscriber is keeping up.
pub const AG_BUFFER_OK: i32 = 0;
/// Subscriber is past `max_buffer_bytes`; write the gap frame, then close.
pub const AG_BUFFER_SLOW_CONSUMER: i32 = 1;
/// No such subscriber — a write that completed after teardown.
pub const AG_BUFFER_UNKNOWN: i32 = 2;

/// No cursor was presented; omit the checkpoint header entirely.
pub const AG_CHECKPOINT_ABSENT: i32 = 0;
/// History reaches the cursor; echo it back.
pub const AG_CHECKPOINT_ECHO: i32 = 1;
/// History no longer reaches it; send `earliest` and a `~gap` frame.
pub const AG_CHECKPOINT_EARLIEST: i32 = 2;

/// `~gap` reason: the cursor was older than retained history.
pub const AG_GAP_HISTORY_TRUNCATED: i32 = 0;
/// `~gap` reason: the subscriber could not drain its socket.
pub const AG_GAP_SLOW_CONSUMER: i32 = 1;

/// The ABI revision. Bindings should refuse to load a library whose major differs.
///
/// Encoded as `major * 1000 + minor`.
///
/// **3000** added [`ag_append`] and [`ag_encode`], without which a backplane cannot be
/// expressed outside Node — and a backplane is a prerequisite for the second binding, not
/// a feature after it, because Gunicorn, Puma and Swoole are multi-worker by default. A
/// major bump rather than a minor one because [`AG_ERR_MALFORMED_ID`] is a status a
/// version-2000 caller has no arm for. Broken deliberately while nothing has shipped and
/// no binding exists; the alternative was a shim living forever.
///
/// **3100** added [`ag_note_sent`] and [`ag_note_flushed`], so §8.2 is reachable from a
/// host that cannot report an absolute socket depth. A *minor* bump: both are new symbols
/// returning existing status codes, so a 3000-era caller keeps working untouched.
///
/// **3200** added [`ag_compare_ids`]. Also minor, and also additive: a host that keeps
/// persistent history has to decide whether a cursor predates what its storage threw
/// away, and §2.1 forbids comparing ids as strings — so without this every binding would
/// have to reimplement the one comparison the corpus exists to keep identical.
pub const AG_ABI_VERSION: u32 = 3_200;

// ---------------------------------------------------------------------- types

/// A borrowed byte string: pointer and length, never assumed null-terminated.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ag_str {
    /// Start of the bytes. May be null only when `len` is zero.
    pub ptr: *const u8,
    /// Length in bytes.
    pub len: usize,
}

impl ag_str {
    /// # Safety
    /// `ptr` must be valid for `len` bytes, or `len` must be zero.
    unsafe fn as_str(&self) -> Result<&str, i32> {
        if self.len == 0 {
            return Ok("");
        }
        if self.ptr.is_null() {
            return Err(AG_ERR_NULL);
        }
        // SAFETY: the caller of `as_str` guarantees `ptr` is valid for `len` bytes; the
        // zero-length and null cases returned above, so this is a live, readable range.
        let bytes = unsafe { std::slice::from_raw_parts(self.ptr, self.len) };
        std::str::from_utf8(bytes).map_err(|_| AG_ERR_UTF8)
    }
}

/// Limits. Zero means "use the default" for every field, so a caller that
/// zero-initialises the struct gets sane behaviour rather than a hub that refuses
/// every connection.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct ag_config {
    /// Bytes of history retained. 0 → 8 MiB.
    pub max_history_bytes: u64,
    /// Queued bytes before a subscriber is a slow consumer. 0 → 1 MiB.
    pub max_buffer_bytes: u64,
    /// Connections per process. 0 → unlimited.
    pub max_connections: u64,
    /// Connections per key. 0 → unlimited.
    pub max_connections_per_key: u64,
    /// Topics per connection. 0 → 64.
    pub max_topics_per_connection: u64,
}

impl From<ag_config> for HubConfig {
    fn from(c: ag_config) -> HubConfig {
        let d = HubConfig::default();
        HubConfig {
            max_history_bytes: pick(c.max_history_bytes, d.max_history_bytes),
            max_buffer_bytes: pick(c.max_buffer_bytes, d.max_buffer_bytes),
            max_connections: pick_unlimited(c.max_connections),
            max_connections_per_key: pick_unlimited(c.max_connections_per_key),
            max_topics_per_connection: pick(
                c.max_topics_per_connection,
                d.max_topics_per_connection,
            ),
        }
    }
}

/// Saturating rather than `as`, because these are 64-bit fields landing in a `usize`.
///
/// On a 32-bit host — 32-bit ARM and i686 are squarely in the set of runtimes this ABI
/// exists for — `4 GiB as usize` is **0**, and a zero history budget evicts every event
/// on the push that adds it. The limit a caller asked to raise would have silently become
/// the tightest one the hub can hold, and every cursor would then be told it missed
/// something. Clamping to `usize::MAX` reads as "as much as this host can address",
/// which is what a caller naming a number that large meant.
fn to_usize_saturating(v: u64) -> usize {
    usize::try_from(v).unwrap_or(usize::MAX)
}

fn pick(v: u64, default: usize) -> usize {
    if v == 0 {
        default
    } else {
        to_usize_saturating(v)
    }
}

fn pick_unlimited(v: u64) -> usize {
    if v == 0 {
        usize::MAX
    } else {
        to_usize_saturating(v)
    }
}

/// An opaque hub handle.
///
/// Internally synchronised, because Go, the JVM and threaded Python may call from
/// several threads. Node pays for an uncontended lock, which is far cheaper than the
/// alternative of a second, unsynchronised entry point to keep correct.
pub struct ag_hub {
    inner: Mutex<Hub>,
}

/// The result of a publish. Owns the encoded frame and the target list.
pub struct ag_publish_result {
    effect: PublishEffect,
    targets: Vec<u64>,
}

/// The result of a subscribe. Owns the replay frames.
pub struct ag_subscribe_result {
    effect: SubscribeEffect,
}

/// An owned byte buffer handed to the caller. Free with [`ag_buf_free`].
pub struct ag_buf {
    bytes: Vec<u8>,
}

// ------------------------------------------------------------------- helpers

fn topic_code(e: TopicError) -> i32 {
    match e {
        TopicError::Empty => AG_ERR_TOPIC_EMPTY,
        TopicError::TooLong => AG_ERR_TOPIC_TOO_LONG,
        TopicError::ControlCharacter => AG_ERR_TOPIC_CONTROL,
        TopicError::ReservedPrefix => AG_ERR_TOPIC_RESERVED,
    }
}

fn origin_code(e: OriginError) -> i32 {
    match e {
        OriginError::Empty => AG_ERR_ORIGIN_EMPTY,
        OriginError::TooLong => AG_ERR_ORIGIN_TOO_LONG,
        OriginError::ControlCharacter => AG_ERR_ORIGIN_CONTROL,
    }
}

fn publish_code(e: PublishError) -> i32 {
    match e {
        PublishError::Topic(t) => topic_code(t),
        PublishError::Origin(o) => origin_code(o),
        // The same code the string form gets. An id outside §2's range is not a second
        // kind of failure — `ag_append("9007199254740992-0", ..)` and a `now_ms` in
        // nanoseconds break the identical rule — so it would be a new status for callers
        // to grow an arm for while saying nothing new. See [`AG_ERR_MALFORMED_ID`].
        PublishError::IdOutOfRange => AG_ERR_MALFORMED_ID,
    }
}

fn subscribe_code(e: SubscribeError) -> i32 {
    match e {
        SubscribeError::Topic(t) => topic_code(t),
        SubscribeError::TopicCount => AG_ERR_TOPIC_COUNT,
        SubscribeError::MaxConnections => AG_ERR_MAX_CONNECTIONS,
        SubscribeError::MaxConnectionsPerKey => AG_ERR_MAX_CONNECTIONS_PER_KEY,
    }
}

/// Reads the three wire-bound strings every write path takes.
///
/// Shared by `ag_publish`, `ag_append` and `ag_encode` so the "empty origin means absent"
/// rule cannot hold on one path and not another — the kind of divergence that shows up as
/// a frame differing by one field depending on whether a backplane was configured.
///
/// # Safety
/// Each `ag_str` must be valid for its stated length, or have length zero.
unsafe fn write_args<'a>(
    topic: &'a ag_str,
    payload: &'a ag_str,
    origin: &'a ag_str,
) -> Result<(&'a str, &'a str, Option<&'a str>), i32> {
    // SAFETY: `topic` is an `ag_str` this function's contract requires to be valid for its
    // own length, or to have length zero.
    let topic = unsafe { topic.as_str() }?;
    // SAFETY: `payload` carries the same contract as `topic` above.
    let payload = unsafe { payload.as_str() }?;
    // A null pointer and a zero length both mean absent — see `ag_publish`.
    let origin = if origin.ptr.is_null() {
        None
    } else {
        // SAFETY: `origin` is non-null here, and carries the same contract as `topic` above.
        Some(unsafe { origin.as_str() }?)
    };
    Ok((topic, payload, origin))
}

/// Parses a caller-supplied `<ms>-<seq>`, per §2.1.
///
/// # Safety
/// `id` must be valid for its stated length, or have length zero.
unsafe fn read_id(id: &ag_str) -> Result<EventId, i32> {
    // SAFETY: `id` is an `ag_str` this function's contract requires to be valid for its own
    // length, or to have length zero.
    let raw = unsafe { id.as_str() }?;
    EventId::parse(raw).ok_or(AG_ERR_MALFORMED_ID)
}

/// Turns a caller's handle into a borrow, or `None` if it is null.
///
/// The whole of the pointer half of every hub operation, in one line per entry point.
/// The alternative — passing the raw pointer down into [`with_hub`] — makes the closure
/// body sit inside an `unsafe` block, and then the `unsafe` blocks the closure writes for
/// its own dereferences become redundant and stop being written. That is precisely the
/// hiding `deny(unsafe_op_in_unsafe_fn)` is set to prevent.
///
/// # Safety
/// `hub` must be null, or a handle from [`ag_hub_new`] that has not been freed, and no
/// other thread may free it for the lifetime of the returned borrow.
unsafe fn hub_ref<'a>(hub: *mut ag_hub) -> Option<&'a ag_hub> {
    // SAFETY: the caller guarantees a live handle or null, which is exactly what
    // `as_ref` asks for; it yields `None` for the null case rather than a bad reference.
    unsafe { hub.as_ref() }
}

/// Runs `f` with the hub locked, converting panics and poisoning into status codes.
///
/// Takes a borrow rather than a pointer, so this — where the lock and the panic boundary
/// live — contains no unsafe at all.
fn with_hub<F>(hub: Option<&ag_hub>, f: F) -> i32
where
    F: FnOnce(&mut Hub) -> i32,
{
    let Some(handle) = hub else {
        return AG_ERR_NULL;
    };
    let result = catch_unwind(AssertUnwindSafe(|| match handle.inner.lock() {
        Err(_) => AG_ERR_POISONED,
        Ok(mut guard) => f(&mut guard),
    }));
    result.unwrap_or(AG_ERR_PANIC)
}

// ------------------------------------------------------------------ lifecycle

/// Returns [`AG_ABI_VERSION`].
#[no_mangle]
pub extern "C" fn ag_abi_version() -> u32 {
    AG_ABI_VERSION
}

/// Creates a hub. `config` may be null, meaning all defaults.
///
/// Returns null only on allocation failure or panic.
///
/// # Safety
/// `config` must be null, or point to a readable, aligned `ag_config`. It is copied
/// before this returns and is not retained.
#[no_mangle]
pub unsafe extern "C" fn ag_hub_new(config: *const ag_config) -> *mut ag_hub {
    let result = catch_unwind(|| {
        let cfg = if config.is_null() {
            ag_config::default()
        } else {
            // SAFETY: `config` was null-checked on the line above, and the entry point's contract
            // requires a readable, aligned `ag_config` behind it. It is copied, not retained.
            unsafe { *config }
        };
        Box::into_raw(Box::new(ag_hub { inner: Mutex::new(Hub::new(cfg.into())) }))
    });
    result.unwrap_or(std::ptr::null_mut())
}

/// Destroys a hub. Null is a no-op. Must not be called twice on the same pointer.
///
/// # Safety
/// `hub` must be null, or a handle from [`ag_hub_new`] that has not already been
/// freed. No other thread may be inside a call on it, and it must not be used again.
#[no_mangle]
pub unsafe extern "C" fn ag_hub_free(hub: *mut ag_hub) {
    if hub.is_null() {
        return;
    }
    // SAFETY: `hub` was null-checked above, and the entry point's contract requires a handle
    // from `ag_hub_new` that has not already been freed — so ownership returns here.
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(hub));
    }));
}

// -------------------------------------------------------------------- publish

/// Assigns an id, encodes a frame, and matches subscribers.
///
/// On [`AG_OK`], `*out` receives a result the caller must release with
/// [`ag_publish_result_free`]. On error, `*out` is left untouched.
///
/// `origin` is §6.0's optional field. Absent is either a null `origin.ptr` or a zero
/// length — the two mean the same thing, because the callers on the other side of a
/// binding produce empty strings for missing values as a matter of course (`?? ""` in
/// JavaScript, `""` from a missing header) and turning that into an error would make the
/// common case the hostile one.
///
/// [`AG_ERR_ORIGIN_EMPTY`] therefore cannot come from here. It exists for a binding that
/// calls the validator directly on a value it means to treat as present.
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`]. Each `ag_str` must be
/// valid for its stated length, or have length zero. `out` must be null or point to a
/// writable `*mut ag_publish_result`; on [`AG_OK`] it receives a result to release with
/// [`ag_publish_result_free`].
#[no_mangle]
pub unsafe extern "C" fn ag_publish(
    hub: *mut ag_hub,
    now_ms: u64,
    topic: ag_str,
    payload: ag_str,
    origin: ag_str,
    out: *mut *mut ag_publish_result,
) -> i32 {
    if out.is_null() {
        return AG_ERR_NULL;
    }
    with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| {
            // SAFETY: the three `ag_str`s are this entry point's arguments, which its contract
            // requires to be valid for their stated lengths.
            let (topic, payload, origin) = match unsafe { write_args(&topic, &payload, &origin) } {
                Ok(args) => args,
                Err(code) => return code,
            };
            match h.publish(now_ms, topic, payload, origin) {
                Err(e) => publish_code(e),
                // SAFETY: `out` was null-checked at the top of this entry point.
                Ok(effect) => unsafe { yield_publish(effect, out) },
            }
        },
    )
}

/// Records an event whose id was assigned elsewhere, and reports who should receive it.
///
/// The backplane counterpart to [`ag_publish`]: a shared sequencer owns id assignment, so
/// the id arrives rather than being drawn. Per-process counters collide — two pods
/// publishing in the same millisecond would both mint `<ms>-0` and every client's dedupe
/// would discard one of them as already-seen — which is why this exists as its own call
/// instead of an `ag_publish` that accepts an id.
///
/// `id` is a canonical `<ms>-<seq>` string, not the split halves, so that §2.1's parsing
/// rule stays in the core. On [`AG_OK`], `*out` receives a result to release with
/// [`ag_publish_result_free`]; on error `*out` is left untouched.
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`]. Each `ag_str` must be
/// valid for its stated length, or have length zero. `out` must be null or point to a
/// writable `*mut ag_publish_result`.
#[no_mangle]
pub unsafe extern "C" fn ag_append(
    hub: *mut ag_hub,
    id: ag_str,
    topic: ag_str,
    payload: ag_str,
    origin: ag_str,
    out: *mut *mut ag_publish_result,
) -> i32 {
    if out.is_null() {
        return AG_ERR_NULL;
    }
    with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| {
            // SAFETY: `id` is this entry point's argument, valid for its length by contract.
            let id = match unsafe { read_id(&id) } {
                Ok(id) => id,
                Err(code) => return code,
            };
            // SAFETY: the three `ag_str`s are this entry point's arguments, valid for their stated
            // lengths by contract.
            let (topic, payload, origin) = match unsafe { write_args(&topic, &payload, &origin) } {
                Ok(args) => args,
                Err(code) => return code,
            };
            match h.append(id, topic, payload, origin) {
                Err(e) => publish_code(e),
                // SAFETY: `out` was null-checked at the top of this entry point.
                Ok(effect) => unsafe { yield_publish(effect, out) },
            }
        },
    )
}

/// Encodes a frame for an event whose id was assigned elsewhere, recording nothing.
///
/// What replay from a *shared* history needs: those events are already in the shared log,
/// so the only thing missing is their bytes. Routing them through [`ag_append`] instead
/// would push duplicates into the local ring on every reconnect, out of id order, which
/// corrupts the ordering the truncation decision depends on.
///
/// On [`AG_OK`], `*out` receives a buffer to release with [`ag_buf_free`].
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`]. Each `ag_str` must be
/// valid for its stated length, or have length zero. `out` must be null or point to a
/// writable `*mut ag_buf`.
#[no_mangle]
pub unsafe extern "C" fn ag_encode(
    hub: *mut ag_hub,
    id: ag_str,
    topic: ag_str,
    payload: ag_str,
    origin: ag_str,
    out: *mut *mut ag_buf,
) -> i32 {
    if out.is_null() {
        return AG_ERR_NULL;
    }
    with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| {
            // SAFETY: `id` is this entry point's argument, valid for its length by contract.
            let id = match unsafe { read_id(&id) } {
                Ok(id) => id,
                Err(code) => return code,
            };
            // SAFETY: the three `ag_str`s are this entry point's arguments, valid for their stated
            // lengths by contract.
            let (topic, payload, origin) = match unsafe { write_args(&topic, &payload, &origin) } {
                Ok(args) => args,
                Err(code) => return code,
            };
            match h.encode(id, topic, payload, origin) {
                Err(e) => publish_code(e),
                Ok(bytes) => {
                    // SAFETY: `out` was null-checked at the top of this entry point, and its contract
                    // requires it to be writable. The caller owns the buffer from here.
                    unsafe { *out = Box::into_raw(Box::new(ag_buf { bytes })) };
                    AG_OK
                }
            }
        },
    )
}

/// Boxes a [`PublishEffect`] for the caller. Shared by `ag_publish` and `ag_append`.
///
/// # Safety
/// `out` must be non-null and writable.
unsafe fn yield_publish(effect: PublishEffect, out: *mut *mut ag_publish_result) -> i32 {
    let targets = effect.targets.iter().map(|s| s.0).collect();
    let boxed = Box::new(ag_publish_result { effect, targets });
    // SAFETY: `out` is documented as non-null and writable, and every caller null-checks it
    // before entering the hub. The caller owns the result from here.
    unsafe { *out = Box::into_raw(boxed) };
    AG_OK
}

/// The encoded frame. Valid until the result is freed.
///
/// # Safety
/// `result` must be null or a live result from [`ag_publish`] or [`ag_append`], and
/// `len` null or writable. The returned pointer borrows from `result` and is invalidated
/// by [`ag_publish_result_free`].
#[no_mangle]
pub unsafe extern "C" fn ag_publish_frame(
    result: *const ag_publish_result,
    len: *mut usize,
) -> *const u8 {
    if result.is_null() || len.is_null() {
        return std::ptr::null();
    }
    // SAFETY: `result` was null-checked above; the contract requires a live result.
    let r = unsafe { &*result };
    // SAFETY: `len` was null-checked above; the contract requires it to be writable.
    unsafe { *len = r.effect.frame.len() };
    r.effect.frame.as_ptr()
}

/// The matching subscriber ids. Valid until the result is freed.
///
/// # Safety
/// `result` must be null or a live result from [`ag_publish`] or [`ag_append`], and
/// `count` null or writable. The returned pointer borrows from `result`.
#[no_mangle]
pub unsafe extern "C" fn ag_publish_targets(
    result: *const ag_publish_result,
    count: *mut usize,
) -> *const u64 {
    if result.is_null() || count.is_null() {
        return std::ptr::null();
    }
    // SAFETY: `result` was null-checked above; the contract requires a live result.
    let r = unsafe { &*result };
    // SAFETY: `count` was null-checked above; the contract requires it to be writable.
    unsafe { *count = r.targets.len() };
    r.targets.as_ptr()
}

/// Writes the assigned id into `ms` and `seq`.
///
/// # Safety
/// `result` must be null or a live result from [`ag_publish`] or [`ag_append`], and
/// `ms` and `seq` null or writable.
#[no_mangle]
pub unsafe extern "C" fn ag_publish_id(
    result: *const ag_publish_result,
    ms: *mut u64,
    seq: *mut u64,
) {
    if result.is_null() || ms.is_null() || seq.is_null() {
        return;
    }
    // SAFETY: `result` was null-checked above; the contract requires a live result.
    let r = unsafe { &*result };
    // SAFETY: `ms` and `seq` were null-checked above; the contract requires both to be
    // writable.
    unsafe {
        *ms = r.effect.id.ms();
        *seq = r.effect.id.seq();
    }
}

/// Releases a publish result. Null is a no-op.
///
/// # Safety
/// `result` must be null, or a result that has not already been freed. It must not
/// be used again, and neither may any pointer borrowed from it.
#[no_mangle]
pub unsafe extern "C" fn ag_publish_result_free(result: *mut ag_publish_result) {
    if result.is_null() {
        return;
    }
    // SAFETY: `result` was null-checked above, and the contract requires a result that has
    // not already been freed — so ownership returns here.
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(result));
    }));
}

// ------------------------------------------------------------------ subscribe

/// Registers a subscriber, decides the checkpoint and snapshots the replay set.
///
/// These are one call because §4.5 requires them to describe one instant. A binding
/// that split them across two FFI calls would reintroduce exactly the race the single
/// call exists to prevent, so the ABI does not offer the pieces separately.
///
/// `key` may be empty to opt out of the per-key cap. `has_cursor` is 0 or 1.
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`]. `topics` must be valid
/// for `topic_count` elements when `topic_count` is non-zero, and each element valid for
/// its own length. `key` must be valid for its length, or have length zero. `out` must be
/// null or point to a writable `*mut ag_subscribe_result`.
#[no_mangle]
pub unsafe extern "C" fn ag_subscribe(
    hub: *mut ag_hub,
    topics: *const ag_str,
    topic_count: usize,
    key: ag_str,
    has_cursor: i32,
    cursor_ms: u64,
    cursor_seq: u64,
    out: *mut *mut ag_subscribe_result,
) -> i32 {
    if out.is_null() || (topics.is_null() && topic_count > 0) {
        return AG_ERR_NULL;
    }
    with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| {
            let slice = if topic_count == 0 {
                &[][..]
            } else {
                // SAFETY: `topics` is non-null whenever `topic_count` is non-zero (checked at the top of
                // this entry point), and the contract requires it to be valid for that many elements.
                unsafe { std::slice::from_raw_parts(topics, topic_count) }
            };
            let mut owned = Vec::with_capacity(slice.len());
            for entry in slice {
                // SAFETY: each element is an `ag_str` the contract requires to be valid for its own
                // length, or to have length zero.
                match unsafe { entry.as_str() } {
                    Ok(t) => owned.push(t.to_string()),
                    Err(code) => return code,
                }
            }
            // SAFETY: `key` is this entry point's argument, valid for its length by contract.
            let key = match unsafe { key.as_str() } {
                // Empty is "no per-key cap", not a key of length zero.
                Ok("") => None,
                Ok(k) => Some(k.to_string()),
                Err(code) => return code,
            };
            // Assembled from two integers, so it never passed the parser — and the bound
            // §2.1 puts on a cursor string has to hold here too, or the one path that skips
            // the parser is the one that can smuggle an id no JavaScript client can name.
            let cursor = if has_cursor != 0 {
                match EventId::new(cursor_ms, cursor_seq) {
                    Some(id) => Some(id),
                    None => return AG_ERR_MALFORMED_ID,
                }
            } else {
                None
            };

            match h.subscribe(owned, key, cursor) {
                Err(e) => subscribe_code(e),
                Ok(effect) => {
                    // SAFETY: `out` was null-checked at the top of this entry point. The caller owns the
                    // result from here.
                    unsafe { *out = Box::into_raw(Box::new(ag_subscribe_result { effect })) };
                    AG_OK
                }
            }
        },
    )
}

/// The registered subscriber id. Never zero on success.
///
/// # Safety
/// `result` must be null or a live result from [`ag_subscribe`].
#[no_mangle]
pub unsafe extern "C" fn ag_subscribe_id(result: *const ag_subscribe_result) -> u64 {
    if result.is_null() {
        return 0;
    }
    // SAFETY: `result` was null-checked above; the contract requires a live result.
    unsafe { &*result }.effect.id.0
}

/// One of the `AG_CHECKPOINT_*` constants.
///
/// # Safety
/// `result` must be null or a live result from [`ag_subscribe`].
#[no_mangle]
pub unsafe extern "C" fn ag_subscribe_checkpoint(result: *const ag_subscribe_result) -> i32 {
    if result.is_null() {
        return AG_CHECKPOINT_ABSENT;
    }
    // SAFETY: `result` was null-checked above; the contract requires a live result.
    match unsafe { &*result }.effect.checkpoint {
        Checkpoint::Absent => AG_CHECKPOINT_ABSENT,
        Checkpoint::Echo(_) => AG_CHECKPOINT_ECHO,
        Checkpoint::Earliest => AG_CHECKPOINT_EARLIEST,
    }
}

/// How many frames to replay.
///
/// # Safety
/// `result` must be null or a live result from [`ag_subscribe`].
#[no_mangle]
pub unsafe extern "C" fn ag_subscribe_replay_count(result: *const ag_subscribe_result) -> usize {
    if result.is_null() {
        return 0;
    }
    // SAFETY: `result` was null-checked above; the contract requires a live result.
    unsafe { &*result }.effect.replay.len()
}

/// The `index`th replay frame, oldest first. Valid until the result is freed.
///
/// # Safety
/// `result` must be null or a live result from [`ag_subscribe`], and `len` null or
/// writable. The returned pointer borrows from `result`.
#[no_mangle]
pub unsafe extern "C" fn ag_subscribe_replay_at(
    result: *const ag_subscribe_result,
    index: usize,
    len: *mut usize,
) -> *const u8 {
    if result.is_null() || len.is_null() {
        return std::ptr::null();
    }
    // SAFETY: `result` was null-checked above; the contract requires a live result.
    let r = unsafe { &*result };
    match r.effect.replay.get(index) {
        None => std::ptr::null(),
        Some(frame) => {
            // SAFETY: `len` was null-checked above; the contract requires it to be writable.
            unsafe { *len = frame.len() };
            frame.as_ptr()
        }
    }
}

/// Releases a subscribe result. Null is a no-op.
///
/// # Safety
/// `result` must be null, or a result that has not already been freed. It must not
/// be used again, and neither may any frame pointer borrowed from it.
#[no_mangle]
pub unsafe extern "C" fn ag_subscribe_result_free(result: *mut ag_subscribe_result) {
    if result.is_null() {
        return;
    }
    // SAFETY: `result` was null-checked above, and the contract requires a result that has
    // not already been freed — so ownership returns here.
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(result));
    }));
}

// ------------------------------------------------------------- subscriber ops

/// Reports a subscriber's *absolute* queued byte depth. Returns a `AG_BUFFER_*` constant.
///
/// Prefer this wherever the transport can be asked how much is outstanding — then the
/// socket is the authority and no accounting can drift away from it. Node's
/// `res.writableLength` is exactly that.
///
/// Hosts that cannot answer that question use [`ag_note_sent`] / [`ag_note_flushed`].
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`].
#[no_mangle]
pub unsafe extern "C" fn ag_note_buffer(
    hub: *mut ag_hub,
    subscriber: u64,
    queued_bytes: u64,
) -> i32 {
    with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| buffer_code(h.note_buffer(SubscriberId(subscriber), to_usize_saturating(queued_bytes))),
    )
}

/// Reports that `bytes` were handed to the transport, for a host with no absolute depth.
///
/// ASGI's `await send()` suspends until the transport accepts the data and returns
/// nothing; neither Go's `http.ResponseWriter` nor Swoole exposes a queue depth. Without
/// this pair, §8.2 — half of the loss story this protocol exists for — is unimplementable
/// in most of the runtimes this ABI was built to serve.
///
/// Pair every call with [`ag_note_flushed`] once the bytes have drained. Saturating in
/// both directions, so neither a missed flush nor a double-counted one can wrap the
/// counter and invert the verdict. Returns a `AG_BUFFER_*` constant.
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`].
#[no_mangle]
pub unsafe extern "C" fn ag_note_sent(hub: *mut ag_hub, subscriber: u64, bytes: u64) -> i32 {
    with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| buffer_code(h.note_sent(SubscriberId(subscriber), to_usize_saturating(bytes))),
    )
}

/// Reports that `bytes` previously passed to [`ag_note_sent`] have drained.
///
/// Saturates at zero rather than underflowing: a flush reported for bytes never sent must
/// leave a caught-up subscriber caught up, not `usize::MAX` bytes behind.
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`].
#[no_mangle]
pub unsafe extern "C" fn ag_note_flushed(hub: *mut ag_hub, subscriber: u64, bytes: u64) -> i32 {
    with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| buffer_code(h.note_flushed(SubscriberId(subscriber), to_usize_saturating(bytes))),
    )
}

/// One mapping for all three backpressure entry points, so they cannot disagree.
fn buffer_code(verdict: BufferVerdict) -> i32 {
    match verdict {
        BufferVerdict::Ok => AG_BUFFER_OK,
        BufferVerdict::SlowConsumer => AG_BUFFER_SLOW_CONSUMER,
        BufferVerdict::Unknown => AG_BUFFER_UNKNOWN,
    }
}

/// §2.1 — compares two ids, writing -1, 0 or 1 through `out`.
///
/// Exposed because a host genuinely needs it and must not reimplement it. Ids MUST NOT be
/// compared as strings — `1755083412345-10` sorts before `1755083412345-7` — and a host
/// that got this wrong would silently discard live events as already-seen. The persistent-
/// history path is the first caller: it has to decide whether a cursor predates what its
/// storage compacted away.
///
/// Returns [`AG_ERR_MALFORMED_ID`] if either side is not a canonical `<ms>-<seq>`.
///
/// # Safety
/// Each `ag_str` must be valid for its stated length, or have length zero, and `out`
/// must be null or point to a writable `int32_t`.
#[no_mangle]
pub unsafe extern "C" fn ag_compare_ids(a: ag_str, b: ag_str, out: *mut i32) -> i32 {
    if out.is_null() {
        return AG_ERR_NULL;
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: `a` is this entry point's argument, valid for its length by contract.
        let a = match unsafe { read_id(&a) } {
            Ok(id) => id,
            Err(code) => return code,
        };
        // SAFETY: `b` is this entry point's argument, valid for its length by contract.
        let b = match unsafe { read_id(&b) } {
            Ok(id) => id,
            Err(code) => return code,
        };
        let ordering = match a.cmp(&b) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        };
        // SAFETY: `out` was null-checked at the top of this entry point.
        unsafe { *out = ordering };
        AG_OK
    }));
    result.unwrap_or(AG_ERR_PANIC)
}

/// Removes a subscriber. Idempotent — returns 1 if it existed, 0 if not.
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`].
#[no_mangle]
pub unsafe extern "C" fn ag_remove(hub: *mut ag_hub, subscriber: u64) -> i32 {
    with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| i32::from(h.remove(SubscriberId(subscriber))),
    )
}

/// Open subscriber count, or a negative status code.
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`].
#[no_mangle]
pub unsafe extern "C" fn ag_connection_count(hub: *mut ag_hub) -> i64 {
    let mut count: i64 = 0;
    let code = with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| {
            // A count cannot exceed the address space, so this is lossless on every host;
            // saturating anyway keeps a negative — a status code, in this return — impossible.
            count = i64::try_from(h.connection_count()).unwrap_or(i64::MAX);
            AG_OK
        },
    );
    if code == AG_OK {
        count
    } else {
        code as i64
    }
}

/// Writes the newest assigned id, or `0-0` if nothing has been published.
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`], and `ms` and `seq` null
/// or writable.
#[no_mangle]
pub unsafe extern "C" fn ag_cursor(hub: *mut ag_hub, ms: *mut u64, seq: *mut u64) -> i32 {
    if ms.is_null() || seq.is_null() {
        return AG_ERR_NULL;
    }
    with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| {
            let c = h.cursor();
            // SAFETY: `ms` and `seq` were null-checked above; the contract requires both to be
            // writable.
            unsafe {
                *ms = c.ms();
                *seq = c.seq();
            }
            AG_OK
        },
    )
}

// --------------------------------------------------------------- control frames

/// Builds a `~gap` frame for a subscriber. `reason` is a `AG_GAP_*` constant.
///
/// Returns null on error. Free with [`ag_buf_free`].
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`]. The returned buffer, if
/// any, must be released with [`ag_buf_free`].
#[no_mangle]
pub unsafe extern "C" fn ag_gap_frame(
    hub: *mut ag_hub,
    subscriber: u64,
    reason: i32,
) -> *mut ag_buf {
    let mut out: *mut ag_buf = std::ptr::null_mut();
    let _ = with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| {
            let id = SubscriberId(subscriber);
            let bytes = if reason == AG_GAP_SLOW_CONSUMER {
                h.slow_consumer_frame(id)
            } else {
                h.truncated_frame(id)
            };
            out = Box::into_raw(Box::new(ag_buf { bytes }));
            AG_OK
        },
    );
    out
}

/// Builds a `~denied` frame naming the topics `authorize` refused.
///
/// # Safety
/// `hub` must be null or a live handle from [`ag_hub_new`]. `topics` must be valid
/// for `topic_count` elements when `topic_count` is non-zero, and each element valid for
/// its own length. The returned buffer, if any, must be released with [`ag_buf_free`].
#[no_mangle]
pub unsafe extern "C" fn ag_denied_frame(
    hub: *mut ag_hub,
    topics: *const ag_str,
    topic_count: usize,
) -> *mut ag_buf {
    if topics.is_null() && topic_count > 0 {
        return std::ptr::null_mut();
    }
    let mut out: *mut ag_buf = std::ptr::null_mut();
    let _ = with_hub(
        // SAFETY: the caller's contract on this entry point — a handle from
        // `ag_hub_new` that is still live, or null.
        unsafe { hub_ref(hub) },
        |h| {
            let slice = if topic_count == 0 {
                &[][..]
            } else {
                // SAFETY: `topics` is non-null whenever `topic_count` is non-zero (checked at the top of
                // this entry point), and the contract requires it to be valid for that many elements.
                unsafe { std::slice::from_raw_parts(topics, topic_count) }
            };
            let mut owned = Vec::with_capacity(slice.len());
            for entry in slice {
                // SAFETY: each element is an `ag_str` the contract requires to be valid for its own
                // length, or to have length zero.
                match unsafe { entry.as_str() } {
                    Ok(t) => owned.push(t.to_string()),
                    Err(code) => return code,
                }
            }
            out = Box::into_raw(Box::new(ag_buf { bytes: h.denied_frame(&owned) }));
            AG_OK
        },
    );
    out
}

/// The bytes of an owned buffer.
///
/// # Safety
/// `buf` must be null or a live buffer, and `len` null or writable. The returned
/// pointer borrows from `buf` and is invalidated by [`ag_buf_free`].
#[no_mangle]
pub unsafe extern "C" fn ag_buf_data(buf: *const ag_buf, len: *mut usize) -> *const u8 {
    if buf.is_null() || len.is_null() {
        return std::ptr::null();
    }
    // SAFETY: `buf` was null-checked above; the contract requires a live buffer.
    let b = unsafe { &*buf };
    // SAFETY: `len` was null-checked above; the contract requires it to be writable.
    unsafe { *len = b.bytes.len() };
    b.bytes.as_ptr()
}

/// Releases an owned buffer. Null is a no-op.
///
/// # Safety
/// `buf` must be null, or a buffer that has not already been freed. It must not be
/// used again, and neither may any pointer borrowed from it.
#[no_mangle]
pub unsafe extern "C" fn ag_buf_free(buf: *mut ag_buf) {
    if buf.is_null() {
        return;
    }
    // SAFETY: `buf` was null-checked above, and the contract requires a buffer that has not
    // already been freed — so ownership returns here.
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(buf));
    }));
}

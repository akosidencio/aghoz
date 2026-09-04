/*
 * aghoz — stable C ABI.
 *
 * The single surface every language binding targets. See PROTOCOL.md for what the
 * operations mean; this file describes only how to call them.
 *
 * Ownership
 *   Anything returned through an out-parameter or as a pointer is owned by the library
 *   and must be released with its matching *_free. Never call free() on it. Every
 *   *_free tolerates NULL.
 *
 * Strings
 *   ag_str is a pointer and a length. Nothing is assumed NUL-terminated: payloads may
 *   legitimately contain NUL bytes, and strlen() here would silently truncate them.
 *   All strings must be valid UTF-8; invalid input returns AG_ERR_UTF8 rather than
 *   being reinterpreted.
 *
 * Threading
 *   ag_hub is internally synchronised. Calls from multiple threads are safe. Result
 *   objects (ag_publish_result, ag_subscribe_result, ag_buf) are not — do not share one
 *   across threads without your own synchronisation.
 *
 * Errors
 *   Functions returning int32_t return AG_OK or a negative AG_ERR_*. No panic ever
 *   crosses this boundary; an internal failure surfaces as AG_ERR_PANIC.
 */

#ifndef AGHOZ_H
#define AGHOZ_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- status codes ------------------------------------------------------- */

#define AG_OK                            0
#define AG_ERR_TOPIC_EMPTY              -1
#define AG_ERR_TOPIC_TOO_LONG           -2   /* 255 BYTES, not characters */
#define AG_ERR_TOPIC_CONTROL            -3
#define AG_ERR_TOPIC_RESERVED           -4   /* began with '~' */
#define AG_ERR_TOPIC_COUNT              -5
#define AG_ERR_MAX_CONNECTIONS          -6   /* map to HTTP 429 */
#define AG_ERR_MAX_CONNECTIONS_PER_KEY  -7   /* map to HTTP 429 */
#define AG_ERR_NULL                     -8
#define AG_ERR_UTF8                     -9
#define AG_ERR_PANIC                   -10
#define AG_ERR_POISONED                -11
#define AG_ERR_ORIGIN_EMPTY            -12   /* validator only; ag_publish never returns it */
#define AG_ERR_ORIGIN_TOO_LONG         -13   /* 64 BYTES, not characters */
#define AG_ERR_ORIGIN_CONTROL          -14
#define AG_ERR_MALFORMED_ID            -15   /* not a canonical <ms>-<seq>, or a half
                                              above 2^53-1 */

/* ag_note_buffer verdicts */
#define AG_BUFFER_OK                     0
#define AG_BUFFER_SLOW_CONSUMER          1
#define AG_BUFFER_UNKNOWN                2

/* ag_subscribe_checkpoint results — what the last-event-id-checkpoint header says */
#define AG_CHECKPOINT_ABSENT             0   /* omit the header */
#define AG_CHECKPOINT_ECHO               1   /* echo the cursor back */
#define AG_CHECKPOINT_EARLIEST           2   /* send "earliest", and a ~gap frame */

/* ag_gap_frame reasons */
#define AG_GAP_HISTORY_TRUNCATED         0
#define AG_GAP_SLOW_CONSUMER             1

/* ---- types -------------------------------------------------------------- */

typedef struct ag_hub ag_hub;
typedef struct ag_publish_result ag_publish_result;
typedef struct ag_subscribe_result ag_subscribe_result;
typedef struct ag_buf ag_buf;

/* A borrowed byte string. ptr may be NULL only when len is 0. */
typedef struct {
  const uint8_t *ptr;
  size_t len;
} ag_str;

/* Limits. Zero means "default" for every field, so a zero-initialised struct yields a
 * working hub rather than one that refuses every connection. */
typedef struct {
  uint64_t max_history_bytes;         /* 0 -> 8 MiB. Bytes, not events. */
  uint64_t max_buffer_bytes;          /* 0 -> 1 MiB */
  uint64_t max_connections;           /* 0 -> unlimited */
  uint64_t max_connections_per_key;   /* 0 -> unlimited */
  uint64_t max_topics_per_connection; /* 0 -> 64 */
} ag_config;

/* ---- lifecycle ---------------------------------------------------------- */

/* major * 1000 + minor. Refuse to load a library whose major differs.
 *
 * Currently 3200.
 *
 * 3000 added ag_append and ag_encode. A major bump because AG_ERR_MALFORMED_ID is a
 * status a 2000-era caller has no arm for.
 * 3100 added ag_note_sent and ag_note_flushed. A minor bump: new symbols returning
 * existing status codes, so a 3000-era caller keeps working untouched.
 * 3200 added ag_compare_ids. Minor for the same reason. */
uint32_t ag_abi_version(void);

ag_hub *ag_hub_new(const ag_config *config); /* config may be NULL for all defaults */
void ag_hub_free(ag_hub *hub);

/* ---- publish ------------------------------------------------------------ */

/* Assigns an id, encodes a frame, and matches subscribers.
 * On AG_OK, *out receives a result to release with ag_publish_result_free.
 *
 * origin is the optional §6.0 field. Pass {NULL, 0} for absent; a zero length means the
 * same thing, because bindings routinely produce an empty string where a value was
 * missing and rejecting that would make the common case the hostile one.
 *
 * now_ms is MILLISECONDS. A clock in another unit is not silently accepted: anything
 * that would put either half of the id above 2^53-1 — the range §2 narrowed to so that
 * one cursor string names one event in every language — returns AG_ERR_MALFORMED_ID and
 * assigns no id. Nanoseconds land two orders of magnitude past it, so the mistake shows
 * up on the first call rather than as ids no JavaScript client can hold. */
int32_t ag_publish(ag_hub *hub, uint64_t now_ms, ag_str topic, ag_str payload,
                   ag_str origin, ag_publish_result **out);

/* Records an event whose id a shared sequencer assigned, and matches subscribers.
 *
 * The backplane counterpart to ag_publish. A per-process counter cannot be used across
 * processes: two of them publishing in the same millisecond both mint <ms>-0, and every
 * client's dedupe discards one of the two as already-seen. So the id arrives here rather
 * than being drawn — from XADD, in the Redis case, which is why §2 fixed the format.
 *
 * id is the canonical "<ms>-<seq>" text, NOT the split halves, so that §2.1's parsing
 * rule stays in the core rather than being rewritten once per language. Returns
 * AG_ERR_MALFORMED_ID for anything else.
 *
 * Release *out with ag_publish_result_free, exactly as for ag_publish. */
int32_t ag_append(ag_hub *hub, ag_str id, ag_str topic, ag_str payload, ag_str origin,
                  ag_publish_result **out);

/* Encodes a frame for an event whose id was assigned elsewhere, recording NOTHING.
 *
 * This is what replay from a shared history needs: those events are already in the shared
 * log, so the only thing missing is their bytes. Using ag_append for this instead pushes
 * a duplicate into the local ring on every reconnect, out of id order, which corrupts the
 * ordering the truncation decision depends on.
 *
 * On AG_OK, *out receives a buffer to release with ag_buf_free. */
int32_t ag_encode(ag_hub *hub, ag_str id, ag_str topic, ag_str payload, ag_str origin,
                  ag_buf **out);

const uint8_t *ag_publish_frame(const ag_publish_result *result, size_t *len);
const uint64_t *ag_publish_targets(const ag_publish_result *result, size_t *count);
void ag_publish_id(const ag_publish_result *result, uint64_t *ms, uint64_t *seq);
void ag_publish_result_free(ag_publish_result *result);

/* ---- subscribe ---------------------------------------------------------- */

/* Registers a subscriber, decides the checkpoint, and snapshots the replay set.
 *
 * These are one call because the protocol requires them to describe one instant.
 * Splitting them across two FFI calls would let a publish land in between and leave a
 * real gap unreported, so the pieces are deliberately not offered separately.
 *
 * key may be empty to opt out of the per-key cap. has_cursor is 0 or 1. The cursor
 * arrives as two integers rather than as text, so it is the one id that never passes the
 * parser: cursor_ms or cursor_seq above 2^53-1 returns AG_ERR_MALFORMED_ID. */
int32_t ag_subscribe(ag_hub *hub, const ag_str *topics, size_t topic_count, ag_str key,
                     int32_t has_cursor, uint64_t cursor_ms, uint64_t cursor_seq,
                     ag_subscribe_result **out);

uint64_t ag_subscribe_id(const ag_subscribe_result *result); /* never 0 on success */
int32_t ag_subscribe_checkpoint(const ag_subscribe_result *result);
size_t ag_subscribe_replay_count(const ag_subscribe_result *result);
/* Oldest first. Returns NULL when index is out of range. */
const uint8_t *ag_subscribe_replay_at(const ag_subscribe_result *result, size_t index,
                                      size_t *len);
void ag_subscribe_result_free(ag_subscribe_result *result);

/* ---- subscriber operations ---------------------------------------------- */

/* Reports the socket's current queued depth — ABSOLUTE, not a delta. Returns a
 * AG_BUFFER_* verdict.
 *
 * Prefer this wherever the transport can be asked how much is outstanding, because then
 * the socket is the authority and no accounting can drift away from it. Node's
 * res.writableLength is exactly that. */
int32_t ag_note_buffer(ag_hub *hub, uint64_t subscriber, uint64_t queued_bytes);

/* The DELTA alternative, for a host with no absolute depth to report.
 *
 * ASGI's `await send()` suspends until the transport accepts the data and returns
 * nothing; neither Go's http.ResponseWriter nor Swoole exposes a queue depth. Without
 * these, §8.2 is unimplementable in most of the runtimes this ABI exists to serve.
 *
 * Report bytes handed to the transport with ag_note_sent, and report them again with
 * ag_note_flushed once they have drained. Both share ag_note_buffer's counter and
 * threshold, so the drop decision is identical whichever style a host uses — do not mix
 * the two on one subscriber. Saturating in both directions: a missed flush cannot wrap
 * the counter to zero, and a double-counted one cannot wrap it to the top. */
int32_t ag_note_sent(ag_hub *hub, uint64_t subscriber, uint64_t bytes);
int32_t ag_note_flushed(ag_hub *hub, uint64_t subscriber, uint64_t bytes);

/* §2.1 — writes -1, 0 or 1 through out. AG_ERR_MALFORMED_ID if either side is not a
 * canonical <ms>-<seq>.
 *
 * Ids MUST NOT be compared as strings: "1755083412345-10" sorts before
 * "1755083412345-7", and a host that gets this wrong silently discards live events as
 * already-seen. A host keeping persistent history needs this to decide whether a cursor
 * predates what its storage compacted away. */
int32_t ag_compare_ids(ag_str a, ag_str b, int32_t *out);

/* Idempotent. Returns 1 if the subscriber existed, 0 if not. */
int32_t ag_remove(ag_hub *hub, uint64_t subscriber);

int64_t ag_connection_count(ag_hub *hub); /* negative on error */
int32_t ag_cursor(ag_hub *hub, uint64_t *ms, uint64_t *seq);

/* ---- control frames ----------------------------------------------------- */

/* Both return a buffer to release with ag_buf_free, or NULL on error. */
ag_buf *ag_gap_frame(ag_hub *hub, uint64_t subscriber, int32_t reason);
ag_buf *ag_denied_frame(ag_hub *hub, const ag_str *topics, size_t topic_count);

const uint8_t *ag_buf_data(const ag_buf *buf, size_t *len);
void ag_buf_free(ag_buf *buf);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* AGHOZ_H */

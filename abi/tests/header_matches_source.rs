//! The header and the source must agree.
//!
//! `aghoz.h` is hand-written rather than generated, because the comments in it are
//! worth more to a binding author than anything a generator produces. The cost of that
//! choice is drift, so this test pays it back: every exported symbol must be declared,
//! and every declaration must exist.

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

const SOURCE: &str = include_str!("../src/lib.rs");
const HEADER: &str = include_str!("../include/aghoz.h");

/// Symbols the source exports via `#[no_mangle] pub [unsafe] extern "C"`.
///
/// `unsafe` is accepted because every entry point that takes a pointer is one: an
/// `extern "C" fn` that dereferences what a caller handed it is unsound as safe Rust —
/// this crate builds as an `rlib` too, so "the caller is C" is not a guarantee the
/// compiler has. It changes no symbol and no C declaration, which is why the header
/// below is unchanged.
fn exported() -> Vec<String> {
    let mut names = Vec::new();
    let mut previous_was_no_mangle = false;
    for line in SOURCE.lines() {
        let trimmed = line.trim();
        if trimmed == "#[no_mangle]" {
            previous_was_no_mangle = true;
            continue;
        }
        if previous_was_no_mangle {
            let declaration = trimmed
                .strip_prefix("pub unsafe extern \"C\" fn ")
                .or_else(|| trimmed.strip_prefix("pub extern \"C\" fn "));
            if let Some(rest) = declaration {
                if let Some(name) = rest.split('(').next() {
                    names.push(name.to_string());
                }
            }
            previous_was_no_mangle = false;
        }
    }
    names
}

#[test]
fn every_exported_symbol_is_declared_in_the_header() {
    let symbols = exported();
    assert!(!symbols.is_empty(), "parser found no exports — it has drifted from the source");
    let missing: Vec<&String> =
        symbols.iter().filter(|name| !HEADER.contains(name.as_str())).collect();
    assert!(missing.is_empty(), "exported but undeclared in aghoz.h: {missing:?}");
}

#[test]
fn every_header_declaration_exists_in_the_source() {
    let exported = exported();
    let mut undefined = Vec::new();
    for line in HEADER.lines() {
        let trimmed = line.trim();
        // Declarations only; skip comments, macros and typedefs.
        if trimmed.starts_with('*')
            || trimmed.starts_with("/*")
            || trimmed.starts_with('#')
            || trimmed.starts_with("typedef")
            || !trimmed.contains("ag_")
            || !trimmed.contains('(')
        {
            continue;
        }
        if let Some(open) = trimmed.find('(') {
            let head = &trimmed[..open];
            if let Some(name) = head.split_whitespace().last() {
                let name = name.trim_start_matches('*');
                if name.starts_with("ag_") && !exported.contains(&name.to_string()) {
                    undefined.push(name.to_string());
                }
            }
        }
    }
    assert!(undefined.is_empty(), "declared in aghoz.h but not exported: {undefined:?}");
}

/// The header names the current ABI revision in prose, and prose drifts.
///
/// A binding author reads that number to decide what to refuse to load. If it lags the
/// constant, the header tells them a version the library does not speak — and the whole
/// point of a version is that it is the one thing both sides agree on.
#[test]
fn the_header_names_the_current_abi_version() {
    let declared = SOURCE
        .lines()
        .find_map(|l| l.trim().strip_prefix("pub const AG_ABI_VERSION: u32 = "))
        .and_then(|rest| rest.strip_suffix(';'))
        .map(|v| v.replace('_', ""))
        .expect("AG_ABI_VERSION must be declared in lib.rs");

    assert!(
        HEADER.contains(&format!("Currently {declared}")),
        "aghoz.h must say \"Currently {declared}\" — it names a version the library does not speak",
    );
}

#[test]
fn status_codes_agree_between_source_and_header() {
    // A binding that reads -6 as "topic too long" would map a 429 to a 400.
    for (name, value) in [
        ("AG_OK", "0"),
        ("AG_ERR_TOPIC_EMPTY", "-1"),
        ("AG_ERR_TOPIC_TOO_LONG", "-2"),
        ("AG_ERR_TOPIC_CONTROL", "-3"),
        ("AG_ERR_TOPIC_RESERVED", "-4"),
        ("AG_ERR_TOPIC_COUNT", "-5"),
        ("AG_ERR_MAX_CONNECTIONS", "-6"),
        ("AG_ERR_MAX_CONNECTIONS_PER_KEY", "-7"),
        ("AG_ERR_NULL", "-8"),
        ("AG_ERR_UTF8", "-9"),
        ("AG_ERR_PANIC", "-10"),
        ("AG_ERR_POISONED", "-11"),
        ("AG_ERR_ORIGIN_EMPTY", "-12"),
        ("AG_ERR_ORIGIN_TOO_LONG", "-13"),
        ("AG_ERR_ORIGIN_CONTROL", "-14"),
        ("AG_ERR_MALFORMED_ID", "-15"),
        ("AG_BUFFER_SLOW_CONSUMER", "1"),
        ("AG_CHECKPOINT_EARLIEST", "2"),
        ("AG_GAP_SLOW_CONSUMER", "1"),
    ] {
        let in_header = HEADER.lines().filter(|l| l.trim_start().starts_with("#define")).any(|l| {
            let mut parts = l.split_whitespace();
            parts.next();
            parts.next() == Some(name) && parts.next() == Some(value)
        });
        assert!(in_header, "{name} must be {value} in aghoz.h");

        let in_source =
            SOURCE.lines().any(|l| l.contains(&format!("pub const {name}: i32 = {value};")));
        assert!(in_source, "{name} must be {value} in lib.rs");
    }
}

use peek_desktop_lib::{
    protocol::{diagnostics::DiagnosticEvent, remote::validate_frame},
    session::{Library, MAX_LINE_BYTES, read_session},
};
use serde_json::{Value, json};
use std::{fs, io::Cursor, path::Path, sync::atomic::AtomicBool};

fn fixtures() -> &'static Path {
    Path::new("tests/fixtures/upstream")
}

#[test]
fn every_upstream_session_matches_its_manifest_and_roundtrips() {
    let root = fixtures().join("sessions");
    let manifest: Value =
        serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
    for (filename, expected) in manifest.as_object().unwrap() {
        let bytes = fs::read(root.join(filename)).unwrap();
        let session = read_session(Cursor::new(bytes), &AtomicBool::new(false), |_| {});
        if expected["error"] == true {
            assert!(session.is_err(), "{filename}");
            continue;
        }
        let session = session.unwrap_or_else(|e| panic!("{filename}: {e}"));
        assert_eq!(
            session.header.format_version,
            expected["formatVersion"].as_u64().unwrap(),
            "{filename}"
        );
        assert_eq!(
            session.header.format_version > 1,
            expected["newerFormat"].as_bool().unwrap(),
            "{filename}"
        );
        assert_eq!(
            session.skipped,
            expected["skipped"].as_u64().unwrap() as usize,
            "{filename}"
        );
        let ids: Vec<_> = session.entries.iter().map(|e| e.row.id.as_str()).collect();
        assert_eq!(json!(ids), expected["entries"], "{filename}");
        let mut output = Vec::new();
        session.write(&mut output).unwrap();
        let reread = read_session(Cursor::new(output), &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(reread.entries.len(), session.entries.len());
        for (before, after) in session.entries.iter().zip(&reread.entries) {
            assert_eq!(before.raw, after.raw);
        }
    }
}

#[test]
fn every_upstream_remote_frame_matches_its_manifest() {
    let root = fixtures().join("remote");
    let manifest: Value =
        serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
    for (filename, expected) in manifest.as_object().unwrap() {
        let frame: Value = serde_json::from_slice(&fs::read(root.join(filename)).unwrap()).unwrap();
        let kind = validate_frame(&frame).unwrap_or_else(|e| panic!("{filename}: {e}"));
        if expected["ignored"] == true {
            assert!(kind.is_none());
        } else {
            assert_eq!(
                kind.unwrap(),
                expected["type"].as_str().unwrap(),
                "{filename}"
            );
        }
    }
    assert!(validate_frame(&json!({"type":"entry", "op":"mystery"})).is_err());
    assert!(validate_frame(&json!({"type":"bodyResponse", "requestId":"1"})).is_err());
}

#[test]
fn bom_crlf_corruption_and_duplicate_updates_are_handled() {
    let input = fs::read_to_string(fixtures().join("sessions/appended.peek")).unwrap();
    let input = format!(
        "\u{feff}\r\n{}\r\n{{bad json}}\r\n",
        input.replace('\n', "\r\n")
    );
    let session = read_session(Cursor::new(input), &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(session.skipped, 1);
    assert_eq!(session.entries.len(), 2);
    assert_eq!(session.entries[0].row.id, "e4");
    assert_eq!(session.entries[0].row.state, "completed");
}

#[test]
fn original_numbers_duplicate_keys_and_unknown_fields_survive_export() {
    let input = concat!(
        "{\"format\":\"peek\",\"formatVersion\":1,\"peekVersion\":\"2\",\"platform\":\"ios\",\"startedAt\":\"2026-11-13T00:00:00.000Z\"}\n",
        "{\"id\":\"a\",\"source\":\"test\",\"startedAt\":\"2026-11-13T00:00:00.000001Z\",\"request\":{\"method\":\"GET\",\"url\":\"https://example.test\",\"extra\":{\"n\":123456789012345678901234567890,\"n\":0.123456789012345678901}},\"future\":true}\n"
    );
    let session = read_session(Cursor::new(input), &AtomicBool::new(false), |_| {}).unwrap();
    let mut output = Vec::new();
    session.write(&mut output).unwrap();
    assert_eq!(String::from_utf8(output).unwrap(), input);
}

#[test]
fn cancellation_and_capacity_fail_without_partial_session() {
    assert!(read_session(Cursor::new(b""), &AtomicBool::new(true), |_| {}).is_err());
    let large = vec![b'x'; MAX_LINE_BYTES + 1];
    assert_eq!(
        read_session(Cursor::new(large), &AtomicBool::new(false), |_| {})
            .err()
            .unwrap(),
        "lineTooLarge"
    );
    let mut library = Library::default();
    for _ in 0..peek_desktop_lib::session::MAX_SESSIONS {
        let file = fs::read(fixtures().join("sessions/header-only.peek")).unwrap();
        library
            .insert(
                "file.peek".into(),
                read_session(Cursor::new(file), &AtomicBool::new(false), |_| {}).unwrap(),
            )
            .unwrap();
    }
    let file = fs::read(fixtures().join("sessions/header-only.peek")).unwrap();
    assert_eq!(
        library
            .insert(
                "overflow".into(),
                read_session(Cursor::new(file), &AtomicBool::new(false), |_| {}).unwrap()
            )
            .err()
            .unwrap(),
        "libraryFull"
    );
}

#[test]
fn query_filters_and_windows_without_sending_bodies() {
    let file = fs::read(fixtures().join("sessions/basic.peek")).unwrap();
    let session = read_session(Cursor::new(file), &AtomicBool::new(false), |_| {}).unwrap();
    let all = session.query("", "all", 2, 3, 42);
    assert_eq!(all.total, 18);
    assert_eq!(all.offset, 2);
    assert_eq!(all.rows.len(), 3);
    assert_eq!(all.revision, 42);
    assert!(
        session
            .query("", "errors", 0, 500, 1)
            .rows
            .iter()
            .all(|r| r.state == "failed" || r.status.unwrap_or(0) >= 400)
    );
    assert!(
        session
            .query("GET", "all", 0, 500, 1)
            .rows
            .iter()
            .all(|r| r.method == "GET")
    );
    assert_eq!(session.query("no-such-address", "all", 0, 10, 1).total, 0);
    assert!(session.query("", "all", 100, 10, 1).rows.is_empty());
}

#[test]
fn diagnostics_preserve_uint64_sequences_and_original_stack() {
    let event = json!({"eventId":"run/main/1","runId":"run","emitterId":"main","sequence":"18446744073709551615","occurredAt":"2026-11-13T03:00:00.000Z","monotonicMicros":"9007199254740993","kind":"exception","level":"error","source":"app_logger","message":"合成错误","exception":{"stackTrace":"#0 synthetic\n#1 main","stackFormat":"dart"}});
    let parsed = DiagnosticEvent::parse(&event.to_string()).unwrap();
    assert_eq!(parsed.sequence, "18446744073709551615");
    assert_eq!(
        parsed.exception.unwrap().stack_trace,
        "#0 synthetic\n#1 main"
    );
    for sequence in [
        json!(9007199254740993_u64),
        json!("-1"),
        json!("01"),
        json!("18446744073709551616"),
    ] {
        let mut invalid = event.clone();
        invalid["sequence"] = sequence;
        assert!(DiagnosticEvent::parse(&invalid.to_string()).is_err());
    }
}

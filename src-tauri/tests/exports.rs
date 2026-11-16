use peek_desktop_lib::{archive, export, session::Session, storage};
use serde_json::{Value, json};
use std::{path::Path, sync::atomic::AtomicBool};
fn sample() -> Session {
    storage::open(
        Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/upstream/sessions/basic.peek"
        )),
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap()
}
#[test]
fn har_keeps_duplicate_headers_binary_precision_and_incomplete_body_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.har");
    let session = sample();
    export::har(&path, &session).unwrap();
    let har: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let rows = har["log"]["entries"].as_array().unwrap();
    assert_eq!(rows.len(), session.entries.len());
    for row in rows {
        for key in ["send", "wait", "receive"] {
            assert!(row["timings"][key].as_f64().unwrap() >= 0.0);
        }
        let sum: f64 = ["blocked", "dns", "connect", "send", "wait", "receive"]
            .iter()
            .map(|key| row["timings"][key].as_f64().unwrap().max(0.0))
            .sum();
        assert_eq!(row["time"].as_f64().unwrap(), sum);
    }
    let timed = rows
        .iter()
        .find(|r| r["_peek"]["id"] == "spec-timed")
        .unwrap();
    assert_eq!(
        timed["response"]["headers"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|h| h["name"] == "Set-Cookie")
            .count(),
        2
    );
    let binary = rows.iter().find(|r| r["_peek"]["id"] == "image").unwrap();
    assert_eq!(binary["response"]["content"]["encoding"], "base64");
    let remote = rows
        .iter()
        .find(|r| r["_peek"]["id"] == "spec-remote")
        .unwrap();
    assert_eq!(remote["response"]["content"]["_peekBody"]["kind"], "remote");
    assert!(remote["response"]["content"].get("text").is_none());
    let mut has_precision = false;
    for stored in &session.entries {
        if stored.raw.contains("900719925474099") {
            has_precision = true;
        }
    }
    if has_precision {
        assert!(
            serde_json::to_string(&har)
                .unwrap()
                .contains("900719925474099")
        );
    }
}
#[test]
fn curl_rejects_missing_or_incomplete_bodies_instead_of_silently_replaying_partial_requests() {
    let mut value = json!({"request":{"method":"POST","url":"https://synthetic.example.test/","body":{"kind":"text","text":"partial","size":999}}});
    for body in [
        json!({"kind":"remote"}),
        json!({"kind":"bytes","bytes":"AA=="}),
        json!({"kind":"text","text":"partial","truncated":true}),
        value["request"]["body"].clone(),
        json!({"kind":"form","files":[{"filename":"missing"}]}),
    ] {
        value["request"]["body"] = body;
        assert_eq!(
            export::curl(&value.to_string()).unwrap_err(),
            "curlUnsupported"
        );
    }
}
#[test]
#[cfg(unix)]
fn curl_shell_quoting_preserves_literal_arguments_without_expansion_or_file_reads() {
    let body = "@/tmp/not-a-file ' $(touch /tmp/peek-should-never-exist) `echo unsafe`\n中文";
    let value = json!({"request":{"method":"POST","url":"https://synthetic.example.test/{literal}?q=a&x=b","headers":[["X-Value","it's $HOME"],["X-Value","second"]],"body":{"kind":"text","text":body}}});
    let command = export::curl(&value.to_string()).unwrap();
    let output = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(format!("curl() {{ printf '%s\\0' \"$@\"; }}; {command}"))
        .output()
        .unwrap();
    assert!(output.status.success());
    let args: Vec<_> = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|a| !a.is_empty())
        .map(|a| std::str::from_utf8(a).unwrap())
        .collect();
    assert!(args.contains(&"--globoff"));
    assert!(args.contains(&"--data-raw"));
    assert_eq!(args.last(), Some(&body));
    assert!(args.contains(&"X-Value: it's $HOME"));
    assert_eq!(args.iter().filter(|&&a| a == "--header").count(), 2);
}
#[test]
fn full_jsonl_export_exceeds_selection_window_and_reimports_with_original_stack() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("input.jsonl");
    let path = dir.path().join("all.jsonl");
    let text = dir.path().join("all.txt");
    let mut content = String::new();
    for i in 1..=350 {
        content.push_str(&format!("{}\n",json!({"eventId":format!("e-{i}"),"runId":"run","emitterId":"main","sequence":i.to_string(),"occurredAt":"2026-11-16T00:00:00Z","kind":"exception","level":"error","source":"synthetic","message":"中文","exception":{"stackTrace":"#0 original\n#1 caller"}})));
    }
    std::fs::write(&input, &content).unwrap();
    let bundle = archive::open_jsonl(&input, &AtomicBool::new(false)).unwrap();
    export::diagnostics(&path, &bundle, false).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
    assert_eq!(
        archive::open_jsonl(&path, &AtomicBool::new(false))
            .unwrap()
            .runs[0]
            .records
            .len(),
        350
    );
    export::diagnostics(&text, &bundle, true).unwrap();
    assert!(
        std::fs::read_to_string(text)
            .unwrap()
            .contains("#0 original\n#1 caller")
    );
}

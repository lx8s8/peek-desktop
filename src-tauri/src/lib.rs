pub mod protocol;
pub mod session;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run Peek Desktop");
}

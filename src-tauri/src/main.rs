// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use app_lib::mcp::run_mcp_server;
use app_lib::store::DataStore;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp") {
        let store = Arc::new(Mutex::new(DataStore::new()));
        run_mcp_server(store);
        return;
    }

    app_lib::run();
}

use std::io::{self, Read};

fn main() {
    let mut command = "serve".to_string();
    let mut bind = std::env::var("DESIGN_AGENT_BIND").unwrap_or_else(|_| "127.0.0.1:3927".into());
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "serve" | "plan" => command = arg,
            "--bind" => {
                if let Some(value) = args.next() {
                    bind = value;
                }
            }
            other => {
                eprintln!("unknown argument {other}");
                std::process::exit(2);
            }
        }
    }
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    if command == "plan" {
        let mut raw = String::new();
        io::stdin().read_to_string(&mut raw).expect("stdin");
        let request: futureox_design_agent::TurnRequest = serde_json::from_str(&raw).expect("turn request json");
        let core = futureox_design_agent::AgentCore::from_env();
        let response = runtime.block_on(core.turn(request)).unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(1);
        });
        println!("{}", serde_json::to_string(&response).expect("response json"));
        return;
    }
    if let Err(error) = runtime.block_on(futureox_design_agent::serve(&bind)) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

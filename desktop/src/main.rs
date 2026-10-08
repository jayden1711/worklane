// Desktop shell for the local dashboard. It opens one window on the URL the
// dashboard command hands it and does nothing else: navigation is pinned to
// that local origin, the page gets no IPC, and closing the window ends it
// (the dashboard command then stops its server).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

/// Only a plain-http dashboard on this machine's loopback address is allowed.
fn local_url(arg: Option<&str>) -> Result<Url, String> {
    let raw = arg.ok_or("usage: <app> <dashboard url> [title]")?;
    let url = Url::parse(raw).map_err(|e| format!("not a url: {e}"))?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1") | Some("[::1]") | Some("localhost"));
    if url.scheme() != "http" || !loopback || url.port().is_none() {
        return Err(format!("refusing a url that is not the local dashboard: {}", url.origin().ascii_serialization()));
    }
    Ok(url)
}

/// The window may follow links within the dashboard only.
fn same_origin(allowed: &Url, next: &Url) -> bool {
    next.origin() == allowed.origin()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let url = match local_url(args.get(1).map(String::as_str)) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let title = args.get(2).cloned().unwrap_or_else(|| "Dashboard".into());
    tauri::Builder::default()
        .setup(move |app| {
            let allowed = url.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
                .title(&title)
                .inner_size(1440.0, 960.0)
                .min_inner_size(900.0, 600.0)
                .on_navigation(move |next| same_origin(&allowed, next))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("desktop shell failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_local_dashboard() {
        assert!(local_url(Some("http://127.0.0.1:4317/?t=abc")).is_ok());
        for bad in ["https://127.0.0.1:4317/", "http://example.com:4317/", "http://127.0.0.1/", "file:///etc/hosts", "http://10.0.0.5:4317/", "nonsense"] {
            assert!(local_url(Some(bad)).is_err(), "{bad} should be refused");
        }
        assert!(local_url(None).is_err());
    }

    #[test]
    fn navigation_stays_on_the_dashboard_origin() {
        let home = Url::parse("http://127.0.0.1:4317/?t=abc").unwrap();
        assert!(same_origin(&home, &Url::parse("http://127.0.0.1:4317/issues/3").unwrap()));
        assert!(!same_origin(&home, &Url::parse("http://127.0.0.1:9999/").unwrap()));
        assert!(!same_origin(&home, &Url::parse("https://github.com/x").unwrap()));
    }
}

//! Icono de bandeja y su menú contextual.
//!
//! "Grabar pantalla" y "Detener grabación" actúan directamente sobre el núcleo:
//! no hace falta abrir la ventana. Los ítems se habilitan y deshabilitan solos
//! según el estado real de la grabación.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

pub const TRAY_ID: &str = "main";

/// Referencias a los ítems cuyo estado depende de la grabación en curso.
struct TrayItems {
    record: MenuItem<Wry>,
    stop: MenuItem<Wry>,
}

static ITEMS: Mutex<Option<TrayItems>> = Mutex::new(None);

/// Instala el icono de bandeja. El icono se toma de `tauri.conf.json`.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let record = MenuItem::with_id(app, "record", "Grabar pantalla", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Detener grabación", false, None::<&str>)?;
    let library = MenuItem::with_id(app, "library", "Biblioteca", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Ajustes", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir de RECO", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &record,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &library,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("RECO")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "record" => start_recording(app),
            "stop" => stop_recording(app),
            "library" => show_main(app, "library"),
            "settings" => show_main(app, "settings"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Clic izquierdo: abre la ventana principal.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle(), "library");
            }
        })
        .build(app)?;

    if let Ok(mut guard) = ITEMS.lock() {
        *guard = Some(TrayItems { record, stop });
    }

    Ok(())
}

/// Refleja el estado real en el menú: solo una acción posible a la vez.
pub fn set_recording(recording: bool) {
    if let Ok(guard) = ITEMS.lock() {
        if let Some(items) = guard.as_ref() {
            let _ = items.record.set_enabled(!recording);
            let _ = items.stop.set_enabled(recording);
        }
    }
}

fn start_recording(app: &AppHandle) {
    let (width, height) = crate::commands::recording::primary_screen_size(app);
    match crate::commands::recording::start_from_tray(app, width, height) {
        Ok(()) => set_recording(true),
        Err(e) => {
            // Sin ventana abierta, el error se hace visible como notificación.
            tracing::warn!(%e, "no se pudo iniciar la grabación desde la bandeja");
            notify_error(app, "No se pudo empezar a grabar", &e.to_string());
            set_recording(false);
        }
    }
}

fn stop_recording(app: &AppHandle) {
    match crate::commands::recording::stop_from_tray(app) {
        Ok(()) => {}
        Err(e) => {
            tracing::warn!(%e, "no se pudo detener la grabación desde la bandeja");
            notify_error(app, "No se pudo detener la grabación", &e.to_string());
        }
    }
    set_recording(false);
}

fn notify_error(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}

/// Muestra la ventana principal y notifica a la UI qué sección abrir.
fn show_main(app: &AppHandle, section: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    use tauri::Emitter;
    let _ = app.emit("tray:navigate", serde_json::json!({ "section": section }));
}

//! Ventana flotante que muestra el estado del dictado.
//!
//! Es un orbe pequeño, siempre encima y sin foco, para que el usuario vea que
//! RECO está escuchando sin cambiar de aplicación. Se muestra al empezar y se
//! oculta al terminar; nunca roba el foco porque el dictado inserta texto en la
//! ventana que el usuario tenía activa.

use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, PhysicalRect};

const LABEL: &str = "indicator";

/// Lado de la ventana del orbe en píxeles lógicos (coincide con `tauri.conf`).
const ORB_SIZE: f64 = 64.0;

/// Separación con el borde inferior del área de trabajo, en píxeles lógicos.
/// El orbe ocupa solo el centro de la ventana, así que el margen visible real
/// es bastante mayor.
const BOTTOM_MARGIN: f64 = 2.0;

/// Muestra el indicador en la posición configurada (o abajo al centro).
pub fn show(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };

    if let Some(pos) = position(app) {
        let _ = window.set_position(pos);
    }

    // `show` activa la ventana en Windows. Se marca como no enfocable antes de
    // mostrarla para que el foco se quede en la aplicación donde se escribe el
    // texto: si el indicador lo robara, el dictado acabaría en el sitio
    // equivocado.
    let _ = window.set_focusable(false);
    // Y los clics lo atraviesan: es un aviso, no un botón. Sin esto taparía la
    // barra de tareas y cualquier control que quede bajo el orbe.
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.show();
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

/// Etiqueta de la ventana principal (el panel).
const MAIN_LABEL: &str = "main";

/// Separa el panel del borde inferior lo suficiente para que el orbe flotante
/// no se le eche encima cuando aparece durante un dictado.
const MAIN_BOTTOM_MARGIN: f64 = 84.0;

/// Coloca la ventana principal abajo y al centro.
///
/// Se hace en el núcleo y no en el CSS porque `center: true` en la
/// configuración la ponía en mitad de la pantalla, lejos del orbe. Aquí comparte
/// el mismo criterio de área útil que el indicador, así que en pantallas con
/// escalado raro no acaba fuera de sitio.
pub fn place_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };

    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|pos| {
            app.available_monitors().ok().and_then(|list| {
                list.into_iter().find(|m| {
                    let p = m.position();
                    let s = m.size();
                    pos.x >= p.x as f64
                        && pos.x < p.x as f64 + s.width as f64
                        && pos.y >= p.y as f64
                        && pos.y < p.y as f64 + s.height as f64
                })
            })
        })
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return;
    };

    // El tamaño real lo decide Tauri: así la posición sigue siendo correcta si
    // mañana cambia el alto configurado.
    let Ok(size) = window.outer_size() else {
        return;
    };

    let scale = monitor.scale_factor();
    let margin = (MAIN_BOTTOM_MARGIN * scale).round() as i32;
    let area = usable_area(&monitor);

    let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
    let y = area.position.y + area.size.height as i32
        - size.height as i32
        - margin;

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Calcula la posición: preferencia guardada o esquina inferior central.
fn position(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    // Se comprueba que la ventana existe antes de calcular nada.
    app.get_webview_window(LABEL)?;

    if let Some([x, y]) = app
        .try_state::<crate::state::AppState>()
        .map(|s| s.config_snapshot().system.indicator_position)
        .flatten()
    {
        return Some(PhysicalPosition::new(x, y));
    }

    // Sin preferencia: centrado abajo del monitor donde está el cursor.
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|pos| {
            app.available_monitors().ok().and_then(|list| {
                list.into_iter().find(|m| {
                    let p = m.position();
                    let s = m.size();
                    pos.x >= p.x as f64
                        && pos.x < p.x as f64 + s.width as f64
                        && pos.y >= p.y as f64
                        && pos.y < p.y as f64 + s.height as f64
                })
            })
        })
        .or_else(|| app.primary_monitor().ok().flatten())?;

    let scale = monitor.scale_factor();
    let size = (ORB_SIZE * scale).round() as i32;
    let margin = (BOTTOM_MARGIN * scale).round() as i32;

    let area = usable_area(&monitor);
    let x = area.position.x + (area.size.width as i32 - size) / 2;
    let y = area.position.y + area.size.height as i32 - size - margin;

    tracing::info!(
        area_x = area.position.x,
        area_y = area.position.y,
        area_w = area.size.width,
        area_h = area.size.height,
        scale,
        x,
        y,
        "posición del indicador"
    );

    Some(PhysicalPosition::new(x, y))
}

/// Área donde se puede dibujar: la de trabajo si es coherente, si no el monitor.
///
/// En algunos equipos con escalado no estándar `work_area()` devuelve un
/// rectángulo que no encaja con el monitor (por ejemplo, un alto de 1080 en una
/// pantalla de 1440 o un origen desplazado). Usarlo tal cual deja el orbe fuera
/// de la pantalla, así que se contrasta con los límites del monitor y, si no
/// encaja, se cae al monitor completo. Todo se compara en píxeles físicos, que
/// es la unidad de `Monitor`.
fn usable_area(monitor: &Monitor) -> PhysicalRect<i32, u32> {
    let origin = monitor.position();
    let size = monitor.size();
    let work = monitor.work_area();

    let bounds = PhysicalRect {
        position: *origin,
        size: *size,
    };

    let inside = work.size.width > 0
        && work.size.height > 0
        && work.position.x >= origin.x
        && work.position.y >= origin.y
        && work.position.x + work.size.width as i32 <= origin.x + size.width as i32
        && work.position.y + work.size.height as i32 <= origin.y + size.height as i32;

    if inside {
        *work
    } else {
        tracing::warn!(
            work_x = work.position.x,
            work_y = work.position.y,
            work_w = work.size.width,
            work_h = work.size.height,
            mon_x = origin.x,
            mon_y = origin.y,
            mon_w = size.width,
            mon_h = size.height,
            "el área de trabajo no encaja con el monitor; se usa el monitor completo"
        );
        bounds
    }
}

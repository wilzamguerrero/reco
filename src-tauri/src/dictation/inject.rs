//! Inserción del texto dictado en la aplicación activa.

use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectionMethod {
    Paste,
    Keystroke,
    Clipboard,
}

impl InjectionMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            InjectionMethod::Paste => "paste",
            InjectionMethod::Keystroke => "keystroke",
            InjectionMethod::Clipboard => "clipboard",
        }
    }
}

#[derive(Debug, Clone)]
pub struct InjectionReport {
    pub method: InjectionMethod,
    pub ok: bool,
    pub reason: Option<String>,
}

/// Identificador opaco de la ventana que tenía el foco.
pub type WindowHandle = isize;

/// Inserta `text` en la ventana indicada.
///
/// Estrategia (ver `ARCHITECTURE.md` §5.3): portapapeles + Ctrl/Cmd+V, con
/// restauración del portapapeles anterior. Si falla, se deja el texto en el
/// portapapeles y se informa.
pub fn inject(text: &str, target: Option<WindowHandle>) -> Result<InjectionReport> {
    if text.is_empty() {
        return Ok(InjectionReport {
            method: InjectionMethod::Clipboard,
            ok: true,
            reason: Some("texto vacío".into()),
        });
    }

    let previous = read_clipboard().ok();

    if let Err(e) = write_clipboard(text) {
        return Ok(InjectionReport {
            method: InjectionMethod::Clipboard,
            ok: false,
            reason: Some(format!("no se pudo acceder al portapapeles: {e}")),
        });
    }

    match target.and_then(|h| platform_focus_and_paste(h).ok()) {
        Some(()) => {
            // Restaurar el portapapeles anterior tras dar tiempo al pegado.
            std::thread::sleep(std::time::Duration::from_millis(300));
            if let Some(prev) = previous {
                let _ = write_clipboard(&prev);
            }

            Ok(InjectionReport {
                method: InjectionMethod::Paste,
                ok: true,
                reason: None,
            })
        }
        None => Ok(InjectionReport {
            method: InjectionMethod::Clipboard,
            ok: true,
            reason: Some("texto dejado en el portapapeles; pégalo con Ctrl+V".into()),
        }),
    }
}

/// Escribe en el portapapeles del sistema.
pub fn write_clipboard(text: &str) -> Result<()> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| crate::error::Error::Other(format!("portapapeles no disponible: {e}")))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| crate::error::Error::Other(format!("no se pudo escribir el texto: {e}")))
}

/// Lee el contenido de texto actual del portapapeles.
pub fn read_clipboard() -> Result<String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| crate::error::Error::Other(format!("portapapeles no disponible: {e}")))?;
    clipboard
        .get_text()
        .map_err(|e| crate::error::Error::Other(format!("no se pudo leer el portapapeles: {e}")))
}

// ---------------------------------------------------------------- plataforma

/// Reactiva la ventana y simula la combinación de pegado.
#[cfg(windows)]
fn platform_focus_and_paste(handle: WindowHandle) -> Result<()> {
    platform::windows::focus_and_paste(handle)
}

#[cfg(target_os = "macos")]
fn platform_focus_and_paste(handle: WindowHandle) -> Result<()> {
    platform::macos::focus_and_paste(handle)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_focus_and_paste(_handle: WindowHandle) -> Result<()> {
    // Se delega en `xdotool` si está instalado; si no, se cae al portapapeles.
    platform::linux::focus_and_paste()
}

#[cfg(windows)]
mod platform {
    pub mod windows {
        use crate::error::{Error, Result};
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
            KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_V,
        };
        use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;

        pub fn focus_and_paste(handle: isize) -> Result<()> {
            unsafe {
                let hwnd = HWND(handle as *mut core::ffi::c_void);
                if !SetForegroundWindow(hwnd).as_bool() {
                    return Err(Error::Other(
                        "Windows no permitió activar la ventana de destino".into(),
                    ));
                }

                // Pequeña espera: el cambio de foco es asíncrono.
                std::thread::sleep(std::time::Duration::from_millis(80));

                send_vk(VK_CONTROL, false)?;
                send_vk(VK_V, false)?;
                send_vk(VK_V, true)?;
                send_vk(VK_CONTROL, true)?;
            }
            Ok(())
        }

        fn key_input(key: VIRTUAL_KEY, up: bool) -> INPUT {
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: key,
                        wScan: 0,
                        dwFlags: if up {
                            KEYEVENTF_KEYUP
                        } else {
                            KEYBD_EVENT_FLAGS(0)
                        },
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            }
        }

        fn send_vk(key: VIRTUAL_KEY, up: bool) -> Result<()> {
            let input = key_input(key, up);
            let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
            if sent == 0 {
                return Err(Error::Other("SendInput falló".into()));
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    pub mod macos {
        use crate::error::{Error, Result};

        pub fn focus_and_paste(_pid: isize) -> Result<()> {
            // Implementado en la Fase 6 con NSRunningApplication + CGEvent.
            Err(Error::NotImplemented("inserción en macOS (Fase 6)"))
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    pub mod linux {
        use crate::error::{Error, Result};

        pub fn focus_and_paste() -> Result<()> {
            // `xdotool key ctrl+v` es la vía más portable bajo X11. Si no está
            // instalado, se devuelve error y el llamador cae al portapapeles.
            let status = std::process::Command::new("xdotool")
                .args(["key", "--clearmodifiers", "ctrl+v"])
                .status()
                .map_err(|e| Error::Other(format!("xdotool no disponible: {e}")))?;

            if status.success() {
                Ok(())
            } else {
                Err(Error::Other("xdotool no pudo enviar el pegado".into()))
            }
        }
    }
}

/// Guarda el handle de la ventana activa antes de empezar a dictar.
#[cfg(windows)]
pub fn foreground_window() -> Option<WindowHandle> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            None
        } else {
            Some(hwnd.0 as isize)
        }
    }
}

#[cfg(not(windows))]
pub fn foreground_window() -> Option<WindowHandle> {
    None
}

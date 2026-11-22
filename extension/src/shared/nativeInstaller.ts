/**
 * Generador de activador Windows en 1 archivo (`RECO-Activar-Escritorio.cmd`)
 * para que cualquier usuario pueda habilitar la escritura en la barra de
 * direcciones y apps de escritorio directamente desde la interfaz de RECO,
 * sin buscar carpetas ni copiar el ID de la extensión.
 */

const HOST_PS1 = `$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class RecoWinTyper {
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT {
        public uint type;
        public INPUTUNION u;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT {
        public uint uMsg;
        public ushort wParamL, wParamH;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const ushort VK_RETURN = 0x0D;

    public static void TypeText(string text) {
        if (string.IsNullOrEmpty(text)) return;
        var list = new System.Collections.Generic.List<INPUT>(text.Length * 2);

        foreach (char ch in text) {
            if (ch == '\\r') continue;
            if (ch == '\\n') {
                list.Add(MakeVk(VK_RETURN, false));
                list.Add(MakeVk(VK_RETURN, true));
                continue;
            }
            list.Add(MakeUnicode(ch, false));
            list.Add(MakeUnicode(ch, true));
        }

        if (list.Count > 0) {
            SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        }
    }

    static INPUT MakeUnicode(char ch, bool keyUp) {
        return new INPUT {
            type = INPUT_KEYBOARD,
            u = new INPUTUNION {
                ki = new KEYBDINPUT {
                    wVk = 0,
                    wScan = (ushort)ch,
                    dwFlags = KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0),
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };
    }

    static INPUT MakeVk(ushort vk, bool keyUp) {
        return new INPUT {
            type = INPUT_KEYBOARD,
            u = new INPUTUNION {
                ki = new KEYBDINPUT {
                    wVk = vk,
                    wScan = 0,
                    dwFlags = keyUp ? KEYEVENTF_KEYUP : 0,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };
    }
}
"@

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()
$utf8 = [System.Text.Encoding]::UTF8

function Write-NativeMessage($obj) {
    $json = $obj | ConvertTo-Json -Compress
    $bytes = $utf8.GetBytes($json)
    $lenBytes = [BitConverter]::GetBytes([int]$bytes.Length)
    $stdout.Write($lenBytes, 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

function Read-Exact($stream, [int]$count) {
    $buf = New-Object byte[] $count
    $offset = 0
    while ($offset -lt $count) {
        $read = $stream.Read($buf, $offset, $count - $offset)
        if ($read -le 0) { return $null }
        $offset += $read
    }
    return $buf
}

while ($true) {
    $lenBuf = Read-Exact $stdin 4
    if ($null -eq $lenBuf) { break }
    $len = [BitConverter]::ToInt32($lenBuf, 0)
    if ($len -le 0 -or $len -gt 1048576) { break }

    $msgBuf = Read-Exact $stdin $len
    if ($null -eq $msgBuf) { break }

    $raw = $utf8.GetString($msgBuf)
    try {
        $msg = $raw | ConvertFrom-Json
        if ($msg.action -eq "ping") {
            Write-NativeMessage @{ ok = $true; pong = $true }
        } elseif ($msg.action -eq "type") {
            [RecoWinTyper]::TypeText([string]$msg.text)
            Write-NativeMessage @{ ok = $true }
        } else {
            Write-NativeMessage @{ ok = $false; error = "unknown_action" }
        }
    } catch {
        Write-NativeMessage @{ ok = $false; error = $_.Exception.Message }
    }
}
`;

function toUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function buildWindowsNativeActivatorBat(extensionId: string): string {
  const hostPs1B64 = toUtf8Base64(HOST_PS1);
  const installScript = `
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:LOCALAPPDATA "RECO\\native-host"
New-Item -ItemType Directory -Path $dir -Force | Out-Null

$hostPs1Bytes = [Convert]::FromBase64String("${hostPs1B64}")
$hostPs1Text = [System.Text.Encoding]::UTF8.GetString($hostPs1Bytes)
$hostPs1Path = Join-Path $dir "reco-host.ps1"
[System.IO.File]::WriteAllText($hostPs1Path, $hostPs1Text, [System.Text.UTF8Encoding]::new($false))

$cmdPath = Join-Path $dir "reco-host.cmd"
$cmdBody = "@echo off\`r\`n\`"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \`"%~dp0reco-host.ps1\`"\`r\`n"
[System.IO.File]::WriteAllText($cmdPath, $cmdBody, [System.Text.Encoding]::ASCII)

$manifestPath = Join-Path $dir "com.reco.typer.json"
$manifest = @{
  name = "com.reco.typer"
  description = "RECO Desktop & Omnibox Cursor Typer"
  path = $cmdPath
  type = "stdio"
  allowed_origins = @("chrome-extension://${extensionId}/")
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))

foreach ($reg in @(
  "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.reco.typer",
  "HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.reco.typer"
)) {
  New-Item -Path $reg -Force | Out-Null
  Set-ItemProperty -Path $reg -Name "(Default)" -Value $manifestPath
}

Write-Host ""
Write-Host "RECO activado! Ya puedes escribir en la barra de direcciones y en cualquier app de Windows." -ForegroundColor Green
`;

  const b64 = toUtf8Base64(installScript);
  const b64Lines: string[] = [];
  for (let i = 0; i < b64.length; i += 100) {
    b64Lines.push(`::RECO_B64:${b64.slice(i, i + 100)}`);
  }

  return (
    `@echo off\r\n` +
    `title Activando dictado de sistema RECO...\r\n` +
    `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$lines = Get-Content -LiteralPath '%~f0' | Where-Object { $_ -like '::RECO_B64:*' } | ForEach-Object { $_.Substring(11) }; $ps = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($lines -join ''))); Invoke-Expression $ps"\r\n` +
    `if errorlevel 1 (\r\n` +
    `  echo.\r\n` +
    `  echo Hubo un error al activar RECO.\r\n` +
    `  pause\r\n` +
    `) else (\r\n` +
    `  timeout /t 2 >nul\r\n` +
    `)\r\n` +
    `exit /b\r\n` +
    b64Lines.join("\r\n") +
    `\r\n`
  );
}

export function downloadWindowsNativeActivator(extensionId: string): void {
  const batContent = buildWindowsNativeActivatorBat(extensionId);
  const blob = new Blob([batContent], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "RECO-Activar-Escritorio.cmd";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

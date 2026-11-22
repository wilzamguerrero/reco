$ErrorActionPreference = "Stop"

# Win32 SendInput Unicode injector (sin tocar el portapapeles del usuario)
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
            if (ch == '\r') continue;
            if (ch == '\n') {
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

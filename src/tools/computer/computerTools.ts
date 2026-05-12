import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentAction } from '../../core/types.js';

const execFileAsync = promisify(execFile);

type ToolResult = { ok: boolean; output: string; error?: { code: string; message: string } };

type ComputerAction<T extends AgentAction['type']> = Extract<AgentAction, { type: T }>;

function unsupported(tool: string): ToolResult {
  return {
    ok: false,
    output: `${tool} 暂不支持当前平台：${process.platform}`,
    error: { code: 'platform_unsupported', message: `${tool} unsupported on ${process.platform}` },
  };
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, output: message, error: { code, message } };
}

async function runOsascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 20_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function runPowerShell(script: string): Promise<string> {
  const exe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const { stdout } = await execFileAsync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function executeComputerScreenshot(action: ComputerAction<'computer_screenshot'>): Promise<ToolResult> {
  const out = action.outputPath || path.join(await mkdtemp(path.join(os.tmpdir(), 'artemis-screen-')), 'screenshot.png');
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('screencapture', ['-x', out], { timeout: 30_000 });
      return { ok: true, output: `截图已保存：${out}` };
    }
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${out.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose(); Write-Output '${out.replace(/'/g, "''")}'`;
      await runPowerShell(ps);
      return { ok: true, output: `截图已保存：${out}` };
    }
    return unsupported('computer_screenshot');
  } catch (error) {
    return fail('screenshot_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function executeComputerClick(action: ComputerAction<'computer_click'>): Promise<ToolResult> {
  try {
    if (process.platform === 'darwin') {
      await runOsascript(`tell application "System Events" to click at {${Math.round(action.x)}, ${Math.round(action.y)}}`);
      return { ok: true, output: `已点击坐标 (${action.x}, ${action.y})` };
    }
    if (process.platform === 'win32') {
      const ps = `$sig='[DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags,int dx,int dy,int cButtons,int dwExtraInfo);'; Add-Type -MemberDefinition $sig -Name U -Namespace Win32; [Win32.U]::SetCursorPos(${Math.round(action.x)},${Math.round(action.y)}); [Win32.U]::mouse_event(2,0,0,0,0); [Win32.U]::mouse_event(4,0,0,0,0);`;
      await runPowerShell(ps);
      return { ok: true, output: `已点击坐标 (${action.x}, ${action.y})` };
    }
    return unsupported('computer_click');
  } catch (error) {
    return fail('click_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function executeComputerMove(action: ComputerAction<'computer_move'>): Promise<ToolResult> {
  try {
    if (process.platform === 'darwin') {
      await runOsascript(`tell application "System Events" to set mouse location to {${Math.round(action.x)}, ${Math.round(action.y)}}`);
      return { ok: true, output: `鼠标已移动到 (${action.x}, ${action.y})` };
    }
    if (process.platform === 'win32') {
      await runPowerShell(`$sig='[DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y);'; Add-Type -MemberDefinition $sig -Name U -Namespace Win32; [Win32.U]::SetCursorPos(${Math.round(action.x)},${Math.round(action.y)}) | Out-Null`);
      return { ok: true, output: `鼠标已移动到 (${action.x}, ${action.y})` };
    }
    return unsupported('computer_move');
  } catch (error) {
    return fail('move_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function executeComputerType(action: ComputerAction<'computer_type'>): Promise<ToolResult> {
  try {
    if (process.platform === 'darwin') {
      await runOsascript(`tell application "System Events" to keystroke "${escapeAppleScriptString(action.text)}"`);
      return { ok: true, output: `已输入 ${action.text.length} 个字符` };
    }
    if (process.platform === 'win32') {
      await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${action.text.replace(/'/g, "''").replace(/[+^%~(){}[\]]/g, '{$&}')}')`);
      return { ok: true, output: `已输入 ${action.text.length} 个字符` };
    }
    return unsupported('computer_type');
  } catch (error) {
    return fail('type_failed', error instanceof Error ? error.message : String(error));
  }
}



export async function executeComputerKey(action: ComputerAction<'computer_key'>): Promise<ToolResult> {
  try {
    if (process.platform === 'darwin') {
      await runOsascript(`tell application "System Events" to key code ${JSON.stringify(action.key)}`);
      return { ok: true, output: `已按键：${action.key}` };
    }
    if (process.platform === 'win32') {
      await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{${action.key.replace(/'/g, "''")}}')`);
      return { ok: true, output: `已按键：${action.key}` };
    }
    return unsupported('computer_key');
  } catch (error) {
    return fail('key_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function executeComputerDrag(action: ComputerAction<'computer_drag'>): Promise<ToolResult> {
  try {
    const fromX = Math.round(action.fromX); const fromY = Math.round(action.fromY); const toX = Math.round(action.toX); const toY = Math.round(action.toY);
    if (process.platform === 'darwin') {
      await runOsascript(`tell application "System Events" to drag at {${fromX}, ${fromY}} to {${toX}, ${toY}}`);
      return { ok: true, output: `已拖拽 (${fromX}, ${fromY}) → (${toX}, ${toY})` };
    }
    if (process.platform === 'win32') {
      const ps = `$sig='[DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags,int dx,int dy,int cButtons,int dwExtraInfo);'; Add-Type -MemberDefinition $sig -Name U -Namespace Win32; [Win32.U]::SetCursorPos(${fromX},${fromY}); [Win32.U]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds ${Math.max(50, Math.min(5000, action.durationMs ?? 250))}; [Win32.U]::SetCursorPos(${toX},${toY}); [Win32.U]::mouse_event(4,0,0,0,0);`;
      await runPowerShell(ps);
      return { ok: true, output: `已拖拽 (${fromX}, ${fromY}) → (${toX}, ${toY})` };
    }
    return unsupported('computer_drag');
  } catch (error) {
    return fail('drag_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function executeComputerHotkey(action: ComputerAction<'computer_hotkey'>): Promise<ToolResult> {
  try {
    const keys = action.keys.map((k) => k.toLowerCase());
    if (process.platform === 'darwin') {
      const mods = keys.filter((k) => ['cmd', 'command', 'control', 'ctrl', 'option', 'alt', 'shift'].includes(k));
      const main = keys.find((k) => !mods.includes(k));
      if (!main) return fail('invalid_hotkey', 'hotkey must include a non-modifier key');
      const using = mods.map((m) => m === 'cmd' || m === 'command' ? 'command down' : m === 'ctrl' ? 'control down' : m === 'alt' ? 'option down' : `${m} down`).join(', ');
      await runOsascript(`tell application "System Events" to keystroke "${escapeAppleScriptString(main)}"${using ? ` using {${using}}` : ''}`);
      return { ok: true, output: `已按快捷键：${action.keys.join('+')}` };
    }
    if (process.platform === 'win32') {
      const map = (k: string) => k === 'ctrl' || k === 'control' ? '^' : k === 'alt' || k === 'option' ? '%' : k === 'shift' ? '+' : k === 'win' || k === 'meta' ? '^{ESC}' : k;
      await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.map(map).join('')}')`);
      return { ok: true, output: `已按快捷键：${action.keys.join('+')}` };
    }
    return unsupported('computer_hotkey');
  } catch (error) {
    return fail('hotkey_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function executeComputerClipboardGet(_action: ComputerAction<'computer_clipboard_get'>): Promise<ToolResult> {
  try {
    if (process.platform === 'darwin') return { ok: true, output: await runOsascript('the clipboard as text') };
    if (process.platform === 'win32') return { ok: true, output: await runPowerShell('Get-Clipboard') };
    return unsupported('computer_clipboard_get');
  } catch (error) { return fail('clipboard_get_failed', error instanceof Error ? error.message : String(error)); }
}

export async function executeComputerClipboardSet(action: ComputerAction<'computer_clipboard_set'>): Promise<ToolResult> {
  try {
    if (process.platform === 'darwin') {
      await runOsascript(`set the clipboard to "${escapeAppleScriptString(action.text)}"`);
      return { ok: true, output: '剪贴板已更新' };
    }
    if (process.platform === 'win32') {
      await runPowerShell(`Set-Clipboard -Value @'\n${action.text.replace(/@'/g, "@''")}\n'@`);
      return { ok: true, output: '剪贴板已更新' };
    }
    return unsupported('computer_clipboard_set');
  } catch (error) { return fail('clipboard_set_failed', error instanceof Error ? error.message : String(error)); }
}

export async function executeComputerOpenApp(action: ComputerAction<'computer_open_app'>): Promise<ToolResult> {
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('open', ['-a', action.name], { timeout: 20_000 });
      return { ok: true, output: `已打开应用：${action.name}` };
    }
    if (process.platform === 'win32') {
      await runPowerShell(`Start-Process '${action.name.replace(/'/g, "''")}'`);
      return { ok: true, output: `已打开应用：${action.name}` };
    }
    return unsupported('computer_open_app');
  } catch (error) { return fail('open_app_failed', error instanceof Error ? error.message : String(error)); }
}

export async function executeComputerActiveWindow(_action: ComputerAction<'computer_active_window'>): Promise<ToolResult> {
  try {
    if (process.platform === 'darwin') {
      const out = await runOsascript('tell application "System Events" to get name of first application process whose frontmost is true');
      return { ok: true, output: out || '未知前台应用' };
    }
    if (process.platform === 'win32') {
      const ps = `$sig='[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);'; Add-Type -MemberDefinition $sig -Name U -Namespace Win32; $b=New-Object System.Text.StringBuilder 1024; $h=[Win32.U]::GetForegroundWindow(); [void][Win32.U]::GetWindowText($h,$b,$b.Capacity); $b.ToString()`;
      return { ok: true, output: await runPowerShell(ps) };
    }
    return unsupported('computer_active_window');
  } catch (error) { return fail('active_window_failed', error instanceof Error ? error.message : String(error)); }
}

export async function executeComputerDoctor(_action: ComputerAction<'computer_doctor'>): Promise<ToolResult> {
  const lines = [`platform=${process.platform}`, `node=${process.version}`];
  try {
    await import('playwright');
    lines.push('playwright=installed');
  } catch { lines.push('playwright=missing'); }
  if (process.platform === 'darwin') {
    lines.push('macos_screen_capture=screencapture available if screenshot succeeds');
    lines.push('macos_accessibility=required for click/type/hotkey; enable Artemis/Terminal in System Settings > Privacy & Security > Accessibility');
    lines.push('macos_screen_recording=required for screenshots in some contexts; enable in Privacy & Security > Screen Recording');
  } else if (process.platform === 'win32') {
    lines.push('windows_powershell=required');
    lines.push('windows_sendkeys=uses System.Windows.Forms.SendKeys; elevated/admin or secure desktops may block automation');
  }
  return { ok: true, output: lines.join('\n') };
}

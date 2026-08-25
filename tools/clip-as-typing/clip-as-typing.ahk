#Requires AutoHotkey v2.0
#SingleInstance Force
#UseHook true
#Warn All, Off
; No tray icon: the tray already holds the keyboard-layout flag indicator
; (D:\Themes\WormAlang-indicator\lang-flag-tray.ahk), and a second AutoHotkey
; icon next to it reads as "the flag broke".
#NoTrayIcon

; Fix Wispr Flow dictation inside Orca terminals. One job, one hotkey.
;
; The problem, measured 2026-08-24/25 on Windows 11 + Orca 1.4.185:
;   - Wispr puts recognized text on the clipboard and synthesizes Ctrl+V.
;   - Orca cancels a paste whose pane lost focus, and since 1.4.185 it does so
;     silently (upstream stablyai/orca #6165, #13623; #16170 asks for the text
;     to be delivered instead of dropped).
;   - The dictation overlay does NOT take window focus - the active window stays
;     Orca.exe - so the focus is lost inside Orca's renderer and no amount of
;     WinActivate from outside can restore it.
;   - Real keyboard input into the pane does re-arm it.
;
; So: intercept the paste Wispr synthesizes and type the text instead. Typing
; cannot be cancelled. Human Ctrl+V is passed through untouched.
;
; Telling them apart: pressing Ctrl+V holds Ctrl physically, a synthesized one
; holds nothing. GetKeyState(..., "P") reports the physical state. Validated in
; dry-run: four synthesized pastes and two human presses, no misclassification.
;
; Second trap, also measured: Wispr restores the previous clipboard content
; ~500 ms after its paste, more than once per dictation. So the text is captured
; the moment it appears and any value seen again within a few seconds is treated
; as a restore, never as new input.
;
; Only hotkey: Win+* toggles the fix off and on (numpad asterisk, or Win+Shift+8
; for keyboards without a numpad). Nothing else is bound - no spare bindings,
; no reload key. Reload by restarting the process.

LOG_FILE := A_ScriptDir "\clip-as-typing.log"

; Not named Log(): that collides with the built-in logarithm function and the
; script refuses to load with "This Func cannot be used as an output variable".
WriteLog(msg) {
    global LOG_FILE
    try FileAppend FormatTime(, "HH:mm:ss.") A_MSec " " msg "`n", LOG_FILE, "UTF-8"
}

; An unhandled error in a timer pops a modal dialog: the process stays in the
; task list while answering nothing, which reads as "it just stopped working".
OnError(ErrHandler)
ErrHandler(err, mode) {
    WriteLog("ERROR: " err.Message " (" err.File ":" err.Line ")")
    return -1
}

Enabled := true
FRESH_CAPTURE_MS := 10000
SEEN_MS := 6000
PRUNE_MS := 60000
; Wispr restores the previous clipboard content ~500 ms after putting the
; recognized text there. Measured 2026-08-25 over four dictations: 524, 516,
; 504, 501 ms. So any clipboard change arriving shortly after a capture is that
; restore, whatever its content - recognising it by content alone failed, see
; RestoreValues below.
RESTORE_AFTER_MS := 1500
; The restored snapshot is the same value every time, so once seen it is
; remembered and never captured again. Without this the snapshot looked "new"
; on every dictation (each sighting more than SEEN_MS apart) and one injected
; Ctrl+V typed 6549 characters of it into the terminal.
RestoreValues := Map()
; Hard ceiling on automatic typing. A dictated sentence is short; anything this
; long means the capture is wrong, and typing it takes ~14 s of garbage.
MAX_TYPE_CHARS := 2000
LastCaptureAt := 0
SeenAt := Map()
CapturedText := ""
CapturedAt := 0
CurSeen := ""
TARGET_PROCS := Map("Orca.exe", 1)

WriteLog("script started")

OnClipboardChange(OnClip)

OnClip(type) {
    global CapturedText, CapturedAt, CurSeen, SeenAt, SEEN_MS, PRUNE_MS
    global RESTORE_AFTER_MS, RestoreValues, LastCaptureAt
    if (type != 1)
        return
    txt := ""
    try txt := A_Clipboard
    if (txt = "")
        return
    ; The event fires more than once per change; ignore exact repeats.
    if (txt == CurSeen)
        return
    now := A_TickCount
    for k, t in SeenAt.Clone() {
        if (now - t > PRUNE_MS)
            SeenAt.Delete(k)
    }
    seenRecently := SeenAt.Has(txt) && (now - SeenAt[txt] < SEEN_MS)
    SeenAt[txt] := now
    CurSeen := txt
    ; Known restore snapshot, or a change that arrived right on the heels of a
    ; capture: either way it is Wispr putting the old clipboard back.
    justAfterCapture := LastCaptureAt && (now - LastCaptureAt < RESTORE_AFTER_MS)
    if (RestoreValues.Has(txt) || justAfterCapture || seenRecently) {
        if (justAfterCapture && !RestoreValues.Has(txt)) {
            RestoreValues[txt] := now
            WriteLog("clip: restore snapshot learned (len " StrLen(txt) ")")
        }
        WriteLog("clip: restore ignored (len " StrLen(txt) "), keeping capture of " StrLen(CapturedText))
        return
    }
    CapturedText := txt
    CapturedAt := A_TickCount
    LastCaptureAt := A_TickCount
    WriteLog("clip: captured " StrLen(txt) " chars")
}

; Wispr's paste, replaced by typing. A human Ctrl+V goes straight through.
$^vk56:: {
    global CapturedText, CapturedAt, SeenAt, Enabled, FRESH_CAPTURE_MS, TARGET_PROCS
    global MAX_TYPE_CHARS
    if (GetKeyState("Ctrl", "P")) {
        Send "{Blind}{vk56}"
        return
    }
    activeProc := ""
    try activeProc := WinGetProcessName("A")
    fresh := (CapturedText != "") && SeenAt.Has(CapturedText)
        && (A_TickCount - SeenAt[CapturedText] < FRESH_CAPTURE_MS)
    if (!Enabled || !fresh || !TARGET_PROCS.Has(activeProc)) {
        WriteLog("ctrl+v injected: passed through (enabled=" (Enabled ? 1 : 0)
            . " fresh=" (fresh ? 1 : 0) " active=" activeProc ")")
        Send "^{vk56}"
        return
    }
    txt := StrReplace(StrReplace(StrReplace(CapturedText, "`r`n", " "), "`n", " "), "`r", " ")
    n := StrLen(txt)
    if (n > MAX_TYPE_CHARS) {
        WriteLog("ctrl+v injected: capture too long (" n " chars), passed through instead of typing")
        Send "^{vk56}"
        return
    }
    lag := A_TickCount - CapturedAt
    t0 := A_TickCount
    SendText txt
    ms := A_TickCount - t0
    rate := ms > 0 ? Round(n * 1000 / ms) : 0
    WriteLog("MEASURE chars=" n " type_ms=" ms " rate=" rate "/s lag_from_capture_ms=" lag)
}

Toggle(*) {
    global Enabled
    Enabled := !Enabled
    WriteLog("toggled: " (Enabled ? "ON" : "OFF"))
    ; Brief on-screen confirmation - there is no tray icon to show state.
    ToolTip(Enabled ? "Wispr fix: ON" : "Wispr fix: OFF")
    SetTimer () => ToolTip(), -1200
}

; Numpad asterisk, plus Win+Shift+8 for keyboards without a numpad.
#NumpadMult:: Toggle()
#+vk38:: Toggle()

; One log line a minute, so a dead process can be told from a live one.
SetTimer () => WriteLog("alive"), 60000

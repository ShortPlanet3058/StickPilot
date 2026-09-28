// StickPilot's macOS shortcut helper: prints "doubletap" when Right Shift is
// tapped twice quickly with no other key in between.
//
// It runs as its own process with a global NSEvent monitor, so it can never
// block the app. It only receives modifier-key changes plus key-down / mouse-down
// notifications, used to cancel the gesture; it never reads what is typed.
// macOS requires the Accessibility permission, which it takes from StickPilot
// (the app that starts it).
//
// Output lines: "ready", "untrusted" (then exits 2), "doubletap".

import AppKit

setvbuf(stdout, nil, _IOLBF, 0)

let rightShiftKeyCode: UInt16 = 60
let deviceRightShiftMask: UInt = 0x04 // NX_DEVICERSHIFTKEYMASK
let tapMax: TimeInterval = 0.30       // a press longer than this is holding, not tapping
let betweenMax: TimeInterval = 0.40   // second tap must follow the first within this

guard AXIsProcessTrusted() else {
    print("untrusted")
    exit(2)
}

var downAt: TimeInterval = 0
var clean = false
var lastTap: TimeInterval = 0

func cancel() {
    clean = false
    lastTap = 0
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited) // no Dock icon, no menu bar

let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown]) { event in
    guard event.type == .flagsChanged, event.keyCode == rightShiftKeyCode else {
        cancel()
        return
    }
    let now = ProcessInfo.processInfo.systemUptime
    let isDown = event.modifierFlags.rawValue & deviceRightShiftMask != 0
    if isDown {
        if downAt == 0 { downAt = now; clean = true }
        return
    }
    let wasTap = clean && downAt > 0 && now - downAt <= tapMax
    downAt = 0
    guard wasTap else { lastTap = 0; return }
    if lastTap > 0 && now - lastTap <= betweenMax {
        lastTap = 0
        print("doubletap")
    } else {
        lastTap = now
    }
}

if monitor == nil {
    print("untrusted")
    exit(2)
}

// Exit with the app: stdin closes when StickPilot quits
FileHandle.standardInput.readabilityHandler = { handle in
    if handle.availableData.isEmpty { exit(0) }
}

print("ready")
app.run()

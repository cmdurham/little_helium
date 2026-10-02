// Little Helium's optional native helper (Chrome native messaging).
// Answers {"type":"source-window"} with the frontmost on-screen window that
// doesn't belong to Helium, i.e. the app a link was just opened from, so the
// extension can put the Little window on that app's display.
import AppKit
import CoreGraphics
import Foundation

func readMessage() -> [String: Any]? {
  let header = FileHandle.standardInput.readData(ofLength: 4)
  guard header.count == 4 else { return nil }
  let length = header.withUnsafeBytes { $0.load(as: UInt32.self) }
  let body = FileHandle.standardInput.readData(ofLength: Int(length))
  return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

func send(_ object: [String: Any]) {
  let body = try! JSONSerialization.data(withJSONObject: object)
  var length = UInt32(body.count)
  FileHandle.standardOutput.write(Data(bytes: &length, count: 4))
  FileHandle.standardOutput.write(body)
}

// Global coordinates with the origin at the primary display's top-left, in
// points, matching chrome.system.display and chrome.windows bounds.
func sourceWindow() -> [String: Any]? {
  let browserPid = Int(getppid())
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
  for info in list {  // front to back
    guard (info[kCGWindowLayer as String] as? Int) == 0,
          let pid = info[kCGWindowOwnerPID as String] as? Int, pid != browserPid,
          (info[kCGWindowAlpha as String] as? Double ?? 1) > 0,
          let b = info[kCGWindowBounds as String] as? [String: Double],
          let w = b["Width"], let h = b["Height"], w >= 120, h >= 80 else { continue }
    return ["left": b["X"]!, "top": b["Y"]!, "width": w, "height": h, "pid": pid]
  }
  return nil
}

func cursor() -> [String: Any] {
  let p = NSEvent.mouseLocation  // bottom-left origin
  let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
  return ["x": p.x, "y": primaryHeight - p.y]
}

while let message = readMessage() {
  switch message["type"] as? String {
  case "source-window":
    var reply: [String: Any] = ["cursor": cursor()]
    if let w = sourceWindow() { reply["window"] = w }
    send(reply)
  case "ping":
    send(["ok": true, "version": 1])
  default:
    send(["error": "unknown request"])
  }
}

// Native, runtime-only outline reader. Requests contain only a fixed face
// selector and a glyph number. No font files or document text are exported.
import CoreGraphics
import CoreText
import Darwin
import Foundation

struct Face {
    let font: CTFont
    let units: Int
    let normalization: CGFloat

    init?(size: CGFloat, postscript: String) {
        guard let base = CTFontCreateUIFontForLanguage(.system, size, "zh-Hans" as CFString) else { return nil }
        let sample = "系" as CFString
        let font = CTFontCreateForString(base, sample, CFRange(location: 0, length: 1))
        guard CTFontCopyPostScriptName(font) as String == postscript else { return nil }
        let units = CTFontGetUnitsPerEm(font)
        guard units > 0 else { return nil }
        self.font = font
        self.units = Int(units)
        self.normalization = CGFloat(units) / size
    }

    func outline(_ glyph: CGGlyph) -> [String: Any]? {
        guard glyph > 0, Int(glyph) < CTFontGetGlyphCount(font),
              let path = CTFontCreatePathForGlyph(font, glyph, nil) else { return nil }
        var commands: [[Double]] = []
        var valid = true
        path.applyWithBlock { pointer in
            guard valid && commands.count < 4096 else { valid = false; return }
            let element = pointer.pointee
            let opcode: Double
            let points: Int
            switch element.type {
            case .moveToPoint: opcode = 0; points = 1
            case .addLineToPoint: opcode = 1; points = 1
            case .addQuadCurveToPoint: opcode = 2; points = 2
            case .addCurveToPoint: opcode = 3; points = 3
            case .closeSubpath: opcode = 4; points = 0
            @unknown default: valid = false; return
            }
            var command = [opcode]
            for i in 0..<points {
                let p = element.points[i]
                let x = p.x * normalization
                let y = p.y * normalization
                guard x.isFinite && y.isFinite && abs(x) < 65536 && abs(y) < 65536 else { valid = false; return }
                command.append(Double(x)); command.append(Double(y))
            }
            commands.append(command)
        }
        var glyph = glyph
        var advance = CGSize.zero
        CTFontGetAdvancesForGlyphs(font, .horizontal, &glyph, &advance, 1)
        let advanceUnits = advance.width * normalization
        guard valid, !commands.isEmpty, advanceUnits.isFinite, advanceUnits > 0, advanceUnits < 65536 else { return nil }
        return ["glyph": glyph, "units": units, "advance": Double(advanceUnits), "commands": commands]
    }
}

let text = Face(size: 16, postscript: ".PingFangUITextSC-Regular")
let display = Face(size: 46, postscript: ".PingFangUIDisplaySC-Regular")
while let line = readLine() {
    autoreleasepool {
        let fields = line.split(separator: " ", omittingEmptySubsequences: true)
        let response: [String: Any]?
        if fields.count == 2, let glyph = UInt16(fields[1]) {
            response = (fields[0] == "T" ? text : fields[0] == "D" ? display : nil)?.outline(glyph)
        } else {
            response = nil
        }
        if let response, let bytes = try? JSONSerialization.data(withJSONObject: response),
           let json = String(data: bytes, encoding: .utf8) {
            print(json)
        } else {
            print("null")
        }
        fflush(stdout)
    }
}

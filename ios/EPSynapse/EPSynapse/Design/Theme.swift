import SwiftUI
import UIKit

enum ThemePreference: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

final class ThemeStore: ObservableObject {
    @Published var preference: ThemePreference {
        didSet { UserDefaults.standard.set(preference.rawValue, forKey: Self.storageKey) }
    }

    private static let storageKey = "eps.themePreference"

    init() {
        if let raw = UserDefaults.standard.string(forKey: Self.storageKey),
           let stored = ThemePreference(rawValue: raw) {
            preference = stored
        } else {
            preference = .system
        }
    }

    var colorScheme: ColorScheme? { preference.colorScheme }
    var preferredColorScheme: ColorScheme? { preference.colorScheme }

    func cycle() {
        switch preference {
        case .system: preference = .light
        case .light: preference = .dark
        case .dark: preference = .system
        }
    }
}

enum EPSTheme {
    static let accent = Color(red: 235 / 255, green: 167 / 255, blue: 0)

    static let bg0 = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? Self.darkBg0 : Self.lightBg0
    })

    static let bg1 = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? Self.darkBg1 : Self.lightBg1
    })

    static let fg = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? Self.darkFg : Self.lightFg
    })

    static let muted = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? Self.darkMuted : Self.lightMuted
    })

    static let navyBloom = Color(red: 0, green: 70 / 255, blue: 127 / 255)
    static let goldBloom = accent

    static func bg0(_ scheme: ColorScheme) -> Color {
        Color(scheme == .dark ? darkBg0 : lightBg0)
    }

    static func bg1(_ scheme: ColorScheme) -> Color {
        Color(scheme == .dark ? darkBg1 : lightBg1)
    }

    static func fg(_ scheme: ColorScheme) -> Color {
        Color(scheme == .dark ? darkFg : lightFg)
    }

    static func muted(_ scheme: ColorScheme) -> Color {
        Color(scheme == .dark ? darkMuted : lightMuted)
    }

    static func accent(_ scheme: ColorScheme) -> Color {
        Color(red: 235 / 255, green: 167 / 255, blue: 0)
    }

    static func filterOnTint(_ scheme: ColorScheme) -> Color {
        accent.opacity(scheme == .dark ? 0.55 : 0.72)
    }

    static func pageFill(_ scheme: ColorScheme) -> LinearGradient {
        LinearGradient(
            colors: [bg0(scheme), bg1(scheme)],
            startPoint: UnitPoint(x: 0.15, y: 0),
            endPoint: UnitPoint(x: 0.85, y: 1)
        )
    }

    /// CSS 165deg: bg0 → bg1, a little left of straight down.
    static var pageFill: LinearGradient {
        LinearGradient(
            colors: [bg0, bg1],
            startPoint: UnitPoint(x: 0.37, y: 0.02),
            endPoint: UnitPoint(x: 0.63, y: 0.98)
        )
    }

    static var windowBackground: UIColor {
        UIColor { traits in
            traits.userInterfaceStyle == .dark ? Self.darkBg0 : Self.lightBg0
        }
    }

    static func navyBloom(center: UnitPoint = .topLeading, radius: CGFloat = 420) -> RadialGradient {
        RadialGradient(
            colors: [navyBloom.opacity(0.34), navyBloom.opacity(0)],
            center: center,
            startRadius: 8,
            endRadius: radius
        )
    }

    static func goldBloom(center: UnitPoint = .bottomTrailing, radius: CGFloat = 360) -> RadialGradient {
        RadialGradient(
            colors: [goldBloom.opacity(0.2), goldBloom.opacity(0)],
            center: center,
            startRadius: 8,
            endRadius: radius
        )
    }

    private static let lightBg0 = UIColor(red: 228 / 255, green: 234 / 255, blue: 242 / 255, alpha: 1)
    private static let lightBg1 = UIColor(red: 213 / 255, green: 222 / 255, blue: 234 / 255, alpha: 1)
    private static let lightFg = UIColor(red: 11 / 255, green: 31 / 255, blue: 58 / 255, alpha: 1)
    private static let lightMuted = UIColor(red: 74 / 255, green: 93 / 255, blue: 115 / 255, alpha: 1)
    private static let darkBg0 = UIColor(red: 7 / 255, green: 21 / 255, blue: 37 / 255, alpha: 1)
    private static let darkBg1 = UIColor(red: 11 / 255, green: 31 / 255, blue: 58 / 255, alpha: 1)
    private static let darkFg = UIColor(red: 232 / 255, green: 238 / 255, blue: 244 / 255, alpha: 1)
    private static let darkMuted = UIColor(red: 154 / 255, green: 168 / 255, blue: 184 / 255, alpha: 1)
}

/// Period and course colors from the public site (`--tone-*` in styles.css).
enum EPSTone: String, CaseIterable {
    case rose, amber, lime, teal, sky, indigo, orchid, slate

    private static let periodMap: [String: EPSTone] = [
        "A": .rose, "B": .amber, "C": .lime, "D": .teal,
        "E": .sky, "F": .indigo, "G": .orchid, "H": .slate
    ]

    var color: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? self.dark : self.light
        })
    }

    func color(_ scheme: ColorScheme) -> Color {
        Color(scheme == .dark ? dark : light)
    }

    static func forClass(_ klass: SchoolClass) -> EPSTone {
        let letter = klass.period.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if letter.count == 1, let mapped = periodMap[letter] { return mapped }
        return hash(klass.id.isEmpty ? klass.name : klass.id)
    }

    static func forAssignment(_ item: Assignment, classes: [SchoolClass]) -> EPSTone {
        if let match = classes.first(where: { assignment(item, matches: $0) }) {
            return forClass(match)
        }
        let seed = item.courseId.isEmpty ? item.courseName : item.courseId
        return hash(seed)
    }

    private static func assignment(_ item: Assignment, matches schoolClass: SchoolClass) -> Bool {
        if !item.courseId.isEmpty, item.courseId == schoolClass.id { return true }
        if !item.classId.isEmpty, item.classId == schoolClass.id { return true }
        return namesOverlap(item.courseName, schoolClass.name)
    }

    private static func namesOverlap(_ a: String, _ b: String) -> Bool {
        let left = a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let right = b.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if left.isEmpty || right.isEmpty { return false }
        if left == right { return true }
        return left.contains(right) || right.contains(left)
    }

    /// FNV-1a, same seed and multiply as the site so a class keeps its color.
    private static func hash(_ raw: String) -> EPSTone {
        let seed = raw.isEmpty ? "class" : raw
        var h: UInt32 = 2_166_136_261
        for unit in seed.utf16 {
            h ^= UInt32(unit)
            h &*= 16_777_619
        }
        let all = Self.allCases
        return all[Int(h % UInt32(all.count))]
    }

    private var light: UIColor {
        switch self {
        case .rose: return UIColor(red: 196 / 255, green: 91 / 255, blue: 106 / 255, alpha: 1)
        case .amber: return UIColor(red: 196 / 255, green: 146 / 255, blue: 20 / 255, alpha: 1)
        case .lime: return UIColor(red: 95 / 255, green: 143 / 255, blue: 56 / 255, alpha: 1)
        case .teal: return UIColor(red: 42 / 255, green: 138 / 255, blue: 130 / 255, alpha: 1)
        case .sky: return UIColor(red: 58 / 255, green: 115 / 255, blue: 160 / 255, alpha: 1)
        case .indigo: return UIColor(red: 103 / 255, green: 88 / 255, blue: 150 / 255, alpha: 1)
        case .orchid: return UIColor(red: 168 / 255, green: 93 / 255, blue: 144 / 255, alpha: 1)
        case .slate: return UIColor(red: 90 / 255, green: 109 / 255, blue: 130 / 255, alpha: 1)
        }
    }

    private var dark: UIColor {
        switch self {
        case .rose: return UIColor(red: 228 / 255, green: 136 / 255, blue: 146 / 255, alpha: 1)
        case .amber: return UIColor(red: 224 / 255, green: 180 / 255, blue: 74 / 255, alpha: 1)
        case .lime: return UIColor(red: 143 / 255, green: 191 / 255, blue: 90 / 255, alpha: 1)
        case .teal: return UIColor(red: 76 / 255, green: 188 / 255, blue: 176 / 255, alpha: 1)
        case .sky: return UIColor(red: 106 / 255, green: 168 / 255, blue: 212 / 255, alpha: 1)
        case .indigo: return UIColor(red: 155 / 255, green: 138 / 255, blue: 212 / 255, alpha: 1)
        case .orchid: return UIColor(red: 212 / 255, green: 139 / 255, blue: 188 / 255, alpha: 1)
        case .slate: return UIColor(red: 143 / 255, green: 160 / 255, blue: 180 / 255, alpha: 1)
        }
    }
}

extension DashboardStore {
    func tone(for klass: SchoolClass) -> Color {
        EPSTone.forClass(klass).color
    }

    func tone(for item: Assignment) -> Color {
        EPSTone.forAssignment(item, classes: displayedClasses).color
    }
}

extension View {
    /// Page gradient behind a screen. Also paints the navigation container so
    /// the stack does not show the system white/black behind pushed pages.
    func epsPageBackground() -> some View {
        background {
            EPSTheme.pageFill.ignoresSafeArea()
        }
        .containerBackground(EPSTheme.pageFill, for: .navigation)
    }
}

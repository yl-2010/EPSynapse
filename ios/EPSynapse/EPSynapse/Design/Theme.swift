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

extension View {
    func epsPageBackground() -> some View {
        background {
            EPSTheme.pageFill.ignoresSafeArea()
        }
    }
}

import SwiftUI
import UIKit

enum EPSHaptics {
    static func tap() {
        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
    }

    static func medium() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }
}

extension View {
    func epsHapticOnTap() -> some View {
        simultaneousGesture(TapGesture().onEnded { EPSHaptics.tap() })
    }

    func epsHapticNavigation() -> some View {
        simultaneousGesture(TapGesture().onEnded { EPSHaptics.medium() })
    }
}

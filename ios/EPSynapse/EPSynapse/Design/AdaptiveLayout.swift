import SwiftUI
import UIKit

enum AdaptiveLayout {
    static let pageMaxWidth: CGFloat = 1100
    static let chatMaxWidth: CGFloat = 760
    static let formMaxWidth: CGFloat = 560

    static var isPad: Bool {
        UIDevice.current.userInterfaceIdiom == .pad
    }

    static var isPhone: Bool {
        UIDevice.current.userInterfaceIdiom == .phone
    }

    static func isWideLayout(
        horizontal: UserInterfaceSizeClass?,
        vertical: UserInterfaceSizeClass?
    ) -> Bool {
        horizontal == .regular || vertical == .compact
    }

    static func isWideLayout(
        horizontalSizeClass: UserInterfaceSizeClass?,
        verticalSizeClass: UserInterfaceSizeClass?
    ) -> Bool {
        isWideLayout(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    static func pagePadding(
        horizontal: UserInterfaceSizeClass?,
        vertical: UserInterfaceSizeClass?
    ) -> CGFloat {
        isWideLayout(horizontal: horizontal, vertical: vertical) ? 32 : 20
    }
}

private struct AdaptiveReadableWidthModifier: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    var maxWidth: CGFloat

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: maxWidth)
            .frame(maxWidth: .infinity)
            .padding(
                .horizontal,
                AdaptiveLayout.pagePadding(
                    horizontal: horizontalSizeClass,
                    vertical: verticalSizeClass
                )
            )
    }
}

extension View {
    func adaptiveReadableWidth(_ maxWidth: CGFloat = AdaptiveLayout.pageMaxWidth) -> some View {
        modifier(AdaptiveReadableWidthModifier(maxWidth: maxWidth))
    }
}

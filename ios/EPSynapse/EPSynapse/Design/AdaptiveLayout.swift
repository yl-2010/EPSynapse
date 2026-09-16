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

    static var cornerOrbSide: CGFloat { isPad ? 60 : 52 }
    static var cornerPad: CGFloat { isPad ? 20 : 16 }
    static var chatPillSide: CGFloat { 56 }

    static var windowSafeArea: UIEdgeInsets {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        if let window = scene?.keyWindow ?? scene?.windows.first {
            return window.safeAreaInsets
        }
        return UIEdgeInsets(top: 59, left: 0, bottom: 34, right: 0)
    }

    static func isRegularWidth(_ sizeClass: UserInterfaceSizeClass?) -> Bool {
        sizeClass == .regular
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

    /// iPhone landscape (compact height). Do not use size-class width alone — Plus/Max are `.regular`.
    static func isPhoneLandscape(verticalSizeClass: UserInterfaceSizeClass?) -> Bool {
        isPhone && verticalSizeClass == .compact
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

    /// Page scrolls up and down only. Buttons and orbs still get Liquid Glass warp.
    func epsVerticalScrollOnly() -> some View {
        self
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .background {
                EPSVerticalScrollLock()
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
            }
    }
}

enum EPSScrollAxis {
    static func lockVertical(_ scroll: UIScrollView) {
        scroll.alwaysBounceHorizontal = false
        scroll.isDirectionalLockEnabled = true
        if #available(iOS 17.4, *) {
            scroll.bouncesHorizontally = false
        }
    }
}

private struct EPSVerticalScrollLock: UIViewRepresentable {
    func makeUIView(context: Context) -> EPSVerticalScrollLockView {
        EPSVerticalScrollLockView()
    }

    func updateUIView(_ uiView: EPSVerticalScrollLockView, context: Context) {
        uiView.apply()
    }
}

private final class EPSVerticalScrollLockView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        apply()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        apply()
    }

    func apply() {
        var node: UIView? = superview
        while let current = node {
            if let scroll = current as? UIScrollView {
                EPSScrollAxis.lockVertical(scroll)
                return
            }
            node = current.superview
        }
    }
}

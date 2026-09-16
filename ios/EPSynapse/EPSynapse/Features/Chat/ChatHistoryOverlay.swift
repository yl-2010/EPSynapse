import SwiftUI
import UIKit

struct ChatHistoryOverlay: View {
    @EnvironmentObject private var chat: ChatStore
    @State private var panelMounted = false
    @State private var panelWarming = false
    @State private var didWarm = false
    @State private var hapticGate = EPSHalfwayHapticGate(threshold: 0.5)

    var body: some View {
        GeometryReader { geo in
            let safe = AdaptiveLayout.windowSafeArea
            let leading = Self.panelLeading(safeLeading: safe.left)
            let top = Self.panelTop(safeTop: safe.top)
            let bottom = Self.panelBottom(safeBottom: safe.bottom)
            let width = Self.panelWidth(for: geo.size)
            let height = Self.panelHeight(for: geo.size, top: top, bottom: bottom)
            let travel = width + Self.hideExtra
            let showPanel = chat.historyDragging || chat.historyReveal >= 1 || panelMounted
            let mountPanel = showPanel || panelWarming

            ZStack(alignment: .topLeading) {
                Color.black
                    .opacity(0.28 * max(0, min(1, chat.historyReveal)))
                    .ignoresSafeArea()
                    .onTapGesture {
                        chat.setHistoryOpen(false)
                    }

                if mountPanel {
                    ChatHistoryPanel(
                        sections: ChatHistoryGrouping.sections(from: chat.chats),
                        isLoading: chat.historyLoading,
                        width: width,
                        onSelect: { item in
                            Task { await chat.resume(sessionId: item.sessionId) }
                        }
                    )
                    .frame(height: height)
                    .padding(.top, top)
                    .padding(.leading, leading)
                    .offset(x: (chat.historyReveal - 1) * travel)
                    .accessibilityHidden(!showPanel)
                    .transition(.identity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .task(id: travel) {
                chat.historyPanelWidth = travel
            }
            .onAppear {
                warmUpIfNeeded()
            }
            .onChange(of: chat.historyReveal) { _, value in
                if value >= 1 {
                    panelMounted = true
                }
                if value <= 0, !chat.historyDragging, !panelWarming {
                    panelMounted = false
                }
            }
            .onChange(of: chat.historyDragging) { _, dragging in
                if dragging { panelMounted = true }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea()
        .modifier(
            EPSProgressMonitor(progress: chat.historyReveal) { progress in
                hapticGate.handle(progress)
            }
        )
        .allowsHitTesting(overlayHits)
    }

    private var overlayHits: Bool {
        chat.historyDragging || chat.historyReveal > 0.5
    }

    static let hideExtra: CGFloat = 64
    static let commitVelocity: CGFloat = 520

    static func panelWidth(for size: CGSize) -> CGFloat {
        if AdaptiveLayout.isPad {
            return min(360, max(320, size.width * 0.34))
        }
        if size.width > size.height {
            return min(300, size.width * 0.40)
        }
        return size.width * 0.69
    }

    static func panelLeading(safeLeading: CGFloat) -> CGFloat {
        safeLeading + 8
    }

    static func panelTop(safeTop: CGFloat) -> CGFloat {
        safeTop + AdaptiveLayout.cornerPad + AdaptiveLayout.cornerOrbSide + 8
    }

    static func panelBottom(safeBottom: CGFloat) -> CGFloat {
        safeBottom + AdaptiveLayout.cornerPad + AdaptiveLayout.chatPillSide + 8
    }

    static func panelHeight(for size: CGSize, top: CGFloat, bottom: CGFloat) -> CGFloat {
        let available = max(160, size.height - top - bottom)
        let preferred: CGFloat
        if AdaptiveLayout.isPad {
            preferred = min(520, size.height * 0.55)
        } else if size.width > size.height {
            preferred = size.height * 0.78
        } else {
            preferred = size.height * 0.58
        }
        return min(preferred, available)
    }

    /// Build the panel once off-screen after the overlay appears, then drop it.
    /// First Liquid Glass construction is slow on a cold launch; doing it at
    /// idle keeps the first real swipe from drawing an empty sheet.
    private func warmUpIfNeeded() {
        guard !didWarm else { return }
        didWarm = true
        panelWarming = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            panelWarming = false
            if chat.historyReveal <= 0, !chat.historyDragging {
                panelMounted = false
            }
        }
    }

    static func rubber(_ raw: CGFloat) -> CGFloat {
        if raw < 0 { return raw * 0.22 }
        if raw > 1 { return 1 + (raw - 1) * 0.22 }
        return raw
    }

    static func linear(_ displayed: CGFloat) -> CGFloat {
        if displayed < 0 { return displayed / 0.22 }
        if displayed > 1 { return 1 + (displayed - 1) / 0.22 }
        return displayed
    }
}

struct ChatHistoryOpenModifier: ViewModifier {
    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var dashboard: DashboardStore

    func body(content: Content) -> some View {
        content.background {
            ChatHistoryPanBridge(
                travel: max(chat.historyPanelWidth, 1),
                blocksOpen: blocksHistoryOpen
            )
            .frame(width: 0, height: 0)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    private var blocksHistoryOpen: Bool {
        if dashboard.stackDepth > 0 { return true }
        let view = dashboard.uiContext.view.lowercased()
        return view == "class" || view == "note" || view == "todo"
    }
}

extension View {
    func chatHistoryOpenGesture() -> some View {
        modifier(ChatHistoryOpenModifier())
    }
}

/// Window pan so a left-to-right swipe opens past chats even when the home
/// scroll or the iOS 26 full-content back gesture would eat a SwiftUI drag.
private struct ChatHistoryPanBridge: UIViewRepresentable {
    var travel: CGFloat
    var blocksOpen: Bool

    func makeUIView(context: Context) -> ChatHistoryPanInstaller {
        let view = ChatHistoryPanInstaller()
        view.travel = travel
        view.blocksOpen = blocksOpen
        return view
    }

    func updateUIView(_ view: ChatHistoryPanInstaller, context: Context) {
        view.travel = travel
        view.blocksOpen = blocksOpen
        view.attach(to: view.window)
        view.syncNavPop()
    }

    static func dismantleUIView(_ view: ChatHistoryPanInstaller, coordinator: ()) {
        view.detach()
    }
}

final class ChatHistoryPanInstaller: UIView, UIGestureRecognizerDelegate {
    var travel: CGFloat = 280
    var blocksOpen = false

    private let pan = UIPanGestureRecognizer()
    private var engaged = false
    private var startReveal: CGFloat = 0
    private var hapticGate = EPSHalfwayHapticGate(threshold: 0.5)
    private weak var hostView: UIView?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        pan.addTarget(self, action: #selector(handlePan))
        pan.cancelsTouchesInView = false
        pan.maximumNumberOfTouches = 1
        pan.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        attach(to: window)
        syncNavPop()
    }

    func detach() {
        hostView?.removeGestureRecognizer(pan)
        hostView = nil
    }

    func attach(to window: UIWindow?) {
        if hostView === window { return }
        hostView?.removeGestureRecognizer(pan)
        hostView = window
        window?.addGestureRecognizer(pan)
    }

    /// On home, turn off system swipe-back so it cannot swallow the history swipe.
    /// Pushed pages keep the system pop.
    func syncNavPop() {
        guard let nav = findHomeNavigation() else { return }
        nav.interactivePopGestureRecognizer?.isEnabled = blocksOpen
        if #available(iOS 26, *) {
            nav.interactiveContentPopGestureRecognizer?.isEnabled = blocksOpen
        }
    }

    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        guard let view = gesture.view else { return }
        if view.window?.rootViewController?.presentedViewController != nil { return }

        let translation = gesture.translation(in: view)
        let velocity = gesture.velocity(in: view)

        switch gesture.state {
        case .began, .changed:
            applyDrag(dx: translation.x)
        case .ended, .cancelled, .failed:
            finishDrag(velocityX: velocity.x)
        default:
            break
        }
    }

    private func applyDrag(dx: CGFloat) {
        MainActor.assumeIsolated {
            let chat = ChatStore.shared
            if !engaged {
                engaged = true
                startReveal = chat.historyReveal
                chat.historyDragging = true
                hapticGate.reset()
                EPSHaptics.swipeBackBegan()
                hapticGate.handle(startReveal)
                Task { await chat.loadList() }
            }
            let raw = startReveal + dx / max(travel, 1)
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                chat.historyReveal = ChatHistoryOverlay.rubber(raw)
            }
            hapticGate.handle(min(max(chat.historyReveal, 0), 1))
        }
    }

    private func finishDrag(velocityX: CGFloat) {
        MainActor.assumeIsolated {
            guard engaged else { return }
            engaged = false
            let chat = ChatStore.shared
            chat.historyDragging = false
            let open: Bool
            if velocityX >= ChatHistoryOverlay.commitVelocity, chat.historyReveal > 0.08 {
                open = true
            } else if velocityX <= -ChatHistoryOverlay.commitVelocity, chat.historyReveal < 0.92 {
                open = false
            } else {
                open = ChatHistoryOverlay.linear(chat.historyReveal) >= 0.5
            }
            chat.setHistoryOpen(open)
        }
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
        if window?.rootViewController?.presentedViewController != nil { return false }
        let reveal = MainActor.assumeIsolated { ChatStore.shared.historyReveal }
        if blocksOpen && reveal < 0.5 { return false }
        let velocity = pan.velocity(in: pan.view)
        let translation = pan.translation(in: pan.view)
        let dx = hypot(velocity.x, velocity.y) > 8 ? velocity.x : translation.x
        let dy = hypot(velocity.x, velocity.y) > 8 ? velocity.y : translation.y
        if reveal < 0.08 {
            return dx > 0 && abs(dx) > abs(dy) * 1.15
        }
        return abs(dx) > abs(dy) * 1.15
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }

    private func findHomeNavigation() -> UINavigationController? {
        guard let root = window?.rootViewController else { return nil }
        return deepestNavigation(from: root)
    }

    private func deepestNavigation(from root: UIViewController) -> UINavigationController? {
        if let nav = root as? UINavigationController {
            for child in root.children.reversed() {
                if let found = deepestNavigation(from: child) { return found }
            }
            return nav
        }
        for child in root.children.reversed() {
            if let found = deepestNavigation(from: child) { return found }
        }
        return nil
    }
}

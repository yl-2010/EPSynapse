import SwiftUI

struct ChatHistoryOverlay: View {
    @EnvironmentObject private var chat: ChatStore
    @State private var interceptClose = false
    @State private var closeStart: CGFloat = 0
    @State private var closeEngaged = false
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
                    ChatHistoryPanel()
                        .frame(width: width)
                        .frame(height: height)
                        .epsGlassRounded(cornerRadius: 22, interactive: false)
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
                    interceptClose = true
                    panelMounted = true
                }
                if value <= 0 {
                    interceptClose = false
                    if !chat.historyDragging && !panelWarming {
                        panelMounted = false
                    }
                }
            }
            .onChange(of: chat.historyDragging) { _, dragging in
                if dragging { panelMounted = true }
            }
            .simultaneousGesture(closeDrag(travel: travel))
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
        if chat.historyDragging {
            return interceptClose || chat.historyReveal > 0.5
        }
        return chat.historyReveal > 0.5
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

    private func closeDrag(travel: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .local)
            .onChanged { value in
                let dx = value.translation.width
                let dy = value.translation.height
                if !closeEngaged {
                    guard dx < 0, abs(dx) > 8, abs(dx) > abs(dy) * 1.15 else { return }
                    closeEngaged = true
                    closeStart = chat.historyReveal
                    chat.historyDragging = true
                    panelMounted = true
                    hapticGate.reset()
                    EPSHaptics.swipeBegin()
                    hapticGate.handle(closeStart)
                }
                follow(start: closeStart, dx: dx, travel: travel)
                hapticGate.handle(min(max(chat.historyReveal, 0), 1))
            }
            .onEnded { value in
                guard closeEngaged else { return }
                closeEngaged = false
                commit(velocity: value.velocity.width)
            }
    }

    private func follow(start: CGFloat, dx: CGFloat, travel: CGFloat) {
        let raw = start + dx / max(travel, 1)
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            chat.historyReveal = Self.rubber(raw)
        }
    }

    private func commit(velocity vx: CGFloat) {
        chat.historyDragging = false
        let open: Bool
        if vx >= Self.commitVelocity, chat.historyReveal > 0.08 {
            open = true
        } else if vx <= -Self.commitVelocity, chat.historyReveal < 0.92 {
            open = false
        } else {
            open = Self.linear(chat.historyReveal) >= 0.5
        }
        chat.setHistoryOpen(open)
        if !open {
            panelMounted = chat.historyReveal > 0.01
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
    @State private var startReveal: CGFloat = 0
    @State private var engaged = false
    @State private var hapticGate = EPSHalfwayHapticGate(threshold: 0.5)

    func body(content: Content) -> some View {
        content.simultaneousGesture(openDrag)
    }

    private var blocksHistoryOpen: Bool {
        if dashboard.stackDepth > 0 { return true }
        let view = dashboard.uiContext.view.lowercased()
        return view == "class" || view == "note" || view == "todo"
    }

    private var openDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard !blocksHistoryOpen else { return }
                let dx = value.translation.width
                let dy = value.translation.height
                if !engaged {
                    guard dx > 8, abs(dx) > abs(dy) * 1.15 else { return }
                    engaged = true
                    startReveal = chat.historyReveal
                    chat.historyDragging = true
                    hapticGate.reset()
                    EPSHaptics.swipeBegin()
                    hapticGate.handle(startReveal)
                    Task { await chat.loadList() }
                }
                let travel = max(chat.historyPanelWidth, 1)
                let raw = startReveal + dx / travel
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    chat.historyReveal = ChatHistoryOverlay.rubber(raw)
                }
                hapticGate.handle(min(max(chat.historyReveal, 0), 1))
            }
            .onEnded { value in
                guard engaged else { return }
                engaged = false
                chat.historyDragging = false
                let vx = value.velocity.width
                let open: Bool
                if vx >= ChatHistoryOverlay.commitVelocity, chat.historyReveal > 0.08 {
                    open = true
                } else if vx <= -ChatHistoryOverlay.commitVelocity, chat.historyReveal < 0.92 {
                    open = false
                } else {
                    open = ChatHistoryOverlay.linear(chat.historyReveal) >= 0.5
                }
                chat.setHistoryOpen(open)
            }
    }
}

extension View {
    func chatHistoryOpenGesture() -> some View {
        modifier(ChatHistoryOpenModifier())
    }
}

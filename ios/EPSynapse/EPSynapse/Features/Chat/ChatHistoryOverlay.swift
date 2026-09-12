import SwiftUI

struct ChatHistoryOverlay: View {
    @EnvironmentObject private var chat: ChatStore
    @State private var interceptClose = false
    @State private var closeStart: CGFloat = 0
    @State private var closeEngaged = false

    var body: some View {
        GeometryReader { geo in
            let safe = AdaptiveLayout.windowSafeArea
            let leading = Self.panelLeading(safeLeading: safe.left)
            let top = Self.panelTop(safeTop: safe.top)
            let bottom = Self.panelBottom(safeBottom: safe.bottom)
            let width = Self.panelWidth(for: geo.size)
            let height = Self.panelHeight(for: geo.size, top: top, bottom: bottom)
            let travel = width + leading

            ZStack(alignment: .topLeading) {
                Color.black
                    .opacity(0.28 * max(0, min(1, chat.historyReveal)))
                    .ignoresSafeArea()
                    .onTapGesture {
                        chat.setHistoryOpen(false)
                    }

                ChatHistoryPanel()
                    .frame(width: width)
                    .frame(height: height)
                    .epsGlassRounded(cornerRadius: 22, interactive: false, clear: true)
                    .padding(.top, top)
                    .padding(.leading, leading)
                    .offset(x: (chat.historyReveal - 1) * travel)
            }
            .task(id: travel) {
                chat.historyPanelWidth = travel
            }
            .onChange(of: chat.historyReveal) { _, value in
                if value >= 1 { interceptClose = true }
                if value <= 0 { interceptClose = false }
            }
            .simultaneousGesture(closeDrag(travel: travel))
        }
        .ignoresSafeArea()
        .allowsHitTesting(chat.historyDragging && interceptClose || chat.historyReveal > 0.5)
    }

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

    private func closeDrag(travel: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .local)
            .onChanged { value in
                let dx = value.translation.width
                let dy = value.translation.height
                if !closeEngaged {
                    guard dx < 0, abs(dx) > abs(dy) * 1.15 else { return }
                    closeEngaged = true
                    closeStart = chat.historyReveal
                    chat.historyDragging = true
                    EPSHaptics.swipeBegin()
                }
                follow(start: closeStart, dx: dx, travel: travel)
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
        if vx >= 800 {
            open = true
        } else if vx <= -800 {
            open = false
        } else {
            open = Self.linear(chat.historyReveal) >= 0.5
        }
        chat.setHistoryOpen(open)
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
    @State private var startReveal: CGFloat = 0
    @State private var engaged = false

    func body(content: Content) -> some View {
        content.simultaneousGesture(openDrag)
    }

    private var openDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                let dx = value.translation.width
                let dy = value.translation.height
                if !engaged {
                    guard dx > 0, abs(dx) > abs(dy) * 1.15 else { return }
                    engaged = true
                    startReveal = chat.historyReveal
                    chat.historyDragging = true
                    EPSHaptics.swipeBegin()
                    Task { await chat.loadList() }
                }
                let travel = max(chat.historyPanelWidth, 1)
                let raw = startReveal + dx / travel
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    chat.historyReveal = ChatHistoryOverlay.rubber(raw)
                }
            }
            .onEnded { value in
                guard engaged else { return }
                engaged = false
                chat.historyDragging = false
                let vx = value.velocity.width
                let open: Bool
                if vx >= 800 {
                    open = true
                } else if vx <= -800 {
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

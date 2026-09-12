import SwiftUI
import UIKit

struct ChatOverlay: View {
    @EnvironmentObject private var session: SessionStore

    @State private var isOpen = false
    @State private var draft = ""
    @State private var turns: [ChatTurn] = []
    @State private var busy = false
    @State private var dragY: CGFloat = 0
    @State private var overlayFrame: CGRect = .zero
    @FocusState private var composerFocused: Bool

    private var showPanel: Bool { isOpen && !turns.isEmpty }
    private var pillSide: CGFloat { 56 }

    private var openWidth: CGFloat {
        AdaptiveLayout.isPad ? min(420, AdaptiveLayout.chatMaxWidth) : .infinity
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 10) {
            if showPanel {
                messagePanel
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            composer
        }
        .background {
            AgentFrameProbe { overlayFrame = $0 }
        }
        .offset(y: dragY)
        .background {
            if isOpen {
                AgentDismissBridge(
                    overlayFrame: overlayFrame,
                    onDrag: { next in
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) { dragY = next }
                    },
                    onEnd: finishDismissDrag
                )
                .frame(width: 0, height: 0)
                .allowsHitTesting(false)
            }
        }
        .onKeyPress(.escape) {
            if isOpen {
                minimize()
                return .handled
            }
            return .ignored
        }
        .animation(.spring(response: 0.38, dampingFraction: 0.86), value: isOpen)
        .animation(.spring(response: 0.38, dampingFraction: 0.86), value: showPanel)
        .frame(width: isOpen && AdaptiveLayout.isPad ? openWidth : nil)
        .frame(maxWidth: isOpen ? openWidth : pillSide, alignment: .bottomTrailing)
    }

    private var composer: some View {
        HStack(spacing: 8) {
            if isOpen {
                Button {
                    minimize()
                } label: {
                    minusGlyph
                        .foregroundStyle(EPSTheme.fg)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .epsSizedGlassCircle(side: 36)
                .accessibilityLabel("Hide chat")

                TextField("Ask your personal agent…", text: $draft, axis: .vertical)
                    .lineLimit(1 ... 4)
                    .font(.body)
                    .foregroundStyle(EPSTheme.fg)
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.send)
                    .focused($composerFocused)
                    .onSubmit { send() }

                Button {
                    send()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(Color.white)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .epsSizedGlassCircle(side: 36, tint: EPSTheme.accent)
                .accessibilityLabel("Send")
            } else {
                Button {
                    EPSHaptics.tap()
                    isOpen = true
                } label: {
                    Image(systemName: "ellipsis.bubble.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(EPSTheme.fg)
                        .frame(width: pillSide, height: pillSide)
                }
                .buttonStyle(.plain)
                .epsSizedGlassCircle(side: pillSide)
                .accessibilityLabel("Personal assistant")
            }
        }
        .padding(.horizontal, isOpen ? 10 : 0)
        .padding(.vertical, isOpen ? 8 : 0)
        .frame(minHeight: pillSide)
        .frame(maxWidth: isOpen ? .infinity : pillSide)
        .epsGlassCapsule(interactive: true)
    }

    private var messagePanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Spacer(minLength: 0)
                Button {
                    clearChat()
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .bold))
                        .rotationEffect(.degrees(45))
                        .foregroundStyle(EPSTheme.fg)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .epsSizedGlassCircle(side: 28)
                .accessibilityLabel("New chat")
            }
            .padding(.bottom, 8)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(turns) { turn in
                            chatBubble(turn)
                                .id(turn.id)
                        }
                    }
                    .padding(.bottom, 4)
                }
                .scrollDismissesKeyboard(.never)
                .onChange(of: turns.last?.content) { _, _ in
                    if let last = turns.last {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .frame(maxHeight: 360)
        .epsGlassRounded(cornerRadius: 22, interactive: true)
    }

    @ViewBuilder
    private func chatBubble(_ turn: ChatTurn) -> some View {
        let isUser = turn.role == "user"
        VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
            if !turn.thinking.isEmpty, !isUser {
                Text(turn.thinking)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .epsGlassRounded(cornerRadius: 16, interactive: false)
            }
            if !turn.content.isEmpty || isUser {
                Text(turn.content)
                    .font(.body)
                    .foregroundStyle(EPSTheme.fg)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .epsGlassRounded(
                        cornerRadius: 16,
                        tint: isUser ? EPSTheme.accent.opacity(0.18) : nil,
                        interactive: false
                    )
            }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .padding(isUser ? .leading : .trailing, 28)
    }

    private var minusGlyph: some View {
        Capsule()
            .frame(width: 13, height: 3)
    }

    private func finishDismissDrag(offset: CGFloat, velocity: CGFloat, travel: CGFloat) {
        let flick = velocity > 850
        let reverse = velocity < -420
        let far = offset > max(travel * 0.32, 72)
        if !reverse, flick || far {
            let extra = max(travel - offset, 90)
            let duration = flick
                ? min(0.28, max(0.12, extra / max(velocity, 900)))
                : 0.2
            withAnimation(.easeIn(duration: duration)) {
                dragY = offset + extra
            }
            AgentKeyboardScrub.finishOffscreen(from: offset, extra: extra, duration: duration) {
                minimize()
            }
        } else {
            AgentKeyboardScrub.snapBack()
            withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                dragY = 0
            }
        }
    }

    private func minimize() {
        composerFocused = false
        draft = ""
        isOpen = false
        dragY = 0
        AgentKeyboardScrub.commitHide()
    }

    private func clearChat() {
        turns = []
        busy = false
        draft = ""
        isOpen = true
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy else { return }
        draft = ""
        isOpen = true
        let user = ChatTurn(role: "user", content: text)
        let assistant = ChatTurn(role: "assistant", content: "", thinking: "Thinking…")
        turns.append(user)
        turns.append(assistant)
        busy = true
        EPSHaptics.tap()

        let history = turns.dropLast().map { ["role": $0.role, "content": $0.content] }
        let assistantId = assistant.id

        Task {
            do {
                try await APIClient.shared.streamChat(
                    provider: session.provider,
                    messages: Array(history),
                    sessionId: session.sessionId,
                    apiKey: session.modelKey
                ) { content, reasoning in
                    Task { @MainActor in
                        guard let index = turns.firstIndex(where: { $0.id == assistantId }) else { return }
                        if !reasoning.isEmpty {
                            if turns[index].thinking == "Thinking…" {
                                turns[index].thinking = reasoning
                            } else {
                                turns[index].thinking += reasoning
                            }
                        }
                        if !content.isEmpty {
                            turns[index].content += content
                        }
                    }
                }
                await MainActor.run {
                    finishAssistant(assistantId, fallback: "The model returned an empty reply.")
                }
            } catch {
                await MainActor.run {
                    if let index = turns.firstIndex(where: { $0.id == assistantId }) {
                        turns[index].thinking = ""
                        turns[index].content = (error as? APIError)?.message
                            ?? "Could not reach api.epsynapse.com."
                    }
                    busy = false
                }
            }
        }
    }

    private func finishAssistant(_ id: UUID, fallback: String) {
        if let index = turns.firstIndex(where: { $0.id == id }) {
            if turns[index].thinking == "Thinking…" {
                turns[index].thinking = ""
            }
            if turns[index].content.isEmpty {
                turns[index].content = fallback
            }
        }
        busy = false
    }
}

/// Reports the agent chrome in window coordinates, including keyboard lift.
private struct AgentFrameProbe: UIViewRepresentable {
    var onChange: (CGRect) -> Void

    func makeUIView(context: Context) -> AgentFrameProbeView {
        let view = AgentFrameProbeView()
        view.onChange = onChange
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: AgentFrameProbeView, context: Context) {
        view.onChange = onChange
        view.report()
    }
}

final class AgentFrameProbeView: UIView {
    var onChange: ((CGRect) -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        report()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        report()
    }

    func report() {
        guard window != nil, bounds.width > 1, bounds.height > 1 else { return }
        onChange?(convert(bounds, to: nil))
    }
}

/// Window pan so a downward page scroll can keep going into the agent bar.
/// Once the finger hits the bar, the bar and keyboard track 1:1. A flick closes.
private struct AgentDismissBridge: UIViewRepresentable {
    var overlayFrame: CGRect
    var onDrag: (CGFloat) -> Void
    var onEnd: (CGFloat, CGFloat, CGFloat) -> Void

    func makeUIView(context: Context) -> AgentDismissInstaller {
        let view = AgentDismissInstaller()
        view.onDrag = onDrag
        view.onEnd = onEnd
        view.overlayFrame = overlayFrame
        return view
    }

    func updateUIView(_ view: AgentDismissInstaller, context: Context) {
        view.onDrag = onDrag
        view.onEnd = onEnd
        view.overlayFrame = overlayFrame
        view.isEnabled = true
        AgentKeyboardScrub.prepare()
    }

    static func dismantleUIView(_ view: AgentDismissInstaller, coordinator: ()) {
        view.detach()
    }
}

final class AgentDismissInstaller: UIView, UIGestureRecognizerDelegate {
    var overlayFrame: CGRect = .zero
    var isEnabled = false
    var onDrag: ((CGFloat) -> Void)?
    var onEnd: ((CGFloat, CGFloat, CGFloat) -> Void)?

    private let pan = UIPanGestureRecognizer()
    private var engaged = false
    private var originY: CGFloat = 0
    private var offset: CGFloat = 0
    private weak var hostWindow: UIWindow?
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
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if hostView == nil { attach(to: window) }
    }

    func detach() {
        hostView?.removeGestureRecognizer(pan)
        hostView = nil
        hostWindow = nil
        AgentKeyboardScrub.cancel()
    }

    private func attach(to window: UIWindow?) {
        let target = window?.rootViewController?.view ?? window
        if hostView === target { return }
        hostView?.removeGestureRecognizer(pan)
        hostWindow = window
        hostView = target
        target?.addGestureRecognizer(pan)
    }

    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        guard isEnabled, let view = gesture.view else { return }
        if view.window?.rootViewController?.presentedViewController != nil { return }

        let location = gesture.location(in: nil)
        switch gesture.state {
        case .began, .changed:
            if !engaged {
                guard hitBar(location) else { return }
                engaged = true
                originY = location.y
                AgentKeyboardScrub.begin()
            }
            offset = max(0, location.y - originY)
            AgentKeyboardScrub.setOffset(offset)
            onDrag?(offset)
        case .ended, .cancelled, .failed:
            if engaged {
                let velocity = gesture.velocity(in: view).y
                let travel = max(overlayFrame.height + AgentKeyboardScrub.coverage, 160)
                onEnd?(offset, velocity, travel)
            }
            engaged = false
            offset = 0
        default:
            break
        }
    }

    private func hitBar(_ location: CGPoint) -> Bool {
        let bar = hitRect()
        guard bar.height > 8 else { return false }
        return location.y >= bar.minY && location.x >= bar.minX && location.x <= bar.maxX
    }

    /// Top of the input bar, which sits on the keyboard when the keys are up.
    private func hitRect() -> CGRect {
        let window = hostWindow ?? self.window
        var keyboard = AgentKeyboardScrub.keyboardFrame
        if let window, keyboard.height > 20 {
            keyboard = window.convert(keyboard, from: nil)
        }

        let barHeight = max(overlayFrame.height, 56)
        var minY = overlayFrame.minY
        var minX = overlayFrame.minX
        var width = overlayFrame.width

        if AgentKeyboardScrub.isKeyboardUp {
            let liftedTop = keyboard.minY - barHeight
            if minY < 8 || overlayFrame.height < 8 || minY > keyboard.minY - 8 {
                minY = liftedTop
            } else {
                minY = min(minY, liftedTop)
            }
        }

        if width < 8, let window {
            minX = 0
            width = window.bounds.width
        }

        return CGRect(x: minX - 36, y: minY, width: width + 72, height: 4000)
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard isEnabled, let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
        if window?.rootViewController?.presentedViewController != nil { return false }
        let velocity = pan.velocity(in: pan.view)
        let translation = pan.translation(in: pan.view)
        if hypot(velocity.x, velocity.y) > 8 {
            return velocity.y > abs(velocity.x) * 0.35
        }
        return translation.y > abs(translation.x) * 0.35
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }
}

enum AgentKeyboardScrub {
    private static weak var host: UIView?
    private(set) static var coverage: CGFloat = 0
    private static var lastKeyboardFrame: CGRect = .zero
    private static var observers: [NSObjectProtocol] = []

    static var keyboardFrame: CGRect { lastKeyboardFrame }

    static var isKeyboardUp: Bool {
        let frame = lastKeyboardFrame
        guard frame.height > 40 else { return false }
        let bottom = UIScreen.main.bounds.maxY
        return frame.minY < bottom - 20
    }

    static func prepare() {
        listenIfNeeded()
    }

    static func begin() {
        listenIfNeeded()
        if lastKeyboardFrame.height < 20 {
            lastKeyboardFrame = currentKeyboardFrame()
        }
        host = findHost(matching: lastKeyboardFrame)
        coverage = max(lastKeyboardFrame.height, host?.bounds.height ?? 0)
        if coverage < 20 { coverage = 0 }
    }

    static func setOffset(_ dy: CGFloat) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        host?.transform = CGAffineTransform(translationX: 0, y: max(0, dy))
        CATransaction.commit()
    }

    static func snapBack() {
        let view = host
        UIView.animate(
            withDuration: 0.32,
            delay: 0,
            usingSpringWithDamping: 0.86,
            initialSpringVelocity: 0.4,
            options: [.allowUserInteraction, .beginFromCurrentState]
        ) {
            view?.transform = .identity
        }
        host = nil
        coverage = 0
    }

    static func finishOffscreen(from dy: CGFloat, extra: CGFloat, duration: TimeInterval, then: @escaping () -> Void) {
        let view = host
        UIView.animate(
            withDuration: duration,
            delay: 0,
            options: [.curveEaseIn, .beginFromCurrentState]
        ) {
            view?.transform = CGAffineTransform(translationX: 0, y: dy + extra)
        } completion: { _ in
            commitHide()
            then()
        }
    }

    static func commitHide() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        UIView.setAnimationsEnabled(false)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        host?.transform = .identity
        UIView.setAnimationsEnabled(true)
        CATransaction.commit()
        host = nil
        coverage = 0
        lastKeyboardFrame = .zero
    }

    static func cancel() {
        host?.transform = .identity
        host = nil
        coverage = 0
    }

    private static func listenIfNeeded() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        let names = [
            UIResponder.keyboardWillShowNotification,
            UIResponder.keyboardDidShowNotification,
            UIResponder.keyboardWillChangeFrameNotification,
            UIResponder.keyboardDidChangeFrameNotification,
            UIResponder.keyboardWillHideNotification,
            UIResponder.keyboardDidHideNotification,
        ]
        for name in names {
            observers.append(
                center.addObserver(forName: name, object: nil, queue: .main) { note in
                    if name == UIResponder.keyboardWillHideNotification
                        || name == UIResponder.keyboardDidHideNotification {
                        lastKeyboardFrame = .zero
                        return
                    }
                    if let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
                        lastKeyboardFrame = frame
                    }
                }
            )
        }
    }

    private static func currentKeyboardFrame() -> CGRect {
        if lastKeyboardFrame.height > 20 { return lastKeyboardFrame }
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows where NSStringFromClass(type(of: window)).contains("Keyboard") {
                return window.convert(window.bounds, to: nil)
            }
        }
        return .zero
    }

    private static func findHost(matching keyboardScreenFrame: CGRect) -> UIView? {
        if let named = keyboardWindow() { return named }
        guard keyboardScreenFrame.height > 20 else { return keyboardWindow() }

        var best: UIView?
        var bestScore = CGFloat.greatestFiniteMagnitude

        func consider(_ view: UIView) {
            let frame = view.convert(view.bounds, to: nil)
            guard frame.height > 30, frame.height < keyboardScreenFrame.height * 1.8 else { return }
            let score = abs(frame.minY - keyboardScreenFrame.minY)
                + abs(frame.maxY - keyboardScreenFrame.maxY)
                + abs(frame.height - keyboardScreenFrame.height)
            guard score < bestScore else { return }
            bestScore = score
            best = view
        }

        func walk(_ view: UIView) {
            consider(view)
            for sub in view.subviews { walk(sub) }
        }

        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows { walk(window) }
        }
        if bestScore < 180 { return best }
        return keyboardWindow()
    }

    private static func keyboardWindow() -> UIWindow? {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                let name = NSStringFromClass(type(of: window))
                if name.contains("Keyboard") { return window }
            }
        }
        return nil
    }
}

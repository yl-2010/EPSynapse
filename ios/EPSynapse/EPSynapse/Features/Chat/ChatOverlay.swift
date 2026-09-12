import SwiftUI
import UIKit

struct ChatOverlay: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var chat: ChatStore
    @Environment(\.colorScheme) private var colorScheme

    @State private var isOpen = false
    @State private var draft = ""
    @State private var dragY: CGFloat = 0
    @State private var overlayFrame: CGRect = .zero
    @FocusState private var composerFocused: Bool

    private var showPanel: Bool { isOpen }
    private var pillSide: CGFloat { 56 }

    private var openWidth: CGFloat {
        AdaptiveLayout.isPad ? min(420, AdaptiveLayout.chatMaxWidth) : .infinity
    }

    private var panelMaxHeight: CGFloat {
        let screen = UIScreen.main.bounds.height
        if AdaptiveLayout.isPad { return min(440, screen * 0.45) }
        return min(300, max(200, screen * 0.34))
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
            AgentFrameProbe { next in
                if overlayFrame != next {
                    overlayFrame = next
                }
            }
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
                    onEnd: finishDismissDrag,
                    onScrubStart: { lift in
                        if lift > 0 { chat.keyboardScrubLift = lift }
                    }
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
        .onChange(of: chat.wantsChatOpen) { _, want in
            if want {
                isOpen = true
                composerFocused = true
                Task { @MainActor in
                    chat.wantsChatOpen = false
                }
            }
        }
        .onChange(of: isOpen) { _, open in
            Task { @MainActor in
                chat.composerOpen = open
            }
        }
        .task {
            chat.composerOpen = isOpen
        }
        .onDisappear {
            chat.composerOpen = false
            chat.keyboardScrubLift = 0
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            if chat.keyboardScrubLift > 0 {
                chat.keyboardScrubLift = 0
            }
        }
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
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background {
                        KeyboardAccessoryInstaller()
                    }
                    .epsGlassField(interactive: false, cornerRadius: 18)
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
                .disabled(chat.busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .epsSizedGlassCircle(side: 36, tint: EPSTheme.accent)
                .accessibilityLabel("Send")
            } else {
                Button {
                    EPSHaptics.tap()
                    isOpen = true
                    composerFocused = true
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
        .fixedSize(horizontal: false, vertical: true)
        .epsGlassRounded(cornerRadius: isOpen ? 28 : pillSide / 2, interactive: !isOpen)
    }

    private var messagePanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Spacer(minLength: 0)
                Button {
                    clearChat()
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 14, weight: .bold))
                        .rotationEffect(.degrees(45))
                        .foregroundStyle(EPSTheme.fg)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .epsSizedGlassCircle(side: 36)
                .accessibilityLabel("New chat")
            }
            .padding(.bottom, 8)

            if chat.turns.isEmpty {
                Text("Ask about classes, Canvas, or your day.")
                    .font(.body)
                    .foregroundStyle(EPSTheme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(chat.turns) { turn in
                                chatBubble(turn)
                                    .id(turn.id)
                            }
                        }
                        .padding(.bottom, 4)
                    }
                    .scrollDismissesKeyboard(.never)
                    .onAppear { scrollToLatest(proxy) }
                    .onChange(of: chat.turns.count) { _, _ in
                        scrollToLatest(proxy)
                    }
                    .onChange(of: chat.turns.last?.content) { _, _ in
                        scrollToLatest(proxy)
                    }
                    .onChange(of: chat.turns.last?.thinking) { _, _ in
                        scrollToLatest(proxy)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .frame(maxHeight: panelMaxHeight)
        .epsGlassRounded(cornerRadius: 22, interactive: true)
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        guard let last = chat.turns.last else { return }
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(last.id, anchor: .bottom)
        }
    }

    @ViewBuilder
    private func chatBubble(_ turn: ChatTurn) -> some View {
        let isUser = turn.role == "user"
        HStack(alignment: .top, spacing: 0) {
            if isUser { Spacer(minLength: 36) }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                if !turn.thinking.isEmpty, !isUser {
                    Text(turn.thinking)
                        .font(.body)
                        .foregroundStyle(EPSTheme.muted)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .epsGlassRounded(cornerRadius: 16, interactive: false)
                        .accessibilityLabel("Thinking")
                }
                if !turn.content.isEmpty {
                    Group {
                        if isUser {
                            Text(turn.content)
                                .font(.body)
                                .foregroundStyle(EPSTheme.fg)
                                .multilineTextAlignment(.leading)
                        } else {
                            EPSMarkdownText(source: turn.content, scheme: colorScheme)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .epsGlassRounded(
                        cornerRadius: 16,
                        tint: isUser ? EPSTheme.accent.opacity(0.18) : nil,
                        interactive: false
                    )
                }
            }
            if !isUser { Spacer(minLength: 36) }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
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
            let refocus = chat.keyboardScrubLift > 0
            AgentKeyboardScrub.snapBack()
            withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                dragY = 0
            }
            if refocus {
                composerFocused = true
            }
        }
    }

    private func minimize() {
        composerFocused = false
        isOpen = false
        dragY = 0
        chat.keyboardScrubLift = 0
        AgentKeyboardScrub.commitHide()
    }

    private func clearChat() {
        chat.newChat()
        draft = ""
        isOpen = true
    }

    private func send() {
        guard session.isSignedIn else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !chat.busy else { return }
        draft = ""
        isOpen = true
        let user = ChatTurn(role: "user", content: text)
        let assistant = ChatTurn(role: "assistant", content: "", thinking: "Thinking…")
        chat.turns.append(user)
        chat.turns.append(assistant)
        chat.busy = true
        EPSHaptics.tap()

        let history = chat.turns.dropLast().map { ["role": $0.role, "content": $0.content] }
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
                        chat.mutateTurn(id: assistantId) { turn in
                            if !reasoning.isEmpty {
                                if turn.thinking == "Thinking…" {
                                    turn.thinking = reasoning
                                } else {
                                    turn.thinking += reasoning
                                }
                            }
                            if !content.isEmpty {
                                turn.content += content
                            }
                        }
                    }
                }
                await MainActor.run {
                    finishAssistant(assistantId, fallback: "The model returned an empty reply.")
                }
                await chat.persistCurrent()
            } catch {
                await MainActor.run {
                    chat.mutateTurn(id: assistantId) { turn in
                        turn.thinking = ""
                        turn.content = (error as? APIError)?.message
                            ?? "Could not reach api.epsynapse.com."
                    }
                    chat.busy = false
                }
                await chat.persistCurrent()
            }
        }
    }

    private func finishAssistant(_ id: UUID, fallback: String) {
        chat.mutateTurn(id: id) { turn in
            if turn.thinking == "Thinking…" {
                turn.thinking = ""
            }
            if turn.content.isEmpty {
                let thought = turn.thinking.trimmingCharacters(in: .whitespacesAndNewlines)
                if !thought.isEmpty {
                    turn.content = thought
                    turn.thinking = ""
                } else {
                    turn.content = fallback
                }
            }
        }
        chat.busy = false
    }
}

/// Lives on the composer as `inputAccessoryView` so we can walk up into the
/// real keyboard host and drag the keys with the bar.
final class KeyboardAnchorView: UIView {
    static let shared = KeyboardAnchorView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: 1)
    }

    var keyboardHost: UIView? {
        var view: UIView? = superview ?? window
        var fallback: UIView?
        while let current = view {
            let name = NSStringFromClass(type(of: current))
            if AgentKeyboardScrub.isKeyboardHostName(name) {
                if name.contains("UIKeyboardItemContainer")
                    || name.contains("UIInputSetHost")
                    || name.contains("UIInputSetContainer")
                    || name.contains("UITrackingWindow")
                    || (current is UIWindow && AgentKeyboardScrub.isKeyboardChrome(current as! UIWindow)) {
                    return current
                }
                fallback = current
            }
            view = current.superview
        }
        if let window, AgentKeyboardScrub.isKeyboardChrome(window) {
            return window
        }
        return fallback
    }
}

/// Finds the SwiftUI field and hangs the keyboard hook on it.
private struct KeyboardAccessoryInstaller: UIViewRepresentable {
    func makeUIView(context: Context) -> KeyboardAccessoryInstallerView {
        KeyboardAccessoryInstallerView()
    }

    func updateUIView(_ view: KeyboardAccessoryInstallerView, context: Context) {
        view.attach()
    }
}

final class KeyboardAccessoryInstallerView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        attach()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        attach()
    }

    func attach() {
        if let field = findTextField(from: superview) ?? findTextField(from: window) {
            if field.inputAccessoryView !== KeyboardAnchorView.shared {
                field.inputAccessoryView = KeyboardAnchorView.shared
                if field.isFirstResponder {
                    field.reloadInputViews()
                }
            }
            return
        }
        if let view = findTextView(from: superview) ?? findTextView(from: window) {
            if view.inputAccessoryView !== KeyboardAnchorView.shared {
                view.inputAccessoryView = KeyboardAnchorView.shared
                if view.isFirstResponder {
                    view.reloadInputViews()
                }
            }
        }
    }

    private func findTextField(from root: UIView?) -> UITextField? {
        guard let root else { return nil }
        if let field = root as? UITextField { return field }
        for sub in root.subviews {
            if let found = findTextField(from: sub) { return found }
        }
        return nil
    }

    private func findTextView(from root: UIView?) -> UITextView? {
        guard let root else { return nil }
        if let view = root as? UITextView { return view }
        for sub in root.subviews {
            if let found = findTextView(from: sub) { return found }
        }
        return nil
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
        let rect = convert(bounds, to: nil)
        DispatchQueue.main.async { [onChange] in
            onChange?(rect)
        }
    }
}

/// Window pan so a downward page scroll can keep going into the agent bar.
/// Once the finger hits the bar, the bar and keyboard track 1:1. A flick closes.
private struct AgentDismissBridge: UIViewRepresentable {
    var overlayFrame: CGRect
    var onDrag: (CGFloat) -> Void
    var onEnd: (CGFloat, CGFloat, CGFloat) -> Void
    var onScrubStart: (CGFloat) -> Void

    func makeUIView(context: Context) -> AgentDismissInstaller {
        let view = AgentDismissInstaller()
        view.onDrag = onDrag
        view.onEnd = onEnd
        view.onScrubStart = onScrubStart
        view.overlayFrame = overlayFrame
        return view
    }

    func updateUIView(_ view: AgentDismissInstaller, context: Context) {
        view.onDrag = onDrag
        view.onEnd = onEnd
        view.onScrubStart = onScrubStart
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
    var onScrubStart: ((CGFloat) -> Void)?

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
                onScrubStart?(AgentKeyboardScrub.frozenLift)
                DispatchQueue.main.async {
                    AgentKeyboardScrub.dropRealKeyboard()
                }
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

        let barHeight: CGFloat = 72
        var minX = overlayFrame.minX
        var width = overlayFrame.width
        var minY = overlayFrame.maxY - barHeight

        if overlayFrame.height < 8 {
            minY = overlayFrame.minY
        }

        if AgentKeyboardScrub.isKeyboardUp {
            let liftedTop = keyboard.minY - barHeight
            if overlayFrame.height < 8 || overlayFrame.maxY < keyboard.minY - 40 {
                minY = liftedTop
            }
        }

        if width < 8, let window {
            minX = 0
            width = window.bounds.width
        }

        return CGRect(x: minX - 36, y: minY - 8, width: width + 72, height: barHeight + 28)
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
    private static var hosts: [UIView] = []
    private(set) static var coverage: CGFloat = 0
    private(set) static var frozenLift: CGFloat = 0
    private static var lastKeyboardFrame: CGRect = .zero
    private static var observers: [NSObjectProtocol] = []
    private static var displayLink: CADisplayLink?
    private static var currentOffset: CGFloat = 0
    private static var puppet: UIView?
    private static var hidden: [(UIView, CGFloat)] = []

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
        currentOffset = 0
        frozenLift = 0
        resolveHosts()
        coverage = max(lastKeyboardFrame.height, hosts.first?.bounds.height ?? 0)
        if coverage < 20 { coverage = lastKeyboardFrame.height }
        if coverage < 20 { coverage = 0 }
        pinPuppet()
        hideHostViews()
        frozenLift = coverage
        startDisplayLink()
    }

    static func dropRealKeyboard() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        UIView.setAnimationsEnabled(false)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        UIView.setAnimationsEnabled(true)
        CATransaction.commit()
    }

    static func setOffset(_ dy: CGFloat) {
        currentOffset = max(0, dy)
        applyOffset()
    }

    static func snapBack() {
        stopDisplayLink()
        restoreHidden()
        resetHostTransforms()
        let slide = puppet
        currentOffset = 0
        UIView.animate(
            withDuration: 0.32,
            delay: 0,
            usingSpringWithDamping: 0.86,
            initialSpringVelocity: 0.4,
            options: [.allowUserInteraction, .beginFromCurrentState]
        ) {
            slide?.transform = .identity
        } completion: { _ in
            slide?.removeFromSuperview()
            if puppet === slide { puppet = nil }
        }
        hosts = []
        coverage = 0
    }

    static func finishOffscreen(from dy: CGFloat, extra: CGFloat, duration: TimeInterval, then: @escaping () -> Void) {
        stopDisplayLink()
        let views = hosts
        let slide = puppet
        currentOffset = dy + extra
        UIView.animate(
            withDuration: duration,
            delay: 0,
            options: [.curveEaseIn, .beginFromCurrentState]
        ) {
            let ty = dy + extra
            let transform = CGAffineTransform(translationX: 0, y: ty)
            slide?.transform = transform
            for view in views {
                view.transform = transform
            }
        } completion: { _ in
            commitHide()
            then()
        }
    }

    static func commitHide() {
        stopDisplayLink()
        currentOffset = 0
        frozenLift = 0
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        UIView.setAnimationsEnabled(false)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        restoreHidden()
        resetHostTransforms()
        puppet?.removeFromSuperview()
        puppet = nil
        UIView.setAnimationsEnabled(true)
        CATransaction.commit()
        hosts = []
        coverage = 0
        lastKeyboardFrame = .zero
    }

    static func cancel() {
        stopDisplayLink()
        currentOffset = 0
        frozenLift = 0
        restoreHidden()
        resetHostTransforms()
        puppet?.removeFromSuperview()
        puppet = nil
        hosts = []
        coverage = 0
    }

    static func isKeyboardHostName(_ name: String) -> Bool {
        name.contains("UIKeyboardItemContainer")
            || name.contains("UIKeyboardItem")
            || name.contains("UITrackingWindowView")
            || name.contains("UIInputSetHost")
            || name.contains("UIInputSetContainer")
            || name.contains("UIRemoteKeyboard")
            || name.contains("UIKeyboard")
            || name.contains("InputSetHost")
            || name.contains("InputSetContainer")
    }

    static func isKeyboardChrome(_ window: UIWindow) -> Bool {
        let name = NSStringFromClass(type(of: window))
        return name.contains("Keyboard")
            || name.contains("TextEffects")
            || name.contains("RemoteKeyboard")
            || name.contains("InputSet")
            || name.contains("UIEditingOverlay")
            || name.contains("UITracking")
    }

    private static func applyOffset() {
        if puppet == nil, hosts.isEmpty { resolveHosts() }
        let transform = CGAffineTransform(translationX: 0, y: currentOffset)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        puppet?.transform = transform
        for host in hosts {
            host.transform = transform
        }
        CATransaction.commit()
    }

    private static func pinPuppet() {
        puppet?.removeFromSuperview()
        puppet = makePuppet()
    }

    private static func hideHostViews() {
        restoreHidden()
        func hide(_ view: UIView) {
            if hidden.contains(where: { $0.0 === view }) { return }
            hidden.append((view, view.alpha))
            view.alpha = 0
        }
        for host in hosts {
            hide(host)
        }
        for window in keyboardWindows() {
            hide(window)
        }
    }

    private static func restoreHidden() {
        for (view, alpha) in hidden {
            view.alpha = alpha
        }
        hidden = []
    }

    private static func makePuppet() -> UIView? {
        guard let key = keyWindow() else { return nil }
        var kbFrame = lastKeyboardFrame
        if kbFrame.height < 20 {
            kbFrame = currentKeyboardFrame()
            lastKeyboardFrame = kbFrame
        }
        guard kbFrame.height > 20 else { return nil }

        let box = UIView(frame: key.convert(kbFrame, from: nil))
        box.isUserInteractionEnabled = false
        box.clipsToBounds = true
        box.isOpaque = false

        var placed = false
        let overlapping = allWindows()
            .filter { window in
                window.alpha > 0.01
                    && !window.isHidden
                    && window.convert(window.bounds, to: nil).intersects(kbFrame)
            }
            .sorted { $0.windowLevel.rawValue < $1.windowLevel.rawValue }

        for window in overlapping {
            let local = window.convert(kbFrame, from: nil).intersection(window.bounds)
            guard local.width > 8, local.height > 8 else { continue }
            if let snap = window.resizableSnapshotView(
                from: local,
                afterScreenUpdates: false,
                withCapInsets: .zero
            ) {
                snap.frame = box.bounds
                box.addSubview(snap)
                placed = true
            }
        }

        for host in hosts {
            guard host.bounds.width > 20, host.bounds.height > 40 else { continue }
            guard let snap = host.snapshotView(afterScreenUpdates: false) else { continue }
            snap.frame = box.convert(host.convert(host.bounds, to: nil), from: nil)
            box.addSubview(snap)
            placed = true
        }

        if !placed, let image = captureKeyboardImage(frame: kbFrame) {
            let imageView = UIImageView(image: image)
            imageView.frame = box.bounds
            imageView.contentMode = .scaleToFill
            box.addSubview(imageView)
            placed = true
        }

        if !placed {
            let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
            blur.frame = box.bounds
            blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            box.addSubview(blur)
        }

        key.addSubview(box)
        return box
    }

    private static func captureKeyboardImage(frame: CGRect) -> UIImage? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = UIScreen.main.scale
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: frame.size, format: format)
        let image = renderer.image { ctx in
            for window in allWindows() where window.alpha > 0.01 && !window.isHidden {
                let winFrame = window.convert(window.bounds, to: nil)
                guard winFrame.intersects(frame) else { continue }
                ctx.cgContext.saveGState()
                ctx.cgContext.translateBy(x: winFrame.minX - frame.minX, y: winFrame.minY - frame.minY)
                window.drawHierarchy(in: CGRect(origin: .zero, size: winFrame.size), afterScreenUpdates: false)
                ctx.cgContext.restoreGState()
            }
        }
        return image.size.width > 1 ? image : nil
    }

    private static func keyboardWindows() -> [UIWindow] {
        let key = keyWindow()
        return allWindows().filter { window in
            if window === key { return false }
            if isKeyboardChrome(window) { return true }
            if window === KeyboardAnchorView.shared.window { return true }
            return containsKeyboardView(window)
        }
    }

    private static func containsKeyboardView(_ root: UIView) -> Bool {
        let name = NSStringFromClass(type(of: root))
        if isKeyboardHostName(name) { return true }
        for sub in root.subviews {
            if containsKeyboardView(sub) { return true }
        }
        return false
    }

    private static func startDisplayLink() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: DisplayLinkProxy.shared, selector: #selector(DisplayLinkProxy.tick))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private static func stopDisplayLink() {
        displayLink?.invalidate()
        displayLink = nil
    }

    fileprivate static func tickDisplayLink() {
        guard displayLink != nil, currentOffset > 0 else { return }
        applyOffset()
    }

    private static func resetHostTransforms() {
        for host in hosts {
            host.transform = .identity
        }
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
        for window in allWindows() where isKeyboardChrome(window) {
            return window.convert(window.bounds, to: nil)
        }
        return .zero
    }

    private static func resolveHosts() {
        var candidates: [UIView] = []
        func append(_ view: UIView?) {
            guard let view, isSafeHost(view) else { return }
            if candidates.contains(where: { $0 === view }) { return }
            candidates.append(view)
        }

        append(KeyboardAnchorView.shared.keyboardHost)
        for window in allWindows() {
            collectKeyboardViews(in: window, into: &candidates)
        }
        if candidates.isEmpty {
            append(frameMatchedHost())
            append(overlappingKeyboardWindow())
        }

        hosts = pickHosts(candidates)
        if coverage < 20 {
            coverage = max(lastKeyboardFrame.height, hosts.first?.bounds.height ?? 0)
            if coverage < 20 { coverage = 0 }
        }
    }

    private static func collectKeyboardViews(in root: UIView, into candidates: inout [UIView]) {
        let name = NSStringFromClass(type(of: root))
        let isItem = name.contains("UIKeyboardItem") && !name.contains("Container")
        if !isItem, isKeyboardHostName(name), root.bounds.height > 30, isSafeHost(root) {
            if !candidates.contains(where: { $0 === root }) {
                candidates.append(root)
            }
        }
        for sub in root.subviews {
            collectKeyboardViews(in: sub, into: &candidates)
        }
    }

    private static func pickHosts(_ views: [UIView]) -> [UIView] {
        let target = lastKeyboardFrame
        let ranked = views.sorted { lhs, rhs in
            hostScore(lhs, target: target) < hostScore(rhs, target: target)
        }
        var picked: [UIView] = []
        for view in ranked {
            if picked.contains(where: { $0 === view || view.isDescendant(of: $0) || $0.isDescendant(of: view) }) {
                continue
            }
            picked.append(view)
        }
        return picked
    }

    private static func hostScore(_ view: UIView, target: CGRect) -> CGFloat {
        let name = NSStringFromClass(type(of: view))
        var bonus: CGFloat = 0
        if name.contains("UIKeyboardItemContainer") { bonus -= 80 }
        else if name.contains("UIInputSetHost") { bonus -= 40 }
        else if name.contains("UITrackingWindow") { bonus -= 20 }
        else if name.contains("UIKeyboardItem") { bonus += 120 }
        guard target.height > 20 else { return view.bounds.height > 30 ? bonus : 400 }
        let frame = view.convert(view.bounds, to: nil)
        return abs(frame.minY - target.minY)
            + abs(frame.height - target.height)
            + bonus
    }

    private static func isSafeHost(_ view: UIView) -> Bool {
        if let window = view as? UIWindow, window === keyWindow() {
            return false
        }
        if let key = keyWindow() {
            if view === key.rootViewController?.view { return false }
            if view === key { return false }
        }
        return true
    }

    private static func frameMatchedHost() -> UIView? {
        let target = lastKeyboardFrame
        guard target.height > 20 else { return nil }

        var best: UIView?
        var bestScore = CGFloat.greatestFiniteMagnitude
        let key = keyWindow()

        func consider(_ view: UIView) {
            guard isSafeHost(view) else { return }
            let name = NSStringFromClass(type(of: view))
            if let key, view.isDescendant(of: key), !isKeyboardHostName(name) { return }
            let frame = view.convert(view.bounds, to: nil)
            guard frame.height > 30, frame.height < target.height * 1.9 else { return }
            let score = abs(frame.minY - target.minY)
                + abs(frame.maxY - target.maxY)
                + abs(frame.height - target.height)
            guard score < bestScore else { return }
            bestScore = score
            best = view
        }

        func walk(_ view: UIView) {
            consider(view)
            for sub in view.subviews { walk(sub) }
        }

        for window in allWindows() {
            walk(window)
        }
        return bestScore < 220 ? best : nil
    }

    private static func overlappingKeyboardWindow() -> UIWindow? {
        let target = lastKeyboardFrame
        guard target.height > 20 else { return nil }
        let key = keyWindow()
        for window in allWindows() {
            if window === key || window.isHidden || window.alpha < 0.01 { continue }
            let frame = window.convert(window.bounds, to: nil)
            if frame.intersection(target).height > target.height * 0.45 {
                return window
            }
        }
        return nil
    }

    private static func allWindows() -> [UIWindow] {
        var seen = Set<ObjectIdentifier>()
        var windows: [UIWindow] = []
        func add(_ window: UIWindow?) {
            guard let window else { return }
            let id = ObjectIdentifier(window)
            guard !seen.contains(id) else { return }
            seen.insert(id)
            windows.append(window)
        }
        for session in UIApplication.shared.openSessions {
            addWindows(from: session.scene as? UIWindowScene, into: &windows, seen: &seen)
        }
        for scene in UIApplication.shared.connectedScenes {
            addWindows(from: scene as? UIWindowScene, into: &windows, seen: &seen)
        }
        for window in UIApplication.shared.windows {
            add(window)
        }
        if let anchorWindow = KeyboardAnchorView.shared.window {
            add(anchorWindow)
        }
        return windows
    }

    private static func addWindows(
        from scene: UIWindowScene?,
        into windows: inout [UIWindow],
        seen: inout Set<ObjectIdentifier>
    ) {
        guard let scene else { return }
        for window in scene.windows {
            let id = ObjectIdentifier(window)
            guard !seen.contains(id) else { continue }
            seen.insert(id)
            windows.append(window)
        }
    }

    private static func keyWindow() -> UIWindow? {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            if let key = windowScene.keyWindow { return key }
        }
        return nil
    }
}

private final class DisplayLinkProxy: NSObject {
    static let shared = DisplayLinkProxy()

    @objc func tick() {
        AgentKeyboardScrub.tickDisplayLink()
    }
}

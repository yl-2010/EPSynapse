import SwiftUI
import UIKit

/// iMessage iOS 26 composer metrics, measured off a Messages screenshot
/// (393pt-wide iPhone, 1.201 px/pt).
private enum IMessageComposer {
    /// Plus circle and single-line field share this height (measured 43px ≈ 36pt).
    static let height: CGFloat = 36
    /// In-field send: wider-than-tall capsule with continuous corners
    /// (measured 40×30px ≈ 34×26pt) — not a circle, square, or plain oval.
    static let sendWidth: CGFloat = 34
    static let sendHeight: CGFloat = 26
    /// Equal inset from the field’s top / bottom / trailing (measured ~6.5px ≈ 5pt).
    static let sendInset: CGFloat = 5
    /// Gap between plus and field at rest (measured 12px ≈ 10pt).
    static let spacing: CGFloat = 10
    /// Screen-edge inset.
    static let horizontalPadding: CGFloat = 16
    /// Single-line field is a capsule (radius = height / 2). Fixed radius keeps
    /// side padding stable when the field grows multi-line.
    static let fieldRadius: CGFloat = 18
    static let fieldLeading: CGFloat = 16
    /// Glass merge threshold — must stay BELOW the rest gap (`spacing`) or the
    /// shapes bleed together at rest. Finger-drag warp closes the distance,
    /// crossing this threshold and melting them (Messages behavior).
    static let meltSpacing: CGFloat = 6
}

struct ChatView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var dashboard: DashboardStore
    @EnvironmentObject private var nav: AppNavigationStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.epsKeyboardReservedBottom) private var keyboardReservedBottom
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft = ""
    @State private var composerFocused = false
    /// Live height of the glass field — the vertical-axis TextField's real
    /// single-line height can drift a point above the nominal 36, which made
    /// the bottom-anchored send capsule sit visibly low.
    @State private var composerFieldHeight: CGFloat = IMessageComposer.height
    /// Glass field in window space, snapshotted on send as the flight origin.
    @State private var composerFieldGlobalFrame: CGRect = .zero
    @State private var pendingSendFlights: [ChatSendFlightPending] = []
    @State private var sendFlight: ChatSendFlightState?
    @State private var sendFlightGeneration = 0
    /// Long-press Copy pill target — message stays put (no context-menu lift).
    @State private var copyMenuMessageID: UUID?
    /// 0 = closed, 1 = open. Tracks the finger while dragging.
    @State private var historyReveal: CGFloat = 0
    @State private var historyDragging = false
    /// True from latch through the settle spring when this open swipe also hides the keyboard.
    @State private var historyScrubbingKeyboard = false
    @State private var historyDragOrigin: CGFloat = 0
    @State private var historyMeasuredWidth: CGFloat = 280
    @State private var historyChromeTop: CGFloat = 0
    @State private var historyHapticGate = EPSHalfwayHapticGate()
    @State private var historySwipeBlocks = ChatHistorySwipeBlocks()
    /// Stays true until the close slide finishes so SwiftUI does not fade the
    /// panel out (default `if` removal) while it is still on screen.
    @State private var historyPanelMounted = false
    /// One-shot off-screen mount at idle so the first swipe does not pay the
    /// panel's first-time view construction / Liquid Glass setup mid-gesture.
    @State private var historyPanelWarming = false
    @State private var didWarmHistoryPanel = false
    @State private var chatRowsMemo = ChatRowsMemo()
    /// Vertical inset so body text + padding lands on iMessage’s 36pt single-line height.
    @State private var composerFieldVerticalPadding = ChatView.composerFieldVerticalPaddingValue()
    @State private var sendHoldArmed = false
    @State private var streamTask: Task<Void, Never>?

    private static let historySwipeVelocityCommit: CGFloat = 520
    private static let historySwipeSpring = Animation.spring(response: 0.42, dampingFraction: 0.86)
    private static let historyHideExtra: CGFloat = 64
    /// Past the last bubble + composer clearance so `scrollTo` can hit true bottom.
    private static let chatScrollEndID = "chat-scroll-end"

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(
            horizontalSizeClass: horizontalSizeClass,
            verticalSizeClass: verticalSizeClass
        )
    }

    private var chatPagePadding: CGFloat {
        isWide ? 24 : 16
    }

    private var messages: [ChatTurn] {
        chat.turns
    }

    private var isBusy: Bool {
        chat.busy
    }

    private var hasChatKey: Bool {
        session.profile?.modelKeySet == true || !session.modelKey.isEmpty
    }

    /// iMessage shows the send button only when there is content to send;
    /// `canSend` separately gates whether tapping it works (busy / no key).
    private var composerHasContent: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSend: Bool {
        composerHasContent
    }

    private var workingLabel: String {
        if let last = messages.last, last.role == "assistant" {
            let thought = last.thinking.trimmingCharacters(in: .whitespacesAndNewlines)
            if !thought.isEmpty, thought != "Thinking…" {
                return thought
            }
        }
        return "Working"
    }

    private static func composerFieldVerticalPaddingValue() -> CGFloat {
        let line = UIFont.preferredFont(forTextStyle: .body).lineHeight
        return max(0, (IMessageComposer.height - line) / 2)
    }

    /// While the field is one line tall, center the send capsule on the
    /// field’s *measured* height (bottom-anchoring on a fixed inset left it
    /// ~1pt low whenever the TextField ran taller than nominal). Once the
    /// field grows multi-line, fall back to iMessage’s fixed bottom anchor.
    private var composerSendBottomInset: CGFloat {
        let singleLineCutoff = IMessageComposer.height + 12
        guard composerFieldHeight < singleLineCutoff else {
            return IMessageComposer.sendInset
        }
        return max(0, (composerFieldHeight - IMessageComposer.sendHeight) / 2)
    }

    /// Message list rows with Working covering the empty in-flight assistant.
    private var chatRows: [ChatRow] {
        chatRowsMemo.rows(
            messages: messages,
            isBusy: isBusy,
            workingLabel: workingLabel
        )
    }

    /// Opening user bubble sits under the nav chrome, so Copy must drop below.
    private var firstUserMessageID: UUID? {
        messages.first(where: { $0.role == "user" })?.id
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if messages.isEmpty {
                                ChatEmptyState(colorScheme: colorScheme)
                                    .equatable()
                            }
                            ForEach(chatRows) { row in
                                switch row {
                                case .message(let msg):
                                    chatBubbleRow(
                                        msg: msg,
                                        flying: sendFlight?.messageID == msg.id
                                    )
                                    .id(msg.id)
                                    // Later LazyVStack rows paint on top; lift the open Copy row
                                    // so the pill is not covered by the next bubble.
                                    .zIndex(copyMenuMessageID == msg.id ? 10 : 0)
                                case .working(let label):
                                    ChatWorkingBubble(
                                        label: label,
                                        isWide: isWide,
                                        colorScheme: colorScheme
                                    )
                                    .equatable()
                                    .id("working-indicator")
                                }
                            }
                        }
                        .padding(.horizontal, chatPagePadding)
                        .padding(.top, isWide ? 24 : 16)
                        // Extra bottom clearance so the last bubble can scroll fully
                        // above the floating composer (safeAreaPadding alone is tight).
                        .padding(.bottom, isWide ? 72 : 64)
                        .adaptiveReadableWidth(AdaptiveLayout.chatMaxWidth)
                        .animation(.spring(response: 0.38, dampingFraction: 0.86), value: isBusy)
                        .animation(.spring(response: 0.38, dampingFraction: 0.86), value: workingLabel)

                        Color.clear
                            .frame(height: 1)
                            .id(Self.chatScrollEndID)
                            .accessibilityHidden(true)
                    }
                }
                .scrollClipDisabled()
                .scrollDismissesKeyboard(
                    (historyDragging || historyScrubbingKeyboard) ? .never : .interactively
                )
                // Blocks are tracked per view via `onGeometryChange` into a plain
                // class (no preference tree, no SwiftUI invalidation) so scrolling
                // does not recompute a bound preference on every frame.
                .environment(\.chatHistorySwipeBlocks, historySwipeBlocks)
                .simultaneousGesture(historyOpenDragGesture)
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.frame(in: .global).minY
                } action: { y in
                    guard abs(y - historyChromeTop) > 0.5 else { return }
                    historyChromeTop = y
                }
                .onChange(of: messages.count) { _, _ in
                    dismissCopyMenu()
                    bindSendFlightIfNeeded()
                    if let id = sendFlight?.messageID,
                       !messages.contains(where: { $0.id == id })
                    {
                        finishSendFlight()
                    }
                    scrollChatToEnd(proxy: proxy)
                }
                .onChange(of: isBusy) { wasBusy, busy in
                    scrollChatToEnd(proxy: proxy)
                    guard wasBusy, !busy else { return }
                    guard historyReveal < 0.5 else { return }
                    guard let sid = chat.currentSessionId else { return }
                    Task { await chat.markRead(sid) }
                }
                .onChange(of: chat.turns.last?.content) { _, _ in
                    scrollChatToEnd(proxy: proxy)
                }
                .onChange(of: chat.turns.last?.thinking) { _, _ in
                    scrollChatToEnd(proxy: proxy)
                }
                .onChange(of: nav.tabReselectGeneration) { _, _ in
                    handleChatTabReselect(proxy: proxy)
                }
                .onScrollPhaseChange { _, newPhase in
                    if newPhase != .idle { dismissCopyMenu() }
                }
            }
            .epsPageBackground()
            .epsBusyHaptics(isBusy)
            .navigationTitle("Personal Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    newChatButton
                }
            }
            .onChange(of: dynamicTypeSize) { _, _ in
                composerFieldVerticalPadding = Self.composerFieldVerticalPaddingValue()
            }
            .onChange(of: composerFocused) { _, focused in
                if focused { closeChatHistory() }
            }
        }
        .epsKeyboardAccessory {
            EPSHostedFocus(isFocused: $composerFocused) { focus in
                composer(focus: focus)
            }
        }
        .overlay {
            ZStack {
                if let flight = sendFlight {
                    ChatSendFlightOverlay(flight: flight, colorScheme: colorScheme)
                }
                chatHistoryOverlay
            }
        }
        .onDisappear {
            streamTask?.cancel()
        }
    }

    @ViewBuilder
    private func chatBubbleRow(msg: ChatTurn, flying: Bool) -> some View {
        ChatBubbleView(
            msg: msg,
            isWide: isWide,
            showCopyMenu: copyMenuMessageID == msg.id,
            copyMenuBelow: msg.id == firstUserMessageID,
            colorScheme: colorScheme,
            reportsBubbleFrame: flying,
            onShowCopyMenu: {
                EPSHaptics.medium()
                withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                    copyMenuMessageID = msg.id
                }
            },
            onDismissCopyMenu: dismissCopyMenu,
            onBubbleFrame: { frame in
                updateSendFlightDest(frame)
            }
        )
        .equatable()
        .opacity(flying ? 0 : 1)
        .animation(nil, value: flying)
    }

    private func scrollChatToEnd(proxy: ScrollViewProxy) {
        withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
            proxy.scrollTo(Self.chatScrollEndID, anchor: .bottom)
        }
    }

    private func handleChatTabReselect(proxy: ScrollViewProxy) {
        guard nav.selectedTab == .chat else { return }
        if historyReveal > 0.5 || historyPanelMounted {
            closeChatHistory()
            return
        }
        scrollChatToEnd(proxy: proxy)
    }

    private func dismissCopyMenu() {
        guard copyMenuMessageID != nil else { return }
        withAnimation(.spring(response: 0.28, dampingFraction: 0.9)) {
            copyMenuMessageID = nil
        }
    }

    private func historyPanelWidth(_ containerWidth: CGFloat) -> CGFloat {
        if AdaptiveLayout.isPad {
            return min(360, max(320, containerWidth * 0.34))
        }
        if AdaptiveLayout.isPhoneLandscape(verticalSizeClass: verticalSizeClass) {
            return min(300, containerWidth * 0.40)
        }
        // Portrait: 1.33× the previous 0.52 fraction so titles fit.
        return containerWidth * 0.69
    }

    /// Finger-follow drawer. Closed: swipe the page background (not a bubble
    /// or widget). Open: swipe anywhere (same gradual + halfway haptic as
    /// Education swipe-back).
    private var historyOpenDragGesture: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { value in
                handleHistoryDragChanged(value)
            }
            .onEnded { value in
                handleHistoryDragEnded(value)
            }
    }

    /// Overlay is outside the scroll named-space, so closing uses local coords.
    private var historyCloseDragGesture: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .local)
            .onChanged { value in
                handleHistoryDragChanged(value)
            }
            .onEnded { value in
                handleHistoryDragEnded(value)
            }
    }

    private var chatHistoryOverlay: some View {
        GeometryReader { geo in
            let width = historyPanelWidth(geo.size.width)
            let hideTravel = width + Self.historyHideExtra
            let x = (historyReveal - 1) * hideTravel
            let overlayTop = geo.frame(in: .global).minY
            let topPad = max(6, historyChromeTop - overlayTop)
            let bottomPad = max(keyboardReservedBottom, IMessageComposer.height + 24) + 10
            let showPanel = historyDragging || historyPanelMounted
            // Warm-up renders the panel at its resting off-screen offset
            // (fully outside the clipped overlay) — never visible.
            let mountPanel = showPanel || historyPanelWarming

            VStack(spacing: 0) {
                Color.clear
                    .frame(height: topPad)
                    .allowsHitTesting(false)

                ZStack(alignment: .topLeading) {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture { closeChatHistory() }
                        .accessibilityLabel("Dismiss past chats")
                        .accessibilityAddTraits(.isButton)

                    if mountPanel {
                        ChatHistoryPanel(
                            sections: ChatHistoryGrouping.sections(from: chat.chats),
                            isLoading: chat.historyLoading,
                            width: width,
                            onSelect: selectHistoryChat
                        )
                        .padding(.leading, 8)
                        .padding(.bottom, bottomPad)
                        .offset(x: x)
                        .accessibilityHidden(!showPanel)
                        .transition(.identity)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .onAppear {
                historyMeasuredWidth = width
                warmUpHistoryPanelIfNeeded()
            }
            .onChange(of: width) { _, newWidth in
                historyMeasuredWidth = newWidth
            }
        }
        .clipped()
        .modifier(
            EPSProgressMonitor(progress: historyReveal) { progress in
                historyHapticGate.handle(progress)
                if historyScrubbingKeyboard {
                    EPSKeyboardScrub.setProgress(min(max(progress, 0), 1))
                }
            }
        )
        .simultaneousGesture(historyCloseDragGesture)
        .allowsHitTesting(historyOverlayHits)
    }

    /// Opening stays on the chat scroll gesture so the overlay cannot steal the
    /// finger mid-drag. Closing (and the open resting state) use the overlay so
    /// a swipe from anywhere on the screen, including over the composer, works.
    private var historyOverlayHits: Bool {
        if historyDragging {
            return historyDragOrigin >= 0.5
        }
        return historyReveal > 0.5
    }

    /// Build the panel once off-screen shortly after the overlay appears, then
    /// drop it again. First-time SwiftUI/Liquid Glass construction is the
    /// multi-second hitch on a cold debug session; doing it at idle keeps the
    /// first real swipe smooth without changing what is on screen.
    private func warmUpHistoryPanelIfNeeded() {
        guard !didWarmHistoryPanel else { return }
        didWarmHistoryPanel = true
        historyPanelWarming = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            historyPanelWarming = false
        }
    }

    private func historySwipeStartsOnChrome(_ point: CGPoint) -> Bool {
        historySwipeBlocks.frames.values.contains { $0.contains(point) }
    }

    private func handleHistoryDragChanged(_ value: DragGesture.Value) {
        let dx = value.translation.width
        let dy = value.translation.height

        if !historyDragging {
            guard abs(dx) > 8, abs(dx) > abs(dy) * 1.15 else { return }
            let opening = historyReveal < 0.5
            if opening {
                guard dx > 0 else { return }
                guard !historySwipeStartsOnChrome(value.startLocation) else { return }
            }
            historyDragging = true
            historyPanelMounted = true
            historyDragOrigin = min(max(historyReveal, 0), 1)
            historyHapticGate.reset()
            EPSHaptics.swipeBackBegan()
            historyHapticGate.handle(historyDragOrigin)
            if opening {
                loadHistoryIfNeeded()
                if composerFocused {
                    historyScrubbingKeyboard = true
                    EPSKeyboardScrub.begin()
                    EPSKeyboardScrub.setProgress(min(max(historyDragOrigin, 0), 1))
                }
            }
        }

        let w = max(historyMeasuredWidth, 1)
        let raw = historyDragOrigin + dx / w
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            historyReveal = rubberBandReveal(raw)
        }
        historyHapticGate.handle(min(max(historyReveal, 0), 1))
        if historyScrubbingKeyboard {
            EPSKeyboardScrub.setProgress(min(max(historyReveal, 0), 1))
        }
    }

    private func handleHistoryDragEnded(_ value: DragGesture.Value) {
        guard historyDragging else { return }
        historyDragging = false
        let vx = value.velocity.width
        let flungOpen = vx >= Self.historySwipeVelocityCommit && historyReveal > 0.08
        let flungClose = vx <= -Self.historySwipeVelocityCommit && historyReveal < 0.92
        let open: Bool
        if flungOpen {
            open = true
        } else if flungClose {
            open = false
        } else {
            open = historyReveal >= 0.5
        }
        settleHistory(open: open)
    }

    private func rubberBandReveal(_ raw: CGFloat) -> CGFloat {
        if raw >= 0, raw <= 1 { return raw }
        if raw > 1 {
            return 1 + (raw - 1) * 0.22
        }
        return raw * 0.22
    }

    private func loadHistoryIfNeeded() {
        Task { await chat.loadList() }
    }

    private func settleHistory(open: Bool, animated: Bool = true, markVisibleRead: Bool = true) {
        if open {
            loadHistoryIfNeeded()
            historyPanelMounted = true
        } else if markVisibleRead {
            markVisibleChatReadIfIdle()
        }
        let apply = {
            historyReveal = open ? 1 : 0
        }
        if animated {
            withAnimation(Self.historySwipeSpring) {
                apply()
            } completion: {
                if !open, !historyDragging, historyReveal < 0.01 {
                    historyPanelMounted = false
                }
                historyHapticGate.reset()
                finishHistoryKeyboardScrub()
            }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction, apply)
            historyPanelMounted = open
            historyHapticGate.reset()
            finishHistoryKeyboardScrub()
        }
    }

    /// After the drawer spring finishes, commit or restore the keyboard that
    /// was tracking `historyReveal`. Uses the live reveal so an interrupted
    /// settle (close while still springing open) does not resign by mistake.
    private func finishHistoryKeyboardScrub() {
        guard historyScrubbingKeyboard, !historyDragging else { return }
        if historyReveal >= 0.99 {
            historyScrubbingKeyboard = false
            EPSKeyboardScrub.setProgress(1)
            EPSKeyboardScrub.commitHide()
            composerFocused = false
        } else if historyReveal <= 0.01 {
            historyScrubbingKeyboard = false
            EPSKeyboardScrub.setProgress(0)
            EPSKeyboardScrub.cancel()
        }
    }

    private func closeChatHistory(animated: Bool = true, markVisibleRead: Bool = true) {
        guard historyDragging || historyReveal > 0.001 else { return }
        historyDragging = false
        settleHistory(open: false, animated: animated, markVisibleRead: markVisibleRead)
    }

    private func markVisibleChatReadIfIdle() {
        guard !chat.busy else { return }
        guard let sid = chat.currentSessionId else { return }
        Task { await chat.markRead(sid) }
    }

    private func selectHistoryChat(_ item: ChatListItem) {
        EPSHaptics.tap()
        let sameThread = item.sessionId == chat.currentSessionId
        closeChatHistory(markVisibleRead: sameThread)
        Task { await chat.markRead(item.sessionId) }
        if sameThread {
            return
        }
        Task { await chat.resume(sessionId: item.sessionId) }
    }

    private func composer(focus: FocusState<Bool>.Binding) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // iMessage: matching-height capsule + in-bar capsule send.
            // GlassEffectContainer melts shapes only when interactive
            // glass warp drags them within `meltSpacing` — never at rest.
            EPSGlassEffectContainer(spacing: IMessageComposer.meltSpacing) {
                HStack(alignment: .bottom, spacing: IMessageComposer.spacing) {
                    composerField(focus: focus)
                }
            }
            .padding(.horizontal, IMessageComposer.horizontalPadding)
            .padding(.vertical, 8)
            .frame(maxWidth: AdaptiveLayout.chatMaxWidth)
            .frame(maxWidth: .infinity)
            .zIndex(10)
        }
    }

    private func composerField(focus: FocusState<Bool>.Binding) -> some View {
        HStack(alignment: .bottom, spacing: 0) {
            TextField(
                "Ask your personal agent…",
                text: $draft,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(.body)
            .lineLimit(1...8)
            .fixedSize(horizontal: false, vertical: true)
            // Return inserts a newline (never sends) — the send
            // button is the only send path.
            .submitLabel(.return)
            .focused(focus)
            // Send-button insert/remove animation on the parent HStack must not
            // apply to the field — that is what leaves typed text on screen
            // after `draft = ""` while the field is still first responder.
            .transaction { $0.animation = nil }
            .padding(.leading, IMessageComposer.fieldLeading)
            .padding(.trailing, 4)
            .padding(.vertical, composerFieldVerticalPadding)
            .frame(minHeight: IMessageComposer.height)

            // iMessage: send appears only once there is something to send.
            if composerHasContent {
                composerSendButton
                    .padding(.trailing, IMessageComposer.sendInset)
                    .padding(.bottom, composerSendBottomInset)
                    .transition(.scale(scale: 0.4).combined(with: .opacity))
            }
        }
        .onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .global)
        } action: { frame in
            composerFieldGlobalFrame = frame
            composerFieldHeight = frame.height
        }
        .animation(
            .spring(response: 0.3, dampingFraction: 0.8),
            value: composerHasContent
        )
        .epsGlassField(cornerRadius: IMessageComposer.fieldRadius)
        .epsInteractiveInput(isFocused: focus)
        .zIndex(1)
    }

    /// iMessage send: opaque gold, wider-than-tall continuous-corner capsule
    /// inside the field (radius = half height, `.continuous` smoothing gives
    /// Messages’ subtly-flattened squircle arcs — not a circle or plain oval).
    /// Hold ≥ 2s while the Personal Agent is busy, then release, to interrupt.
    private var composerSendButton: some View {
        let shape = RoundedRectangle(
            cornerRadius: IMessageComposer.sendHeight / 2,
            style: .continuous
        )
        return Button {
            let interrupt = sendHoldArmed && isBusy
            sendHoldArmed = false
            if interrupt {
                EPSHaptics.interrupt()
            } else {
                EPSHaptics.tap()
            }
            submitComposer(interrupt: interrupt)
        } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 15, weight: .bold))
                .symbolRenderingMode(.monochrome)
                .foregroundStyle(.white)
                .frame(
                    width: IMessageComposer.sendWidth,
                    height: IMessageComposer.sendHeight
                )
                .background(EPSTheme.chatSend(colorScheme), in: shape)
                .contentShape(shape)
                .scaleEffect(sendHoldArmed ? 1.12 : 1)
                .animation(.spring(response: 0.28, dampingFraction: 0.72), value: sendHoldArmed)
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .opacity(canSend ? 1 : 0.45)
        .accessibilityLabel("Send")
        .accessibilityHint(
            "Send. Hold two seconds while working to interrupt."
        )
        .accessibilityAction(named: "Interrupt and send") {
            guard canSend, isBusy else { return }
            EPSHaptics.interrupt()
            submitComposer(interrupt: true)
        }
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 2)
                .onEnded { _ in
                    guard canSend, isBusy else { return }
                    sendHoldArmed = true
                    EPSHaptics.medium()
                }
        )
    }

    private func submitComposer(interrupt: Bool = false) {
        guard canSend else { return }
        guard session.isSignedIn else { return }
        if !interrupt, isBusy { return }
        let text = draft
        let persistInterrupted = interrupt
        if interrupt {
            cancelStream(closeAssistant: true)
        }
        prepareSendFlight(text: text)
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            draft = ""
        }
        EPSComposerInput.clearFocusedText()
        Task { @MainActor in
            if draft.isEmpty {
                EPSComposerInput.clearFocusedText()
            }
        }
        let generation = sendFlightGeneration
        Task {
            if persistInterrupted {
                await chat.persistCurrent()
            }
            await send(text)
            clearPendingSendFlightIfOrphaned(generation: generation)
        }
    }

    private func prepareSendFlight(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        sendFlightGeneration += 1
        let generation = sendFlightGeneration
        if sendFlight != nil {
            finishSendFlight()
        }
        guard !reduceMotion,
              !trimmed.isEmpty,
              historyReveal < 0.5,
              composerFieldGlobalFrame.width > 1,
              composerFieldGlobalFrame.height > 1
        else { return }
        pendingSendFlights.append(
            ChatSendFlightPending(
                generation: generation,
                origin: composerFieldGlobalFrame
            )
        )
    }

    private func bindSendFlightIfNeeded() {
        guard !pendingSendFlights.isEmpty else { return }
        // send() appends the user turn and the empty assistant in one shot,
        // so `messages.last` is the placeholder, not the flying bubble.
        guard let last = messages.last(where: { $0.role == "user" }) else { return }
        let pending = pendingSendFlights.removeFirst()
        if sendFlight != nil {
            finishSendFlight()
        }
        sendFlight = ChatSendFlightState(
            generation: pending.generation,
            messageID: last.id,
            text: last.content,
            origin: pending.origin,
            dest: nil,
            progress: 0
        )
        scheduleSendFlightTimeout(generation: pending.generation)
    }

    private func updateSendFlightDest(_ frame: CGRect) {
        guard sendFlight != nil, frame.width > 1, frame.height > 1 else { return }
        let first = sendFlight?.dest == nil
        if sendFlight?.dest != frame {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                sendFlight?.dest = frame
            }
        }
        if first {
            Task { @MainActor in
                launchSendFlight()
            }
        }
    }

    private func launchSendFlight() {
        guard sendFlight?.dest != nil, sendFlight?.progress == 0 else { return }
        withAnimation(ChatSendFlightMotion.spring) {
            sendFlight?.progress = 1
        } completion: {
            finishSendFlight()
        }
    }

    private func finishSendFlight() {
        sendFlight = nil
    }

    private func clearPendingSendFlightIfOrphaned(generation: Int) {
        pendingSendFlights.removeAll { $0.generation == generation }
    }

    private func scheduleSendFlightTimeout(generation: Int) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: ChatSendFlightMotion.timeoutNanoseconds)
            guard sendFlight?.generation == generation else { return }
            finishSendFlight()
        }
    }

    private func cancelStream(closeAssistant: Bool) {
        streamTask?.cancel()
        streamTask = nil
        guard closeAssistant else { return }
        if let last = chat.turns.last, last.role == "assistant" {
            let empty = last.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if empty {
                chat.turns.removeLast()
            } else {
                finishAssistant(last.id, fallback: last.content)
            }
        }
        chat.busy = false
    }

    private func send(_ text: String) async {
        guard session.isSignedIn else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if !hasChatKey {
            return
        }
        let user = ChatTurn(role: "user", content: trimmed)
        let assistant = ChatTurn(role: "assistant", content: "", thinking: "Thinking…")
        chat.turns.append(user)
        chat.turns.append(assistant)
        chat.busy = true

        let history = chat.turns.dropLast().map { ["role": $0.role, "content": $0.content] }
        let assistantId = assistant.id

        let task = Task {
            do {
                try await APIClient.shared.streamChat(
                    provider: session.provider,
                    messages: Array(history),
                    sessionId: session.sessionId,
                    apiKey: session.modelKey,
                    uiContext: dashboard.uiContext,
                    onDelta: { content, reasoning in
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
                    },
                    onEvent: { event in
                        Task { @MainActor in
                            let type = event["type"] as? String ?? ""
                            if type == "status", let text = event["text"] as? String, !text.isEmpty {
                                chat.mutateTurn(id: assistantId) { turn in
                                    turn.thinking = text
                                }
                            }
                            if type == "mutation" {
                                await dashboard.load(from: session)
                            }
                            if type == "navigate" {
                                NotificationCenter.default.post(name: .epsAgentNavigate, object: event)
                            }
                        }
                    }
                )
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    finishAssistant(assistantId, fallback: "The model returned an empty reply.")
                }
                await chat.persistCurrent()
            } catch {
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    chat.mutateTurn(id: assistantId) { turn in
                        turn.thinking = ""
                        turn.content = (error as? APIError)?.message
                            ?? APIClient.unreachableChatMessage
                    }
                    chat.busy = false
                }
                await chat.persistCurrent()
            }
        }
        streamTask = task
        await task.value
        if streamTask == task {
            streamTask = nil
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
                } else if !fallback.isEmpty {
                    turn.content = fallback
                }
            }
        }
        chat.busy = false
    }

    private var newChatButton: some View {
        Button {
            startNewChat()
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(EPSTheme.fg(colorScheme))
                .frame(width: 36, height: 36)
                .contentShape(Circle())
                .modifier(NewChatToolbarChrome())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("New chat")
    }

    private func startNewChat() {
        EPSHaptics.tap()
        if isBusy {
            cancelStream(closeAssistant: true)
        }
        chat.newChat()
        draft = ""
        dismissCopyMenu()
        closeChatHistory()
        finishSendFlight()
    }
}

private final class ChatRowsMemo {
    private var messages: [ChatTurn] = []
    private var isBusy = false
    private var workingLabel = "Working"
    private var cached: [ChatRow] = []

    func rows(
        messages: [ChatTurn],
        isBusy: Bool,
        workingLabel: String
    ) -> [ChatRow] {
        if messages == self.messages,
           isBusy == self.isBusy,
           workingLabel == self.workingLabel
        {
            return cached
        }
        self.messages = messages
        self.isBusy = isBusy
        self.workingLabel = workingLabel
        var rows: [ChatRow] = []
        var insertedWorking = false
        for msg in messages {
            if isBusy, !insertedWorking, msg.role == "assistant",
               msg.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                rows.append(.working(workingLabel))
                insertedWorking = true
                continue
            }
            rows.append(.message(msg))
        }
        if isBusy, !insertedWorking {
            rows.append(.working(workingLabel))
        }
        cached = rows
        return rows
    }
}

/// Global-space frames of chrome (bubbles / widgets) a history-open swipe must
/// not start on. Plain class so per-frame writes never invalidate SwiftUI —
/// the old PreferenceKey version re-reduced every visible frame while
/// scrolling ("Bound preference tried to update multiple times per frame").
private final class ChatHistorySwipeBlocks {
    var frames: [UUID: CGRect] = [:]
}

private struct ChatHistorySwipeBlocksEnvironmentKey: EnvironmentKey {
    static let defaultValue: ChatHistorySwipeBlocks? = nil
}

private extension EnvironmentValues {
    var chatHistorySwipeBlocks: ChatHistorySwipeBlocks? {
        get { self[ChatHistorySwipeBlocksEnvironmentKey.self] }
        set { self[ChatHistorySwipeBlocksEnvironmentKey.self] = newValue }
    }
}

private struct ChatHistorySwipeBlockModifier: ViewModifier {
    @Environment(\.chatHistorySwipeBlocks) private var blocks
    @State private var blockID = UUID()

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .global)
            } action: { frame in
                blocks?.frames[blockID] = frame
            }
            .onDisappear {
                blocks?.frames.removeValue(forKey: blockID)
            }
    }
}

private extension View {
    /// Frames are tracked unconditionally; whether a swipe may start on chrome
    /// is decided at drag start.
    func chatHistorySwipeBlock() -> some View {
        modifier(ChatHistorySwipeBlockModifier())
    }
}

private struct ChatEmptyState: View, Equatable {
    let colorScheme: ColorScheme

    var body: some View {
        Text("Ask your personal agent about classes, todos, schedule, or notes.")
            .font(.headline)
            .foregroundStyle(EPSTheme.fg(colorScheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .epsGlassRounded(cornerRadius: 18, interactive: true)
            .chatHistorySwipeBlock()
    }
}

private struct ChatWorkingBubble: View, Equatable {
    let label: String
    let isWide: Bool
    let colorScheme: ColorScheme

    var body: some View {
        HStack {
            HStack(alignment: .center, spacing: 6) {
                Text(label)
                    .font(.body)
                EPSBusyDots()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .foregroundStyle(EPSTheme.muted(colorScheme))
            .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .epsGlassRounded(cornerRadius: 22, interactive: true)
            .chatHistorySwipeBlock()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)

            Spacer(minLength: isWide ? 120 : 40)
        }
        .transition(
            .asymmetric(
                insertion: .opacity.combined(with: .move(edge: .bottom)),
                removal: .opacity
            )
        )
    }
}

private struct ChatBubbleView: View, Equatable {
    let msg: ChatTurn
    let isWide: Bool
    let showCopyMenu: Bool
    let copyMenuBelow: Bool
    let colorScheme: ColorScheme
    var reportsBubbleFrame: Bool = false
    var onShowCopyMenu: () -> Void
    var onDismissCopyMenu: () -> Void
    var onBubbleFrame: ((CGRect) -> Void)?

    static func == (lhs: ChatBubbleView, rhs: ChatBubbleView) -> Bool {
        lhs.msg == rhs.msg
            && lhs.isWide == rhs.isWide
            && lhs.showCopyMenu == rhs.showCopyMenu
            && lhs.copyMenuBelow == rhs.copyMenuBelow
            && lhs.colorScheme == rhs.colorScheme
            && lhs.reportsBubbleFrame == rhs.reportsBubbleFrame
    }

    var body: some View {
        let isUser = msg.role == "user"
        let sendTint = EPSTheme.chatSend(colorScheme)
            .opacity(colorScheme == .dark ? 0.26 : 0.16)
        let copyable = !msg.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return HStack {
            if isUser { Spacer(minLength: isWide ? 120 : 40) }
            if copyable {
                Group {
                    if isUser {
                        Text(msg.content)
                            .foregroundStyle(EPSTheme.fg(colorScheme))
                    } else {
                        EPSMarkdownText(source: msg.content, scheme: colorScheme)
                            .equatable()
                    }
                }
                .padding(12)
                .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .epsGlassRounded(
                    cornerRadius: 22,
                    tint: isUser ? sendTint : nil,
                    interactive: true
                )
                .chatHistorySwipeBlock()
                .background {
                    if reportsBubbleFrame {
                        Color.clear
                            .onGeometryChange(for: CGRect.self) { proxy in
                                proxy.frame(in: .global)
                            } action: { frame in
                                onBubbleFrame?(frame)
                            }
                    }
                }
                .overlay {
                    if showCopyMenu {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { onDismissCopyMenu() }
                    }
                }
                .overlay(alignment: copyMenuBelow ? .bottom : .top) {
                    if showCopyMenu {
                        copyMessagePill {
                            UIPasteboard.general.string = msg.content
                            EPSHaptics.tap()
                            onDismissCopyMenu()
                        }
                        .offset(y: copyMenuBelow ? 40 : -40)
                        .transition(
                            .opacity.combined(
                                with: .scale(
                                    scale: 0.92,
                                    anchor: copyMenuBelow ? .top : .bottom
                                )
                            )
                        )
                    }
                }
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.35)
                        .onEnded { _ in
                            guard copyable else { return }
                            onShowCopyMenu()
                        }
                )
                .simultaneousGesture(
                    TapGesture().onEnded {
                        if !showCopyMenu {
                            onDismissCopyMenu()
                        }
                    }
                )
                .accessibilityAction(named: "Copy") {
                    guard copyable else { return }
                    UIPasteboard.general.string = msg.content
                    EPSHaptics.tap()
                }
            }
            if !isUser { Spacer(minLength: isWide ? 120 : 40) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .zIndex(showCopyMenu ? 2 : 0)
    }

    private func copyMessagePill(action: @escaping () -> Void) -> some View {
        Text("Copy")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(EPSTheme.fg(colorScheme))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .epsGlassCapsule(interactive: true)
            .fixedSize()
            .highPriorityGesture(
                TapGesture().onEnded { action() }
            )
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Copy")
    }
}

private struct NewChatToolbarChrome: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
        } else {
            content.glassCircle(interactive: true)
        }
    }
}

/// Rows: messages plus an optional Working indicator covering the empty
/// in-flight assistant turn.
private enum ChatRow: Identifiable, Equatable {
    case message(ChatTurn)
    case working(String)

    var id: String {
        switch self {
        case .message(let msg): return msg.id.uuidString
        case .working: return "working-indicator"
        }
    }
}

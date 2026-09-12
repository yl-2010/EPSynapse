import SwiftUI

struct ChatOverlay: View {
    @EnvironmentObject private var session: SessionStore

    @State private var isOpen = false
    @State private var draft = ""
    @State private var turns: [ChatTurn] = []
    @State private var busy = false
    @State private var dragOffset: CGFloat = 0

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
        .offset(y: dragOffset)
        .gesture(minimizeDrag)
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
                    plusGlyph(minus: true)
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
                    plusGlyph(minus: false)
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
                    plusGlyph(minus: false)
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

    private func plusGlyph(minus: Bool) -> some View {
        ZStack {
            Capsule()
                .frame(width: 13, height: 3)
            if !minus {
                Capsule()
                    .frame(width: 3, height: 13)
            }
        }
    }

    private var minimizeDrag: some Gesture {
        DragGesture(minimumDistance: 16)
            .onChanged { value in
                if value.translation.height > 0 {
                    dragOffset = value.translation.height * 0.35
                }
            }
            .onEnded { value in
                if value.translation.height > 48 {
                    minimize()
                }
                dragOffset = 0
            }
    }

    private func minimize() {
        draft = ""
        isOpen = false
        dragOffset = 0
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

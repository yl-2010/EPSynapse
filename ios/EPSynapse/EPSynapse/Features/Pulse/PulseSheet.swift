import SwiftUI

struct PulseSheet: View {
    @Binding var isPresented: Bool
    @ObservedObject var store: PulseStore
    var sessionId: String
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if !store.pulse.blurb.isEmpty {
                        Text(store.pulse.blurb)
                            .font(.subheadline)
                            .foregroundStyle(EPSTheme.muted)
                    }
                    if !store.status.isEmpty {
                        Text(store.status)
                            .font(.footnote)
                            .foregroundStyle(EPSTheme.muted)
                    }

                    if store.pulse.voted, let results = store.results {
                        resultsBlock(results)
                    } else {
                        questionsBlock
                    }

                    liveCountsButton
                }
                .padding(20)
                .frame(maxWidth: AdaptiveLayout.formMaxWidth)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
        }
        .presentationDetents([.large])
        .presentationBackground(.ultraThinMaterial)
        .task {
            await store.load(sessionId: sessionId)
        }
    }

    private var header: some View {
        HStack {
            Text(store.pulse.title.isEmpty ? "This week's LPC" : store.pulse.title)
                .font(.title3.weight(.bold))
                .foregroundStyle(EPSTheme.fg)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(EPSTheme.accent)
                        .frame(width: 3)
                }
            Spacer()
            Button {
                isPresented = false
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(EPSTheme.fg)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .epsSizedGlassCircle(side: 28)
            .accessibilityLabel("Close pulse")
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 12)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(EPSTheme.accent.opacity(0.38))
                .frame(height: 1)
        }
    }

    private var questionsBlock: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(store.pulse.questions) { question in
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.prompt)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(EPSTheme.fg)
                    PulseChipRow(
                        options: question.options,
                        selected: store.answers[question.id]
                    ) { optionId in
                        store.answers[question.id] = optionId
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Grade (optional)")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(EPSTheme.fg)
                PulseChipRow(
                    options: store.pulse.grades.map { PulseOption(id: $0, label: $0) },
                    selected: store.grade
                ) { optionId in
                    store.grade = store.grade == optionId ? "" : optionId
                }
            }

            Button {
                EPSHaptics.tap()
                Task { await store.vote(sessionId: sessionId) }
            } label: {
                Text(store.isVoting ? "Sending…" : "Submit")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(goldLabel)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.plain)
            .disabled(!store.canSubmit)
            .opacity(store.canSubmit ? 1 : 0.55)
            .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
        }
    }

    private func resultsBlock(_ results: PulseResults) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(results.n == 1 ? "1 answer" : "\(results.n) answers")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(EPSTheme.muted)

            ForEach(results.questions) { question in
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.prompt)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(EPSTheme.fg)
                    ForEach(question.options) { option in
                        PulseResultBar(option: option)
                    }
                }
            }
        }
    }

    private var liveCountsButton: some View {
        Button {
            openURL(PulseStore.boardURL)
        } label: {
            Text("Live counts")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(EPSTheme.fg)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .epsGlassRounded(cornerRadius: 14, interactive: true)
        .epsHapticOnTap()
    }

    private var goldLabel: Color {
        colorScheme == .dark ? Color.white : Color(red: 11 / 255, green: 31 / 255, blue: 58 / 255)
    }
}

struct PulseChipRow: View {
    var options: [PulseOption]
    var selected: String?
    var onPick: (String) -> Void

    private let columns = [GridItem(.adaptive(minimum: 92), spacing: 8)]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            ForEach(options) { option in
                let on = selected == option.id
                Button {
                    EPSHaptics.tap()
                    onPick(option.id)
                } label: {
                    Text(option.label)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(on ? goldLabel : EPSTheme.fg)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .epsGlassRounded(
                    cornerRadius: 12,
                    tint: on ? EPSTheme.accent.opacity(0.72) : nil,
                    interactive: true
                )
            }
        }
    }

    private var goldLabel: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? .white
                : UIColor(red: 11 / 255, green: 31 / 255, blue: 58 / 255, alpha: 1)
        })
    }
}

struct PulseResultBar: View {
    var option: PulseResultOption

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(option.label)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(EPSTheme.fg)
                Spacer(minLength: 8)
                Text("\(option.count) · \(option.pct)%")
                    .font(.caption)
                    .foregroundStyle(EPSTheme.muted)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(EPSTheme.muted.opacity(0.18))
                    Capsule()
                        .fill(EPSTheme.accent)
                        .frame(width: barWidth(in: geo.size.width))
                }
            }
            .frame(height: 8)
        }
    }

    private func barWidth(in total: CGFloat) -> CGFloat {
        let pct = min(max(option.pct, 0), 100)
        if pct == 0 { return 0 }
        return max(6, total * CGFloat(pct) / 100)
    }
}

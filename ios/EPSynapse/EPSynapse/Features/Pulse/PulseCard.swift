import SwiftUI

struct PulseCard: View {
    @ObservedObject var store: PulseStore
    var slim: Bool
    var onAnswer: () -> Void

    var body: some View {
        if slim {
            slimCard
        } else {
            fullCard
        }
    }

    private var fullCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(store.pulse.title.isEmpty ? "This week's LPC" : store.pulse.title)
                .font(.title3.weight(.bold))
                .foregroundStyle(EPSTheme.fg)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(EPSTheme.accent)
                        .frame(width: 3)
                }

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

            Button(action: onAnswer) {
                Text(store.pulse.voted ? "Results" : "Answer")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(goldLabel)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.plain)
            .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
            .epsHapticOnTap()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .epsGlassRounded(cornerRadius: 22, interactive: true)
    }

    private var slimCard: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(store.pulse.title.isEmpty ? "This week's LPC" : store.pulse.title)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(EPSTheme.fg)
                Text(slimSubline)
                    .font(.caption)
                    .foregroundStyle(EPSTheme.muted)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: onAnswer) {
                Text(store.pulse.voted ? "Results" : "Answer")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(goldLabel)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.plain)
            .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
            .epsHapticOnTap()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .epsGlassRounded(cornerRadius: 22, interactive: true)
    }

    private var slimSubline: String {
        if !store.status.isEmpty { return store.status }
        if !store.pulse.blurb.isEmpty { return store.pulse.blurb }
        return "This week's cafeteria pulse"
    }

    private var goldLabel: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? .white
                : UIColor(red: 11 / 255, green: 31 / 255, blue: 58 / 255, alpha: 1)
        })
    }
}

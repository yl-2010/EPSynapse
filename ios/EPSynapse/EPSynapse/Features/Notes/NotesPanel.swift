import SwiftUI

struct NotesPanel: View {
    @Binding var path: NavigationPath
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.openURL) private var openURL

    @State private var draft = ""

    var body: some View {
        EPSPanel(title: "Notes") {
            VStack(alignment: .leading, spacing: 10) {
                TextField("Paste class notes", text: $draft, axis: .vertical)
                    .lineLimit(5 ... 12)
                    .font(.body)
                    .foregroundStyle(EPSTheme.fg)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .epsGlassField(interactive: true, cornerRadius: 14)

                HStack(spacing: 8) {
                    Button {
                        EPSHaptics.tap()
                        Task {
                            if let note = await dashboard.classifyNote(text: draft, session: session) {
                                draft = ""
                                path.append(HomeDestination.note(note.id))
                            }
                        }
                    } label: {
                        Text(dashboard.notesBusy ? "Classifying…" : "Classify")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(goldLabel)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.plain)
                    .disabled(dashboard.notesBusy)
                    .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)

                    Button {
                        EPSHaptics.tap()
                        openURL(EPSLinks.research)
                    } label: {
                        Text("Research")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(EPSTheme.fg)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.plain)
                    .epsGlassRounded(cornerRadius: 14, interactive: true)
                    .accessibilityHint("Opens the public research page in Safari")
                }

                if !dashboard.notesStatus.isEmpty {
                    Text(dashboard.notesStatus)
                        .font(.footnote)
                        .foregroundStyle(EPSTheme.muted)
                }
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

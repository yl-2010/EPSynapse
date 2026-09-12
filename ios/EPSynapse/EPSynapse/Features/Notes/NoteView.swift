import SwiftUI

struct NoteView: View {
    var noteId: String

    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var subject = ""

    private var note: ClassifiedNote? {
        dashboard.note(id: noteId)
    }

    private var pagePad: CGFloat {
        AdaptiveLayout.pagePadding(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    private var pickerSubjects: [String] {
        var list = dashboard.noteClassLabels
        if !subject.isEmpty, !list.contains(subject) {
            list.insert(subject, at: 0)
        }
        return list
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                backRow
                if let note {
                    textCard(note.text)
                    votesCard(note)
                    orchestratorCard(note)
                    subjectCard
                    deleteButton
                    researchButton
                } else {
                    EmptyLine("This note is gone.")
                }
            }
            .padding(.horizontal, pagePad)
            .padding(.top, AdaptiveLayout.isPad ? 96 : 88)
            .padding(.bottom, 108)
            .frame(maxWidth: AdaptiveLayout.pageMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .epsVerticalScrollOnly()
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .epsPageBackground()
        .epsSwipeBackHaptics()
        .task {
            await dashboard.refreshNote(id: noteId, session: session)
            hydrate()
            if let note { dashboard.uiContext = .note(note) }
        }
        .onAppear {
            hydrate()
            if let note { dashboard.uiContext = .note(note) }
        }
        .onChange(of: noteId) { _, _ in hydrate() }
        .onChange(of: subject) { _, next in
            guard let note, !next.isEmpty, next != note.subject else { return }
            Task { await dashboard.updateNoteSubject(id: note.id, subject: next, session: session) }
        }
    }

    private var backRow: some View {
        Button {
            EPSHaptics.tap()
            dismiss()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 13, weight: .bold))
                Text("Back")
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(EPSTheme.fg)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
        .epsGlassRounded(cornerRadius: 14, interactive: true)
        .accessibilityLabel("Back")
    }

    private func textCard(_ text: String) -> some View {
        EPSPanel(title: "Note") {
            Text(text)
                .font(.body)
                .foregroundStyle(EPSTheme.fg)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func votesCard(_ note: ClassifiedNote) -> some View {
        EPSPanel(title: "Classifiers") {
            VStack(alignment: .leading, spacing: 10) {
                voteRow("BERT", note.votes.zeroShot, correct: note.orchestrator.baseBertCorrect)
                voteRow("Fine-tuned BERT", note.votes.fineTuned, correct: note.orchestrator.fineTunedBertCorrect)
            }
        }
    }

    private func voteRow(_ label: String, _ vote: NoteVote?, correct: Bool?) -> some View {
        let bits = [vote?.confidenceLabel ?? "", correctLabel(correct)].filter { !$0.isEmpty }
        return VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(EPSTheme.muted)
            if let vote, !vote.subject.isEmpty {
                Text(vote.subject)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(EPSTheme.fg)
                if !bits.isEmpty {
                    Text(bits.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(EPSTheme.muted)
                }
            } else {
                Text("No vote")
                    .font(.body)
                    .foregroundStyle(EPSTheme.muted)
            }
        }
    }

    private func correctLabel(_ correct: Bool?) -> String {
        guard let correct else { return "" }
        return correct ? "correct" : "wrong"
    }

    private func orchestratorCard(_ note: ClassifiedNote) -> some View {
        EPSPanel(title: "Orchestrator") {
            VStack(alignment: .leading, spacing: 6) {
                Text(note.orchestrator.subject.isEmpty ? note.subject : note.orchestrator.subject)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(EPSTheme.fg)
                if let confidence = note.orchestrator.confidence {
                    Text(NoteVote(confidence: confidence).confidenceLabel)
                        .font(.caption)
                        .foregroundStyle(EPSTheme.muted)
                }
                if !note.orchestrator.rationale.isEmpty {
                    Text(note.orchestrator.rationale)
                        .font(.footnote)
                        .foregroundStyle(EPSTheme.muted)
                }
            }
        }
    }

    private var subjectCard: some View {
        EPSPanel(title: "Class") {
            Picker("Class", selection: $subject) {
                ForEach(pickerSubjects, id: \.self) { label in
                    Text(label).tag(label)
                }
            }
            .pickerStyle(.menu)
            .tint(EPSTheme.fg)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .epsGlassField(interactive: true, cornerRadius: 14)
            if !dashboard.notesStatus.isEmpty {
                Text(dashboard.notesStatus)
                    .font(.footnote)
                    .foregroundStyle(EPSTheme.muted)
            }
        }
    }

    private var deleteButton: some View {
        Button(role: .destructive) {
            guard let note else { return }
            Task {
                if await dashboard.deleteNote(id: note.id, session: session) {
                    EPSHaptics.tap()
                    dismiss()
                }
            }
        } label: {
            Text("Delete note")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(goldLabel)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
    }

    private var researchButton: some View {
        Button {
            EPSHaptics.tap()
            openURL(EPSLinks.research)
        } label: {
            Text("Research")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(goldLabel)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
        .accessibilityHint("Opens the public research page in Safari")
    }

    private var goldLabel: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? .white
                : UIColor(red: 11 / 255, green: 31 / 255, blue: 58 / 255, alpha: 1)
        })
    }

    private func hydrate() {
        if let note {
            subject = note.subject.isEmpty ? "Other" : note.subject
        }
    }
}


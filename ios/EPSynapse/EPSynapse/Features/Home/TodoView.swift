import SwiftUI

struct TodoView: View {
    var todoId: String

    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var htmlFile: DriveFile?
    @State private var pendingDone: Bool?

    private var item: Assignment? {
        dashboard.assignment(id: todoId)
    }

    private var shownDone: Bool {
        pendingDone ?? item?.done ?? false
    }

    private var pagePad: CGFloat {
        AdaptiveLayout.pagePadding(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    private var className: String {
        guard let item else { return "" }
        if !item.courseName.isEmpty { return CourseTitle.pretty(item.courseName) }
        let classId = item.classId.isEmpty ? item.courseId : item.classId
        if !classId.isEmpty, let klass = dashboard.schoolClass(id: classId) {
            return CourseTitle.pretty(klass.name)
        }
        return ""
    }

    private var todoFiles: [DriveFile] {
        guard let item else { return [] }
        return dashboard.files(forTodo: item)
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                backRow
                if let item {
                    titleCard(item)
                    statusRow(item)
                    metaCard(item)
                    if !item.description.isEmpty {
                        descriptionCard(item.description)
                    }
                    if !item.canvasLink.isEmpty {
                        canvasButton(item.canvasLink)
                    }
                    filesPanel
                } else {
                    EmptyLine("This todo is gone.")
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
        .sheet(item: $htmlFile) { file in
            ClassHTMLSheet(file: file)
        }
        .task {
            await dashboard.refreshTodoFiles(todoId: todoId, session: session)
            if let item { dashboard.uiContext = .todo(item) }
        }
        .onAppear {
            if let item { dashboard.uiContext = .todo(item) }
        }
        .onChange(of: item?.done) { _, _ in
            if let item { dashboard.uiContext = .todo(item) }
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
                Text("Home")
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(EPSTheme.fg)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
        .epsGlassRounded(cornerRadius: 14, interactive: true)
        .accessibilityLabel("Back to home")
    }

    private func titleCard(_ item: Assignment) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            EPSTagChip(tag: item.tag)
            Text(item.title.isEmpty ? "Todo" : item.title)
                .font(.title.weight(.bold))
                .foregroundStyle(EPSTheme.fg)
                .strikethrough(shownDone, color: EPSTheme.fg.opacity(0.55))
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .epsGlassRounded(cornerRadius: 22, interactive: false)
    }

    private func statusRow(_ item: Assignment) -> some View {
        HStack(spacing: 12) {
            checkbox(item)
            Button {
                toggle(item)
            } label: {
                Text(shownDone ? "Done" : "Open")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(goldLabel)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.plain)
            .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
        }
    }

    private func metaCard(_ item: Assignment) -> some View {
        EPSPanel(title: "Details") {
            VStack(alignment: .leading, spacing: 6) {
                if !className.isEmpty {
                    Text(className)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(dashboard.tone(for: item))
                }
                if !item.due.isEmpty {
                    Text(EPSDueFormat.due(item.due))
                        .font(.subheadline)
                        .foregroundStyle(EPSTheme.muted)
                }
                if className.isEmpty, item.due.isEmpty {
                    EmptyLine("No class or due date")
                }
            }
        }
    }

    private func descriptionCard(_ text: String) -> some View {
        EPSPanel(title: "Description") {
            Text(text)
                .font(.body)
                .foregroundStyle(EPSTheme.fg)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func canvasButton(_ raw: String) -> some View {
        Button {
            // Server-supplied string. Only https and mailto get through.
            if let url = EPSMarkdown.safeURL(raw) {
                openURL(url)
            }
        } label: {
            Text("Open in Canvas")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(goldLabel)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .epsGlassRounded(cornerRadius: 14, tint: EPSTheme.accent.opacity(0.72), interactive: true)
        .epsHapticOnTap()
    }

    private var filesPanel: some View {
        EPSPanel(title: "Files") {
            if todoFiles.isEmpty {
                EmptyLine("No files on this todo yet")
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(todoFiles) { file in
                        Button {
                            EPSHaptics.tap()
                            if file.isHTML, !file.text.isEmpty {
                                htmlFile = file
                            } else if let url = EPSMarkdown.safeURL(file.webUrl) {
                                openURL(url)
                            } else if file.isHTML {
                                htmlFile = file
                            }
                        } label: {
                            Text(file.name)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(EPSTheme.fg)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func checkbox(_ item: Assignment) -> some View {
        Button {
            toggle(item)
        } label: {
            Color.clear
                .epsSizedGlassCircle(side: 28, interactive: false)
                .overlay {
                    if shownDone {
                        Circle()
                            .fill(dashboard.tone(for: item))
                            .frame(width: 12, height: 12)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
        }
        .buttonStyle(.plain)
        .animation(.spring(duration: 0.34, bounce: 0.26), value: shownDone)
        .accessibilityLabel(shownDone ? "Mark incomplete" : "Mark complete")
        .epsHapticOnTap()
    }

    private func toggle(_ item: Assignment) {
        guard pendingDone == nil else { return }
        Task {
            if item.done {
                pendingDone = false
                try? await Task.sleep(for: .milliseconds(420))
                await dashboard.markUndone(item, session: session)
            } else {
                pendingDone = true
                try? await Task.sleep(for: .milliseconds(420))
                await dashboard.markDone(item, session: session)
            }
            pendingDone = nil
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

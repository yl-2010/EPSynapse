import SwiftUI

struct TodoView: View {
    var todoId: String

    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @EnvironmentObject private var homeFocus: HomeFocusStore
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

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
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
            VStack(alignment: .leading, spacing: 14) {
                if let item {
                    EducationTodoTitle(item: item, font: .largeTitle.weight(.bold), done: shownDone)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    VStack(alignment: .leading, spacing: 14) {
                        HStack(alignment: .center, spacing: 12) {
                            EducationTodoCheckbox(done: shownDone) {
                                toggle(item)
                            }
                            Text(shownDone ? "Done" : "Open")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(EPSTheme.fg)
                            Spacer(minLength: 0)
                        }

                        let when = NaturalWhen.formatDetail(date: item.dueDateValue, time: item.dueTimeValue)
                        if !when.isEmpty {
                            Text(when)
                                .font(.subheadline)
                                .foregroundStyle(EPSTheme.muted)
                        }

                        if !className.isEmpty {
                            Text(className)
                                .font(.subheadline)
                                .foregroundStyle(EPSTheme.muted)
                        }

                        if item.description.isEmpty {
                            Text("No description")
                                .font(.subheadline)
                                .foregroundStyle(EPSTheme.muted)
                        } else {
                            Text(item.description)
                                .font(.body)
                                .foregroundStyle(EPSTheme.fg)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .epsGlassRounded(cornerRadius: 22, interactive: true)

                    filesPanel
                } else {
                    EmptyLine("This todo is gone.")
                }
            }
            .padding(.horizontal, isWide ? 28 : 16)
            .padding(.vertical, 12)
            .frame(maxWidth: AdaptiveLayout.pageMaxWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .epsVerticalScrollOnly()
        .homeTabReselectScroll(isActive: homeFocus.isShowingTodo(todoId))
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let item, let url = item.canvasURL {
                ToolbarItem(placement: .topBarTrailing) {
                    CanvasToolbarButton(webURL: url, scoreLabel: item.scoreLabel)
                }
            }
        }
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

    private func toggle(_ item: Assignment) {
        guard pendingDone == nil else { return }
        Task {
            pendingDone = !item.done
            if item.done {
                await dashboard.markUndone(item, session: session)
            } else {
                await dashboard.markDone(item, session: session)
            }
            pendingDone = nil
        }
    }
}

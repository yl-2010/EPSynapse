import SwiftUI
import WebKit

struct ClassView: View {
    var classId: String

    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var todoExpanded = false
    @State private var htmlFile: DriveFile?

    private var schoolClass: SchoolClass? {
        dashboard.schoolClass(id: classId)
    }

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    private var pagePad: CGFloat {
        AdaptiveLayout.pagePadding(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
    }

    private var items: [Assignment] {
        guard let schoolClass else { return [] }
        return dashboard.assignments(for: schoolClass)
    }

    private static let collapsedLimit = 6

    private var todoItems: [Assignment] {
        items.filter { !$0.done }
    }

    private var visibleTodos: [Assignment] {
        todoExpanded ? todoItems : Array(todoItems.prefix(Self.collapsedLimit))
    }

    private var doneItems: [Assignment] {
        items.filter(\.done)
    }

    private var classNotes: [ClassifiedNote] {
        guard let schoolClass else { return [] }
        return dashboard.notes(for: schoolClass)
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                backRow
                if let schoolClass {
                    hero(schoolClass)
                    if !schoolClass.canvasLink.isEmpty {
                        canvasButton(schoolClass.canvasLink)
                    }
                    if isWide {
                        HStack(alignment: .top, spacing: 16) {
                            VStack(spacing: 16) {
                                todoPanel
                                completedPanel
                            }
                            .frame(maxWidth: .infinity, alignment: .top)
                            VStack(spacing: 16) {
                                notesPanel
                                filesPanel
                            }
                            .frame(maxWidth: .infinity, alignment: .top)
                        }
                    } else {
                        todoPanel
                        notesPanel
                        filesPanel
                        completedPanel
                    }
                } else {
                    EmptyLine("This class is gone from the schedule.")
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
        .onAppear {
            if let schoolClass {
                dashboard.uiContext = .schoolClass(schoolClass)
            }
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

    private func hero(_ schoolClass: SchoolClass) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            if !schoolClass.period.isEmpty {
                Text(schoolClass.period)
                    .font(.system(size: 44, weight: .bold))
                    .foregroundStyle(EPSTone.forClass(schoolClass).color)
                    .minimumScaleFactor(0.6)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(schoolClass.name.isEmpty ? "Class" : CourseTitle.pretty(schoolClass.name))
                    .font(.title.weight(.bold))
                    .foregroundStyle(EPSTheme.fg)
                HStack(spacing: 8) {
                    if schoolClass.freePeriod {
                        Text("Free period")
                    }
                    if !schoolClass.courseCode.isEmpty {
                        Text(schoolClass.courseCode)
                    }
                    // Teacher and room only come from uploaded (model-parsed) schedules.
                    if !schoolClass.teacher.isEmpty {
                        Text(schoolClass.teacher)
                    }
                    if !schoolClass.room.isEmpty {
                        Text(roomLabel(schoolClass.room))
                    }
                }
                .font(.subheadline)
                .foregroundStyle(EPSTheme.muted)
                if !schoolClass.meetings.isEmpty {
                    Text(meetingsLine(schoolClass.meetings))
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(EPSTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .epsGlassRounded(cornerRadius: 22, interactive: false)
    }

    /// "Room 204" unless the PDF already printed the word.
    private func roomLabel(_ room: String) -> String {
        let trimmed = room.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("room") || trimmed.lowercased().hasPrefix("rm") {
            return trimmed
        }
        return "Room \(trimmed)"
    }

    /// Weekly meetings as one line, e.g. "Mon 09:00-09:50 · Wed 09:00-09:50".
    private func meetingsLine(_ meetings: [ClassMeeting]) -> String {
        let order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        let sorted = meetings.sorted { a, b in
            let da = order.firstIndex(of: a.day) ?? order.count
            let db = order.firstIndex(of: b.day) ?? order.count
            if da != db { return da < db }
            return a.start < b.start
        }
        return sorted.map(\.label).filter { !$0.isEmpty }.joined(separator: " · ")
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

    private var todoPanel: some View {
        EPSPanel(title: "TODO", expanded: todoExpanded, onToggleExpanded: { todoExpanded.toggle() }) {
            if todoItems.isEmpty {
                EmptyLine("No open work")
            } else {
                TodoRows(items: visibleTodos) { item in
                    TodoRow(item: item)
                        .transition(.asymmetric(
                            insertion: .opacity.combined(with: .move(edge: .top)),
                            removal: .opacity.combined(with: .move(edge: .bottom))
                        ))
                }
            }
        }
    }

    private var completedPanel: some View {
        EPSPanel(title: "Completed", dimmed: true) {
            if doneItems.isEmpty {
                EmptyLine("Nothing completed yet")
            } else {
                TodoRows(items: doneItems) { item in
                    TodoRow(item: item)
                        .transition(.asymmetric(
                            insertion: .opacity.combined(with: .move(edge: .top)),
                            removal: .opacity.combined(with: .move(edge: .bottom))
                        ))
                }
            }
        }
    }

    private var notesPanel: some View {
        EPSPanel(title: "Notes") {
            if classNotes.isEmpty {
                EmptyLine("No notes for this class")
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(classNotes) { note in
                        NavigationLink(value: HomeDestination.note(note.id)) {
                            ClassNoteRow(
                                note: note,
                                tone: schoolClass.map { dashboard.tone(for: $0) } ?? EPSTheme.accent
                            )
                        }
                        .buttonStyle(.plain)
                        .epsHapticNavigation()
                    }
                }
            }
        }
    }

    private var classFiles: [DriveFile] {
        guard let schoolClass else { return [] }
        return dashboard.files(for: schoolClass)
    }

    private var filesPanel: some View {
        EPSPanel(title: "Files") {
            if classFiles.isEmpty {
                EmptyLine("No files on this class yet")
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(classFiles) { file in
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

    private var goldLabel: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? .white
                : UIColor(red: 11 / 255, green: 31 / 255, blue: 58 / 255, alpha: 1)
        })
    }
}

struct ClassNoteRow: View {
    var note: ClassifiedNote
    var tone: Color = EPSTheme.accent

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                if !note.subject.isEmpty {
                    Text(note.subject)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(tone)
                }
                Text(note.text)
                    .font(.body)
                    .foregroundStyle(EPSTheme.fg)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(EPSTheme.muted)
                .padding(.top, 4)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 8)
    }
}

struct ClassHTMLSheet: View {
    var file: DriveFile
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ClassHTMLWebView(html: file.text)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(file.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
        }
    }
}

/// Read-only rendering of API-provided HTML. Scripts are off, link previews are
/// off, and the only navigation allowed is the initial loadHTMLString. A tapped
/// https or mailto link leaves the web view and opens through the system.
struct ClassHTMLWebView: UIViewRepresentable {
    var html: String
    @Environment(\.openURL) private var openURL

    func makeCoordinator() -> Coordinator {
        Coordinator(openURL: openURL)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.allowsLinkPreview = false
        view.navigationDelegate = context.coordinator
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.openURL = openURL
        guard context.coordinator.loadedHTML != html else { return }
        context.coordinator.loadedHTML = html
        uiView.loadHTMLString(html, baseURL: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var openURL: OpenURLAction
        var loadedHTML: String?

        init(openURL: OpenURLAction) {
            self.openURL = openURL
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            let url = navigationAction.request.url
            if navigationAction.navigationType == .linkActivated {
                if let raw = url?.absoluteString, let safe = EPSMarkdown.safeURL(raw) {
                    openURL(safe)
                }
                decisionHandler(.cancel)
                return
            }
            // loadHTMLString(_, baseURL: nil) arrives as about:blank on the main frame.
            let isInitialLoad = navigationAction.navigationType == .other
                && navigationAction.targetFrame?.isMainFrame == true
                && url?.scheme?.lowercased() == "about"
            decisionHandler(isInitialLoad ? .allow : .cancel)
        }
    }
}

import SwiftUI
import WebKit

struct ClassView: View {
    var classId: String

    @EnvironmentObject private var dashboard: DashboardStore
    @EnvironmentObject private var homeFocus: HomeFocusStore
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
            VStack(alignment: .leading, spacing: 14) {
                if let schoolClass {
                    hero(schoolClass)
                    if isWide {
                        HStack(alignment: .top, spacing: 14) {
                            VStack(alignment: .leading, spacing: 14) {
                                todoPanel
                                completedPanel
                            }
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            VStack(alignment: .leading, spacing: 14) {
                                notesPanel
                                filesPanel
                            }
                            .frame(maxWidth: .infinity, alignment: .topLeading)
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
            .padding(.horizontal, isWide ? 28 : 16)
            .padding(.vertical, 12)
            .frame(maxWidth: AdaptiveLayout.pageMaxWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .epsVerticalScrollOnly()
        .homeTabReselectScroll(isActive: homeFocus.isShowingClass(classId))
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let schoolClass, let url = schoolClass.canvasURL {
                ToolbarItem(placement: .topBarTrailing) {
                    CanvasToolbarButton(webURL: url, scoreLabel: schoolClass.scoreLabel)
                }
            }
        }
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

    private func hero(_ schoolClass: SchoolClass) -> some View {
        let nextWhen: String = {
            guard let next = dashboard.nextOccurrence(for: schoolClass) else { return "" }
            return NaturalWhen.formatNextClassWhen(
                dateKey: next.dateKey,
                start: next.start,
                end: next.end
            )
        }()
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if !schoolClass.period.isEmpty {
                    Text(schoolClass.period.uppercased())
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(EPSTheme.accent)
                }
                Text(schoolClass.name.isEmpty ? "Class" : CourseTitle.pretty(schoolClass.name))
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(EPSTheme.fg)
            }
            if !nextWhen.isEmpty {
                Text(nextWhen)
                    .font(.subheadline)
                    .foregroundStyle(EPSTheme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
    }

    private var todoPanel: some View {
        EPSPanel(title: "TODO", filters: true, expanded: todoExpanded, onToggleExpanded: { todoExpanded.toggle() }) {
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
                EmptyLine("Nothing here")
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

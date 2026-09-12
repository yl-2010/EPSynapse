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
                    todoPanel
                    completedPanel
                    notesPanel
                    filesPanel
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
        .sheet(item: $htmlFile) { file in
            ClassHTMLSheet(file: file)
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
                    .foregroundStyle(EPSTheme.accent)
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
                }
                .font(.subheadline)
                .foregroundStyle(EPSTheme.muted)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .epsGlassRounded(cornerRadius: 22, interactive: false)
    }

    private func canvasButton(_ raw: String) -> some View {
        Button {
            if let url = URL(string: raw) {
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
                            removal: .opacity.combined(with: .scale(scale: 0.97, anchor: .top))
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
                            removal: .opacity.combined(with: .scale(scale: 0.97, anchor: .top))
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
                            ClassNoteRow(note: note)
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
                            } else if let url = URL(string: file.webUrl), !file.webUrl.isEmpty {
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

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                if !note.subject.isEmpty {
                    Text(note.subject)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(EPSTheme.accent)
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

struct ClassHTMLWebView: UIViewRepresentable {
    var html: String

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero)
        view.isOpaque = false
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        uiView.loadHTMLString(html, baseURL: nil)
    }
}

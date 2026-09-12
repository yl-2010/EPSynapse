import SwiftUI
import UIKit

enum EPSDueFormat {
    static func due(_ iso: String) -> String {
        guard let date = parse(iso) else {
            return iso.isEmpty ? "" : String(iso.prefix(10))
        }
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.setLocalizedDateFormatFromTemplate("EEE MMM d jm")
        return formatter.string(from: date)
    }

    static func dayKey(_ iso: String) -> String {
        if let date = parse(iso) {
            let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
            if let year = parts.year, let month = parts.month, let day = parts.day {
                return String(format: "%04d-%02d-%02d", year, month, day)
            }
        }
        let trimmed = iso.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count >= 10 {
            let prefix = String(trimmed.prefix(10))
            if prefix.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil {
                return prefix
            }
        }
        return ""
    }

    private static func parse(_ iso: String) -> Date? {
        let trimmed = iso.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFrac.date(from: trimmed) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: trimmed) { return date }
        return nil
    }
}

struct EPSPanel<Content: View>: View {
    var title: String
    var filters: Bool = false
    var dimmed: Bool = false
    var expanded: Bool? = nil
    var onToggleExpanded: (() -> Void)? = nil
    @ViewBuilder var content: () -> Content

    @EnvironmentObject private var dashboard: DashboardStore

    private var showFilters: Bool {
        filters && (expanded ?? true)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 10) {
                titleView
                Spacer(minLength: 8)
                if showFilters {
                    FilterOrbBar()
                }
            }

            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .epsGlassRounded(cornerRadius: 22, interactive: false)
        .opacity(dimmed ? 0.78 : 1)
    }

    private var titleLabel: some View {
        Text(title)
            .font(.title3.weight(.bold))
            .foregroundStyle(EPSTheme.fg)
            .padding(.leading, 10)
            .overlay(alignment: .leading) {
                Capsule()
                    .fill(EPSTheme.accent)
                    .frame(width: 3)
            }
    }

    @ViewBuilder
    private var titleView: some View {
        if let expanded, let onToggleExpanded {
            Button {
                EPSHaptics.tap()
                onToggleExpanded()
            } label: {
                titleLabel
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "Collapse \(title.lowercased())" : "Expand \(title.lowercased())")
            .accessibilityHint("Shows the full list when expanded")
        } else {
            titleLabel
        }
    }
}

struct FilterOrbBar: View {
    @EnvironmentObject private var dashboard: DashboardStore

    var body: some View {
        HStack(spacing: 6) {
            ForEach(DashboardStore.tags, id: \.self) { tag in
                FilterOrb(
                    tag: tag,
                    isOn: dashboard.typeFilter.contains(tag)
                ) {
                    withAnimation(.easeInOut(duration: 0.28)) {
                        dashboard.toggleFilter(tag)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Assignment filters")
    }
}

struct FilterOrb: View {
    var tag: String
    var isOn: Bool
    var action: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: action) {
            Text(tag)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(isOn ? Color.white : EPSTheme.muted)
                .frame(width: 33, height: 33)
        }
        .buttonStyle(.plain)
        .epsSizedGlassCircle(side: 33, tint: isOn ? EPSTheme.filterOnTint(colorScheme) : nil, interactive: false)
        .animation(.easeInOut(duration: 0.22), value: isOn)
        .accessibilityLabel(tag)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
        .epsHapticOnTap()
    }
}

struct TodoPanel: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @State private var expanded = false

    private static let collapsedLimit = 6

    private var items: [Assignment] {
        dashboard.assignments.filter { !$0.done && Self.matches($0, filter: dashboard.typeFilter) }
    }

    private var visible: [Assignment] {
        expanded ? items : Array(items.prefix(Self.collapsedLimit))
    }

    var body: some View {
        EPSPanel(title: "TODO", filters: true, expanded: expanded, onToggleExpanded: { expanded.toggle() }) {
            if items.isEmpty {
                EmptyLine(
                    session.profile?.canvasConnected == true
                        ? "No open work"
                        : "Connect Canvas in settings"
                )
            } else {
                TodoRows(items: visible) { item in
                    TodoRow(item: item)
                        .transition(.asymmetric(
                            insertion: .opacity.combined(with: .move(edge: .top)),
                            removal: .opacity.combined(with: .move(edge: .bottom))
                        ))
                }
            }
        }
    }

    static func matches(_ item: Assignment, filter: Set<String>) -> Bool {
        filter.contains(item.tag.isEmpty ? "HW" : item.tag)
    }
}

struct CompletedPanel: View {
    @EnvironmentObject private var dashboard: DashboardStore

    private var items: [Assignment] {
        dashboard.assignments.filter { $0.done && TodoPanel.matches($0, filter: dashboard.typeFilter) }
    }

    var body: some View {
        EPSPanel(title: "Completed", dimmed: true) {
            if items.isEmpty {
                EmptyLine("Nothing completed yet")
            } else {
                TodoRows(items: items) { item in
                    TodoRow(item: item)
                        .transition(.asymmetric(
                            insertion: .opacity.combined(with: .move(edge: .top)),
                            removal: .opacity.combined(with: .move(edge: .bottom))
                        ))
                }
            }
        }
    }
}

struct TodoDaySeparator: View {
    var body: some View {
        Rectangle()
            .fill(EPSTheme.fg.opacity(0.12))
            .frame(height: 1)
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .accessibilityHidden(true)
    }
}

struct TodoRows<Row: View>: View {
    var items: [Assignment]
    @ViewBuilder var row: (Assignment) -> Row

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 {
                    if EPSDueFormat.dayKey(items[index - 1].due) != EPSDueFormat.dayKey(item.due) {
                        TodoDaySeparator()
                    } else {
                        Color.clear.frame(height: 4)
                    }
                }
                row(item)
            }
        }
    }
}

struct TodoRow: View {
    var item: Assignment
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @State private var hovering = false
    @State private var pendingDone: Bool?

    private var shownDone: Bool { pendingDone ?? item.done }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            checkbox
            Button {
                if let url = URL(string: item.canvasLink), !item.canvasLink.isEmpty {
                    openURL(url)
                }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        EPSTagChip(tag: item.tag)
                        Text(item.title)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(EPSTheme.fg)
                            .strikethrough(shownDone, color: EPSTheme.fg.opacity(0.55))
                            .multilineTextAlignment(.leading)
                    }
                    HStack(spacing: 8) {
                        if !item.courseName.isEmpty {
                            Text(CourseTitle.pretty(item.courseName))
                        }
                        if !item.due.isEmpty {
                            Text(EPSDueFormat.due(item.due))
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(EPSTheme.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 8)
        .background {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(EPSTheme.accent.opacity(hovering ? 0.14 : 0))
        }
        .opacity(shownDone ? (hovering ? 0.9 : 0.55) : 1)
        .animation(.easeOut(duration: 0.2), value: hovering)
        .onHover { hovering = $0 }
    }

    private var checkbox: some View {
        Button {
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
        } label: {
            Color.clear
                .epsSizedGlassCircle(side: 20, interactive: false)
                .overlay {
                    if shownDone {
                        Circle()
                            .fill(EPSTheme.accent)
                            .frame(width: 8, height: 8)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
        }
        .buttonStyle(.plain)
        .animation(.spring(duration: 0.34, bounce: 0.26), value: shownDone)
        .accessibilityLabel(shownDone ? "Mark incomplete" : "Mark complete")
        .epsHapticOnTap()
    }
}

struct ClassesPanel: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore

    private var rows: [SchoolClass] { dashboard.displayedClasses }

    var body: some View {
        EPSPanel(title: "Classes") {
            if rows.isEmpty {
                EmptyLine(emptyCopy)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(rows) { course in
                        NavigationLink(value: HomeDestination.schoolClass(course.id)) {
                            ClassRow(course: course)
                        }
                        .buttonStyle(.plain)
                        .epsHapticNavigation()
                    }
                }
            }
        }
    }

    private var emptyCopy: String {
        if !dashboard.scheduleClasses.isEmpty { return "No classes" }
        if session.profile?.canvasConnected == true { return "No classes" }
        return "Upload an EPS schedule PDF in settings"
    }
}

struct ClassRow: View {
    var course: SchoolClass

    private var isCurrent: Bool {
        guard let now = DashboardStore.currentPeriod() else { return false }
        let p = course.period.uppercased()
        return p == now.num || p == now.letter
    }

    private var trailing: String {
        course.courseCode
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            if !course.period.isEmpty {
                Text(course.period)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(EPSTheme.accent)
                    .frame(width: 22, alignment: .center)
            }
            Text(CourseTitle.pretty(course.name))
                .font(.body.weight(.semibold))
                .foregroundStyle(EPSTheme.fg)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !trailing.isEmpty {
                Text(trailing)
                    .font(.caption)
                    .foregroundStyle(EPSTheme.muted)
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(EPSTheme.muted)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 8)
        .background {
            if isCurrent {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(EPSTheme.accent.opacity(0.12))
            }
        }
        .contentShape(Rectangle())
    }
}

struct EPSTagChip: View {
    var tag: String

    private var resolved: String {
        tag.isEmpty ? "HW" : tag.uppercased()
    }

    var body: some View {
        Text(resolved)
            .font(.system(size: 11, weight: .bold))
            .tracking(0.4)
            .foregroundStyle(EPSTheme.accent)
    }
}

struct EmptyLine: View {
    var text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(EPSTheme.muted)
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
    }
}

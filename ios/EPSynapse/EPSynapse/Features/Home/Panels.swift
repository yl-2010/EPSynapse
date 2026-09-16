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

    static func timeHM(_ iso: String) -> String? {
        if let date = parse(iso) {
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            guard let hour = parts.hour, let minute = parts.minute else { return nil }
            if hour == 0, minute == 0, !iso.contains("T"), !iso.contains(":") {
                return nil
            }
            return String(format: "%02d:%02d", hour, minute)
        }
        let trimmed = iso.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count >= 16 {
            let slice = String(trimmed.dropFirst(11).prefix(5))
            if slice.contains(":") { return slice }
        }
        return nil
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
    var accentPrefix: String? = nil
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
            HStack(alignment: .center, spacing: 8) {
                titleView
                if showFilters {
                    Spacer(minLength: 8)
                    FilterOrbBar()
                }
            }

            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .epsGlassRounded(cornerRadius: 22, interactive: true)
        .opacity(dimmed ? 0.55 : 1)
    }

    private var titleLabel: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let accentPrefix, !accentPrefix.isEmpty {
                Text(accentPrefix)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(EPSTheme.accent)
            }
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(EPSTheme.fg)
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
                    withAnimation(.easeInOut(duration: 0.22)) {
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
        Button {
            EPSHaptics.tap()
            action()
        } label: {
            Text(tag)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(isOn ? Color.white : EPSTheme.muted)
                .frame(width: 32, height: 32)
                .glassCircle(
                    interactive: true,
                    tint: isOn ? EPSTheme.filterOnTint(colorScheme) : nil
                )
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tag)
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
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
                EmptyLine("Nothing here")
            } else {
                TodoRows(items: items) { item in
                    TodoRow(item: item)
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
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                VStack(alignment: .leading, spacing: 0) {
                    if index > 0, EPSDueFormat.dayKey(items[index - 1].due) != EPSDueFormat.dayKey(item.due) {
                        TodoDaySeparator()
                    }
                    row(item)
                }
            }
            .animation(.spring(response: 0.42, dampingFraction: 0.86), value: items.map(\.id))
        }
    }
}

struct TodoRow: View {
    var item: Assignment
    var showClass: Bool = true
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var dashboard: DashboardStore
    @State private var pendingDone: Bool?

    private var shownDone: Bool { pendingDone ?? item.done }

    var body: some View {
        let when = NaturalWhen.format(date: item.dueDateValue, time: item.dueTimeValue)
        let className = showClass ? CourseTitle.pretty(item.courseName) : ""
        let hasMeta = !className.isEmpty || !when.isEmpty

        HStack(alignment: .top, spacing: 12) {
            EducationTodoCheckbox(done: shownDone) {
                toggle()
            }
            .padding(.top, 2)

            NavigationLink(value: HomeDestination.todo(item.id)) {
                VStack(alignment: .leading, spacing: 4) {
                    EducationTodoTitle(item: item, font: .body.weight(.semibold), done: shownDone)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if hasMeta {
                        HStack(spacing: 8) {
                            if !className.isEmpty {
                                Text(className)
                                    .font(.caption)
                                    .foregroundStyle(EPSTheme.muted)
                            }
                            if !when.isEmpty {
                                Text(when)
                                    .font(.caption)
                                    .foregroundStyle(EPSTheme.muted)
                            }
                        }
                    }
                }
            }
            .buttonStyle(.plain)
            .epsHapticNavigation()

            EducationCanvasScoreButton(
                label: item.scoreLabel,
                url: item.canvasURL,
                topPadding: 3
            )
        }
        .padding(.vertical, 8)
    }

    private func toggle() {
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

/// Title with CW/HW/QA/MA in accent at the same size as the name.
struct EducationTodoTitle: View {
    var item: Assignment
    var font: Font
    var done: Bool = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let tag = item.displayTag {
                Text(tag)
                    .font(font)
                    .foregroundStyle(done ? EPSTheme.muted : EPSTheme.accent)
            }
            Text(item.title)
                .font(font)
                .foregroundStyle(EPSTheme.fg)
                .strikethrough(done, color: EPSTheme.muted)
        }
    }
}

/// Checkbox locked to the title row so class / due meta never vertically shifts it.
struct EducationTodoCheckbox: View {
    var done: Bool
    var action: () -> Void

    static let size: CGFloat = 22

    var body: some View {
        Button {
            if !done {
                EPSHaptics.tap()
            }
            action()
        } label: {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.system(size: Self.size, weight: .medium))
                .foregroundStyle(done ? EPSTheme.accent : EPSTheme.muted)
                .frame(width: Self.size, height: Self.size)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel(done ? "Mark not done" : "Mark done")
    }
}

struct DayPanel: View {
    var section: DaySection

    var body: some View {
        EPSPanel(title: section.whenLabel, accentPrefix: section.typeCode) {
            if section.classes.isEmpty {
                EmptyLine("Nothing here")
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(section.classes) { dayClass in
                        classRow(dayClass, isCurrent: section.isCurrent(dayClass))
                    }
                }
            }
        }
    }

    private func classRow(_ dayClass: DayClass, isCurrent: Bool) -> some View {
        HStack(spacing: 10) {
            NavigationLink(value: HomeDestination.schoolClass(dayClass.klass.id)) {
                HStack(spacing: 10) {
                    Text(dayClass.period)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(EPSTheme.accent)
                        .frame(width: 22, alignment: .leading)
                    Text(dayClass.klass.freePeriod ? "Free Period" : CourseTitle.pretty(dayClass.klass.name))
                        .font(.body.weight(.semibold))
                        .foregroundStyle(EPSTheme.fg)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .epsHapticNavigation()

            EducationCanvasScoreButton(
                label: dayClass.klass.scoreLabel,
                url: dayClass.klass.canvasURL
            )
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 8)
        .background {
            if isCurrent {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(EPSTheme.accent.opacity(0.12))
            }
        }
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
                VStack(alignment: .leading, spacing: 0) {
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
        if session.profile?.isOtherDoor == true { return "Upload your schedule PDF in settings" }
        return "Upload an EPS schedule PDF in settings"
    }
}

struct ClassRow: View {
    var course: SchoolClass
    @EnvironmentObject private var dashboard: DashboardStore

    private var isCurrent: Bool {
        dashboard.daySections.contains { section in
            section.classes.contains { $0.klass.id == course.id && section.isCurrent($0) }
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 10) {
                if !course.period.isEmpty {
                    Text(course.period)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(EPSTheme.accent)
                        .frame(width: 22, alignment: .leading)
                }
                Text(CourseTitle.pretty(course.name))
                    .font(.body.weight(.semibold))
                    .foregroundStyle(EPSTheme.fg)
                Spacer(minLength: 0)
            }

            EducationCanvasScoreButton(
                label: course.scoreLabel,
                url: course.canvasURL
            )
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
    }
}

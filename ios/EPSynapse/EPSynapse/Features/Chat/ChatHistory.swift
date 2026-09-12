import SwiftUI

struct ChatListItem: Identifiable, Equatable, Hashable {
    var id: String { sessionId }
    var sessionId: String
    var title: String
    var preview: String
    var updated: Date
    var unread: Bool
    var working: Bool

    init(
        sessionId: String,
        title: String,
        preview: String = "",
        updated: Date = Date(),
        unread: Bool = false,
        working: Bool = false
    ) {
        self.sessionId = sessionId
        self.title = title
        self.preview = preview
        self.updated = updated
        self.unread = unread
        self.working = working
    }

    init(_ row: ChatListItemResponse) {
        sessionId = row.sessionId
        title = row.title.isEmpty ? "Chat" : row.title
        preview = row.preview
        updated = ChatISODate.date(from: row.updated.isEmpty ? row.started : row.updated)
        unread = row.unread
        working = false
    }
}

struct ChatHistorySection: Identifiable, Equatable {
    var id: String { title }
    var title: String
    var showAge: Bool
    var items: [ChatListItem]
}

enum ChatISODate {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func date(from raw: String) -> Date {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return Date() }
        return fractional.date(from: trimmed) ?? plain.date(from: trimmed) ?? Date()
    }

    static func string(from date: Date) -> String {
        fractional.string(from: date)
    }
}

enum ChatHistoryGrouping {
    static func relativeAge(from date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        return "\(Int(seconds / 3600))h"
    }

    static func sections(from chats: [ChatListItem], now: Date = Date(), calendar: Calendar = .current) -> [ChatHistorySection] {
        let ordered = chats.sorted { $0.updated > $1.updated }
        var today: [ChatListItem] = []
        var yesterday: [ChatListItem] = []
        var weekdays: [(String, [ChatListItem])] = []
        var weekdayIndex: [String: Int] = [:]
        var older: [ChatListItem] = []

        for item in ordered {
            if calendar.isDateInToday(item.updated) {
                today.append(item)
                continue
            }
            if calendar.isDateInYesterday(item.updated) {
                yesterday.append(item)
                continue
            }
            let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: item.updated), to: calendar.startOfDay(for: now)).day ?? 99
            if days >= 0 && days < 7 {
                let name = weekdayName(item.updated, calendar: calendar)
                if let index = weekdayIndex[name] {
                    weekdays[index].1.append(item)
                } else {
                    weekdayIndex[name] = weekdays.count
                    weekdays.append((name, [item]))
                }
                continue
            }
            older.append(item)
        }

        var result: [ChatHistorySection] = []
        if !today.isEmpty {
            result.append(ChatHistorySection(title: "Today", showAge: true, items: today))
        }
        if !yesterday.isEmpty {
            result.append(ChatHistorySection(title: "Yesterday", showAge: false, items: yesterday))
        }
        for (title, items) in weekdays where !items.isEmpty {
            result.append(ChatHistorySection(title: title, showAge: false, items: items))
        }
        if !older.isEmpty {
            result.append(ChatHistorySection(title: "Older", showAge: false, items: older))
        }
        return result
    }

    private static func weekdayName(_ date: Date, calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = .current
        formatter.dateFormat = "EEEE"
        return formatter.string(from: date)
    }
}

struct ChatHistoryPanel: View {
    @EnvironmentObject private var chat: ChatStore

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if chat.chats.isEmpty, chat.historyLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 20)
                } else if chat.chats.isEmpty {
                    Text("No past chats yet.")
                        .font(.subheadline)
                        .foregroundStyle(EPSTheme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 20)
                } else {
                    ForEach(ChatHistoryGrouping.sections(from: chat.chats)) { section in
                        Text(section.title)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(EPSTheme.muted)
                            .padding(.horizontal, 4)
                            .padding(.top, 4)

                        ForEach(section.items) { item in
                            Button {
                                Task { await chat.resume(sessionId: item.sessionId) }
                            } label: {
                                ChatHistoryRowLabel(item: item, showAge: section.showAge)
                            }
                            .buttonStyle(ChatHistoryRowButtonStyle())
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 12)
            .padding(.bottom, 20)
        }
        .scrollIndicators(.hidden)
    }
}

struct ChatHistoryRowLabel: View {
    var item: ChatListItem
    var showAge: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if item.unread || item.working {
                ChatHistoryStatusDot(working: item.working)
                    .alignmentGuide(.firstTextBaseline) { dim in dim.height * 0.72 }
            }
            Text(item.title)
                .font(.subheadline)
                .foregroundStyle(EPSTheme.fg)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if showAge {
                Text(ChatHistoryGrouping.relativeAge(from: item.updated))
                    .font(.caption2)
                    .foregroundStyle(EPSTheme.muted)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .epsGlassRounded(cornerRadius: 11, interactive: true)
    }
}

struct ChatHistoryRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct ChatHistoryStatusDot: View {
    var working: Bool
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(EPSTheme.accent)
            .frame(width: 8, height: 8)
            .opacity(working && pulse ? 0.35 : 1)
            .onAppear { spinIfNeeded() }
            .onChange(of: working) { _, _ in
                pulse = false
                spinIfNeeded()
            }
    }

    private func spinIfNeeded() {
        guard working else { return }
        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
            pulse = true
        }
    }
}
